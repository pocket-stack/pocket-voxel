//! pocketvoxel-gl — the vitaGL (GXM) backend for the Pocket Voxel diorama.
//!
//! Consumes the core's [`DrawList`] exactly as the software rasterizer
//! (`pocketvoxel-sim/src/raster.rs`) and the PSP GE backend
//! (`pocketvoxel-gu`) do: same draw order (the list is already ordered),
//! same camera-ward pull displacement, same alpha-test cutoff, same visible
//! depth semantics. Where the GE backend has to express those semantics
//! through the GE's inverted 16-bit depth range, this one does not: the
//! core's projection is [`Mat4::perspective_gl`], so GL's own conventions —
//! depth range [0, 1], `GL_LEQUAL`, clear depth 1.0 — ARE the rasterizer's
//! "less wins".
//!
//! Like the GE backend, this crate never opens or closes a frame: the frame
//! loop owns `vglSwapBuffers` and present pacing. A frame composes as:
//!
//! ```text
//! renderer.render(&draw::build(&scene, &pak), &pak)
//! vglSwapBuffers(GL_FALSE)
//! ```
//!
//! Three facts about this machine shape the backend, and each is pinned at
//! its site below:
//!
//! - **The pak's vertex and index pools live in GL buffer objects**, uploaded
//!   once at boot, and a mesh draws by re-pointing the attribute offsets at
//!   its own `vert_base`. vitaGL's fixed-function path skips both the index
//!   scan and the staging copy when every attribute comes from a VBO, so the
//!   world pass costs no per-frame CPU per vertex at all — the thing that
//!   cost the PSP 65-103 ms a frame before the `pullDepthBias` dial existed.
//! - **The 2x native raster is free here.** The core stays at its 480x272
//!   logical viewport (the camera, the UI layout and the goldens are all
//!   defined there), and the physical viewport is 960x544: geometry is
//!   transformed once and rasterized at 4x the pixels, with the atlases
//!   sampled `GL_NEAREST` so the art reads as the same picture rather than a
//!   blurred one.
//! - **GXM has no palette sampler vitaGL exposes**, so the CLUT the GE
//!   samples in hardware is resolved on the CPU into RGBA textures and
//!   cached ([`atlas`]). The day tint multiplies into the palette there, the
//!   same `modulate_rgb` the other two backends apply.

mod atlas;
pub mod gl;

use pocketvoxel_core::draw::{DrawList, Item, MeshDraw, SKY_BANDS, resolve_pal};
use pocketvoxel_core::math::{Mat4, Vec3, sqrtf, vec3};
use pocketvoxel_core::pak::{Pak, PakVert};
use pocketvoxel_core::spec::{COLOR_PAL_NONE, TILE_PX, VERTEX_STRIDE, VIEW_H, VIEW_W};

pub use atlas::AtlasCache;
use gl::{GLuint, GLvoid_ptr};

/// The physical raster the Vita presents. The logical viewport stays
/// [`VIEW_W`]x[`VIEW_H`] — this is a raster density, not a layout.
pub const PHYSICAL_W: i32 = VIEW_W * 2;
pub const PHYSICAL_H: i32 = VIEW_H * 2;

/// Alpha-test cutoff. The GE spells it `AlphaFunc::Greater, 0x7f`; GL takes a
/// normalized reference, and 0x7f/0xff is the same texel boundary.
const ALPHA_REF: f32 = 127.0 / 255.0;

/// The divisor the cooked fixed-point UVs carry (voxel-spec §VXPK v8): the
/// GE's `TEXTURE_16BIT` coords divide by 32768 in hardware, and GL's
/// `GL_SHORT` texture coordinates do not, so the same number rides in the
/// texture matrix here. Every textured pass in this backend feeds i16 UVs in
/// exactly that fixed point, so the matrix is set once per frame.
const UV_SCALE: f32 = 1.0 / 32768.0;

// ---------------------------------------------------------------------------
// Vertex formats
// ---------------------------------------------------------------------------

/// The world vertex is the pak's own [`PakVert`], drawn from the VBO in
/// place. The attribute offsets below describe that 16-byte layout; the
/// const-asserts make a core-side change a compile error rather than a
/// plausible-looking garble.
const _: () = assert!(core::mem::size_of::<PakVert>() == VERTEX_STRIDE);
const _: () = assert!(VERTEX_STRIDE == 16, "16B world vertex — repr(C), NOT packed");
const WORLD_UV_OFF: usize = 0;
const WORLD_COLOR_OFF: usize = 4;
const WORLD_POS_OFF: usize = 8;

/// CPU-built untextured vertex: sky bands, shadow decals, the ghost.
#[repr(C)]
#[derive(Clone, Copy)]
struct FlatVert {
    abgr: u32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(core::mem::size_of::<FlatVert>() == 16);

/// CPU-built textured vertex: billboard cards and the GB UI layer. UVs are
/// the same 1/32768 fixed point the pak's are, so one texture matrix serves
/// every textured pass.
#[repr(C)]
#[derive(Clone, Copy)]
struct TexVert {
    u: i16,
    v: i16,
    abgr: u32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(core::mem::size_of::<TexVert>() == 20);

/// Quantize a 0..1 texture coordinate into the cooked fixed point. Clamped
/// to 32767 for the same reason the cooker clamps (voxelmon/cook/pak.ts):
/// 32768 would read back as a negative i16.
#[inline]
fn q16(f: f32) -> i16 {
    ((f.clamp(0.0, 1.0) * 32768.0) as i32).min(32767) as i16
}

/// Screen-space projection for the 2D passes: the logical 480x272 box mapped
/// to NDC with y down, which is the coordinate system every screen-space
/// item in the draw list is already expressed in. The physical viewport does
/// the 2x — no term here knows about it.
fn logical_ortho() -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[0] = 2.0 / VIEW_W as f32;
    m.m[5] = -2.0 / VIEW_H as f32;
    m.m[10] = 0.0;
    m.m[12] = -1.0;
    m.m[13] = 1.0;
    m
}

/// The seam translation for a pak mesh. Unlike the GE backend there is no
/// x32768 counter-scale: vitaGL maps `GL_SHORT` positions to GXM's
/// non-normalized `S16` format, so the cooked i16 world coordinates arrive
/// as the integers they are.
fn world_model(off_x: i32, off_y: i32) -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[12] = off_x as f32;
    m.m[14] = off_y as f32;
    m
}

/// The mod's camera-ward pull: displace toward the eye along the vertex's own
/// ray — the same projection-invariant depth bias `raster.rs` applies in
/// `to_clip` (screen position unchanged, only depth moves). Same operation
/// ORDER as `Vec3::normalize().scale(pull)` so the result matches the sim's.
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

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Which client arrays and buffer bindings the pipe currently holds. Setting
/// GL state is cheap but not free, and the frame alternates between the VBO
/// world pass and client-array screen passes dozens of times; this collapses
/// the redundant transitions without anyone having to remember to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pipe {
    None,
    /// Indexed pak geometry out of the two buffer objects.
    World,
    /// Client-array `FlatVert`, no texture.
    Flat,
    /// Client-array `TexVert`.
    Tex,
}

pub struct Renderer {
    /// The pak's shared vertex pool.
    vert_vbo: GLuint,
    /// The pak's shared index pool.
    index_vbo: GLuint,
    atlas: AtlasCache,
    /// Last bound atlas key, to skip redundant `glBindTexture`.
    bound: Option<atlas::Key>,
    pipe: Pipe,
    palette: i32,
    /// Reused staging for the pulled-mesh restage and the CPU-built quads —
    /// allocated once, cleared per use, never reallocated in a steady frame.
    pull_verts: Vec<PakVert>,
    quad: Vec<FlatVert>,
    tex_quad: Vec<TexVert>,
    ui: Vec<TexVert>,
    /// Vertices restaged through the geometric-pull path this frame, and the
    /// draws issued — the frame loop's telemetry reads both.
    pub pull_verts_count: u32,
    pub draw_count: u32,
}

impl Renderer {
    /// Upload the pak's vertex and index pools into GL buffer objects.
    ///
    /// This is the whole reason the world pass costs no per-vertex CPU: with
    /// every attribute sourced from a VBO, vitaGL's fixed-function draw skips
    /// the index scan and the staging copy it would otherwise do for
    /// client-side arrays, and `sceGxmDraw` reads the cooked bytes directly.
    ///
    /// Bytes the pak's pools need in vitaGL's RAM pool. Checked before the
    /// upload rather than after, because `glBufferData` reports an exhausted
    /// pool by leaving the buffer object empty — which draws as a world that
    /// is simply not there, the hardest failure of all to read.
    pub fn pool_bytes_needed(pak: &Pak) -> usize {
        core::mem::size_of_val(pak.verts) + core::mem::size_of_val(pak.indices)
    }

    /// # Safety
    /// A GL context must be current on the calling thread.
    pub unsafe fn new(pak: &Pak) -> Result<Self, &'static str> {
        let needed = Self::pool_bytes_needed(pak);
        // A little headroom: vitaGL rounds allocations and the atlas cache
        // draws from the same pool on the first frame.
        if gl::vglMemFree(gl::VGL_MEM_RAM) < needed + 4 * 1024 * 1024 {
            return Err("vitaGL RAM pool too small for the pak's vertex and index pools");
        }
        let mut vert_vbo: GLuint = 0;
        let mut index_vbo: GLuint = 0;
        gl::glGenBuffers(1, &mut vert_vbo);
        gl::glGenBuffers(1, &mut index_vbo);
        gl::glBindBuffer(gl::GL_ARRAY_BUFFER, vert_vbo);
        gl::glBufferData(
            gl::GL_ARRAY_BUFFER,
            core::mem::size_of_val(pak.verts) as isize,
            pak.verts.as_ptr().cast(),
            gl::GL_STATIC_DRAW,
        );
        gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, index_vbo);
        gl::glBufferData(
            gl::GL_ELEMENT_ARRAY_BUFFER,
            core::mem::size_of_val(pak.indices) as isize,
            pak.indices.as_ptr().cast(),
            gl::GL_STATIC_DRAW,
        );
        gl::glBindBuffer(gl::GL_ARRAY_BUFFER, 0);
        gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, 0);
        Ok(Self {
            vert_vbo,
            index_vbo,
            atlas: AtlasCache::new(),
            bound: None,
            pipe: Pipe::None,
            palette: -1,
            pull_verts: Vec::new(),
            quad: Vec::new(),
            tex_quad: Vec::new(),
            ui: Vec::new(),
            pull_verts_count: 0,
            draw_count: 0,
        })
    }

    /// Paint one solid frame and present it.
    ///
    /// `glClear` runs vitaGL's PRECOMPILED clear shader, so this works even
    /// when the runtime shader compiler is absent and no geometry can draw at
    /// all. That is what lets the shell's boot stages report themselves as
    /// colours on a console with no log and no memory-card access.
    ///
    /// # Safety
    /// A GL context must be current, with no scene mid-draw.
    pub unsafe fn paint(r: f32, g: f32, b: f32) {
        gl::glClearColor(r, g, b, 1.0);
        gl::glClearDepthf(1.0);
        gl::glDepthMask(1);
        gl::glClear(gl::GL_COLOR_BUFFER_BIT | gl::GL_DEPTH_BUFFER_BIT);
        gl::vglSwapBuffers(0);
    }

    /// Whether vitaGL brought its runtime shader compiler up. False means
    /// `libshacccg.suprx` is not installed: `glClear` still works, so the
    /// screen is paintable, but no geometry can ever draw.
    pub fn shader_compiler_online() -> bool {
        unsafe { gl::is_shark_online != 0 }
    }

    /// Bytes of atlas texture currently resident (boot log / telemetry).
    pub fn atlas_bytes(&self) -> usize {
        self.atlas.resident_bytes()
    }

    /// Record one DrawList. Draw order is the list's order — the core
    /// already ordered it (docs/VOXEL.md §3).
    ///
    /// # Safety
    /// A GL context must be current, and the pak must be the one whose pools
    /// were uploaded by [`Renderer::new`].
    pub unsafe fn render(&mut self, list: &DrawList, pak: &Pak) {
        self.bound = None;
        self.pipe = Pipe::None;
        self.palette = list.palette;
        self.pull_verts_count = 0;
        self.draw_count = 0;
        self.atlas.tick();
        self.atlas.retint(list.tint);

        gl::glViewport(0, 0, PHYSICAL_W, PHYSICAL_H);
        // Base state for the frame. GL's own depth sense IS the
        // rasterizer's: near is 0, far is 1, and less wins.
        gl::glDepthFunc(gl::GL_LEQUAL);
        gl::glDepthMask(1);
        // Double-sided, like the raster: the cooked streams do not share one
        // winding (column tops, gables, water and grass slabs are each
        // emitted in their own order), so no single front face is right for
        // all of them. Dropping occluded faces belongs at COOK time, where a
        // face's neighbours are known.
        gl::glDisable(gl::GL_CULL_FACE);
        gl::glShadeModel(gl::GL_SMOOTH); // per-vertex AO gouraud
        gl::glTexEnvi(gl::GL_TEXTURE_ENV, gl::GL_TEXTURE_ENV_MODE, gl::GL_MODULATE as i32);
        gl::glBlendFunc(gl::GL_SRC_ALPHA, gl::GL_ONE_MINUS_SRC_ALPHA);
        gl::glAlphaFunc(gl::GL_GREATER, ALPHA_REF);
        gl::glDisable(gl::GL_BLEND);
        gl::glDisable(gl::GL_DEPTH_TEST);
        gl::glDisable(gl::GL_ALPHA_TEST);
        gl::glDisable(gl::GL_TEXTURE_2D);
        // One fixed point for every textured pass in the frame.
        gl::glMatrixMode(gl::GL_TEXTURE);
        gl::glLoadMatrixf(uv_matrix().m.as_ptr());

        for item in &list.items {
            match item {
                Item::SkyBands {
                    colors,
                    horizon_row,
                } => self.sky(colors, *horizon_row),
                Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                    self.mesh(pak, mesh, list.cam.eye, &list.cam.vp);
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.flat_quad(&list.cam.vp, *corners, *abgr, list.cam.eye, 0.0, false);
                }
                Item::Ghost { verts, pull, abgr } => {
                    self.flat_quad(&list.cam.vp, *verts, *abgr, list.cam.eye, *pull, true);
                }
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => self.card(pak, &list.cam.vp, *verts, *page, *uv, *mirror, *pull, list.cam.eye),
                Item::UiQuad { .. } => {
                    // Batched below: UiQuads are contiguous at the tail of
                    // the list (draw order), and the whole GB layer is one
                    // upload and one draw instead of ~100 of each.
                }
            }
        }

        self.ui_batch(list, pak);
        self.set_pipe(Pipe::None);
    }

    // -- pipeline state ------------------------------------------------------

    /// Point the fixed-function attribute arrays at one of the three vertex
    /// sources. The client-array pipes bind buffer 0 so vitaGL reads the
    /// caller's memory; the world pipe leaves the buffers bound and only the
    /// per-mesh offsets move.
    unsafe fn set_pipe(&mut self, pipe: Pipe) {
        if self.pipe == pipe {
            return;
        }
        self.pipe = pipe;
        match pipe {
            Pipe::None => {
                gl::glDisableClientState(gl::GL_VERTEX_ARRAY);
                gl::glDisableClientState(gl::GL_COLOR_ARRAY);
                gl::glDisableClientState(gl::GL_TEXTURE_COORD_ARRAY);
                gl::glBindBuffer(gl::GL_ARRAY_BUFFER, 0);
                gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, 0);
            }
            Pipe::World => {
                gl::glBindBuffer(gl::GL_ARRAY_BUFFER, self.vert_vbo);
                gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, self.index_vbo);
                gl::glEnableClientState(gl::GL_VERTEX_ARRAY);
                gl::glEnableClientState(gl::GL_COLOR_ARRAY);
                gl::glEnableClientState(gl::GL_TEXTURE_COORD_ARRAY);
            }
            Pipe::Flat => {
                gl::glBindBuffer(gl::GL_ARRAY_BUFFER, 0);
                gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, 0);
                gl::glEnableClientState(gl::GL_VERTEX_ARRAY);
                gl::glEnableClientState(gl::GL_COLOR_ARRAY);
                gl::glDisableClientState(gl::GL_TEXTURE_COORD_ARRAY);
            }
            Pipe::Tex => {
                gl::glBindBuffer(gl::GL_ARRAY_BUFFER, 0);
                gl::glBindBuffer(gl::GL_ELEMENT_ARRAY_BUFFER, 0);
                gl::glEnableClientState(gl::GL_VERTEX_ARRAY);
                gl::glEnableClientState(gl::GL_COLOR_ARRAY);
                gl::glEnableClientState(gl::GL_TEXTURE_COORD_ARRAY);
            }
        }
    }

    /// Point the world pipe's attributes at one mesh's vertex range. The pak
    /// stores each mesh's indices relative to its own `vert_base` (GE batch
    /// style), so folding the base into the attribute offsets is what makes
    /// those indices correct here without a base-vertex draw.
    unsafe fn world_attribs(&self, vert_base: u32) {
        let base = vert_base as usize * VERTEX_STRIDE;
        let at = |offset: usize| (base + offset) as GLvoid_ptr;
        gl::glTexCoordPointer(2, gl::GL_SHORT, VERTEX_STRIDE as i32, at(WORLD_UV_OFF));
        gl::glColorPointer(4, gl::GL_UNSIGNED_BYTE, VERTEX_STRIDE as i32, at(WORLD_COLOR_OFF));
        gl::glVertexPointer(3, gl::GL_SHORT, VERTEX_STRIDE as i32, at(WORLD_POS_OFF));
    }

    unsafe fn flat_attribs(&self, verts: &[FlatVert]) {
        let base = verts.as_ptr() as usize;
        let stride = core::mem::size_of::<FlatVert>() as i32;
        gl::glColorPointer(4, gl::GL_UNSIGNED_BYTE, stride, base as GLvoid_ptr);
        gl::glVertexPointer(3, gl::GL_FLOAT, stride, (base + 4) as GLvoid_ptr);
    }

    unsafe fn tex_attribs(&self, verts: &[TexVert]) {
        let base = verts.as_ptr() as usize;
        let stride = core::mem::size_of::<TexVert>() as i32;
        gl::glTexCoordPointer(2, gl::GL_SHORT, stride, base as GLvoid_ptr);
        gl::glColorPointer(4, gl::GL_UNSIGNED_BYTE, stride, (base + 4) as GLvoid_ptr);
        gl::glVertexPointer(3, gl::GL_FLOAT, stride, (base + 8) as GLvoid_ptr);
    }

    /// Load one matrix pair: the whole VP into PROJECTION (View is identity —
    /// the core hands both backends one clip matrix) and the per-draw model
    /// into MODELVIEW.
    unsafe fn matrices(&self, vp: &Mat4, model: &Mat4) {
        gl::glMatrixMode(gl::GL_PROJECTION);
        gl::glLoadMatrixf(vp.m.as_ptr());
        gl::glMatrixMode(gl::GL_MODELVIEW);
        gl::glLoadMatrixf(model.m.as_ptr());
    }

    // -- textures ------------------------------------------------------------

    /// Bind one atlas page frame through the palette the core resolved.
    ///
    /// `pal` is the draw's own VCOL palette (`COLOR_PAL_NONE` for anything
    /// that has none); `resolve_pal` owns the rest of the precedence ladder,
    /// and it is shared with the software rasterizer and the GE backend so
    /// all three sample the same CLUT for the same draw. Returns false when
    /// the page or palette is missing — the draw is then skipped rather than
    /// rendered against whatever was bound before.
    unsafe fn bind(&mut self, pak: &Pak, page_idx: u16, frame: u16, tinted: bool, pal: u16) -> bool {
        let Some(page) = pak.atlases.get(page_idx as usize) else {
            return false;
        };
        let key = atlas::Key {
            page: page_idx,
            frame: frame % page.frames.max(1),
            pal: resolve_pal(pak, page_idx, page.kind, pal, self.palette) as u16,
            tinted,
        };
        if self.bound == Some(key) {
            return true;
        }
        let Some(texture) = self.atlas.texture(pak, key) else {
            return false;
        };
        gl::glBindTexture(gl::GL_TEXTURE_2D, texture);
        self.bound = Some(key);
        true
    }

    // -- item passes ---------------------------------------------------------

    /// Sky pass: owns the frame clear (color = the below-horizon band, depth
    /// = the far plane), then the gradient bands over rows
    /// `[0, horizon_row)` as screen-space quads.
    unsafe fn sky(&mut self, colors: &[u32; SKY_BANDS], horizon_row: i32) {
        let backdrop = colors[SKY_BANDS - 1];
        gl::glClearColor(
            (backdrop & 0xff) as f32 / 255.0,
            ((backdrop >> 8) & 0xff) as f32 / 255.0,
            ((backdrop >> 16) & 0xff) as f32 / 255.0,
            1.0,
        );
        gl::glClearDepthf(1.0);
        gl::glDepthMask(1); // a masked depth buffer would refuse the clear
        gl::glClear(gl::GL_COLOR_BUFFER_BIT | gl::GL_DEPTH_BUFFER_BIT);

        let hr = horizon_row.clamp(0, VIEW_H);
        if hr == 0 {
            return;
        }
        gl::glDisable(gl::GL_DEPTH_TEST);
        gl::glDisable(gl::GL_TEXTURE_2D);
        gl::glDisable(gl::GL_BLEND);
        gl::glDisable(gl::GL_ALPHA_TEST);
        self.matrices(&logical_ortho(), &Mat4::IDENTITY);

        self.quad.clear();
        for (i, &c) in colors.iter().enumerate() {
            let y0 = (hr * i as i32 / SKY_BANDS as i32) as f32;
            let y1 = (hr * (i as i32 + 1) / SKY_BANDS as i32) as f32;
            if y1 <= y0 {
                continue;
            }
            let (x0, x1) = (0.0, VIEW_W as f32);
            let corner = |x: f32, y: f32| FlatVert { abgr: c, x, y, z: 0.0 };
            self.quad.extend_from_slice(&[
                corner(x0, y0),
                corner(x1, y0),
                corner(x1, y1),
                corner(x0, y0),
                corner(x1, y1),
                corner(x0, y1),
            ]);
        }
        if self.quad.is_empty() {
            return;
        }
        self.set_pipe(Pipe::Flat);
        self.flat_attribs(&self.quad);
        gl::glDrawArrays(gl::GL_TRIANGLES, 0, self.quad.len() as i32);
        self.draw_count += 1;
    }

    /// One chunk/stamp mesh. `pull == 0` draws the pak's i16 verts in place
    /// straight out of the VBO; `pull != 0` (grass and flower at the
    /// geometric-pull rungs) applies the eye-ray displacement CPU-side,
    /// exactly as `raster.rs to_clip` does per vertex; `pull_bias != 0` (the
    /// `pullDepthBias` rung) draws in place through the same biased VP the
    /// rasterizer uses — the depth trick with zero per-vertex work.
    unsafe fn mesh(&mut self, pak: &Pak, m: &MeshDraw, eye: Vec3, vp: &Mat4) {
        if m.index_count == 0 {
            return;
        }
        if !self.bind(pak, m.page, m.frame, true, m.pal) {
            return;
        }
        gl::glEnable(gl::GL_DEPTH_TEST);
        gl::glDepthMask(1);
        gl::glEnable(gl::GL_TEXTURE_2D);
        // Every textured pass alpha-tests at the raster's texel cutoff.
        gl::glEnable(gl::GL_ALPHA_TEST);
        gl::glDisable(gl::GL_BLEND);

        if m.pull == 0.0 {
            let projection = if m.pull_bias != 0.0 {
                pocketvoxel_core::draw::biased_vp(vp, m.pull_bias)
            } else {
                *vp
            };
            self.set_pipe(Pipe::World);
            self.matrices(&projection, &world_model(m.off_x, m.off_y));
            self.world_attribs(m.vert_base);
            gl::glDrawElements(
                gl::GL_TRIANGLES,
                m.index_count as i32,
                gl::GL_UNSIGNED_SHORT,
                (m.index_base as usize * 2) as GLvoid_ptr,
            );
        } else {
            // Displaced vertices restage into the pak's own vertex format
            // with the seam offsets baked in, so the pulled draw stays on
            // the same i16 attribute layout as the in-place one and the
            // model matrix is identity.
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
            // Same client-array state as a card (three arrays, no buffer
            // objects) — only the stride and the component types differ, and
            // every draw re-points its own attributes anyway.
            self.set_pipe(Pipe::Tex);
            let base = self.pull_verts.as_ptr() as usize;
            let stride = VERTEX_STRIDE as i32;
            gl::glTexCoordPointer(2, gl::GL_SHORT, stride, (base + WORLD_UV_OFF) as GLvoid_ptr);
            gl::glColorPointer(
                4,
                gl::GL_UNSIGNED_BYTE,
                stride,
                (base + WORLD_COLOR_OFF) as GLvoid_ptr,
            );
            gl::glVertexPointer(3, gl::GL_SHORT, stride, (base + WORLD_POS_OFF) as GLvoid_ptr);
            self.matrices(vp, &Mat4::IDENTITY);
            let indices =
                &pak.indices[m.index_base as usize..m.index_base as usize + m.index_count as usize];
            gl::glDrawElements(
                gl::GL_TRIANGLES,
                m.index_count as i32,
                gl::GL_UNSIGNED_SHORT,
                indices.as_ptr() as GLvoid_ptr,
            );
        }
        self.draw_count += 1;
    }

    /// Flat-color blended quad: shadow decals (normal depth test, no write)
    /// and the player ghost (`ghost = true`: inverted test — `GL_GREATER`
    /// draws only where occluded — no write, pulled).
    #[allow(clippy::too_many_arguments)]
    unsafe fn flat_quad(
        &mut self,
        vp: &Mat4,
        corners: [[f32; 3]; 4],
        abgr: u32,
        eye: Vec3,
        pull: f32,
        ghost: bool,
    ) {
        gl::glEnable(gl::GL_DEPTH_TEST);
        gl::glDepthMask(0); // no depth writes
        if ghost {
            gl::glDepthFunc(gl::GL_GREATER);
        }
        gl::glEnable(gl::GL_BLEND);
        gl::glDisable(gl::GL_TEXTURE_2D);
        gl::glDisable(gl::GL_ALPHA_TEST);

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
        self.set_pipe(Pipe::Flat);
        self.flat_attribs(&self.quad);
        self.matrices(vp, &Mat4::IDENTITY);
        gl::glDrawArrays(gl::GL_TRIANGLES, 0, 6);
        self.draw_count += 1;

        gl::glDepthMask(1);
        gl::glDisable(gl::GL_BLEND);
        if ghost {
            gl::glDepthFunc(gl::GL_LEQUAL);
        }
    }

    /// A billboard card: textured, alpha-tested (sprite cutouts),
    /// depth-written, pulled along each vertex's eye ray.
    #[allow(clippy::too_many_arguments)]
    unsafe fn card(
        &mut self,
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
        if !self.bind(pak, page, 0, true, COLOR_PAL_NONE) {
            return;
        }
        gl::glEnable(gl::GL_DEPTH_TEST);
        gl::glDepthMask(1);
        gl::glEnable(gl::GL_TEXTURE_2D);
        gl::glEnable(gl::GL_ALPHA_TEST);
        gl::glDisable(gl::GL_BLEND);

        let (u0, u1) = if mirror { (uv[2], uv[0]) } else { (uv[0], uv[2]) };
        let (v0, v1) = (uv[1], uv[3]);
        // Verts arrive bl, br, tr, tl; v0 is the texture top (raster.rs).
        let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
        self.tex_quad.clear();
        for ci in [0usize, 1, 2, 0, 2, 3] {
            let p = pulled(eye, vec3(verts[ci][0], verts[ci][1], verts[ci][2]), pull);
            self.tex_quad.push(TexVert {
                u: q16(uvs[ci].0),
                v: q16(uvs[ci].1),
                abgr: 0xffff_ffff,
                x: p.x,
                y: p.y,
                z: p.z,
            });
        }
        self.set_pipe(Pipe::Tex);
        self.tex_attribs(&self.tex_quad);
        self.matrices(vp, &Mat4::IDENTITY);
        gl::glDrawArrays(gl::GL_TRIANGLES, 0, 6);
        self.draw_count += 1;
    }

    /// The whole GB UI layer in one pass: screen space, no depth, UNTINTED
    /// palette (raster.rs composites the UI layer verbatim), one upload and
    /// one draw for every tile.
    unsafe fn ui_batch(&mut self, list: &DrawList, pak: &Pak) {
        let mut page_idx = None;
        for item in &list.items {
            if let Item::UiQuad { page, .. } = item {
                page_idx.get_or_insert(*page);
            }
        }
        let Some(page) = page_idx else {
            return;
        };
        let Some(p) = pak.atlases.get(page as usize) else {
            return;
        };
        if !self.bind(pak, page, 0, false, COLOR_PAL_NONE) {
            return;
        }
        gl::glDisable(gl::GL_DEPTH_TEST);
        gl::glEnable(gl::GL_TEXTURE_2D);
        gl::glEnable(gl::GL_ALPHA_TEST);
        gl::glDisable(gl::GL_BLEND);

        let cols = ((p.w as i32 / TILE_PX) as u16).max(1);
        let (pw, ph) = (p.w as f32, p.h as f32);
        self.ui.clear();
        for item in &list.items {
            let Item::UiQuad {
                x,
                y,
                w,
                h,
                tile,
                ..
            } = item
            else {
                continue;
            };
            let tx0 = (tile % cols) as f32 * TILE_PX as f32;
            let ty0 = (tile / cols) as f32 * TILE_PX as f32;
            let (u0, v0) = (q16(tx0 / pw), q16(ty0 / ph));
            let (u1, v1) = (
                q16((tx0 + TILE_PX as f32) / pw),
                q16((ty0 + TILE_PX as f32) / ph),
            );
            // The GB layer keeps its fractional logical position here rather
            // than rounding to a device pixel as the GE backend must: at 2x
            // the raster a half-logical-pixel edge is a real device pixel,
            // so rounding would cost detail this machine can show.
            let corner = |px: f32, py: f32, u: i16, v: i16| TexVert {
                u,
                v,
                abgr: 0xffff_ffff,
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
        }
        if self.ui.is_empty() {
            return;
        }
        self.set_pipe(Pipe::Tex);
        self.tex_attribs(&self.ui);
        self.matrices(&logical_ortho(), &Mat4::IDENTITY);
        gl::glDrawArrays(gl::GL_TRIANGLES, 0, self.ui.len() as i32);
        self.draw_count += 1;
    }
}

/// The texture matrix every textured pass runs through: the 1/32768 the GE
/// applies in hardware to `TEXTURE_16BIT` coordinates.
fn uv_matrix() -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[0] = UV_SCALE;
    m.m[5] = UV_SCALE;
    m
}
