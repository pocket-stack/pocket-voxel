//! pocketvoxel-gxm — the raw-GXM backend for the Pocket Voxel diorama.
//!
//! Consumes the core's [`DrawList`] exactly as the software rasterizer
//! (`pocketvoxel-sim/src/raster.rs`) and the PSP GE backend
//! (`pocketvoxel-gu`) do: same draw order (the list is already ordered), same
//! camera-ward pull, same `resolve_pal`, same visible depth semantics. The
//! core projects with [`Mat4::perspective_gl`], so GXM's `LESS_EQUAL` against
//! a depth buffer cleared to far IS the rasterizer's "less wins", and the
//! player ghost's occluded-only pass is `GREATER`.
//!
//! Like the other two backends this one never opens or closes a frame: the
//! frame loop owns vita2d's scene and present. A frame composes as
//!
//! ```text
//! vita2d_start_drawing()
//! vita2d_clear_screen()
//!   renderer.render(&draw::build(&scene, &pak), &pak)
//! vita2d_end_drawing()
//! vita2d_swap_buffers()
//! ```
//!
//! # What the five shaders cost
//!
//! GXM is shader-only and this backend brings shaders it did not write (see
//! [`gxm`]), so two things the GE does in one pass are done differently here,
//! and both are visible in the code:
//!
//! **Per-vertex AO needs a second pass.** `texture_v` takes no colour
//! attribute, so an opaque mesh draws twice over the same indices — the texel,
//! then the pak's AO through `color_v` with a `dst * src` blend. The result is
//! `texel * ao`, which is what `TextureEffect::Modulate` gets the GE in one.
//!
//! **There is no alpha test.** The GE cuts sprite art out with
//! `AlphaFunc::Greater 0x7f`; GXM has no equivalent and these shaders cannot
//! discard. So alpha is resolved by blending, and the passes split by whether
//! their art is cut out:
//!
//! - Solid geometry (terrain, the ground bake, all three tree levels, water)
//!   draws opaque with depth writes, then takes its AO pass. Its art is
//!   carved into the mesh, not into the texture.
//! - Cut-out geometry (grass, flowers, billboard cards, the GB UI layer)
//!   draws alpha-blended and depth-preserving, in the list's own order. It
//!   takes **no AO pass**: the multiply pass carries no texture, so where a
//!   texel was transparent it would darken the background into a visible
//!   rectangle. Losing the AO on a grass tuft is the cheaper error.
//!
//! The GB UI layer loses nothing at all — it is 2D, drawn last, and never
//! depth-tested, so blending is exactly what the GE's cutout produced.

#![cfg(target_os = "vita")]

mod atlas;
pub mod gxm;
mod video;

use core::ffi::c_void;

use pocketvoxel_core::draw::{DrawList, Item, MeshDraw, SKY_BANDS, resolve_pal};
use pocketvoxel_core::math::{Mat4, Vec3, sqrtf, vec3};
use pocketvoxel_core::pak::{Pak, PakVert};
use pocketvoxel_core::spec::{COLOR_PAL_NONE, TILE_PX, VERTEX_STRIDE, VIEW_H, VIEW_W, mesh_kind};
use vita2d_sys as v2d;

pub use atlas::AtlasCache;
use gxm::{DepthMode, TexMode};

/// The physical raster the Vita presents. The logical viewport stays
/// [`VIEW_W`]x[`VIEW_H`] — this is a raster density, not a layout.
pub const PHYSICAL_W: i32 = VIEW_W * 2;
pub const PHYSICAL_H: i32 = VIEW_H * 2;

/// Sequential indices for the CPU-built passes, which are all plain triangle
/// lists. The overlay expands bounded 5x7 label runs to at most 2048 quads
/// (12288 vertices), which is the largest CPU-built pass.
const SEQUENTIAL_INDICES: usize = 16384;

/// CPU-built untextured vertex for sky bands and shadow decals.
#[repr(C)]
#[derive(Clone, Copy)]
struct FlatVert {
    abgr: u32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(core::mem::size_of::<FlatVert>() == gxm::FLAT_STRIDE as usize);

/// CPU-built textured vertex: billboard cards and the GB UI layer.
#[repr(C)]
#[derive(Clone, Copy)]
struct TexVert {
    u: f32,
    v: f32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(core::mem::size_of::<TexVert>() == gxm::TEX_STRIDE as usize);

/// The colour below the horizon — the frame's clear.
///
/// The GE backend's sky pass owns its own clear; here the scene is already
/// open and cleared by the time the list is recorded, so the frame loop needs
/// this one value BEFORE it starts drawing. vita2d's clear colour is packed
/// the same way the pak's palettes are (`0xAABBGGRR`), so it passes straight
/// through.
pub fn backdrop(list: &DrawList) -> u32 {
    for item in &list.items {
        if let Item::SkyBands { colors, .. } = item {
            return colors[SKY_BANDS - 1];
        }
    }
    0xff00_0000
}

/// Whether a mesh kind's art is cut out of its texture. Solid kinds carve
/// their silhouette into the mesh instead, so nothing is lost by drawing them
/// opaque — and drawing them opaque is what lets them take the AO pass.
fn is_cutout(kind: u16) -> bool {
    matches!(kind, mesh_kind::GRASS | mesh_kind::FLOWER)
}

/// Screen-space projection for the 2D passes: the logical 480x272 box mapped
/// to NDC with y down, which is the space every screen-space item in the draw
/// list is already expressed in. The physical viewport does the 2x — no term
/// here knows about it.
fn logical_ortho() -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[0] = 2.0 / VIEW_W as f32;
    m.m[5] = -2.0 / VIEW_H as f32;
    m.m[10] = 0.0;
    m.m[12] = -1.0;
    m.m[13] = 1.0;
    m
}

/// The seam translation for a pak mesh, folded into the one matrix the
/// shaders take. There is no ×32768 counter-scale: GXM's `S16` attribute
/// format is not normalized, so the cooked i16 world coordinates arrive as
/// the integers they are.
fn world_wvp(vp: &Mat4, off_x: i32, off_y: i32) -> [f32; 16] {
    let mut m = *vp;
    // Column-major: translating in world space post-multiplies the VP, which
    // for a pure translation is this column update.
    for row in 0..4 {
        m.m[12 + row] = vp.m[row] * off_x as f32 + vp.m[8 + row] * off_y as f32 + vp.m[12 + row];
    }
    m.m
}

/// The mod's camera-ward pull: displace toward the eye along the vertex's own
/// ray — the same projection-invariant depth bias `raster.rs` applies in
/// `to_clip`. Same operation ORDER as `Vec3::normalize().scale(pull)` so the
/// result matches the sim's.
#[inline]
fn pulled(eye: Vec3, pos: Vec3, pull: f32) -> Vec3 {
    if pull == 0.0 {
        return pos;
    }
    let d = eye.sub(pos);
    let len = sqrtf(d.dot(d));
    if len > 1e-12 {
        pos.add(d.scale(1.0 / len).scale(pull))
    } else {
        pos
    }
}

/// Copy a CPU-built vertex slice into vita2d's per-frame GPU pool. The pool
/// is reset by `vita2d_start_drawing`, so the returned pointer is valid for
/// exactly this frame — which is all a staged draw needs.
unsafe fn stage<T: Copy>(data: &[T]) -> Option<*const c_void> {
    if data.is_empty() {
        return None;
    }
    let bytes = core::mem::size_of_val(data);
    let destination = v2d::vita2d_pool_memalign(bytes as u32, 4);
    if destination.is_null() {
        return None;
    }
    core::ptr::copy_nonoverlapping(data.as_ptr(), destination.cast::<T>(), data.len());
    Some(destination.cast_const())
}

pub struct Renderer {
    /// The pak's shared vertex pool, in GXM-mapped memory.
    verts: gxm::GpuSlab,
    /// The pak's shared index pool.
    indices: gxm::GpuSlab,
    /// `0, 1, 2, …` for the CPU-built passes.
    sequential: gxm::GpuSlab,
    atlas: AtlasCache,
    /// Last bound atlas key, to skip redundant texture binds.
    bound: Option<atlas::Key>,
    palette: i32,
    /// Reused staging — allocated once, cleared per use.
    pull_verts: Vec<PakVert>,
    quad: Vec<FlatVert>,
    tex_quad: Vec<TexVert>,
    ui: Vec<TexVert>,
    /// The companion's latest desktop frame. Its pixels are updated only in
    /// the GPU-idle window owned by the Vita application shell.
    remote_video: Option<video::VideoTexture>,
    /// Vertices restaged through the geometric-pull path this frame, and the
    /// draws issued. The frame loop's telemetry reads both.
    pub pull_verts_count: u32,
    pub draw_count: u32,
}

impl Renderer {
    /// Bytes of GXM-mapped memory the pak's pools need.
    pub fn pool_bytes_needed(pak: &Pak) -> usize {
        core::mem::size_of_val(pak.verts) + core::mem::size_of_val(pak.indices)
    }

    /// Copy the pak's vertex and index pools into GXM-mapped memory.
    ///
    /// The GPU cannot read the heap the pak was loaded into, so this is the
    /// one unavoidable copy of the port — after it, every chunk draws from
    /// its own cooked bytes in place, with no per-frame per-vertex work at
    /// all.
    ///
    /// # Safety
    /// Render thread, after vita2d init.
    pub unsafe fn new(pak: &Pak) -> Result<Self, &'static str> {
        gxm::pipeline()?;

        let vert_bytes = core::mem::size_of_val(pak.verts);
        let verts = gxm::GpuSlab::alloc(vert_bytes)?;
        core::ptr::copy_nonoverlapping(
            pak.verts.as_ptr(),
            verts.as_ptr().cast::<PakVert>(),
            pak.verts.len(),
        );

        let index_bytes = core::mem::size_of_val(pak.indices);
        let indices = gxm::GpuSlab::alloc(index_bytes)?;
        core::ptr::copy_nonoverlapping(
            pak.indices.as_ptr(),
            indices.as_ptr().cast::<u16>(),
            pak.indices.len(),
        );

        let sequential = gxm::GpuSlab::alloc(SEQUENTIAL_INDICES * 2)?;
        let out = sequential.as_ptr().cast::<u16>();
        for i in 0..SEQUENTIAL_INDICES {
            out.add(i).write(i as u16);
        }

        Ok(Self {
            verts,
            indices,
            sequential,
            atlas: AtlasCache::new(),
            bound: None,
            palette: -1,
            pull_verts: Vec::new(),
            quad: Vec::new(),
            tex_quad: Vec::new(),
            ui: Vec::new(),
            remote_video: None,
            pull_verts_count: 0,
            draw_count: 0,
        })
    }

    pub fn atlas_bytes(&self) -> usize {
        self.atlas.resident_bytes()
    }

    /// Record one DrawList into the caller's open vita2d scene. Draw order is
    /// the list's order — the core already ordered it (docs/VOXEL.md §3).
    ///
    /// # Safety
    /// Render thread, inside an open vita2d scene, with the pak whose pools
    /// [`Renderer::new`] uploaded.
    pub unsafe fn render(&mut self, list: &DrawList, pak: &Pak) {
        let Ok(pipeline) = gxm::pipeline() else {
            return;
        };
        self.bound = None;
        self.palette = list.palette;
        self.pull_verts_count = 0;
        self.draw_count = 0;
        self.atlas.tick();
        self.atlas.retint(list.tint);

        // Double-sided, like the raster: the cooked streams do not share one
        // winding (column tops, gables, water and grass slabs are each
        // emitted in their own order), so no single cull mode is right for
        // all of them.
        v2d::sceGxmSetCullMode(
            v2d::vita2d_get_context(),
            v2d::SceGxmCullMode_SCE_GXM_CULL_NONE,
        );

        let vp = list.cam.vp;
        for item in &list.items {
            match item {
                Item::SkyBands {
                    colors,
                    horizon_row,
                } => self.sky(pipeline, colors, *horizon_row),
                Item::ChunkMesh { kind, mesh, .. } => {
                    self.mesh(pipeline, pak, mesh, *kind, list.cam.eye, &vp)
                }
                // A stamp is a terrain sub-mesh and draws in the terrain pass.
                Item::StampMesh { mesh, .. } => {
                    self.mesh(pipeline, pak, mesh, mesh_kind::TERRAIN, list.cam.eye, &vp)
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.flat_quad(pipeline, &vp, *corners, *abgr, list.cam.eye, 0.0)
                }
                Item::Ghost {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                    abgr,
                } => self.ghost(
                    pipeline,
                    pak,
                    &vp,
                    *verts,
                    *page,
                    *uv,
                    *mirror,
                    *pull,
                    *abgr,
                    list.cam.eye,
                ),
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => self.card(pipeline, pak, &vp, *verts, *page, *uv, *mirror, *pull, list.cam.eye),
                Item::UiQuad { .. } => {
                    // Batched below: UiQuads are contiguous at the tail of the
                    // list, and the whole GB layer is one staged upload and
                    // one draw instead of ~100 of each.
                }
                Item::VideoQuad { .. } => {
                    // Batched after the GB UI and before the window chrome.
                }
                Item::OverlayRect { .. } => {
                    // Batched after ui_batch so it composites over the
                    // complete GB layer without disturbing that fast path.
                }
            }
        }
        self.ui_batch(pipeline, list, pak);
        self.remote_video_quad(pipeline, list);
        self.overlay_batch(pipeline, list);
    }

    /// Commit a complete CLUT8 frame into the Vita's persistent RGBA video
    /// texture. The application shell calls this immediately after
    /// `vita2d_start_drawing`, where replacing or freeing GPU storage is safe.
    pub unsafe fn update_remote_video(
        &mut self,
        w: u32,
        h: u32,
        palette: &[u8],
        indices: &[u8],
    ) -> bool {
        if self
            .remote_video
            .as_ref()
            .is_none_or(|texture| texture.geometry() != (w, h))
        {
            self.clear_remote_video();
            let Ok(texture) = video::VideoTexture::new(w, h) else {
                return false;
            };
            self.remote_video = Some(texture);
        }
        self.remote_video
            .as_mut()
            .is_some_and(|texture| texture.update(palette, indices))
    }

    /// Release remote-video storage in the same GPU-idle window.
    pub unsafe fn clear_remote_video(&mut self) {
        if let Some(texture) = self.remote_video.take() {
            texture.free();
        }
    }

    // -- textures ------------------------------------------------------------

    /// Bind one atlas page frame through the palette the core resolved.
    /// `resolve_pal` is shared with the software rasterizer and the GE
    /// backend, so all three sample the same CLUT for the same draw.
    unsafe fn bind(
        &mut self,
        pak: &Pak,
        page_idx: u16,
        frame: u16,
        tinted: bool,
        pal: u16,
        solid: Option<u32>,
    ) -> bool {
        let Some(page) = pak.atlases.get(page_idx as usize) else {
            return false;
        };
        let key = atlas::Key {
            page: page_idx,
            frame: frame % page.frames.max(1),
            pal: resolve_pal(pak, page_idx, page.kind, pal, self.palette) as u16,
            tinted,
            solid,
        };
        if self.bound == Some(key) {
            return true;
        }
        let Some(texture) = self.atlas.texture(pak, key) else {
            return false;
        };
        v2d::sceGxmSetFragmentTexture(v2d::vita2d_get_context(), 0, texture);
        self.bound = Some(key);
        true
    }

    // -- item passes ---------------------------------------------------------

    /// Sky pass: the gradient bands over rows `[0, horizon_row)`. The colour
    /// below the horizon is the caller's clear (`vita2d_set_clear_color`), and
    /// depth arrives cleared with the scene, so unlike the GE backend this
    /// pass owns no clear of its own.
    unsafe fn sky(&mut self, pipeline: &gxm::Pipeline, colors: &[u32; SKY_BANDS], horizon_row: i32) {
        let hr = horizon_row.clamp(0, VIEW_H);
        if hr == 0 {
            return;
        }
        self.quad.clear();
        for (i, &c) in colors.iter().enumerate() {
            let y0 = (hr * i as i32 / SKY_BANDS as i32) as f32;
            let y1 = (hr * (i as i32 + 1) / SKY_BANDS as i32) as f32;
            if y1 <= y0 {
                continue;
            }
            let corner = |x: f32, y: f32| FlatVert { abgr: c, x, y, z: 0.0 };
            self.quad.extend_from_slice(&[
                corner(0.0, y0),
                corner(VIEW_W as f32, y0),
                corner(VIEW_W as f32, y1),
                corner(0.0, y0),
                corner(VIEW_W as f32, y1),
                corner(0.0, y1),
            ]);
        }
        let Some(staged) = stage(&self.quad) else {
            return;
        };
        gxm::set_depth(DepthMode::Overlay);
        if pipeline.bind_flat(&logical_ortho().m, false) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), self.quad.len() as u32);
            self.draw_count += 1;
        }
    }

    /// One chunk/stamp mesh. `pull == 0` draws the pak's i16 vertices in place
    /// out of GXM-mapped memory; `pull != 0` (grass and flower at the
    /// geometric-pull rungs) applies the eye-ray displacement CPU-side into
    /// the frame pool, exactly as `raster.rs to_clip` does per vertex;
    /// `pull_bias != 0` (the `pullDepthBias` rung) draws in place through the
    /// same biased VP the rasterizer uses.
    unsafe fn mesh(
        &mut self,
        pipeline: &gxm::Pipeline,
        pak: &Pak,
        m: &MeshDraw,
        kind: u16,
        eye: Vec3,
        vp: &Mat4,
    ) {
        if m.index_count == 0 || !self.bind(pak, m.page, m.frame, true, m.pal, None) {
            return;
        }
        let projection = if m.pull_bias != 0.0 {
            pocketvoxel_core::draw::biased_vp(vp, m.pull_bias)
        } else {
            *vp
        };
        let indices = self.indices.as_ptr().cast::<u16>().add(m.index_base as usize);

        // Where the vertices come from, and what the AO pass may do with them.
        let (vertices, wvp) = if m.pull == 0.0 {
            (
                self.verts
                    .as_ptr()
                    .add(m.vert_base as usize * VERTEX_STRIDE)
                    .cast_const()
                    .cast::<c_void>(),
                world_wvp(&projection, m.off_x, m.off_y),
            )
        } else {
            let n = m.vert_count as usize;
            let src = &pak.verts[m.vert_base as usize..m.vert_base as usize + n];
            self.pull_verts.clear();
            self.pull_verts.reserve(n);
            for pv in src {
                let pos = pulled(
                    eye,
                    vec3(
                        pv.x as f32 + m.off_x as f32,
                        pv.y as f32,
                        pv.z as f32 + m.off_y as f32,
                    ),
                    m.pull,
                );
                self.pull_verts.push(PakVert {
                    u: pv.u,
                    v: pv.v,
                    abgr: pv.abgr,
                    x: pos.x as i16,
                    y: pos.y as i16,
                    z: pos.z as i16,
                    pad: 0,
                });
            }
            self.pull_verts_count += n as u32;
            // The pak's indices are relative to `vert_base`, and the restage
            // starts at exactly that vertex, so the same index range addresses
            // the staged copy without rebasing.
            let Some(staged) = stage(&self.pull_verts) else {
                return;
            };
            (staged, projection.m)
        };

        if is_cutout(kind) {
            // No discard on this hardware: blend, and leave depth alone so a
            // transparent texel cannot occlude what is behind it. No AO pass
            // follows — see the module docs.
            gxm::set_depth(DepthMode::TestOnly);
            if pipeline.bind_pak_textured(&wvp, TexMode::Alpha) {
                pipeline.draw(vertices, indices, m.index_count as u32);
                self.draw_count += 1;
            }
            return;
        }

        gxm::set_depth(DepthMode::Opaque);
        if pipeline.bind_pak_textured(&wvp, TexMode::Opaque) {
            pipeline.draw(vertices, indices, m.index_count as u32);
            self.draw_count += 1;
        }
        // The AO pass: same geometry, same indices, `dst * src`. Depth is
        // already written by the pass above, so this one only has to match it.
        gxm::set_depth(DepthMode::TestOnly);
        if pipeline.bind_pak_light(&wvp) {
            pipeline.draw(vertices, indices, m.index_count as u32);
            self.draw_count += 1;
        }
    }

    /// Flat-colour blended quad for a shadow decal (depth-tested, never
    /// written). The player ghost is textured separately so its transparent
    /// card pixels cannot become a visible rectangle.
    #[allow(clippy::too_many_arguments)]
    unsafe fn flat_quad(
        &mut self,
        pipeline: &gxm::Pipeline,
        vp: &Mat4,
        corners: [[f32; 3]; 4],
        abgr: u32,
        eye: Vec3,
        pull: f32,
    ) {
        self.quad.clear();
        // bl, br, tr, tl -> two triangles (0,1,2)(0,2,3).
        for ci in [0usize, 1, 2, 0, 2, 3] {
            let p = pulled(eye, vec3(corners[ci][0], corners[ci][1], corners[ci][2]), pull);
            self.quad.push(FlatVert {
                abgr,
                x: p.x,
                y: p.y,
                z: p.z,
            });
        }
        let Some(staged) = stage(&self.quad) else {
            return;
        };
        gxm::set_depth(DepthMode::TestOnly);
        if pipeline.bind_flat(&vp.m, true) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), 6);
            self.draw_count += 1;
        }
    }

    /// Draw the occluded player hint through a sprite-alpha-only atlas
    /// variant. The stock Vita shaders cannot discard or replace sampled RGB,
    /// so the cache expands the page into the flat ghost color ahead of time.
    #[allow(clippy::too_many_arguments)]
    unsafe fn ghost(
        &mut self,
        pipeline: &gxm::Pipeline,
        pak: &Pak,
        vp: &Mat4,
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        abgr: u32,
        eye: Vec3,
    ) {
        if !self.bind(pak, page, 0, false, COLOR_PAL_NONE, Some(abgr)) {
            return;
        }
        self.card_quad(
            pipeline,
            vp,
            verts,
            uv,
            mirror,
            pull,
            eye,
            DepthMode::Occluded,
        );
    }

    /// Stage and draw the shared billboard quad after its caller has bound
    /// either the ordinary sprite texture or the flat-color ghost mask.
    #[allow(clippy::too_many_arguments)]
    unsafe fn card_quad(
        &mut self,
        pipeline: &gxm::Pipeline,
        vp: &Mat4,
        verts: [[f32; 3]; 4],
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        eye: Vec3,
        depth: DepthMode,
    ) {
        let (u0, u1) = if mirror { (uv[2], uv[0]) } else { (uv[0], uv[2]) };
        let (v0, v1) = (uv[1], uv[3]);
        let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
        self.tex_quad.clear();
        for ci in [0usize, 1, 2, 0, 2, 3] {
            let p = pulled(eye, vec3(verts[ci][0], verts[ci][1], verts[ci][2]), pull);
            self.tex_quad.push(TexVert {
                u: uvs[ci].0,
                v: uvs[ci].1,
                x: p.x,
                y: p.y,
                z: p.z,
            });
        }
        let Some(staged) = stage(&self.tex_quad) else {
            return;
        };
        gxm::set_depth(depth);
        if pipeline.bind_tex(&vp.m, TexMode::Alpha) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), 6);
            self.draw_count += 1;
        }
    }

    /// A billboard card: textured, cut out, pulled along each vertex's eye
    /// ray. Depth-preserving for the same reason every cutout pass is.
    #[allow(clippy::too_many_arguments)]
    unsafe fn card(
        &mut self,
        pipeline: &gxm::Pipeline,
        pak: &Pak,
        vp: &Mat4,
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        eye: Vec3,
    ) {
        // A card carries no per-item palette: its OBJ/pic CLUT is a property
        // of the PAGE, which `bind` resolves through VCOL.
        if !self.bind(pak, page, 0, true, COLOR_PAL_NONE, None) {
            return;
        }
        self.card_quad(
            pipeline,
            vp,
            verts,
            uv,
            mirror,
            pull,
            eye,
            DepthMode::TestOnly,
        );
    }

    /// The whole GB UI layer in one pass: screen space, no depth, UNTINTED
    /// palette (raster.rs composites the UI layer verbatim). This is the one
    /// cutout pass that loses nothing to the missing alpha test — it is 2D,
    /// last, and never depth-tested, so blending is exactly what the GE's
    /// cutout produced.
    unsafe fn ui_batch(&mut self, pipeline: &gxm::Pipeline, list: &DrawList, pak: &Pak) {
        let mut page_idx = None;
        for item in &list.items {
            if let Item::UiQuad { page, .. } = item {
                page_idx.get_or_insert(*page);
            }
        }
        let (Some(page), Some(p)) = (page_idx, page_idx.and_then(|i| pak.atlases.get(i as usize)))
        else {
            return;
        };
        if !self.bind(pak, page, 0, false, COLOR_PAL_NONE, None) {
            return;
        }
        let cols = ((p.w as i32 / TILE_PX) as u16).max(1);
        let (pw, ph) = (p.w as f32, p.h as f32);
        self.ui.clear();
        for item in &list.items {
            let Item::UiQuad { x, y, w, h, tile, .. } = item else {
                continue;
            };
            let tx0 = (tile % cols) as f32 * TILE_PX as f32;
            let ty0 = (tile / cols) as f32 * TILE_PX as f32;
            let (u0, v0) = (tx0 / pw, ty0 / ph);
            let (u1, v1) = ((tx0 + TILE_PX as f32) / pw, (ty0 + TILE_PX as f32) / ph);
            // The GB layer keeps its fractional logical position rather than
            // rounding to a device pixel as the GE backend must: at 2x the
            // raster a half-logical-pixel edge is a real device pixel.
            let corner = |px: f32, py: f32, u: f32, v: f32| TexVert {
                u,
                v,
                x: px,
                y: py,
                z: 0.0,
            };
            let (x0, y0, x1, y1) = (*x, *y, *x + *w, *y + *h);
            self.ui.extend_from_slice(&[
                corner(x0, y0, u0, v0),
                corner(x1, y0, u1, v0),
                corner(x1, y1, u1, v1),
                corner(x0, y0, u0, v0),
                corner(x1, y1, u1, v1),
                corner(x0, y1, u0, v1),
            ]);
            if self.ui.len() + 6 > SEQUENTIAL_INDICES {
                break; // the index buffer is the ceiling; drop the tail
            }
        }
        let Some(staged) = stage(&self.ui) else {
            return;
        };
        gxm::set_depth(DepthMode::Overlay);
        if pipeline.bind_tex(&logical_ortho().m, TexMode::Alpha) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), self.ui.len() as u32);
            self.draw_count += 1;
        }
    }

    /// Draw the host-owned desktop texture into the geometry retained by the
    /// core. The following overlay batch supplies the Win98 frame and labels.
    unsafe fn remote_video_quad(&mut self, pipeline: &gxm::Pipeline, list: &DrawList) {
        let Some((x, y, w, h)) = list.items.iter().find_map(|item| match item {
            Item::VideoQuad { x, y, w, h } => Some((*x, *y, *w, *h)),
            _ => None,
        }) else {
            return;
        };
        let Some(texture) = self.remote_video.as_ref() else {
            return;
        };

        self.tex_quad.clear();
        let corner = |px: i32, py: i32, u: f32, v: f32| TexVert {
            u,
            v,
            x: px as f32,
            y: py as f32,
            z: 0.0,
        };
        let (x1, y1) = (x.saturating_add(w), y.saturating_add(h));
        self.tex_quad.extend_from_slice(&[
            corner(x, y, 0.0, 0.0),
            corner(x1, y, 1.0, 0.0),
            corner(x1, y1, 1.0, 1.0),
            corner(x, y, 0.0, 0.0),
            corner(x1, y1, 1.0, 1.0),
            corner(x, y1, 0.0, 1.0),
        ]);
        let Some(staged) = stage(&self.tex_quad) else {
            return;
        };
        v2d::sceGxmSetFragmentTexture(v2d::vita2d_get_context(), 0, texture.texture());
        gxm::set_depth(DepthMode::Overlay);
        if pipeline.bind_tex(&logical_ortho().m, TexMode::Opaque) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), 6);
            self.draw_count += 1;
        }
    }

    /// One staged flat-colour pass for every native-pixel overlay rectangle.
    /// It follows the untouched GB UI batch and preserves append order within
    /// the triangle stream for overlapping translucent commands.
    unsafe fn overlay_batch(&mut self, pipeline: &gxm::Pipeline, list: &DrawList) {
        self.quad.clear();
        for item in &list.items {
            let Item::OverlayRect { x, y, w, h, abgr } = item else {
                continue;
            };
            if self.quad.len() + 6 > SEQUENTIAL_INDICES {
                break;
            }
            let corner = |x: i32, y: i32| FlatVert {
                abgr: *abgr,
                x: x as f32,
                y: y as f32,
                z: 0.0,
            };
            let (x0, y0) = (*x, *y);
            let (x1, y1) = (x.saturating_add(*w), y.saturating_add(*h));
            self.quad.extend_from_slice(&[
                corner(x0, y0),
                corner(x1, y0),
                corner(x1, y1),
                corner(x0, y0),
                corner(x1, y1),
                corner(x0, y1),
            ]);
        }
        let Some(staged) = stage(&self.quad) else {
            return;
        };
        gxm::set_depth(DepthMode::Overlay);
        if pipeline.bind_flat(&logical_ortho().m, true) {
            pipeline.draw(staged, self.sequential.as_ptr().cast(), self.quad.len() as u32);
            self.draw_count += 1;
        }
    }
}
