//! Host-side tests for the parts of this backend that do not need a GPU.
//!
//! The PICA200 cannot be exercised here, so what stands in for it is the
//! **software rasterizer's own arithmetic**: where `pocketvoxel-sim`'s
//! `raster.rs` decides something the picture depends on — the pull
//! displacement, the i16 truncation of textured pulled vertices, the sky band
//! row slicing, the depth-bias matrix, the palette resolution and the tint
//! modulation — the oracle below is that expression transcribed from its
//! source, and the assertion is that this crate agrees with it exactly.
//!
//! Everything a GPU would decide (rasterization, filtering, the actual depth
//! compare) is out of reach and is stated as such in the crate's README.

use super::*;

use alloc::vec;
use alloc::vec::Vec;
use pocketvoxel_core::draw::{self, DrawList, Item, SKY_BANDS, modulate_rgb, resolve_pal};
use pocketvoxel_core::math::{Mat4, Vec3, vec3};
use pocketvoxel_core::pak::{
    self, AlignedBlob, MeshRange, PakVert,
    builder::{ChunkDef, PakBuilder},
};
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::{self, Q4, atlas_kind, mesh_kind, op};

// ---------------------------------------------------------------------------
// A pak with every draw kind this backend has a pass for
// ---------------------------------------------------------------------------

const WORLD_PAL: u16 = 5;
const OBJ_PAL: u16 = 6;

/// One map, one chunk carrying terrain + both tree levels + grass + flower, a
/// stamp, a two-frame terrain page (so the animation frame joins the texture
/// key), a sprite sheet for cards, a UI page, and RED++ bindings so
/// `resolve_pal` has something to resolve. The page sizes are deliberately
/// non-power-of-two, which is the case the POT envelope exists for.
fn demo_pak() -> Vec<u8> {
    let mut b = PakBuilder::new();
    let mut pal = [0xff00_0000u32; 256];
    for (i, c) in pal.iter_mut().enumerate() {
        *c = 0xff00_0000 | (i as u32 * 0x0001_0101);
    }
    pal[0] = 0x0000_0000; // alpha-tested out
    for _ in 0..7 {
        b.palette(pal); // 0..3 kind ramps, 4 the one SGB entry, 5 world, 6 OBJ
    }
    let terrain: Vec<u8> = (0..40 * 24).map(|i| (i % 255 + 1) as u8).collect();
    b.atlas_linear(40, 24, atlas_kind::TERRAIN, &[&terrain, &terrain]);
    b.atlas_linear(64, 128, atlas_kind::SPRITES, &[&vec![7u8; 64 * 128]]);
    b.atlas_linear(24, 24, atlas_kind::UI, &[&vec![9u8; 24 * 24]]);

    let quad = |b: &mut PakBuilder, x0: i16, z0: i16, x1: i16, z1: i16| {
        let v = |x, z| PakVert {
            u: 8192,
            v: 8192,
            abgr: 0xffff_ffff,
            x,
            y: 0,
            z,
            pad: 0,
        };
        b.mesh(&[v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1)], &[0, 1, 2, 0, 2, 3])
    };
    // Two quads, so the detail meshes have a vertex count no other mesh
    // shares — a single-quad pak would let a test match the wrong draw.
    let quad2 = |b: &mut PakBuilder, x0: i16, z0: i16, x1: i16, z1: i16| {
        let v = |x, z, y| PakVert {
            u: 8192,
            v: 8192,
            abgr: 0xffff_ffff,
            x,
            y,
            z,
            pad: 0,
        };
        b.mesh(
            &[
                v(x0, z0, 0),
                v(x1, z0, 0),
                v(x1, z1, 0),
                v(x0, z1, 0),
                v(x0, z0, 8),
                v(x1, z0, 8),
                v(x1, z1, 8),
                v(x0, z1, 8),
            ],
            &[0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
        )
    };
    let mut meshes = [MeshRange::default(); spec::MESH_KINDS];
    meshes[mesh_kind::TERRAIN as usize] = quad(&mut b, 0, 0, 128, 128);
    meshes[mesh_kind::TREE_HULL as usize] = quad(&mut b, 8, 8, 24, 24);
    meshes[mesh_kind::TREE_COARSE as usize] = quad(&mut b, 8, 8, 24, 24);
    meshes[mesh_kind::TREE_BOX as usize] = quad(&mut b, 8, 8, 24, 24);
    meshes[mesh_kind::GRASS as usize] = quad2(&mut b, 0, 0, 64, 64);
    meshes[mesh_kind::FLOWER as usize] = quad2(&mut b, 64, 64, 128, 128);
    let stamp = quad(&mut b, 16, 16, 32, 32);
    b.map(
        7,
        &[ChunkDef {
            cx: 0,
            cy: 0,
            aabb_min: [0, 0, 0],
            aabb_max: [128, 0, 128],
            bake_page: spec::BAKE_PAGE_NONE,
            meshes,
        }],
    );
    b.stamps(7, &[(2, 2, stamp)]);
    b.glyph('A' as u16, 3);
    b.game(b"{}");
    b.meta_flags(spec::VXPK_META_FLAG_TREE_LOD | spec::VXPK_META_FLAG_TREE_COARSE);
    b.color_flags(spec::VXPK_COLOR_FLAG_WORLD);
    b.map_color(7, WORLD_PAL, 0);
    b.page_color(1, OBJ_PAL);
    b.finish()
}

/// A scene with the whole cast on screen: the map, a ghost-flagged player, a
/// second entity, a UI tile and a text run, a non-white day tint and an SGB
/// palette selection.
///
/// Pitch rung 4 (75 degrees off straight down) is deliberate: it is the rung
/// that puts the HORIZON on screen, and without a horizon row the sky pass
/// emits only its clear and the band tests have nothing to check.
fn demo_scene() -> Scene {
    let mut s = Scene::new();
    s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
    s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
    s.op(op::PITCH, &[4], None);
    s.op(op::TINT, &[0x00b0_c0d0], None);
    s.op(op::PALETTE, &[0], None);
    s.op(
        op::ENT,
        &[0, 1, 0, 64 * Q4, 64 * Q4, 0, spec::ent_flag::GHOST as i32],
        None,
    );
    s.op(op::ENT, &[1, 1, 0, 80 * Q4, 72 * Q4, 0, 0], None);
    s.op(op::UI_TILE, &[2, 3, 5], None);
    s.op(op::UI_TEXT, &[1, 1], Some("AAA"));
    s.op(op::UI_REVEAL, &[3], None);
    for _ in 0..spec::PITCH_TWEEN_TICKS {
        s.tick();
    }
    s
}

/// A renderer over a Vec-backed arena — the host would hand `linearAlloc`
/// memory here, and the arena has no idea which it got.
struct Harness {
    r: Renderer,
    _mem: Vec<u8>,
}

impl Harness {
    fn with_bytes(bytes: usize) -> Self {
        let mut mem = vec![0u8; bytes];
        let mut r = Renderer::new();
        unsafe { r.adopt_arena(mem.as_mut_ptr(), mem.len(), 2) };
        Self { r, _mem: mem }
    }
    fn new() -> Self {
        Self::with_bytes(1 << 20)
    }
}

fn built(pak: &pak::Pak, scene: &Scene) -> DrawList {
    draw::build(scene, pak)
}

/// Read a command's staged vertices back out of the arena.
fn world_verts(r: &Renderer, c: &Cmd) -> Vec<WorldVert> {
    assert_eq!(c.vfmt, vfmt::WORLD);
    unsafe {
        core::slice::from_raw_parts(
            r.arena_base().add(c.vert_offset as usize) as *const WorldVert,
            c.vert_count as usize,
        )
    }
    .to_vec()
}

fn flat_verts(r: &Renderer, c: &Cmd) -> Vec<FlatVert> {
    assert_eq!(c.vfmt, vfmt::FLAT);
    unsafe {
        core::slice::from_raw_parts(
            r.arena_base().add(c.vert_offset as usize) as *const FlatVert,
            c.vert_count as usize,
        )
    }
    .to_vec()
}

/// The item → command correspondence, walked in lockstep.
///
/// Every item maps to a known, fixed number of commands: `SkyBands` to one
/// clear plus one draw per non-empty band, a UI run to one batch, everything
/// else to exactly one draw. Tests use this instead of guessing which command
/// came from which item — a heuristic would quietly match the wrong draw the
/// moment two meshes agreed on a vertex count.
///
/// Panics if the streams disagree, which is itself the ordering assertion.
fn correspondence(list: &DrawList, cmds: &[Cmd]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0usize;
    let mut item = 0usize;
    while item < list.items.len() {
        match &list.items[item] {
            Item::SkyBands { .. } => {
                assert_eq!(cmds[at].kind, kind::CLEAR, "the sky opens with the clear");
                out.push((item, at));
                at += 1;
                while at < cmds.len() && cmds[at].vfmt == vfmt::FLAT && cmds[at].flags == 0 {
                    at += 1;
                }
                item += 1;
            }
            Item::UiQuad { page, .. } => {
                let p = *page;
                let n = list.items[item..]
                    .iter()
                    .take_while(|i| matches!(i, Item::UiQuad { page: q, .. } if *q == p))
                    .count();
                out.push((item, at));
                at += 1;
                item += n;
            }
            _ => {
                out.push((item, at));
                at += 1;
                item += 1;
            }
        }
    }
    assert_eq!(at, cmds.len(), "commands left over after the last item");
    out
}

fn indices(r: &Renderer, c: &Cmd) -> Vec<u16> {
    unsafe {
        core::slice::from_raw_parts(
            r.arena_base().add(c.index_offset as usize) as *const u16,
            c.index_count as usize,
        )
    }
    .to_vec()
}

// ---------------------------------------------------------------------------
// 1. The pull displacement
// ---------------------------------------------------------------------------

/// `raster.rs::to_clip_opts`, transcribed:
///
/// ```ignore
/// let p = pos.add(eye.sub(pos).normalize().scale(pull));
/// if i16_trunc { vec3(p.x.trunc(), p.y.trunc(), p.z.trunc()) } else { p }
/// ```
fn raster_pull(eye: Vec3, pos: Vec3, pull: f32, i16_trunc: bool) -> Vec3 {
    if pull == 0.0 {
        return pos;
    }
    let p = pos.add(eye.sub(pos).normalize().scale(pull));
    if i16_trunc {
        vec3(p.x.trunc(), p.y.trunc(), p.z.trunc())
    } else {
        p
    }
}

/// Bit for bit against the oracle, over a spread of eyes, positions and pull
/// magnitudes — including the degenerate vertex-at-the-eye case the `1e-12`
/// guard exists for, and a pull of 0, which must not move anything at all.
#[test]
fn the_pull_is_the_rasterizers_own_arithmetic() {
    let eyes = [
        vec3(0.0, 136.0, 190.0),
        vec3(-321.5, 12.25, 7.0),
        vec3(1e-7, 1e-7, 1e-7),
    ];
    let positions = [
        vec3(0.0, 0.0, 0.0),
        vec3(64.0, 8.0, -64.0),
        vec3(-1024.5, 3.75, 2048.25),
        vec3(1e-7, 1e-7, 1e-7),
    ];
    for &eye in &eyes {
        for &pos in &positions {
            for pull in [0.0f32, 6.0, 38.0, 46.0, 0.5, -6.0] {
                let want = raster_pull(eye, pos, pull, false);
                let got = pulled(eye, pos, pull);
                assert_eq!(
                    (got.x.to_bits(), got.y.to_bits(), got.z.to_bits()),
                    (want.x.to_bits(), want.y.to_bits(), want.z.to_bits()),
                    "eye {eye:?} pos {pos:?} pull {pull}"
                );
            }
        }
    }
}

/// The operation ORDER is load-bearing: scale by `1/len`, then by `pull`.
/// Scaling by `pull/len` in one multiply is algebraically the same and is a
/// different f32.
#[test]
fn the_pull_scales_by_one_over_len_then_by_pull() {
    let eye = vec3(0.0, 136.0, 190.0);
    let pull = 46.0f32;
    let mut fused_differs = 0usize;
    let mut checked = 0usize;
    for i in 0..64i32 {
        for j in 0..64i32 {
            let pos = vec3(i as f32 * 3.7 - 100.0, (j % 17) as f32, j as f32 * -2.3);
            let d = eye.sub(pos);
            let len = d.dot(d).sqrt();
            // The pinned order: scale by 1/len, THEN by pull.
            let two_step = pos.add(d.scale(1.0 / len).scale(pull));
            let got = pulled(eye, pos, pull);
            assert_eq!(got.x.to_bits(), two_step.x.to_bits(), "{pos:?}");
            assert_eq!(got.y.to_bits(), two_step.y.to_bits(), "{pos:?}");
            assert_eq!(got.z.to_bits(), two_step.z.to_bits(), "{pos:?}");
            // Algebraically identical, a different f32 — which is why the
            // order is pinned rather than left to whoever writes it next.
            let fused = pos.add(d.scale(pull / len));
            if (fused.x.to_bits(), fused.y.to_bits(), fused.z.to_bits())
                != (two_step.x.to_bits(), two_step.y.to_bits(), two_step.z.to_bits())
            {
                fused_differs += 1;
            }
            checked += 1;
        }
    }
    assert!(
        fused_differs > 0,
        "the fused form agreed on all {checked} samples, so this test proves nothing"
    );
}

/// A textured pulled mesh truncates toward zero to i16 BEFORE transform, and
/// the staged vertices carry exactly the oracle's truncated positions — the
/// seam offset folded in, since the displacement is a world-space operation.
#[test]
fn textured_pulled_vertices_truncate_to_i16() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    // The `vita` rung keeps the GEOMETRIC pull (pull_depth_bias is false), so
    // grass and flower arrive with a nonzero `pull`.
    let mut s = demo_scene();
    s.op(op::QUALITY, &[spec::quality_tier::VITA as i32], None);
    s.op(op::MAP_SHOW, &[0, 7, 32, -16], None); // a seam offset that shows
    let list = built(&pak, &s);

    let pulled_mesh = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::ChunkMesh { mesh, .. } if mesh.pull != 0.0 => Some(*mesh),
            _ => None,
        })
        .expect("the vita rung pulls grass geometrically");
    assert_ne!(pulled_mesh.pull, 0.0);
    assert_eq!(pulled_mesh.pull_bias, 0.0, "exactly one of the two is set");

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let item = list
        .items
        .iter()
        .position(|i| matches!(i, Item::ChunkMesh { mesh, .. } if mesh.pull != 0.0))
        .unwrap();
    let at = correspondence(&list, h.r.commands())
        .into_iter()
        .find(|&(i, _)| i == item)
        .unwrap()
        .1;
    let cmd = h.r.commands()[at];
    assert!(cmd.flags & flag::TEXTURED != 0);
    let staged = world_verts(&h.r, &cmd);
    let src = &pak.verts[pulled_mesh.vert_base as usize
        ..pulled_mesh.vert_base as usize + pulled_mesh.vert_count as usize];
    assert_eq!(staged.len(), src.len());
    for (got, pv) in staged.iter().zip(src.iter()) {
        let world = vec3(
            pv.x as f32 + pulled_mesh.off_x as f32,
            pv.y as f32,
            pv.z as f32 + pulled_mesh.off_y as f32,
        );
        let want = raster_pull(list.cam.eye, world, pulled_mesh.pull, true);
        assert_eq!(
            (got.x, got.y, got.z),
            (want.x as i16, want.y as i16, want.z as i16),
            "staged vertex must be the oracle's truncated position"
        );
        assert_eq!(got.abgr, pv.abgr, "the baked AO colour rides along");
    }
    assert_eq!(h.r.stats().pull_verts, pulled_mesh.vert_count as u32);
}

/// Untextured pulled geometry — the ghost — stays f32. Truncating it here
/// would be a divergence the rasterizer does not model.
#[test]
fn the_ghost_keeps_f32_positions() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let (verts, pull, abgr) = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::Ghost { verts, pull, abgr } => Some((*verts, *pull, *abgr)),
            _ => None,
        })
        .expect("the ghost-flagged entity emits one");
    assert_ne!(pull, 0.0);

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let cmd = *h
        .r
        .commands()
        .iter()
        .find(|c| c.depth == depth::INVERTED)
        .expect("the ghost's inverted-depth draw");
    assert_eq!(cmd.vfmt, vfmt::FLAT);
    assert_eq!(cmd.flags, flag::BLEND, "blended, untextured, no alpha test");
    let staged = flat_verts(&h.r, &cmd);
    let mut any_fractional = false;
    for (got, corner) in staged.iter().zip(verts.iter()) {
        let want = raster_pull(list.cam.eye, vec3(corner[0], corner[1], corner[2]), pull, false);
        assert_eq!(
            (got.x.to_bits(), got.y.to_bits(), got.z.to_bits()),
            (want.x.to_bits(), want.y.to_bits(), want.z.to_bits())
        );
        assert_eq!(got.abgr, abgr);
        any_fractional |= got.x.fract() != 0.0 || got.y.fract() != 0.0 || got.z.fract() != 0.0;
    }
    assert!(
        any_fractional,
        "if every ghost coordinate were integral this test could not tell f32 from i16"
    );
}

// ---------------------------------------------------------------------------
// 2. The sky pass
// ---------------------------------------------------------------------------

/// `Item::SkyBands` owns the frame clear, and the four bands slice
/// `[0, horizon_row)` by the rasterizer's own integer arithmetic:
/// `y0 = hr*i/4`, `y1 = hr*(i+1)/4`.
#[test]
fn the_sky_owns_the_clear_and_slices_rows_like_the_rasterizer() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let (colors, hr) = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::SkyBands {
                colors,
                horizon_row,
            } => Some((*colors, *horizon_row)),
            _ => None,
        })
        .expect("every frame opens with the sky");
    let hr = hr.clamp(0, spec::VIEW_H);
    assert!(hr > 0, "this camera has a horizon on screen");

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let cmds = h.r.commands();
    assert_eq!(cmds[0].kind, kind::CLEAR, "the clear is the frame's first command");
    assert_eq!(
        cmds[0].clear_abgr,
        colors[SKY_BANDS - 1],
        "the clear colour is the below-horizon band, day-tinted by the core"
    );
    assert!(cmds[1..].iter().all(|c| c.kind == kind::DRAW), "one clear only");

    // The bands, in order, with the rasterizer's row arithmetic.
    let bands: Vec<Cmd> = cmds[1..]
        .iter()
        .take_while(|c| c.vfmt == vfmt::FLAT && c.flags == 0)
        .copied()
        .collect();
    let mut expected = Vec::new();
    for (i, &c) in colors.iter().enumerate() {
        let y0 = hr * i as i32 / SKY_BANDS as i32;
        let y1 = hr * (i as i32 + 1) / SKY_BANDS as i32;
        if y1 > y0 {
            expected.push((y0, y1, c));
        }
    }
    assert_eq!(bands.len(), expected.len());
    for (cmd, (y0, y1, c)) in bands.iter().zip(expected.iter()) {
        assert_eq!(cmd.depth, depth::NONE, "sky bands never touch depth");
        let v = flat_verts(&h.r, cmd);
        assert_eq!(v.len(), 4);
        assert_eq!(v[0].x, 0.0);
        assert_eq!(v[1].x, spec::VIEW_W as f32, "a band spans the full width");
        assert_eq!(v[0].y, *y0 as f32);
        assert_eq!(v[2].y, *y1 as f32);
        assert!(v.iter().all(|q| q.abgr == *c));
        assert_eq!(indices(&h.r, cmd), vec![0, 1, 2, 0, 2, 3]);
    }
    // The slices tile [0, hr) exactly: no gap, no overlap, no rounding drift.
    assert_eq!(expected.first().unwrap().0, 0);
    assert_eq!(expected.last().unwrap().1, hr);
    for w in expected.windows(2) {
        assert_eq!(w[0].1, w[1].0);
    }
}

/// A horizon at row 0 clears and draws nothing — the camera is looking down.
#[test]
fn a_zero_horizon_clears_and_emits_no_bands() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let mut list = built(&pak, &demo_scene());
    for item in &mut list.items {
        if let Item::SkyBands { horizon_row, .. } = item {
            *horizon_row = 0;
        }
    }
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    assert_eq!(h.r.commands()[0].kind, kind::CLEAR);
    assert!(
        !h.r.commands()[1..]
            .iter()
            .any(|c| c.vfmt == vfmt::FLAT && c.flags == 0),
        "no bands below a zero horizon"
    );
}

// ---------------------------------------------------------------------------
// 3. biased_vp
// ---------------------------------------------------------------------------

/// The `pullDepthBias` rung draws its vertices IN PLACE and transforms them
/// through `draw::biased_vp` — the same one formulation the rasterizer uses —
/// with the PICA depth remap applied after it, not instead of it.
#[test]
fn a_depth_biased_mesh_draws_in_place_through_the_biased_vp() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    // The shipped `psp` rung sets pull_depth_bias.
    let s = demo_scene();
    assert!(spec::QUALITY[0].pull_depth_bias, "the psp rung biases rather than pulls");
    let list = built(&pak, &s);
    let biased = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::ChunkMesh { mesh, .. } if mesh.pull_bias != 0.0 => Some(*mesh),
            _ => None,
        })
        .expect("the psp rung biases grass instead of pulling it");
    assert_eq!(biased.pull, 0.0, "exactly one of the two is set");

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let src = &pak.verts
        [biased.vert_base as usize..biased.vert_base as usize + biased.vert_count as usize];
    let cmd = *h
        .r
        .commands()
        .iter()
        .find(|c| {
            c.flags & flag::TEXTURED != 0
                && c.vert_count == biased.vert_count as u32
                && world_verts(&h.r, c)
                    .iter()
                    .zip(src.iter())
                    .all(|(a, b)| (a.x, a.y, a.z) == (b.x, b.y, b.z))
        })
        .expect("a draw whose vertices are the pak's, unmoved");

    // The matrix is `pica_clip(biased_vp(vp, bias)) * translate(seam)`.
    let want = cmd::c3d_order(
        &cmd::pica_clip(&draw::biased_vp(&list.cam.vp, biased.pull_bias))
            .mul(&cmd::world_model(biased.off_x, biased.off_y)),
    );
    assert_eq!(h.r.matrices()[cmd.mtx as usize], want);
    // ...and it is NOT the unbiased one, which is what the whole rung buys.
    let plain = cmd::c3d_order(
        &cmd::pica_clip(&list.cam.vp).mul(&cmd::world_model(biased.off_x, biased.off_y)),
    );
    assert_ne!(h.r.matrices()[cmd.mtx as usize], plain);
}

/// Distinct matrices are deduplicated, so the C side uploads a handful of
/// uniforms per frame rather than one per draw.
#[test]
fn the_matrix_table_deduplicates() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    assert!(
        h.r.matrices().len() < h.r.commands().len(),
        "{} matrices for {} commands",
        h.r.matrices().len(),
        h.r.commands().len()
    );
    let mut seen: Vec<[f32; 16]> = Vec::new();
    for m in h.r.matrices() {
        assert!(!seen.contains(m), "the table holds a duplicate");
        seen.push(*m);
    }
    for c in h.r.commands() {
        if c.kind == kind::DRAW {
            assert!((c.mtx as usize) < h.r.matrices().len());
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Palette resolution and the tint
// ---------------------------------------------------------------------------

/// Every textured draw's palette is `draw::resolve_pal`'s answer and nothing
/// else, and the RED++ precedence survives the trip: the map's world CLUT on
/// meshes, the sprite page's OBJ CLUT on cards, the UI kind's own raw ramp on
/// the GB layer.
#[test]
fn every_textured_draw_carries_the_cores_resolved_palette() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);

    let mut mesh_pals = Vec::new();
    let mut card_pals = Vec::new();
    let mut ui_pals = Vec::new();
    for c in h.r.commands().iter().filter(|c| c.flags & flag::TEXTURED != 0) {
        let kind = pak.atlases[c.page as usize].kind;
        if kind == atlas_kind::UI {
            ui_pals.push((c.pal, c.flags & flag::TINTED));
        } else if kind == atlas_kind::SPRITES {
            card_pals.push(c.pal);
        } else {
            mesh_pals.push(c.pal);
        }
    }
    assert!(!mesh_pals.is_empty() && !card_pals.is_empty() && !ui_pals.is_empty());
    assert!(
        mesh_pals.iter().all(|&p| p == WORLD_PAL),
        "a mesh binds its map's VCOL world palette, which outranks the SGB selection"
    );
    assert!(
        card_pals.iter().all(|&p| p == OBJ_PAL),
        "a card binds its page's OBJ CLUT"
    );
    assert!(
        ui_pals
            .iter()
            .all(|&(p, t)| p == atlas_kind::UI && t == 0),
        "the GB UI keeps its own ramp and is NEVER tinted"
    );
    // Independently: the same answers straight from the core.
    assert_eq!(
        resolve_pal(&pak, 0, atlas_kind::TERRAIN, WORLD_PAL, list.palette),
        WORLD_PAL as usize
    );
    assert_eq!(
        resolve_pal(&pak, 1, atlas_kind::SPRITES, spec::COLOR_PAL_NONE, list.palette),
        OBJ_PAL as usize
    );
    assert_eq!(
        resolve_pal(&pak, 2, atlas_kind::UI, spec::COLOR_PAL_NONE, list.palette),
        atlas_kind::UI as usize
    );
}

/// The day tint is a palette modulation with `draw::modulate_rgb` — the
/// rasterizer's own integer `(c*t + 127)/255` — applied to the CLUT and never
/// as a post-pass or a vertex colour, and never to the GB UI layer.
#[test]
fn the_tint_modulates_the_palette_and_only_the_3d_passes() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let tint = list.tint;
    assert_ne!(tint & 0x00ff_ffff, 0x00ff_ffff, "the demo scene tints");

    let mut h = Harness::new();
    h.r.record(&list, &pak);

    // Not a vertex colour: the staged colours are the pak's own bytes.
    for c in h.r.commands().iter().filter(|c| c.flags & flag::TEXTURED != 0) {
        for v in world_verts(&h.r, c) {
            assert_ne!(
                v.abgr,
                modulate_rgb(0xffff_ffff, tint),
                "the tint must not ride the vertex colour"
            );
        }
    }

    // It is in the texels: expand one tinted key and one untinted one.
    let tinted_key = *h.r.keys().iter().find(|k| k.tinted).unwrap();
    let ui_key = *h.r.keys().iter().find(|k| !k.tinted).unwrap();
    let mut cache = TexCache::new();
    cache.set_tint(tint);
    for (key, want_tint) in [(tinted_key, Some(tint)), (ui_key, None)] {
        let (slot, needs) = cache.slot(&pak, key).unwrap();
        assert!(needs);
        let plan = cache.get(slot).unwrap().plan;
        let mut out = vec![0u16; plan.texels()];
        cache.fill(&pak, slot, &mut out).unwrap();
        let src = pak.palettes[key.pal as usize];
        for sy in 0..plan.src_h as usize {
            for sx in 0..plan.src_w as usize {
                let idx = tex::psp_texel(
                    pak.atlases[key.page as usize].frame(key.frame),
                    pak::swizzle_stride(plan.src_w as usize),
                    sx,
                    sy,
                );
                let want = match want_tint {
                    Some(t) => tex::abgr_to_rgba5551(modulate_rgb(src[idx as usize], t)),
                    None => tex::abgr_to_rgba5551(src[idx as usize]),
                };
                assert_eq!(tex::read_source_texel(&plan, &out, sx, sy), want);
            }
        }
    }
}

/// The texture key is the full `(page, frame, tinted, resolved VPAL)` tuple:
/// one page really does draw through several CLUTs in one frame, so a
/// narrower key would collapse two textures into one.
#[test]
fn one_page_binds_through_several_keys_in_one_frame() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let keys = h.r.keys();
    assert!(!keys.is_empty());
    // Deduplicated.
    for (i, k) in keys.iter().enumerate() {
        assert!(!keys[i + 1..].contains(k), "{k:?} listed twice");
    }
    // Every draw's key is in the set.
    for c in h.r.commands().iter().filter(|c| c.flags & flag::TEXTURED != 0) {
        let want = TexKey {
            page: c.page,
            frame: c.frame,
            pal: c.pal,
            tinted: c.flags & flag::TINTED != 0,
        };
        assert!(keys.contains(&want), "{want:?} missing from the frame's key set");
    }
    // The UI page and a 3D page differ in `tinted`, which is a key field.
    assert!(keys.iter().any(|k| k.tinted));
    assert!(keys.iter().any(|k| !k.tinted));
}

/// The terrain page animates, and the frame index is part of the key — the
/// core computes `mesh.frame` and this backend never re-derives it.
#[test]
fn the_animation_frame_comes_from_the_core_and_joins_the_key() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    assert_eq!(pak.atlases[0].frames, 2, "the demo terrain page animates");
    let mut frames = Vec::new();
    let mut s = demo_scene();
    for _ in 0..3 {
        let list = built(&pak, &s);
        let want = list
            .items
            .iter()
            .find_map(|i| match i {
                Item::ChunkMesh { mesh, .. } if mesh.page == 0 => Some(mesh.frame),
                _ => None,
            })
            .unwrap();
        let mut h = Harness::new();
        h.r.record(&list, &pak);
        let got = h
            .r
            .commands()
            .iter()
            .find(|c| c.flags & flag::TEXTURED != 0 && c.page == 0)
            .unwrap()
            .frame;
        assert_eq!(got, want, "the command carries the core's own mesh.frame");
        frames.push(got);
        for _ in 0..draw::TILE_ANIM_DIV {
            s.tick();
        }
    }
    assert!(frames.windows(2).any(|w| w[0] != w[1]), "the frame advanced");
}

// ---------------------------------------------------------------------------
// 5. Order, depth and state
// ---------------------------------------------------------------------------

/// Draw order is the list's order. The mapping is one command per item (the
/// sky's clear plus its bands, the UI's one batch), and nothing is reordered,
/// merged across kinds, or sorted.
#[test]
fn commands_follow_the_list_order() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);

    // Item by item, in list order: each one's command carries the state that
    // item's kind demands, and no item's command appears before an earlier
    // item's. `correspondence` panics if the two streams ever diverge.
    let pairs = correspondence(&list, h.r.commands());
    assert!(pairs.windows(2).all(|w| w[0].1 < w[1].1), "commands run forward");
    let mut kinds = Vec::new();
    for (item, at) in &pairs {
        let c = h.r.commands()[*at];
        match &list.items[*item] {
            Item::SkyBands { .. } => {
                assert_eq!(c.kind, kind::CLEAR);
                kinds.push("sky");
            }
            Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                assert_eq!(c.depth, depth::TEST_WRITE);
                assert_eq!(c.page, mesh.page, "a mesh binds the page the core chose");
                assert_eq!(c.index_count, mesh.index_count as u32);
                kinds.push("mesh");
            }
            Item::ShadowDecal { .. } => {
                assert_eq!((c.depth, c.flags), (depth::TEST, flag::BLEND));
                kinds.push("decal");
            }
            Item::Ghost { .. } => {
                assert_eq!((c.depth, c.flags), (depth::INVERTED, flag::BLEND));
                kinds.push("ghost");
            }
            Item::Card { page, .. } => {
                assert_eq!(c.depth, depth::TEST_WRITE);
                assert_eq!(c.page, *page);
                assert_eq!(c.vert_count, 4);
                kinds.push("card");
            }
            Item::UiQuad { page, .. } => {
                assert_eq!(c.depth, depth::NONE);
                assert_eq!(c.page, *page);
                kinds.push("ui");
            }
        }
    }
    // ...and the §3 draw order itself came through: sky, then the terrain
    // pass, then decals, the ghost, cards, the detail meshes, the GB UI.
    assert_eq!(kinds.first(), Some(&"sky"));
    assert_eq!(kinds.last(), Some(&"ui"), "the GB UI composites last");
    let first = |k: &str| kinds.iter().position(|x| *x == k).unwrap();
    let last = |k: &str| kinds.iter().rposition(|x| *x == k).unwrap();
    assert!(last("mesh") > first("card"), "grass and flowers draw over cards");
    assert!(first("decal") < first("ghost"));
    assert!(first("ghost") < first("card"));
    assert!(first("card") < last("mesh"));

    // Recording is a pure function of (list, pak): same list, same stream.
    let mut h2 = Harness::new();
    h2.r.record(&list, &pak);
    assert_eq!(h.r.commands(), h2.r.commands());
    assert_eq!(h.r.matrices(), h2.r.matrices());
}

/// The three depth behaviours the DrawList has, and no fourth.
#[test]
fn the_three_depth_behaviours_land_on_the_right_items() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);

    let n_decals = list
        .items
        .iter()
        .filter(|i| matches!(i, Item::ShadowDecal { .. }))
        .count();
    let n_ghosts = list
        .items
        .iter()
        .filter(|i| matches!(i, Item::Ghost { .. }))
        .count();
    let count = |d: u8| h.r.commands().iter().filter(|c| c.depth == d).count();
    assert_eq!(count(depth::TEST), n_decals, "decals test and never write");
    assert_eq!(count(depth::INVERTED), n_ghosts, "the ghost inverts the test");
    assert!(count(depth::TEST_WRITE) > 0, "meshes and cards test and write");

    for c in h.r.commands() {
        if c.kind == kind::CLEAR {
            continue;
        }
        // Every textured pass alpha-tests; nothing untextured does.
        assert_eq!(
            c.flags & flag::ALPHA_TEST != 0,
            c.flags & flag::TEXTURED != 0,
            "the alpha test is the texel cutout, so it rides the texture"
        );
        // Blending is the flat quads' alone.
        assert_eq!(
            c.flags & flag::BLEND != 0,
            c.depth == depth::TEST || c.depth == depth::INVERTED
        );
    }
}

/// The GB UI layer batches into one draw per contiguous same-page run, and
/// the batch is a faithful expansion: one quad per `UiQuad`, in list order,
/// with the rounded screen positions and raw-texel UVs.
#[test]
fn the_ui_layer_batches_without_reordering() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let quads: Vec<(f32, f32, f32, f32, u16)> = list
        .items
        .iter()
        .filter_map(|i| match i {
            Item::UiQuad { x, y, w, h, tile, .. } => Some((*x, *y, *w, *h, *tile)),
            _ => None,
        })
        .collect();
    assert!(quads.len() > 1, "the demo scene has a grid tile and text");

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let ui: Vec<Cmd> = h
        .r
        .commands()
        .iter()
        .filter(|c| c.depth == depth::NONE && c.flags & flag::TEXTURED != 0)
        .copied()
        .collect();
    assert_eq!(ui.len(), 1, "one bind and one draw for the whole layer");
    let cmd = ui[0];
    assert_eq!(cmd.vert_count as usize, quads.len() * 4);
    assert_eq!(cmd.index_count as usize, quads.len() * 6);

    let v = world_verts(&h.r, &cmd);
    let idx = indices(&h.r, &cmd);
    let cols = (pak.atlases[cmd.page as usize].w as i32 / spec::TILE_PX).max(1) as u16;
    for (q, &(x, y, w, hh, tile)) in quads.iter().enumerate() {
        let base = &v[q * 4..q * 4 + 4];
        assert_eq!(base[0].x, (x + 0.5) as i32 as i16, "quad {q} rounds to a pixel");
        assert_eq!(base[0].y, (y + 0.5) as i32 as i16);
        assert_eq!(base[2].x, (x + w + 0.5) as i32 as i16);
        assert_eq!(base[2].y, (y + hh + 0.5) as i32 as i16);
        let tx0 = (tile % cols) as i16 * spec::TILE_PX as i16;
        let ty0 = (tile / cols) as i16 * spec::TILE_PX as i16;
        assert_eq!((base[0].u, base[0].v), (tx0, ty0), "raw texel UVs");
        assert_eq!(
            (base[2].u, base[2].v),
            (tx0 + spec::TILE_PX as i16, ty0 + spec::TILE_PX as i16)
        );
        // The indices are relative to this draw's own vertex block.
        let b = (q * 4) as u16;
        assert_eq!(&idx[q * 6..q * 6 + 6], &[b, b + 1, b + 2, b, b + 2, b + 3]);
    }
    // Raw texel UVs normalize by the POT envelope, not by ÷32768.
    let plan = TexPlan::for_page(&pak, cmd.page).unwrap();
    assert_eq!(cmd.uv_scale, [1.0 / plan.width as f32, 1.0 / plan.height as f32]);
}

/// A card's UVs normalize U by the PAGE width (the core does that in
/// `sheet_uv`) and reach this backend as the pak's own fixed point.
#[test]
fn card_uvs_arrive_as_page_fractions_in_fixed_point() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let (verts, uv, mirror, page) = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::Card {
                verts,
                uv,
                mirror,
                page,
                ..
            } => Some((*verts, *uv, *mirror, *page)),
            _ => None,
        })
        .expect("the demo scene shows entity cards");
    let _ = verts;
    // The sheet is 64 wide and holds 16 px cells, so U stops at 16/64.
    assert_eq!(uv[2], spec::CELL_PX as f32 / pak.atlases[page as usize].w as f32);

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let cmd = *h
        .r
        .commands()
        .iter()
        .find(|c| c.page == page && c.vert_count == 4)
        .unwrap();
    let v = world_verts(&h.r, &cmd);
    let (u0, u1) = if mirror { (uv[2], uv[0]) } else { (uv[0], uv[2]) };
    let q = |f: f32| ((f.clamp(0.0, 1.0) * 32768.0) as i32).min(32767) as i16;
    assert_eq!(v[0].u, q(u0));
    assert_eq!(v[1].u, q(u1));
    assert_eq!(v[0].v, q(uv[3]), "verts are bl, br, tr, tl; v0 is the texture top");
    assert_eq!(v[3].v, q(uv[1]));
    // The scale folds the ÷32768 and the POT envelope into one multiply.
    let plan = TexPlan::for_page(&pak, page).unwrap();
    assert_eq!(
        cmd.uv_scale,
        [plan.u_scale / 32768.0, plan.v_scale / 32768.0]
    );
}

// ---------------------------------------------------------------------------
// 6. The arena
// ---------------------------------------------------------------------------

/// Every staged block lands inside the arena and the offsets a command
/// carries address it correctly — the C side binds `arena + vert_offset` and
/// starts its indices at 0.
#[test]
fn staged_blocks_stay_inside_the_arena() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let bank = (1 << 20) / 2;
    for c in h.r.commands().iter().filter(|c| c.kind == kind::DRAW) {
        // Both staged vertex formats are 16 bytes, which is what lets one
        // stride serve both attribute configurations.
        let vend = c.vert_offset as usize + c.vert_count as usize * 16;
        let iend = c.index_offset as usize + c.index_count as usize * 2;
        assert!(vend <= 1 << 20, "vertices ran off the arena");
        assert!(iend <= 1 << 20, "indices ran off the arena");
        assert_eq!(c.vert_offset % 16, 0, "blocks are 16-aligned");
        assert_eq!(c.index_offset % 16, 0);
        // Both blocks live in the same bank.
        assert_eq!(c.vert_offset as usize / bank, c.index_offset as usize / bank);
        // Indices never leave their own vertex block.
        assert!(indices(&h.r, c).iter().all(|&i| (i as u32) < c.vert_count));
    }
    assert_eq!(h.r.stats().dropped_arena, 0);
    assert_eq!(h.r.stats().dropped_texture, 0);
    assert_eq!(h.r.stats().uv_clamped, 0, "the cooker's UV inset holds");
}

/// A tiny arena drops draws and says so, instead of panicking on a handheld.
#[test]
fn an_arena_too_small_degrades_and_counts() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::with_bytes(512);
    h.r.record(&list, &pak);
    let s = h.r.stats();
    assert!(s.dropped_arena > 0, "a 256-byte bank cannot hold this frame");
    assert!(s.commands >= 1, "the clear still went out");
    assert_eq!(h.r.commands()[0].kind, kind::CLEAR);
    // Whatever survived is still well-formed.
    for c in h.r.commands().iter().filter(|c| c.kind == kind::DRAW) {
        assert!(c.vert_count > 0 && c.index_count > 0);
        assert!(c.vert_offset as usize + c.vert_count as usize * 16 <= 512);
    }
    // And a renderer with NO arena at all draws nothing but the clear.
    let mut bare = Renderer::new();
    bare.record(&list, &pak);
    assert_eq!(bare.commands().len(), 1);
    assert_eq!(bare.commands()[0].kind, kind::CLEAR);
    assert!(bare.stats().dropped_arena > 0);
}

/// Consecutive frames rewind into alternating banks, which is what lets the
/// GPU still be reading the previous frame.
#[test]
fn consecutive_frames_use_different_banks() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let first = h.r.commands()[1].vert_offset;
    h.r.record(&list, &pak);
    let second = h.r.commands()[1].vert_offset;
    assert_ne!(first, second, "frame 2 must not overwrite frame 1's bank");
    h.r.record(&list, &pak);
    assert_eq!(h.r.commands()[1].vert_offset, first, "two banks alternate");
}

// ---------------------------------------------------------------------------
// 7. The texture expansion cost over the shipped pak
// ---------------------------------------------------------------------------

/// "No paletted textures" is the port's one open-ended cost, so it is
/// measured rather than asserted: this walks the SHIPPED pak when it is
/// present and reports what the whole reachable expansion set would occupy.
///
/// The pak is ROM-derived and git-ignored, so the test SKIPS when it is
/// absent; it is evidence for a human running it locally, never a CI gate.
#[test]
fn the_expansion_set_over_the_shipped_pak() {
    let candidates = [
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../dist/voxelmon/voxelmon.vxpak"),
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../pocketvoxel-psp/target/mipsel-sony-psp/release/voxelmon.vxpak"
        ),
    ];
    let Some(path) = candidates.iter().find(|p| std::path::Path::new(p).exists()) else {
        std::eprintln!("SKIP: no cooked pak on disk (dist/ is git-ignored)");
        return;
    };
    let raw = std::fs::read(path).expect("read the pak");
    let blob = AlignedBlob::from_bytes(&raw);
    let pak = pak::read(blob.bytes()).expect("the shipped pak validates");

    // The reachable key set, enumerated the way `draw::build` actually binds
    // — not "every page against every palette", which over-counts badly:
    //   - a chunk / stamp / ground-bake mesh binds its MAP's page through
    //     that map's world palette (`MeshDraw::pal`), at every animation
    //     frame the page carries;
    //   - a card binds its own page with NO item palette, frame 0 (both
    //     backends sample `frames[0]` for a card);
    //   - the GB UI binds its page untinted, frame 0.
    // A bake page is only ever a mesh, and a sprite / pic page is only ever a
    // card, so neither picks up the other's palette.
    let mut keys: Vec<TexKey> = Vec::new();
    let mut push = |k: Option<TexKey>| {
        if let Some(k) = k {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    };
    let sel = -1i32;
    for m in &pak.maps {
        let page = pak
            .map_terrain_page(m.map_id)
            .or_else(|| pak.page_of_kind(atlas_kind::TERRAIN))
            .unwrap_or(0);
        let wpal = pak.map_world_pal(m.map_id).unwrap_or(spec::COLOR_PAL_NONE);
        for f in 0..pak.atlases[page as usize].frames {
            push(TexKey::resolve(&pak, page, f, wpal, sel, true));
        }
        for c in pak.chunks_of(m) {
            if c.bake_page != spec::BAKE_PAGE_NONE {
                push(TexKey::resolve(&pak, c.bake_page, 0, wpal, sel, true));
            }
        }
    }
    let bake_pages: Vec<u16> = pak
        .chunks
        .iter()
        .map(|c| c.bake_page)
        .filter(|&p| p != spec::BAKE_PAGE_NONE)
        .collect();
    let terrain_pages: Vec<u16> = pak
        .maps
        .iter()
        .filter_map(|m| pak.map_terrain_page(m.map_id))
        .chain(pak.page_of_kind(atlas_kind::TERRAIN))
        .collect();
    for (i, p) in pak.atlases.iter().enumerate() {
        let idx = i as u16;
        if p.kind == atlas_kind::UI {
            push(TexKey::resolve(&pak, idx, 0, spec::COLOR_PAL_NONE, sel, false));
        } else if !bake_pages.contains(&idx) && !terrain_pages.contains(&idx) {
            push(TexKey::resolve(&pak, idx, 0, spec::COLOR_PAL_NONE, sel, true));
        }
    }

    let mut cache = TexCache::with_budget(usize::MAX);
    let mut biggest = 0usize;
    for k in &keys {
        let (slot, _) = cache.slot(&pak, *k).expect("every reachable key plans");
        biggest = biggest.max(cache.get(slot).unwrap().plan.bytes());
    }
    let st = cache.stats();
    std::eprintln!(
        "MEASURED texture expansion over {path}:\n  \
         {} atlas pages, {} palettes -> {} distinct textures\n  \
         {:.2} MiB of linear memory ({:.2} MiB of it POT padding)\n  \
         largest single texture {} bytes",
        pak.atlases.len(),
        pak.palettes.len(),
        st.textures,
        st.bytes as f64 / (1024.0 * 1024.0),
        st.padding_bytes as f64 / (1024.0 * 1024.0),
        biggest,
    );
    // The Old 3DS has 32 MiB of linear memory and this backend also wants
    // 12 MiB of vertex arena, so the whole expansion has to fit under the
    // cache's own budget with the arena still affordable beside it.
    assert!(
        st.bytes <= tex::DEFAULT_BUDGET_BYTES,
        "the expansion set grew past the cache budget: {} bytes over {}",
        st.bytes,
        tex::DEFAULT_BUDGET_BYTES
    );
    assert!(
        st.bytes + DEFAULT_ARENA_BYTES < 32 * 1024 * 1024,
        "textures + vertex arena no longer fit an Old 3DS linear heap"
    );
    assert_eq!(st.textures as usize, keys.len());
}

// ---------------------------------------------------------------------------
// 8. Geometry that must not move
// ---------------------------------------------------------------------------

/// The letterbox is the widest rectangle on the top screen that keeps the
/// cooked 480x272 aspect, so nothing in the picture is stretched or cropped.
#[test]
fn the_letterbox_preserves_the_cooked_aspect() {
    assert_eq!((VIEWPORT_W, VIEWPORT_H), (400, 226));
    assert_eq!(VIEWPORT_Y, 7);
    let cooked = spec::VIEW_W as f64 / spec::VIEW_H as f64;
    let shown = VIEWPORT_W as f64 / VIEWPORT_H as f64;
    assert!(
        (cooked - shown).abs() < 0.01,
        "aspect drift {cooked} vs {shown}"
    );
    // Fitting by height would have cost horizontal picture instead.
    let fit_h = SCREEN_H * spec::VIEW_W / spec::VIEW_H;
    assert!(fit_h > SCREEN_W, "fit-by-height crops {} px", fit_h - SCREEN_W);
}

/// An unpulled mesh draws the pak's own vertices, byte for byte, so the only
/// per-frame CPU cost is the copy linear memory forces.
#[test]
fn an_unpulled_mesh_stages_the_pak_vertices_unchanged() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let terrain = list
        .items
        .iter()
        .find_map(|i| match i {
            Item::ChunkMesh { kind, mesh, .. } if *kind == mesh_kind::TERRAIN => Some(*mesh),
            _ => None,
        })
        .unwrap();
    assert_eq!((terrain.pull, terrain.pull_bias), (0.0, 0.0));

    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let src = &pak.verts
        [terrain.vert_base as usize..terrain.vert_base as usize + terrain.vert_count as usize];
    let cmd = *h
        .r
        .commands()
        .iter()
        .find(|c| c.flags & flag::TEXTURED != 0 && c.vert_count == terrain.vert_count as u32)
        .unwrap();
    for (got, want) in world_verts(&h.r, &cmd).iter().zip(src.iter()) {
        assert_eq!(got.u as u16, want.u);
        assert_eq!(got.v as u16, want.v);
        assert_eq!(got.abgr, want.abgr);
        assert_eq!((got.x, got.y, got.z), (want.x, want.y, want.z));
    }
    // The seam translation is the model matrix's job, not the vertices'.
    let want = cmd::c3d_order(
        &cmd::pica_clip(&list.cam.vp).mul(&cmd::world_model(terrain.off_x, terrain.off_y)),
    );
    assert_eq!(h.r.matrices()[cmd.mtx as usize], want);
}

/// The u16 -> i16 UV clamp fires when a UV really does reach 1.0, and only
/// then. The cooker's inset means it should never fire on real content, which
/// is why the counter exists.
#[test]
fn a_full_scale_uv_clamps_and_is_counted() {
    let mut b = PakBuilder::new();
    let pal = [0xffff_ffffu32; 256];
    for _ in 0..3 {
        b.palette(pal);
    }
    b.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&vec![1u8; 256]]);
    b.atlas_linear(16, 16, atlas_kind::SPRITES, &[&vec![1u8; 256]]);
    b.atlas_linear(16, 16, atlas_kind::UI, &[&vec![1u8; 256]]);
    let v = |x: i16, z: i16, u: u16| PakVert {
        u,
        v: u,
        abgr: 0xffff_ffff,
        x,
        y: 0,
        z,
        pad: 0,
    };
    // 32768 is `uv == 1.0` in the pak's fixed point, one past i16.
    let m = b.mesh(
        &[
            v(0, 0, 0),
            v(128, 0, 32768),
            v(128, 128, 32768),
            v(0, 128, 0),
        ],
        &[0, 1, 2, 0, 2, 3],
    );
    let mut meshes = [MeshRange::default(); spec::MESH_KINDS];
    meshes[mesh_kind::TERRAIN as usize] = m;
    b.map(
        7,
        &[ChunkDef {
            cx: 0,
            cy: 0,
            aabb_min: [0, 0, 0],
            aabb_max: [128, 0, 128],
            bake_page: spec::BAKE_PAGE_NONE,
            meshes,
        }],
    );
    b.stamps(7, &[]);
    b.game(b"{}");
    let bytes = b.finish();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let mut s = Scene::new();
    s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
    s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
    let list = built(&pak, &s);
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    assert_eq!(h.r.stats().uv_clamped, 4, "two verts x two axes");
    let cmd = *h
        .r
        .commands()
        .iter()
        .find(|c| c.flags & flag::TEXTURED != 0)
        .unwrap();
    let v = world_verts(&h.r, &cmd);
    assert_eq!(v[1].u, 32767, "clamped to the i16 ceiling, one part in 32768");
    assert_eq!(v[0].u, 0);
}

/// The screen matrix maps the DrawList's own 480x272 coordinates, so the
/// letterbox is a viewport rectangle and not a second coordinate system.
#[test]
fn screen_space_stays_the_cooked_frame() {
    let bytes = demo_pak();
    let blob = AlignedBlob::from_bytes(&bytes);
    let pak = pak::read(blob.bytes()).unwrap();
    let list = built(&pak, &demo_scene());
    let mut h = Harness::new();
    h.r.record(&list, &pak);
    let sky = *h
        .r
        .commands()
        .iter()
        .find(|c| c.kind == kind::DRAW && c.vfmt == vfmt::FLAT && c.flags == 0)
        .unwrap();
    let ui = *h
        .r
        .commands()
        .iter()
        .find(|c| c.depth == depth::NONE && c.flags & flag::TEXTURED != 0)
        .unwrap();
    assert_eq!(
        h.r.matrices()[sky.mtx as usize], h.r.matrices()[ui.mtx as usize],
        "the sky and the GB UI share one screen matrix"
    );
    assert_eq!(h.r.matrices()[sky.mtx as usize], cmd::c3d_order(&cmd::screen_clip()));
}

/// `Mat4` is column-major and `C3D_Mtx` is row-major with reversed rows, so a
/// matrix that survives both reversals transforms a point the same way the
/// core's own `transform` does. This is the check a single-reversal bug fails.
#[test]
fn a_c3d_ordered_matrix_still_transforms_correctly() {
    let vp = Mat4::perspective_gl(1.0, 480.0 / 272.0, 1.0, 512.0).mul(&Mat4::look_at(
        vec3(0.0, 100.0, 100.0),
        Vec3::ZERO,
        Vec3::Y,
    ));
    let m = cmd::pica_clip(&vp).mul(&cmd::world_model(32, -16));
    let c = cmd::c3d_order(&m);
    // Read `c` back the way a PICA vertex shader does: row i dotted with the
    // vertex, where C3D_Mtx row i is stored (w, z, y, x).
    let p = vec3(12.0, 4.0, -30.0);
    let v = [p.x, p.y, p.z, 1.0];
    let mut out = [0.0f32; 4];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (0..4).map(|j| c[i * 4 + (3 - j)] * v[j]).sum();
    }
    let want = m.transform(p, 1.0);
    for (got, want) in out.iter().zip([want.x, want.y, want.z, want.w].iter()) {
        assert!((got - want).abs() < 1e-3, "{got} vs {want}");
    }
}

// ---------------------------------------------------------------------------
// 9. The C ABI
// ---------------------------------------------------------------------------

/// The exact layout `include/pocketvoxel_pica.h` declares. `abi_probe.c`
/// `_Static_assert`s the same numbers under devkitARM, so the two sides of
/// the boundary are pinned against each other rather than against memory.
#[test]
fn abi_layout() {
    use core::mem::{offset_of, size_of};
    std::eprintln!("PvPicaCmd     {} bytes", size_of::<Cmd>());
    std::eprintln!("PvPicaTexKey  {} bytes", size_of::<TexKey>());
    std::eprintln!("PvPicaTexPlan {} bytes", size_of::<TexPlan>());
    std::eprintln!("PvPicaStats   {} bytes", size_of::<Stats>());
    assert_eq!(size_of::<Cmd>(), 40);
    for (name, got, want) in [
        ("kind", offset_of!(Cmd, kind), 0),
        ("vfmt", offset_of!(Cmd, vfmt), 1),
        ("depth", offset_of!(Cmd, depth), 2),
        ("flags", offset_of!(Cmd, flags), 3),
        ("page", offset_of!(Cmd, page), 4),
        ("frame", offset_of!(Cmd, frame), 6),
        ("pal", offset_of!(Cmd, pal), 8),
        ("mtx", offset_of!(Cmd, mtx), 10),
        ("vert_offset", offset_of!(Cmd, vert_offset), 12),
        ("vert_count", offset_of!(Cmd, vert_count), 16),
        ("index_offset", offset_of!(Cmd, index_offset), 20),
        ("index_count", offset_of!(Cmd, index_count), 24),
        ("clear_abgr", offset_of!(Cmd, clear_abgr), 28),
        ("uv_scale", offset_of!(Cmd, uv_scale), 32),
    ] {
        assert_eq!(got, want, "PvPicaCmd.{name}");
    }
    assert_eq!(size_of::<TexKey>(), 8);
    assert_eq!(offset_of!(TexKey, tinted), 6);
    assert_eq!(size_of::<TexPlan>(), 16);
    assert_eq!(offset_of!(TexPlan, width), 4);
    assert_eq!(offset_of!(TexPlan, u_scale), 8);
    assert_eq!(size_of::<Stats>(), 44);
    assert_eq!(offset_of!(Stats, uv_clamped), 40);
    assert_eq!(size_of::<WorldVert>(), 16);
    assert_eq!(size_of::<FlatVert>(), 16);
}
