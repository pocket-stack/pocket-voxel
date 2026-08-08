#![cfg_attr(not(test), no_std)]

//! pocketvoxel-pica — the PICA200 (Nintendo 3DS) backend for the Pocket Voxel
//! diorama, and the sibling of [`pocketvoxel-gu`], the PSP GE backend.
//!
//! It consumes the core's [`DrawList`] exactly as that crate and the software
//! rasterizer (`pocketvoxel-sim/src/raster.rs`) do: **the same list order, the
//! same `resolve_pal` call on every textured draw, the same camera-ward pull,
//! the same alpha-test cutoff, the same three depth behaviours, and the same
//! sky pass owning the frame clear.** What differs is only what the hardware
//! forces.
//!
//! # Why this crate records instead of draws
//!
//! citro3d is a C library that is largely `static inline`, so the split here is
//! the opposite of the PSP's: **Rust resolves the frame, C issues the citro3d
//! calls.** `Renderer::record` walks the DrawList once and produces three flat,
//! `#[repr(C)]` arrays — [`Cmd`]s, matrices, texture keys — plus staged vertex
//! and index bytes in the host's linear arena. Nothing in this crate touches
//! the GPU, allocates linear memory, or owns the frame lifecycle; the C side
//! walks the commands and presents.
//!
//! # The three things the PICA200 forces
//!
//! 1. **No paletted texture format.** The GE re-writes a 256-entry CLUT to
//!    apply the day tint; here every `(page, frame, resolved VPAL, tinted)`
//!    pair becomes its own RGBA5551 image. [`tex`] owns that expansion, the
//!    PSP-to-PICA retiling and the POT envelope it lands in.
//! 2. **s16 attributes convert as RAW INTEGERS.** There is no implicit ÷32768
//!    like the GE's `TRANSFORM_3D`, so the model matrix drops the GE backend's
//!    ×32768 counter-scale and the pak's fixed-point UVs are scaled by the
//!    per-draw [`Cmd::uv_scale`] instead of `sceGuTexScale`.
//! 3. **Vertex data must live in linear memory.** `BufInfo_Add` rejects any
//!    pointer below physical `0x18000000`, so the PSP's zero-copy "point the
//!    GE at the pak" is impossible and every visible vertex is staged into the
//!    host's `linearAlloc` arena each frame ([`pool`]).
//!
//! # Viewport
//!
//! The pak is hard-rejected unless META says 480x272 (`pak.rs`), and `VIEW_W`/
//! `VIEW_H` also fix the camera aspect, the UI scale and the sky horizon row.
//! So the diorama is not re-cooked for the 3DS: it renders through the
//! existing 480x272 camera into the **400x226 letterboxed viewport**
//! ([`VIEWPORT_X`]..[`VIEWPORT_H`]) on the 400x240 top screen, 7 px of bar top
//! and bottom. Fitting by height instead would crop 24 px horizontally, and
//! the GX blit only offers 2x and 2x2 downscale, so the fit belongs in the
//! viewport rectangle rather than the transfer.
//!
//! # A frame
//!
//! ```text
//! // once, at boot
//! renderer.adopt_arena(linearAlloc(ARENA_BYTES), ARENA_BYTES, 2)
//!
//! // per frame, host side
//! scene.tick()
//! renderer.record(&draw::build(&scene, &pak), &pak)
//! // C: C3D_FrameBegin -> walk renderer.commands() -> C3D_FrameEnd
//! ```
//!
//! The arena rewinds inside `record`, one bank per frame. With two banks and a
//! `C3D_FrameBegin(C3D_FRAME_SYNCDRAW)` host loop the bank being rewound is
//! two frames old, so the GPU is provably done with it.
//!
//! [`pocketvoxel-gu`]: https://docs.rs/pocketvoxel-gu

extern crate alloc;

pub mod cmd;
pub mod pool;
pub mod tex;

pub mod cabi;

use alloc::vec::Vec;

use pocketvoxel_core::draw::{DrawList, Item, MeshDraw, SKY_BANDS, biased_vp};
use pocketvoxel_core::math::{Mat4, Vec3, vec3};
use pocketvoxel_core::pak::{Pak, PakVert};
use pocketvoxel_core::spec::{COLOR_PAL_NONE, TILE_PX, VIEW_H, VIEW_W};

pub use cabi::{global, global_pak};
pub use cmd::{Cmd, FlatVert, WorldVert, depth, flag, kind, vfmt};
pub use pool::FrameArena;
pub use tex::{TexCache, TexKey, TexPlan};

// ---------------------------------------------------------------------------
// Screen geometry
// ---------------------------------------------------------------------------

/// The 3DS top screen, in landscape.
pub const SCREEN_W: i32 = 400;
pub const SCREEN_H: i32 = 240;

/// The letterboxed viewport the 480x272 diorama renders into: the widest
/// rectangle on a 400x240 screen that keeps the cooked aspect, `400 * 272 /
/// 480 = 226` rows, centred.
pub const VIEWPORT_W: i32 = SCREEN_W;
pub const VIEWPORT_H: i32 = SCREEN_W * VIEW_H / VIEW_W;
pub const VIEWPORT_X: i32 = 0;
pub const VIEWPORT_Y: i32 = (SCREEN_H - VIEWPORT_H) / 2;

const _: () = assert!(VIEWPORT_H == 226);
const _: () = assert!(VIEWPORT_Y == 7);
const _: () = assert!(VIEWPORT_Y + VIEWPORT_H <= SCREEN_H);
const _: () = assert!(VIEWPORT_X + VIEWPORT_W <= SCREEN_W);

/// A sane default arena: two banks of 6 MiB.
///
/// The worst sampled story frame at the shipped `psp` rung is ~70k triangles
/// and the pre-ground-bake worst was ~110k (docs/VOXEL.md §4a). At 4 vertices
/// and 6 indices per quad, 140k triangles stage as ~4.5 MiB of vertices plus
/// ~0.8 MiB of indices, so one 6 MiB bank clears the worst frame this content
/// can produce with room over it. 12 MiB total sits inside the Old 3DS's
/// 32 MiB linear heap next to the texture set. [`Renderer::stats`] reports the
/// high-water mark, so the number stays a measurement.
pub const DEFAULT_ARENA_BYTES: usize = 12 * 1024 * 1024;
pub const DEFAULT_ARENA_BANKS: usize = 2;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/// What the last recorded frame cost, and what it could not fit.
///
/// `dropped_*` are the graceful-degradation counters: this backend never
/// panics on a handheld, so an arena too small for the content shows up as a
/// hole in the picture and a number here.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Commands in the frame, clear included.
    pub commands: u32,
    /// Draw commands only.
    pub draws: u32,
    /// Vertices staged into the arena.
    pub verts: u32,
    /// Indices staged into the arena.
    pub indices: u32,
    /// Distinct textures the frame binds — the live expansion set.
    pub textures: u32,
    /// Arena bytes used by this frame's bank.
    pub arena_used: u32,
    /// The largest any single bank has ever reached.
    pub arena_high_water: u32,
    /// Draws dropped because the arena could not hold them.
    pub dropped_arena: u32,
    /// Draws dropped because the pak has no such page or palette.
    pub dropped_texture: u32,
    /// Vertices restaged through the geometric pull path.
    pub pull_verts: u32,
    /// UVs that hit the i16 ceiling. The cooker insets UVs, so this is
    /// expected to be 0; it is counted rather than assumed.
    pub uv_clamped: u32,
}

const _: () = assert!(core::mem::size_of::<Stats>() == 44);

// ---------------------------------------------------------------------------
// The pull
// ---------------------------------------------------------------------------

/// The mod's camera-ward pull: displace toward the eye along the vertex's own
/// ray, scaling by `1/len` and THEN by `pull`.
///
/// This is `raster.rs`'s `to_clip_opts` displacement expression verbatim,
/// including [`Vec3::normalize`]'s own `1e-12` guard, called rather than
/// re-derived — the software rasterizer is the visible contract and the
/// cheapest way to match it bit for bit is to run its arithmetic.
#[inline]
pub fn pulled(eye: Vec3, pos: Vec3, pull: f32) -> Vec3 {
    if pull == 0.0 {
        return pos;
    }
    pos.add(eye.sub(pos).normalize().scale(pull))
}

/// The GB UI layer's screen positions round to the nearest device pixel, the
/// same `(v + 0.5) as i32` the GE backend applies.
#[inline]
fn round_i16(v: f32) -> i16 {
    (v + 0.5) as i32 as i16
}

/// A pak UV (`u16` fixed point) as the i16 the PICA can fetch. Returns the
/// clamped value and whether it clamped.
#[inline]
fn clamp_uv(u: u16) -> (i16, bool) {
    if u > i16::MAX as u16 {
        (i16::MAX, true)
    } else {
        (u as i16, false)
    }
}

/// A normalized card UV as the pak's own fixed point, the GE backend's `q16`.
#[inline]
fn q16(f: f32) -> i16 {
    ((f.clamp(0.0, 1.0) * 32768.0) as i32).min(32767) as i16
}

fn as_bytes<T: Copy>(data: &[T]) -> &[u8] {
    // Safety: every caller passes a plain-old-data slice with no padding that
    // matters (the bytes are handed to the GPU verbatim).
    unsafe { core::slice::from_raw_parts(data.as_ptr() as *const u8, core::mem::size_of_val(data)) }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Records one [`DrawList`] into flat arrays the C side executes.
pub struct Renderer {
    arena: FrameArena,
    cmds: Vec<Cmd>,
    mtx: Vec<[f32; 16]>,
    keys: Vec<TexKey>,
    cache: TexCache,
    stats: Stats,
    /// This frame's day tint and SGB palette selection, from the DrawList.
    tint: u32,
    palette: i32,
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            arena: FrameArena::new(),
            cmds: Vec::new(),
            mtx: Vec::new(),
            keys: Vec::new(),
            cache: TexCache::new(),
            stats: Stats::default(),
            tint: 0xffff_ffff,
            palette: -1,
        }
    }

    /// Adopt the host's `linearAlloc` region. See [`pool::FrameArena::adopt`];
    /// `DEFAULT_ARENA_BYTES` / `DEFAULT_ARENA_BANKS` are the sizing this
    /// backend was budgeted against.
    ///
    /// # Safety
    /// The region must be valid, writable linear memory that outlives every
    /// frame the GPU may still be reading.
    pub unsafe fn adopt_arena(&mut self, base: *mut u8, len: usize, banks: usize) {
        self.arena.adopt(base, len, banks);
    }

    pub fn commands(&self) -> &[Cmd] {
        &self.cmds
    }
    /// The frame's matrices, each already in `C3D_Mtx.m[]` order.
    pub fn matrices(&self) -> &[[f32; 16]] {
        &self.mtx
    }
    /// The distinct textures this frame binds, deduplicated — the live
    /// expansion set, which is what the "no paletted textures" tax multiplies.
    pub fn keys(&self) -> &[TexKey] {
        &self.keys
    }
    pub fn arena_base(&self) -> *mut u8 {
        self.arena.base()
    }
    pub fn stats(&self) -> Stats {
        self.stats
    }
    pub fn cache(&self) -> &TexCache {
        &self.cache
    }
    pub fn cache_mut(&mut self) -> &mut TexCache {
        &mut self.cache
    }

    /// Record one DrawList. Draw order is the list's order — the core already
    /// ordered it (docs/VOXEL.md §3), and nothing here reorders, merges across
    /// kinds or sorts: draw order owns equal-depth contests.
    pub fn record(&mut self, list: &DrawList, pak: &Pak) {
        self.cmds.clear();
        self.mtx.clear();
        self.keys.clear();
        self.arena.rotate();
        self.tint = list.tint;
        self.palette = list.palette;
        self.cache.set_tint(list.tint);

        let mut stats = Stats {
            arena_high_water: self.stats.arena_high_water,
            ..Default::default()
        };
        core::mem::swap(&mut self.stats, &mut stats);

        // One VP for the frame, GL clip depth remapped onto the PICA's
        // negative range once. A depth-biased mesh re-derives its own from the
        // UNREMAPPED vp, so `biased_vp` keeps operating in the space its one
        // formulation is written in.
        let vp = list.cam.vp;
        let base_vp = cmd::pica_clip(&vp);
        let screen = self.push_mtx(&cmd::screen_clip());

        let mut i = 0usize;
        while i < list.items.len() {
            match &list.items[i] {
                Item::SkyBands {
                    colors,
                    horizon_row,
                } => {
                    self.sky(colors, *horizon_row, screen);
                    i += 1;
                }
                Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                    self.mesh(pak, mesh, list.cam.eye, &vp, &base_vp);
                    i += 1;
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.flat_quad(*corners, *abgr, list.cam.eye, 0.0, depth::TEST, &base_vp);
                    i += 1;
                }
                Item::Ghost { verts, pull, abgr } => {
                    self.flat_quad(*verts, *abgr, list.cam.eye, *pull, depth::INVERTED, &base_vp);
                    i += 1;
                }
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => {
                    self.card(pak, *verts, *page, *uv, *mirror, *pull, list.cam.eye, &base_vp);
                    i += 1;
                }
                Item::UiQuad { .. } => {
                    // The GB UI layer batches: one bind and one draw for the
                    // whole grid instead of ~100 of each. The run consumed is
                    // the maximal CONTIGUOUS one sharing a page, so the batch
                    // can never move a quad past a non-UI item — order stays
                    // the list's order even if `append_ui` ever stops being
                    // last.
                    i += self.ui_batch(pak, &list.items[i..]).max(1);
                }
            }
        }

        self.stats.commands = self.cmds.len() as u32;
        self.stats.textures = self.keys.len() as u32;
        self.stats.arena_used = self.arena.used() as u32;
        self.stats.arena_high_water = self.arena.high_water() as u32;
    }

    // -- plumbing -----------------------------------------------------------

    fn push_mtx(&mut self, m: &Mat4) -> u16 {
        let c = cmd::c3d_order(m);
        for (i, e) in self.mtx.iter().enumerate() {
            if e.iter().zip(c.iter()).all(|(a, b)| a.to_bits() == b.to_bits()) {
                return i as u16;
            }
        }
        if self.mtx.len() >= u16::MAX as usize {
            return 0; // unreachable for real content: a frame has a handful
        }
        self.mtx.push(c);
        (self.mtx.len() - 1) as u16
    }

    /// Resolve a draw's texture through the core's own precedence ladder and
    /// remember it in this frame's distinct-key set.
    fn key(
        &mut self,
        pak: &Pak,
        page: u16,
        frame: u16,
        item_pal: u16,
        tinted: bool,
    ) -> Option<TexKey> {
        let key = TexKey::resolve(pak, page, frame, item_pal, self.palette, tinted)?;
        if (key.pal as usize) >= pak.palettes.len() {
            return None;
        }
        if !self.keys.contains(&key) {
            self.keys.push(key);
        }
        Some(key)
    }

    /// Copy a mesh's index range into the arena. Indices are already relative
    /// to the mesh's `vert_base`, which is exactly what a per-draw buffer base
    /// wants, so they cross unchanged.
    fn stage_indices(&mut self, idx: &[u16]) -> Option<u32> {
        let p = self.arena.upload(as_bytes(idx))?;
        self.stats.indices += idx.len() as u32;
        Some(self.arena.offset_of(p))
    }

    /// Stage an unpulled mesh: one block copy, then the u16 -> i16 UV clamp
    /// the PICA's lack of an unsigned short attribute forces.
    fn stage_world(&mut self, src: &[PakVert]) -> Option<u32> {
        let dst = self.arena.upload(as_bytes(src))?;
        // Safety: `upload` returned `bytes` of 16-aligned arena, WorldVert and
        // PakVert are the same 16-byte layout (const-asserted in `cmd`).
        let vs = unsafe { core::slice::from_raw_parts_mut(dst as *mut WorldVert, src.len()) };
        for v in vs.iter_mut() {
            // A u16 above 32767 arrives here as a negative i16.
            if v.u < 0 {
                v.u = i16::MAX;
                self.stats.uv_clamped += 1;
            }
            if v.v < 0 {
                v.v = i16::MAX;
                self.stats.uv_clamped += 1;
            }
        }
        self.stats.verts += src.len() as u32;
        Some(self.arena.offset_of(dst))
    }

    /// Stage a pulled mesh: the eye-ray displacement per vertex, in world
    /// space with the seam offsets folded in, truncated back to i16.
    fn stage_world_pulled(
        &mut self,
        src: &[PakVert],
        eye: Vec3,
        off_x: i32,
        off_y: i32,
        pull: f32,
    ) -> Option<u32> {
        let dst = self.arena.alloc(core::mem::size_of_val(src))? as *mut WorldVert;
        for (i, pv) in src.iter().enumerate() {
            let p = pulled(
                eye,
                vec3(
                    pv.x as f32 + off_x as f32,
                    pv.y as f32,
                    pv.z as f32 + off_y as f32,
                ),
                pull,
            );
            let (u, cu) = clamp_uv(pv.u);
            let (v, cv) = clamp_uv(pv.v);
            self.stats.uv_clamped += u32::from(cu) + u32::from(cv);
            // Safety: `alloc` returned src.len() * 16 bytes, 16-aligned.
            unsafe {
                dst.add(i).write(WorldVert {
                    u,
                    v,
                    abgr: pv.abgr,
                    // Truncation toward zero, exactly `raster.rs`'s
                    // `p.x.trunc()` for the whole i16 range these coordinates
                    // live in.
                    x: p.x as i16,
                    y: p.y as i16,
                    z: p.z as i16,
                    pad: 0,
                })
            };
        }
        self.stats.verts += src.len() as u32;
        self.stats.pull_verts += src.len() as u32;
        Some(self.arena.offset_of(dst as *mut u8))
    }

    fn push_draw(&mut self, c: Cmd) {
        self.stats.draws += 1;
        self.cmds.push(c);
    }

    // -- item passes --------------------------------------------------------

    /// The sky pass owns the frame clear: colour `colors[SKY_BANDS - 1]` (the
    /// below-horizon band, already day-tinted by the core), depth cleared to
    /// the far end of the PICA range. Then the gradient over rows
    /// `[0, horizon_row)` in four equal integer slices — `y0 = hr*i/4`,
    /// `y1 = hr*(i+1)/4`, the rasterizer's own arithmetic — as screen-space
    /// quads with no depth.
    fn sky(&mut self, colors: &[u32; SKY_BANDS], horizon_row: i32, screen: u16) {
        self.cmds.push(Cmd {
            kind: kind::CLEAR,
            clear_abgr: colors[SKY_BANDS - 1],
            ..Cmd::zeroed()
        });
        let hr = horizon_row.clamp(0, VIEW_H);
        if hr == 0 {
            return;
        }
        for (i, &c) in colors.iter().enumerate() {
            let y0 = hr * i as i32 / SKY_BANDS as i32;
            let y1 = hr * (i as i32 + 1) / SKY_BANDS as i32;
            if y1 <= y0 {
                continue;
            }
            let quad = [
                FlatVert { x: 0.0, y: y0 as f32, z: 0.0, abgr: c },
                FlatVert { x: VIEW_W as f32, y: y0 as f32, z: 0.0, abgr: c },
                FlatVert { x: VIEW_W as f32, y: y1 as f32, z: 0.0, abgr: c },
                FlatVert { x: 0.0, y: y1 as f32, z: 0.0, abgr: c },
            ];
            let Some(v) = self.arena.upload(as_bytes(&quad)) else {
                self.stats.dropped_arena += 1;
                continue;
            };
            self.stats.verts += 4;
            let vert_offset = self.arena.offset_of(v);
            let Some(index_offset) = self.stage_indices(&QUAD_IDX) else {
                self.stats.dropped_arena += 1;
                continue;
            };
            self.push_draw(Cmd {
                vfmt: vfmt::FLAT,
                depth: depth::NONE,
                mtx: screen,
                vert_offset,
                vert_count: 4,
                index_offset,
                index_count: 6,
                ..Cmd::zeroed()
            });
        }
    }

    /// One chunk or stamp mesh.
    ///
    /// `pull == 0` stages the pak's own vertices; `pull != 0` applies the
    /// eye-ray displacement per vertex, exactly as `raster.rs` does, and
    /// truncates back to i16 BEFORE transform; `pull_bias != 0` (the
    /// `pullDepthBias` rung) draws in place through the same `draw::biased_vp`
    /// the rasterizer transforms by.
    fn mesh(&mut self, pak: &Pak, m: &MeshDraw, eye: Vec3, vp: &Mat4, base_vp: &Mat4) {
        if m.index_count == 0 {
            return;
        }
        let Some(key) = self.key(pak, m.page, m.frame, m.pal, true) else {
            self.stats.dropped_texture += 1;
            return;
        };
        let Ok(plan) = TexPlan::for_page(pak, m.page) else {
            self.stats.dropped_texture += 1;
            return;
        };

        let idx = &pak.indices
            [m.index_base as usize..m.index_base as usize + m.index_count as usize];
        let src = &pak.verts[m.vert_base as usize..m.vert_base as usize + m.vert_count as usize];

        // A pulled mesh bakes the seam offset into its displaced positions
        // (the displacement is a world-space operation), so its model matrix
        // is the identity; everything else translates by the seam.
        let (vert_offset, model) = if m.pull == 0.0 {
            (self.stage_world(src), cmd::world_model(m.off_x, m.off_y))
        } else {
            (
                self.stage_world_pulled(src, eye, m.off_x, m.off_y, m.pull),
                Mat4::IDENTITY,
            )
        };
        let (Some(vert_offset), Some(index_offset)) = (vert_offset, self.stage_indices(idx)) else {
            self.stats.dropped_arena += 1;
            return;
        };

        let clip = if m.pull_bias != 0.0 {
            cmd::pica_clip(&biased_vp(vp, m.pull_bias))
        } else {
            *base_vp
        };
        let mtx = self.push_mtx(&clip.mul(&model));
        self.push_draw(Cmd {
            vfmt: vfmt::WORLD,
            depth: depth::TEST_WRITE,
            flags: flag::TEXTURED | flag::ALPHA_TEST | flag::TINTED,
            page: key.page,
            frame: key.frame,
            pal: key.pal,
            mtx,
            vert_offset,
            vert_count: m.vert_count as u32,
            index_offset,
            index_count: m.index_count as u32,
            uv_scale: fixed_uv_scale(&plan),
            ..Cmd::zeroed()
        });
    }

    /// Shadow decals (test, never write) and the player ghost (INVERTED test,
    /// never write). Both untextured, both blended, and both keep f32
    /// positions: the rasterizer does not truncate untextured pulled geometry,
    /// so neither does this.
    fn flat_quad(
        &mut self,
        corners: [[f32; 3]; 4],
        abgr: u32,
        eye: Vec3,
        pull: f32,
        mode: u8,
        base_vp: &Mat4,
    ) {
        let mut quad = [FlatVert { x: 0.0, y: 0.0, z: 0.0, abgr }; 4];
        for (v, c) in quad.iter_mut().zip(corners.iter()) {
            let p = pulled(eye, vec3(c[0], c[1], c[2]), pull);
            v.x = p.x;
            v.y = p.y;
            v.z = p.z;
        }
        let Some(vp_) = self.arena.upload(as_bytes(&quad)) else {
            self.stats.dropped_arena += 1;
            return;
        };
        self.stats.verts += 4;
        let vert_offset = self.arena.offset_of(vp_);
        let Some(index_offset) = self.stage_indices(&QUAD_IDX) else {
            self.stats.dropped_arena += 1;
            return;
        };
        let mtx = self.push_mtx(base_vp);
        self.push_draw(Cmd {
            vfmt: vfmt::FLAT,
            depth: mode,
            flags: flag::BLEND,
            mtx,
            vert_offset,
            vert_count: 4,
            index_offset,
            index_count: 6,
            ..Cmd::zeroed()
        });
    }

    /// A billboard card: textured, alpha-tested, depth-written, pulled along
    /// each vertex's eye ray and truncated to i16 (a card is textured, so it
    /// takes the same truncation the rasterizer models for this backend).
    #[allow(clippy::too_many_arguments)]
    fn card(
        &mut self,
        pak: &Pak,
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        eye: Vec3,
        base_vp: &Mat4,
    ) {
        // A card carries no per-item palette: its OBJ / pic CLUT is a property
        // of the PAGE, which `resolve_pal` reads out of VCOL itself.
        let Some(key) = self.key(pak, page, 0, COLOR_PAL_NONE, true) else {
            self.stats.dropped_texture += 1;
            return;
        };
        let Ok(plan) = TexPlan::for_page(pak, page) else {
            self.stats.dropped_texture += 1;
            return;
        };
        let (u0, u1) = if mirror { (uv[2], uv[0]) } else { (uv[0], uv[2]) };
        let (v0, v1) = (uv[1], uv[3]);
        // Verts arrive bl, br, tr, tl; v0 is the texture top (raster.rs).
        let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
        let mut out = [WorldVert {
            u: 0,
            v: 0,
            abgr: 0xffff_ffff,
            x: 0,
            y: 0,
            z: 0,
            pad: 0,
        }; 4];
        for (i, o) in out.iter_mut().enumerate() {
            let p = pulled(eye, vec3(verts[i][0], verts[i][1], verts[i][2]), pull);
            o.u = q16(uvs[i].0);
            o.v = q16(uvs[i].1);
            o.x = p.x as i16;
            o.y = p.y as i16;
            o.z = p.z as i16;
        }
        let Some(v) = self.arena.upload(as_bytes(&out)) else {
            self.stats.dropped_arena += 1;
            return;
        };
        self.stats.verts += 4;
        let vert_offset = self.arena.offset_of(v);
        let Some(index_offset) = self.stage_indices(&QUAD_IDX) else {
            self.stats.dropped_arena += 1;
            return;
        };
        let mtx = self.push_mtx(base_vp);
        self.push_draw(Cmd {
            vfmt: vfmt::WORLD,
            depth: depth::TEST_WRITE,
            flags: flag::TEXTURED | flag::ALPHA_TEST | flag::TINTED,
            page: key.page,
            frame: key.frame,
            pal: key.pal,
            mtx,
            vert_offset,
            vert_count: 4,
            index_offset,
            index_count: 6,
            uv_scale: fixed_uv_scale(&plan),
            ..Cmd::zeroed()
        });
    }

    /// The GB UI layer: screen space, no depth, nearest, **untinted palette**
    /// (`raster.rs` composites the UI verbatim). Returns how many leading
    /// items of `items` were consumed.
    fn ui_batch(&mut self, pak: &Pak, items: &[Item]) -> usize {
        let Some(Item::UiQuad { page, .. }) = items.first() else {
            return 0;
        };
        let page = *page;
        let n = items
            .iter()
            .take_while(|it| matches!(it, Item::UiQuad { page: p, .. } if *p == page))
            .count();

        let Some(key) = self.key(pak, page, 0, COLOR_PAL_NONE, false) else {
            self.stats.dropped_texture += 1;
            return n;
        };
        let (Ok(plan), Some(p)) = (TexPlan::for_page(pak, page), pak.atlases.get(page as usize))
        else {
            self.stats.dropped_texture += 1;
            return n;
        };
        let cols = ((p.w as i32 / TILE_PX) as u16).max(1);

        let Some(vbase) = self.arena.alloc(n * 4 * core::mem::size_of::<WorldVert>()) else {
            self.stats.dropped_arena += 1;
            return n;
        };
        let vbase = vbase as *mut WorldVert;
        let mut idx: Vec<u16> = Vec::with_capacity(n * 6);
        for (q, item) in items[..n].iter().enumerate() {
            let Item::UiQuad { x, y, w, h, tile, .. } = item else {
                continue;
            };
            // Raw texel UVs into the page, which the POT envelope's own
            // `uv_scale` normalizes.
            let tx0 = (tile % cols) as i16 * TILE_PX as i16;
            let ty0 = (tile / cols) as i16 * TILE_PX as i16;
            let (x0, y0) = (round_i16(*x), round_i16(*y));
            let (x1, y1) = (round_i16(*x + *w), round_i16(*y + *h));
            let corners = [
                (x0, y0, tx0, ty0),
                (x1, y0, tx0 + TILE_PX as i16, ty0),
                (x1, y1, tx0 + TILE_PX as i16, ty0 + TILE_PX as i16),
                (x0, y1, tx0, ty0 + TILE_PX as i16),
            ];
            for (k, &(px, py, tu, tv)) in corners.iter().enumerate() {
                // Safety: the block above reserved n * 4 vertices.
                unsafe {
                    vbase.add(q * 4 + k).write(WorldVert {
                        u: tu,
                        v: tv,
                        abgr: 0xffff_ffff,
                        x: px,
                        y: py,
                        z: 0,
                        pad: 0,
                    })
                };
            }
            let b = (q * 4) as u16;
            idx.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
        }
        self.stats.verts += (n * 4) as u32;
        let vert_offset = self.arena.offset_of(vbase as *mut u8);
        let Some(index_offset) = self.stage_indices(&idx) else {
            self.stats.dropped_arena += 1;
            return n;
        };
        let mtx = self.push_mtx(&cmd::screen_clip());
        self.push_draw(Cmd {
            vfmt: vfmt::WORLD,
            depth: depth::NONE,
            flags: flag::TEXTURED | flag::ALPHA_TEST,
            page: key.page,
            frame: key.frame,
            pal: key.pal,
            mtx,
            vert_offset,
            vert_count: (n * 4) as u32,
            index_offset,
            index_count: idx.len() as u32,
            uv_scale: [
                1.0 / plan.width as f32,
                1.0 / plan.height as f32,
            ],
            ..Cmd::zeroed()
        });
        n
    }
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

/// bl, br, tr, tl → two triangles, the rasterizer's own `quad_tris` order, so
/// a quad's two halves resolve an equal-depth contest the same way.
const QUAD_IDX: [u16; 6] = [0, 1, 2, 0, 2, 3];

/// The `uv_scale` for pak fixed-point UVs: the POT envelope's rescale and the
/// ÷32768 the GE gets for free, folded into one multiply.
fn fixed_uv_scale(plan: &TexPlan) -> [f32; 2] {
    [plan.u_scale / 32768.0, plan.v_scale / 32768.0]
}

#[cfg(test)]
mod tests;
