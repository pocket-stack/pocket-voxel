//! The recorded frame's wire format: the command record, the two staged
//! vertex layouts, and the matrix conversions between our column-major
//! [`Mat4`] and what citro3d uploads.
//!
//! Everything here is `#[repr(C)]` and mirrored in
//! `include/pocketvoxel_pica.h`; the const asserts below are what stop the
//! two from drifting.

use pocketvoxel_core::math::Mat4;
use pocketvoxel_core::pak::PakVert;
use pocketvoxel_core::spec::{VERTEX_STRIDE, VIEW_H, VIEW_W};

// ---------------------------------------------------------------------------
// Vertex layouts
// ---------------------------------------------------------------------------

/// The textured vertex — **byte-identical to the pak's own [`PakVert`]**, so
/// an unpulled mesh stages with one `copy_nonoverlapping` and a UV clamp
/// instead of a per-vertex rebuild.
///
/// The PICA converts `GPU_SHORT` attributes as RAW INTEGERS (there is no
/// implicit ÷32768 like the GE's `TRANSFORM_3D`), so the positions arrive in
/// world px and the UVs arrive in the pak's fixed point; the per-draw
/// `uv_scale` a command carries folds BOTH the ÷32768 and the POT envelope
/// into one multiply the vertex shader applies.
///
/// The pak stores UVs as `u16` and the PICA has no unsigned short attribute,
/// so a UV of exactly 32768 (`uv == 1.0`) clamps to 32767 — one part in
/// 32768 of a page, 1/256 of a texel on a 128 px page, against the 0.02-texel
/// inset the cooker already applies. [`crate::Stats::uv_clamped`] counts the
/// clamps, so "never happens" stays a measurement.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorldVert {
    pub u: i16,
    pub v: i16,
    pub abgr: u32,
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub pad: i16,
}

/// The untextured vertex: shadow decals and the player ghost, whose pulled
/// geometry stays f32 in the software rasterizer and must stay f32 here.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlatVert {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub abgr: u32,
}

const _: () = assert!(core::mem::size_of::<WorldVert>() == VERTEX_STRIDE);
const _: () = assert!(core::mem::size_of::<WorldVert>() == core::mem::size_of::<PakVert>());
const _: () = assert!(core::mem::align_of::<WorldVert>() == core::mem::align_of::<PakVert>());
const _: () = assert!(core::mem::size_of::<FlatVert>() == 16);

/// Vertex format ids (`PvPicaCmd.vfmt`).
pub mod vfmt {
    /// [`super::WorldVert`]: texcoord(2 x GPU_SHORT), colour(4 x
    /// GPU_UNSIGNED_BYTE), position(3 x GPU_SHORT), stride 16.
    pub const WORLD: u8 = 0;
    /// [`super::FlatVert`]: position(3 x GPU_FLOAT), colour(4 x
    /// GPU_UNSIGNED_BYTE), stride 16.
    pub const FLAT: u8 = 1;
}

/// Command kinds (`PvPicaCmd.kind`).
pub mod kind {
    /// Clear colour + depth. `Item::SkyBands` owns the frame clear, so this
    /// is emitted once, first, and only by the sky pass.
    pub const CLEAR: u8 = 0;
    /// An indexed triangle list.
    pub const DRAW: u8 = 1;
}

/// Depth behaviour (`PvPicaCmd.depth`). Three of them, because the DrawList
/// has exactly three: meshes and cards test and write, `ShadowDecal` tests and
/// never writes, `Ghost` inverts the test and never writes.
pub mod depth {
    /// No depth test, no depth write (sky bands, the GB UI layer).
    pub const NONE: u8 = 0;
    /// Nearer wins, depth written.
    pub const TEST_WRITE: u8 = 1;
    /// Nearer wins, depth NOT written.
    pub const TEST: u8 = 2;
    /// INVERTED: draws only where occluded, depth not written.
    pub const INVERTED: u8 = 3;
}

/// Command flags (`PvPicaCmd.flags`).
pub mod flag {
    /// Bind `page`/`frame`/`pal` and sample it.
    pub const TEXTURED: u8 = 1;
    /// Alpha-test at `0x7f`, `GPU_GREATER`: a cut texel writes neither
    /// colour nor depth.
    pub const ALPHA_TEST: u8 = 2;
    /// Blend `src_alpha, 1 - src_alpha`.
    pub const BLEND: u8 = 4;
    /// The palette this draw samples has the day tint modulated in. Part of
    /// the texture cache key: one page draws tinted in the diorama and raw in
    /// the GB UI layer within one frame.
    pub const TINTED: u8 = 8;
}

/// One recorded draw (or the frame clear). 40 bytes, 4-aligned.
///
/// `vert_offset`/`index_offset` are byte offsets from
/// [`crate::Renderer::arena_base`]; the indices are u16 and **relative to
/// this command's own vertex block**, so the C side binds
/// `arena + vert_offset` as the buffer base and every index starts from 0 —
/// the pak's own `vert_base` convention, preserved.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cmd {
    pub kind: u8,
    pub vfmt: u8,
    pub depth: u8,
    pub flags: u8,
    /// Atlas page, animation frame, and the RESOLVED VPAL index
    /// (`draw::resolve_pal`) — with `flags & TINTED`, the texture cache key.
    pub page: u16,
    pub frame: u16,
    pub pal: u16,
    /// Index into [`crate::Renderer::matrices`].
    pub mtx: u16,
    pub vert_offset: u32,
    pub vert_count: u32,
    pub index_offset: u32,
    pub index_count: u32,
    /// `kind == CLEAR` only: the clear colour, ABGR, as the DrawList states
    /// it (`colors[SKY_BANDS - 1]`, already day-tinted by the core).
    pub clear_abgr: u32,
    /// Multiply the raw i16 texcoord by this to get the PICA's normalized
    /// texcoord. Folds the pak's ÷32768 fixed point and the POT envelope.
    pub uv_scale: [f32; 2],
}

const _: () = assert!(core::mem::size_of::<Cmd>() == 40);
const _: () = assert!(core::mem::align_of::<Cmd>() == 4);

impl Cmd {
    pub const fn zeroed() -> Self {
        Self {
            kind: kind::DRAW,
            vfmt: vfmt::WORLD,
            depth: depth::NONE,
            flags: 0,
            page: 0,
            frame: 0,
            pal: 0,
            mtx: 0,
            vert_offset: 0,
            vert_count: 0,
            index_offset: 0,
            index_count: 0,
            clear_abgr: 0,
            uv_scale: [0.0, 0.0],
        }
    }
}

/// A texture the frame binds: the whole cache key, deduplicated.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TexKey {
    pub page: u16,
    pub frame: u16,
    /// Resolved VPAL index.
    pub pal: u16,
    /// 1 = the day tint is modulated into the palette.
    pub tinted: u16,
}

const _: () = assert!(core::mem::size_of::<TexKey>() == 8);

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

/// GL clip depth (`z in [-w, w]`, smaller wins) → PICA clip depth (`z in
/// [-w, 0]`).
///
/// The core builds one GL-convention VP that the software rasterizer and the
/// GE backend both consume, and the PICA's usable depth range is negative, so
/// the halfspace remap `z' = (z - w) / 2` is the whole conversion. Paired
/// with the host's `C3D_DepthMap(true, -1.0f, 0.0f)` it lands the near plane
/// at depth 1 and the far plane at depth 0, which makes `GPU_GREATER` —
/// `C3D_Init`'s own default — mean "nearer wins", clear depth 0 mean "far",
/// and equal depths go to whichever draw came FIRST, exactly as the software
/// rasterizer's strict `z < depth` resolves them.
///
/// It composes with [`pocketvoxel_core::draw::biased_vp`] the only way that
/// keeps the two backends honest: the bias is applied in GL space first,
/// where its one formulation lives, and this remap runs after.
pub fn pica_clip(vp: &Mat4) -> Mat4 {
    let mut m = *vp;
    for c in 0..4 {
        m.m[c * 4 + 2] = (m.m[c * 4 + 2] - m.m[c * 4 + 3]) * 0.5;
    }
    m
}

/// The screen-space clip matrix: `[0, VIEW_W] x [0, VIEW_H]` with y DOWN,
/// which is how the DrawList states sky-band rows and GB UI quads.
///
/// The diorama is cooked for 480x272 and the pak is hard-rejected otherwise
/// (`pak.rs`), so the 400x240 top screen takes it in a 400x226 letterboxed
/// viewport — see [`crate::VIEWPORT_H`]. That is a viewport rectangle, not a
/// coordinate change: screen space stays 480x272 here and the same scale
/// applies to the diorama and the UI.
pub fn screen_clip() -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[0] = 2.0 / VIEW_W as f32;
    m.m[5] = -2.0 / VIEW_H as f32;
    m.m[10] = 0.0;
    m.m[12] = -1.0;
    m.m[13] = 1.0;
    m.m[14] = 0.0;
    pica_clip(&m)
}

/// A mesh's model matrix: the map slot's seam translation, and nothing else.
///
/// The GE needs a ×32768 scale here to counter its i16-position
/// normalization; the PICA converts `GPU_SHORT` attributes as raw integers,
/// so there is nothing to counter and the scale would be a 32768x world.
pub fn world_model(off_x: i32, off_y: i32) -> Mat4 {
    let mut m = Mat4::IDENTITY;
    m.m[12] = off_x as f32;
    m.m[14] = off_y as f32;
    m
}

/// Our column-major [`Mat4`] in `C3D_Mtx.m[]` order, ready to `memcpy`.
///
/// `C3D_Mtx` is ROW-major and each row is a `C3D_FVec`, which citro3d
/// declares as `struct { float w, z, y, x; }` — so `m[i * 4 + j]` is row `i`,
/// component `3 - j`. Both reversals have to happen or the GPU transforms by
/// a plausible-looking wrong matrix: `out[i * 4 + j] = M[row i][col 3 - j] =
/// mat.m[(3 - j) * 4 + i]`.
pub fn c3d_order(mat: &Mat4) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for i in 0..4 {
        for j in 0..4 {
            out[i * 4 + j] = mat.m[(3 - j) * 4 + i];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketvoxel_core::draw::biased_vp;
    use pocketvoxel_core::math::{Vec3, vec3};

    /// The staged textured vertex has to be the pak's vertex, field for
    /// field, or the "copy the block" fast path is silently wrong.
    #[test]
    fn world_vert_is_the_pak_vertex() {
        let pv = PakVert {
            u: 1,
            v: 2,
            abgr: 0x0403_0201,
            x: 5,
            y: 6,
            z: 7,
            pad: 0,
        };
        let raw: [u8; 16] = unsafe { core::mem::transmute(pv) };
        let wv: WorldVert = unsafe { core::mem::transmute(raw) };
        assert_eq!(
            wv,
            WorldVert {
                u: 1,
                v: 2,
                abgr: 0x0403_0201,
                x: 5,
                y: 6,
                z: 7,
                pad: 0
            }
        );
        // The PICA reads it as [texcoord 4B][colour 4B][position 6B] with a
        // 16-byte stride; the field offsets are what that assumes.
        assert_eq!(core::mem::offset_of!(WorldVert, u), 0);
        assert_eq!(core::mem::offset_of!(WorldVert, abgr), 4);
        assert_eq!(core::mem::offset_of!(WorldVert, x), 8);
        assert_eq!(core::mem::offset_of!(FlatVert, x), 0);
        assert_eq!(core::mem::offset_of!(FlatVert, abgr), 12);
    }

    #[test]
    fn c3d_order_transposes_and_reverses_each_row() {
        // A matrix whose entries name their own (col, row).
        let mut m = Mat4::IDENTITY;
        for c in 0..4 {
            for r in 0..4 {
                m.m[c * 4 + r] = (c * 10 + r) as f32;
            }
        }
        let out = c3d_order(&m);
        // C3D row 0 is (m00, m01, m02, m03) stored as (w, z, y, x) =
        // (m03, m02, m01, m00) — column index counts DOWN across the row.
        assert_eq!(&out[0..4], &[30.0, 20.0, 10.0, 0.0]);
        assert_eq!(&out[4..8], &[31.0, 21.0, 11.0, 1.0]);
        assert_eq!(&out[12..16], &[33.0, 23.0, 13.0, 3.0]);
        // The identity is NOT its own C3D image — the per-row component
        // reversal turns it into the ANTI-diagonal. Worth pinning, because
        // "it looked like the identity" is how a half-applied reversal
        // survives review.
        assert_eq!(
            c3d_order(&Mat4::IDENTITY),
            [
                0.0, 0.0, 0.0, 1.0, //
                0.0, 0.0, 1.0, 0.0, //
                0.0, 1.0, 0.0, 0.0, //
                1.0, 0.0, 0.0, 0.0,
            ]
        );
    }

    /// GL's [-w, w] maps onto the PICA's [-w, 0] with the near plane at the
    /// far end of the depth-map range, which is what makes GPU_GREATER mean
    /// "nearer wins".
    #[test]
    fn pica_clip_remaps_the_depth_halfspace() {
        let vp = Mat4::perspective_gl(1.0, 480.0 / 272.0, 1.0, 512.0).mul(&Mat4::look_at(
            vec3(0.0, 100.0, 100.0),
            Vec3::ZERO,
            Vec3::Y,
        ));
        let pica = pica_clip(&vp);
        // `depth = -z'/w` with C3D_DepthMap(true, -1, 0).
        let depth = |m: &Mat4, p: Vec3| {
            let c = m.transform(p, 1.0);
            -(c.z / c.w)
        };
        let ndc_z = |m: &Mat4, p: Vec3| {
            let c = m.transform(p, 1.0);
            c.z / c.w
        };
        let near = vec3(0.0, 99.0, 99.0);
        let far = vec3(0.0, -50.0, -300.0);
        // x and y are untouched by the remap.
        for p in [near, far] {
            let a = vp.transform(p, 1.0);
            let b = pica.transform(p, 1.0);
            assert!((a.x - b.x).abs() < 1e-4 && (a.y - b.y).abs() < 1e-4 && (a.w - b.w).abs() < 1e-6);
        }
        // GL: smaller z wins. PICA depth: larger wins, and stays in [0, 1].
        assert!(ndc_z(&vp, near) < ndc_z(&vp, far));
        assert!(depth(&pica, near) > depth(&pica, far));
        for p in [near, far] {
            let d = depth(&pica, p);
            assert!((0.0..=1.0).contains(&d), "depth {d} left the buffer range");
        }
        // A GL near-plane point (ndc z = -1) lands at depth 1, the far plane
        // at 0 — the clear value the sky pass writes.
        let synth = |z: f32| {
            let mut m = Mat4::IDENTITY;
            m.m[14] = z; // z_clip = z, w = 1
            -(pica_clip(&m).transform(Vec3::ZERO, 1.0).z)
        };
        assert!((synth(-1.0) - 1.0).abs() < 1e-6);
        assert!((synth(1.0) - 0.0).abs() < 1e-6);
    }

    /// The `pullDepthBias` rung's bias is applied in GL space, where its one
    /// formulation lives, and the PICA remap runs after — so the depth shift
    /// on this backend is exactly half the NDC bias the rasterizer applies,
    /// and it moves the mesh the same WAY.
    ///
    /// The two conventions read opposite, which is the trap: in GL a smaller
    /// z wins, on the PICA a larger depth wins, and `depth = (1 - z_ndc)/2`
    /// carries the sign across. `draw::depth_bias` returns a NEGATIVE number
    /// for a camera-ward pull (the focus moves toward the eye, so its NDC z
    /// falls), which has to come out as a mesh that wins depth on both.
    #[test]
    fn the_depth_bias_survives_the_remap_in_the_same_direction() {
        let vp = Mat4::perspective_gl(1.0, 480.0 / 272.0, 1.0, 512.0).mul(&Mat4::look_at(
            vec3(0.0, 100.0, 100.0),
            Vec3::ZERO,
            Vec3::Y,
        ));
        let p = vec3(4.0, 0.0, -8.0);
        let bias = -0.002; // toward the camera, as `depth_bias` produces
        let gl = |m: &Mat4| {
            let c = m.transform(p, 1.0);
            c.z / c.w
        };
        let plain = gl(&vp);
        let biased = gl(&biased_vp(&vp, bias));
        assert!((biased - (plain + bias)).abs() < 1e-6, "GL: z += bias");
        let dp = -(pica_clip(&vp).transform(p, 1.0).z / vp.transform(p, 1.0).w);
        let db = -(pica_clip(&biased_vp(&vp, bias)).transform(p, 1.0).z / vp.transform(p, 1.0).w);
        assert!((db - (dp - bias * 0.5)).abs() < 1e-6, "PICA: depth -= bias/2");
        // GL is "smaller z wins", PICA is "larger depth wins", and a
        // camera-ward (negative) bias has to win on both.
        assert!(biased < plain, "GL: the biased mesh is nearer");
        assert!(db > dp, "PICA: the biased mesh has the winning depth");
        // ...and a receding bias (what `bake_bias` uses, `-depth_bias`) loses
        // on both, which is the property the ground bake depends on.
        let recede = 0.002f32;
        let dr = -(pica_clip(&biased_vp(&vp, recede)).transform(p, 1.0).z / vp.transform(p, 1.0).w);
        assert!(gl(&biased_vp(&vp, recede)) > plain);
        assert!(dr < dp);
    }

    #[test]
    fn screen_clip_maps_the_480x272_frame_corners() {
        let m = screen_clip();
        let at = |x: f32, y: f32| {
            let c = m.transform(vec3(x, y, 0.0), 1.0);
            (c.x / c.w, c.y / c.w, c.z / c.w)
        };
        let (x, y, z) = at(0.0, 0.0);
        assert!((x + 1.0).abs() < 1e-6 && (y - 1.0).abs() < 1e-6, "top-left");
        assert!((-1.0..=0.0).contains(&z), "screen z sits inside the PICA volume");
        let (x, y, _) = at(VIEW_W as f32, VIEW_H as f32);
        assert!((x - 1.0).abs() < 1e-6 && (y + 1.0).abs() < 1e-6, "bottom-right");
    }

    /// No ×32768 counter-scale: the PICA reads i16 attributes as integers.
    #[test]
    fn the_model_matrix_is_a_pure_seam_translation() {
        let m = world_model(256, -128);
        let p = m.transform(vec3(10.0, 20.0, 30.0), 1.0);
        assert_eq!((p.x, p.y, p.z, p.w), (266.0, 20.0, -98.0, 1.0));
    }
}
