//! The per-frame draw list: one ordered, backend-neutral description of the
//! frame, built from the retained scene + the pak. The software rasterizer
//! (`pocketvoxel-sim`) and the future sceGu backend consume the same items,
//! so everything positional — billboard lean, camera-ward pull, culling,
//! draw order — is decided HERE, once.
//!
//! Draw order (docs/VOXEL.md §3, the mod minus shader-bound passes):
//! sky bands → terrain chunks (+ stamps) → water → shadow decals → player
//! ghost (inverted depth, no write) → entity cards → grass → flower → GB UI.
//! Stamps are terrain sub-meshes and draw in the terrain pass. The `walker`
//! entity flag needs no ordering here: every card already draws before the
//! grass mesh, which is what grants grass its occlusion of walker feet.

use alloc::vec::Vec;

use crate::cam::{self, Camera, horizon_row};
use crate::math::{Mat4, Vec3, sinf, vec3};
use crate::pak::{EMOTE_PAGE_NONE, Pak};
use crate::scene::Scene;
use crate::spec::{
    self, CELL_PX, COLOR_PAL_NONE, FLOWER_PULL_SUB_PX, GHOST_ABGR, PULL_BASE, PULL_MIN_SIN,
    PULL_NUM, PULL_SUB, SHADOW_ALPHA_BATTLE, SHADOW_ALPHA_FIELD, VIEW_H, atlas_kind, ent_flag,
    mesh_kind,
};
use crate::ui;

/// Tile animation clock divisor: animated atlas pages step one frame every
/// 30 ticks (0.5 s at 60 Hz) — `frame = (tick / TILE_ANIM_DIV) % frames`.
/// Pinned here so the sim and the GE backend can never disagree; the tick
/// index is the only clock (docs/VOXEL.md §7).
pub const TILE_ANIM_DIV: u32 = 30;

/// Sky gradient band count and colors (zenith → horizon, ABGR), modulated
/// by the day tint. `colors[SKY_BANDS - 1]` doubles as the backdrop clear
/// color below the horizon.
pub const SKY_BANDS: usize = 4;
pub const SKY_ABGR: [u32; SKY_BANDS] = [0xffc08040, 0xffd0a060, 0xffe0c090, 0xfff0e0c0];

/// VPAL layout (voxel-spec.ts §VXPK_TAG.palette): the 4 ATLAS_KIND default
/// (GB grayscale) palettes, then the SGB set. [`DrawList::palette`] indexes
/// the SGB set, so backends sample `VPAL[SGB_PAL_BASE + palette]` for the
/// non-ui kinds when a palette is selected.
pub const SGB_PAL_BASE: usize = spec::atlas_kind::PICS as usize + 1;

/// The VPAL entry ONE textured draw samples, resolving the precedence the
/// spec pins for `VXPK_TAG.color`:
///
/// 1. the item's own VCOL palette (a chunk/stamp mesh carries its map slot's
///    world palette in [`MeshDraw::pal`]);
/// 2. the page's VCOL `page_pal` (sprite OBJ / battle pic);
/// 3. the `palette` op's SGB selection — `VPAL[SGB_PAL_BASE + i]`, non-ui
///    kinds only;
/// 4. the page kind's own GB grayscale ramp.
///
/// BOTH backends call this — the software rasterizer and the GE backend must
/// bind the same CLUT for the same draw, and that agreement is what the
/// whole per-tile color design rests on. Every rung is range-checked: the op
/// stream and the pak are both untrusted here.
pub fn resolve_pal(pak: &Pak, page: u16, kind: u16, pal: u16, selection: i32) -> usize {
    if pal != COLOR_PAL_NONE && (pal as usize) < pak.palettes.len() {
        return pal as usize;
    }
    if kind != atlas_kind::UI
        && let Some(p) = pak.page_pal(page)
        && (p as usize) < pak.palettes.len()
    {
        return p as usize;
    }
    if kind != atlas_kind::UI && selection >= 0 {
        let sgb = SGB_PAL_BASE + selection as usize;
        if sgb < pak.palettes.len() {
            return sgb;
        }
    }
    kind as usize
}

/// THE distance test every quality dial uses (voxel-spec.ts §quality ladder).
///
/// `dist2` is the squared planar distance from the view centre to a chunk's
/// own centre and `half` that chunk's half-extent, both computed once per
/// visible chunk in [`build`]; `limit` is the dial. The half-extent widens
/// the limit, so a chunk counts as inside the moment any part of it is.
///
/// Every dial compares through this one function against that one pair —
/// the chunk cap and the grass/flower fades cannot drift apart, and a dial
/// added for a later rung measures exactly what the goldens were recorded
/// with. `QUALITY_UNBOUNDED` is finite by construction, so the widened
/// square stays a number; `QUALITY_OFF` (any negative limit) admits
/// NOTHING — the half-extent widening means even a 0 dial still reaches
/// the chunk under the view centre, so "off" is a sign, not a small number,
/// and squaring must not be allowed to erase it.
#[inline]
pub fn within_dist(dist2: f32, half: f32, limit: f32) -> bool {
    if limit < 0.0 {
        return false;
    }
    let r = limit + half;
    dist2 <= r * r
}

/// A chunk that passed the frustum and the rung's chunk cap, plus the
/// distance pair the per-mesh dials re-test against.
struct Visible<'p> {
    slot: u8,
    ox: i32,
    oy: i32,
    chunk: &'p crate::pak::Chunk,
    /// Squared planar distance, view centre → chunk centre (world px²).
    dist2: f32,
    /// Chunk half-extent, world px — widens every dial's limit.
    half: f32,
}

/// Entity shadow decal: half-extents as fractions of the card width, and a
/// lift above the feet so the decal never z-fights the ground it sits on.
pub const SHADOW_W_FRAC: f32 = 0.375;
pub const SHADOW_D_FRAC: f32 = 0.1875;
pub const SHADOW_LIFT_PX: f32 = 0.5;

/// Emote bubbles hover this many px above the entity's feet (one card
/// height plus a 2 px gap).
pub const EMOTE_LIFT_PX: f32 = 18.0;

/// The mod's billboard camera-ward pull (world px), a projection-invariant
/// depth bias: `PULL_BASE + max(0, PULL_NUM*cos a - PULL_SUB) / max(sin a,
/// PULL_MIN_SIN)` with `a` the camera pitch from straight down. Applied by
/// backends along each vertex's own eye ray.
pub fn card_pull(a: f32) -> f32 {
    use crate::math::cosf;
    PULL_BASE + (PULL_NUM * cosf(a) - PULL_SUB).max(0.0) / sinf(a).max(PULL_MIN_SIN)
}

/// The constant NDC-depth bias equal to `pull`'s geometric depth shift AT
/// THE CAMERA FOCUS (voxel-spec.ts §quality ladder, `pullDepthBias`): the
/// focus is the player's own cell under the orbit rig and the arena centre
/// under a battle rig — exactly where grass-over-feet layering is a gameplay
/// contract, so the two pull modes agree there by construction and drift
/// only away from the focus plane.
pub fn depth_bias(cam: &Camera, pull: f32) -> f32 {
    let ndc_z = |p: Vec3| {
        let c = cam.vp.transform(p, 1.0);
        if c.w.abs() > 1e-12 { c.z / c.w } else { 0.0 }
    };
    let toward = cam.eye.sub(cam.focus).normalize();
    ndc_z(cam.focus.add(toward.scale(pull))) - ndc_z(cam.focus)
}

/// The VP with a constant NDC-z bias folded in — `z_clip += bias * w_clip`,
/// so every vertex moves by `bias` in NDC depth and nowhere on screen. THE
/// one formulation: the software rasterizer and the GE backend both
/// transform a depth-biased mesh through exactly this matrix, which is what
/// lets the spec talk about one bias instead of two implementations.
pub fn biased_vp(vp: &Mat4, bias: f32) -> Mat4 {
    let mut m = *vp;
    for c in 0..4 {
        m.m[c * 4 + 2] += bias * m.m[c * 4 + 3];
    }
    m
}

/// One indexed mesh range over the pak's shared pools, ready for a backend.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshDraw {
    pub vert_base: u32,
    pub vert_count: u16,
    pub index_base: u32,
    pub index_count: u16,
    /// Atlas page + animation frame to bind.
    pub page: u16,
    pub frame: u16,
    /// The owning map's RED++ world palette (VPAL index), or
    /// `COLOR_PAL_NONE` — the first rung of [`resolve_pal`]. Per MAP, not
    /// per page: two maps with different roofs share one terrain page and
    /// differ only in this CLUT.
    pub pal: u16,
    /// The owning map slot's seam translation, world px (x east, z south).
    pub off_x: i32,
    pub off_y: i32,
    /// Camera-ward pull, world px, applied per vertex along its eye ray
    /// (0 for terrain/water; grass and flower meshes carry their bias here
    /// so both backends displace identically).
    pub pull: f32,
    /// The `pullDepthBias` rung's alternative to `pull`: a constant NDC-z
    /// bias folded into the VP ([`biased_vp`]) while the vertices draw in
    /// place. Exactly one of `pull`/`pull_bias` is nonzero on a pulled mesh;
    /// both are 0 everywhere else.
    pub pull_bias: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    /// Horizontal gradient bands over rows `[0, horizon_row)`; everything
    /// below clears to `colors[SKY_BANDS - 1]`. Drawn first, no depth.
    SkyBands {
        colors: [u32; SKY_BANDS],
        horizon_row: i32,
    },
    /// A chunk mesh of one `spec::mesh_kind`, frustum-culled by its AABB.
    ChunkMesh { slot: u8, kind: u16, mesh: MeshDraw },
    /// A removable stamp sub-mesh (terrain pass).
    StampMesh { slot: u8, mesh: MeshDraw },
    /// Flat-color blended quad on the ground under an entity/card.
    /// Depth-tested, never depth-written. Corners: bl, br, tr, tl.
    ShadowDecal { corners: [[f32; 3]; 4], abgr: u32 },
    /// The player silhouette: the card again, flat color, inverted depth
    /// test (draws only where occluded), no depth write.
    Ghost {
        verts: [[f32; 3]; 4],
        pull: f32,
        abgr: u32,
    },
    /// A billboard card. Verts: bl, br, tr, tl (world space, unleaned pull —
    /// backends displace by `pull` along each vertex's eye ray). `uv` is
    /// `[u0, v0, u1, v1]` with v0 the texture top; `mirror` swaps u0/u1.
    Card {
        verts: [[f32; 3]; 4],
        page: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
    },
    /// A GB UI tile, screen space, composited last with no depth.
    UiQuad {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        page: u16,
        tile: u16,
    },
}

/// One frame, plain data. `cam` carries the VP and the eye for the pull;
/// `tint` is the day tint backends fold into the CLUT (sky bands arrive
/// pre-tinted). `palette` is the selected SGB palette (index into the pak's
/// SGB set, `VPAL[SGB_PAL_BASE + i]`) the non-ui kinds sample through, or
/// -1 for the GB grayscale ramp; the day tint still modulates on top, and
/// the ui kind always keeps its own raw ramp. On a pak carrying RED++
/// per-tile color the pak's own bindings outrank this selection — see
/// [`resolve_pal`], which every textured draw goes through.
pub struct DrawList {
    pub cam: Camera,
    pub tint: u32,
    pub palette: i32,
    pub items: Vec<Item>,
}

/// Modulate a color's RGB by a tint's RGB (alpha kept). Integer rounding,
/// so backends can match it exactly.
pub fn modulate_rgb(c: u32, tint: u32) -> u32 {
    let r = (((c & 0xff) * (tint & 0xff)) + 127) / 255;
    let g = ((((c >> 8) & 0xff) * ((tint >> 8) & 0xff)) + 127) / 255;
    let b = ((((c >> 16) & 0xff) * ((tint >> 16) & 0xff)) + 127) / 255;
    (c & 0xff00_0000) | (b << 16) | (g << 8) | r
}

/// Billboard quad at `feet`, `w` x `h` world px, leaning back by exactly
/// the camera pitch `a` about its feet: the card's up axis is the orbit
/// camera's own up, `(0, sin a, -cos a)` — flat on the ground at rung 0,
/// upright at a horizontal camera. Verts: bl, br, tr, tl.
pub fn card_verts(feet: Vec3, w: f32, h: f32, a: f32) -> [[f32; 3]; 4] {
    use crate::math::cosf;
    let up = vec3(0.0, sinf(a), -cosf(a));
    let half = w * 0.5;
    let bl = vec3(feet.x - half, feet.y, feet.z);
    let br = vec3(feet.x + half, feet.y, feet.z);
    let tl = bl.add(up.scale(h));
    let tr = br.add(up.scale(h));
    [
        [bl.x, bl.y, bl.z],
        [br.x, br.y, br.z],
        [tr.x, tr.y, tr.z],
        [tl.x, tl.y, tl.z],
    ]
}

fn shadow_quad(center: Vec3, card_w: f32) -> [[f32; 3]; 4] {
    let hw = card_w * SHADOW_W_FRAC;
    let hd = card_w * SHADOW_D_FRAC;
    let y = center.y + SHADOW_LIFT_PX;
    [
        [center.x - hw, y, center.z - hd],
        [center.x + hw, y, center.z - hd],
        [center.x + hw, y, center.z + hd],
        [center.x - hw, y, center.z + hd],
    ]
}

fn alpha_abgr(alpha: f32) -> u32 {
    ((alpha * 255.0 + 0.5) as u32) << 24
}

/// The camera for the current scene state: the battle rig while an arena is
/// staged, the free-roam orbit otherwise.
pub fn camera(scene: &Scene) -> Camera {
    if scene.battle.active {
        let b = &scene.battle;
        let (px, py, ex, ey) = match b.shape {
            // narrow 1x4: enemy at (0,0), player at (0,3).
            x if x == spec::arena_shape::NARROW => (b.x, b.y + 3, b.x, b.y),
            // wide 3x6: enemy at (1,1), player at (1,4).
            _ => (b.x + 1, b.y + 4, b.x + 1, b.y + 1),
        };
        let (ox, oy) = slot0_offset(scene);
        let centre = |cx: i32, cy: i32| {
            vec3(
                (cx * CELL_PX + CELL_PX / 2 + ox) as f32,
                0.0,
                (cy * CELL_PX + CELL_PX / 2 + oy) as f32,
            )
        };
        let p = centre(px, py);
        let e = centre(ex, ey);
        let mid = p.add(e).scale(0.5);
        let axis_yaw = crate::math::atan2f(e.x - p.x, -(e.z - p.z));
        cam::battle(&cam::RigInput {
            rig: b.rig,
            orbit_q8: b.orbit,
            pitch_q8: b.pitch,
            zoom_q8: b.zoom,
            tick: scene.tick,
            mid,
            axis_yaw,
        })
    } else {
        let (cx, cy) = scene.cam_px();
        cam::orbit(cx, cy, scene.pitch_deg())
    }
}

fn slot0_offset(scene: &Scene) -> (i32, i32) {
    let s = &scene.maps[0];
    if s.shown { (s.ox, s.oy) } else { (0, 0) }
}

/// Build the frame's draw list. Pure: (scene, pak) → items, no host state.
pub fn build(scene: &Scene, pak: &Pak) -> DrawList {
    let cam = camera(scene);
    let frustum = cam.frustum();
    let mut items = Vec::new();

    // 1. Sky.
    let mut colors = SKY_ABGR;
    for c in &mut colors {
        *c = modulate_rgb(*c, scene.tint);
    }
    items.push(Item::SkyBands {
        colors,
        horizon_row: horizon_row(&cam, VIEW_H),
    });

    // Visible chunks, gathered once and replayed per mesh-kind pass.
    // The gather stays SLOT-MAJOR: one map's chunks are contiguous, so its
    // world CLUT binds once per pass instead of once per chunk.
    let terrain_page = pak.page_of_kind(atlas_kind::TERRAIN);
    // Per map slot: the terrain page and world palette its chunks bind.
    // Only 5 slots exist, so a flat lookup beats widening the gather tuple.
    let mut slot_page = [terrain_page.unwrap_or(0); crate::scene::MAP_SLOTS];
    let mut slot_pal = [COLOR_PAL_NONE; crate::scene::MAP_SLOTS];
    let mut visible: Vec<Visible<'_>> = Vec::new();
    let mut shown_maps: Vec<(u8, u32, i32, i32)> = Vec::new();
    // The rung this host climbed to: grass/flower draw distances and the
    // chunk cap, all applied below through `within_dist`.
    let dials = scene.dials();
    {
        for (slot, ms) in scene.maps.iter().enumerate() {
            if !ms.shown {
                continue;
            }
            let Some(dir) = pak.find_map(ms.map_id) else {
                continue; // a slot showing a map this pak doesn't know draws nothing
            };
            shown_maps.push((slot as u8, ms.map_id, ms.ox, ms.oy));
            if let Some(page) = pak.map_terrain_page(ms.map_id) {
                slot_page[slot] = page;
            }
            slot_pal[slot] = pak.map_world_pal(ms.map_id).unwrap_or(COLOR_PAL_NONE);
            for chunk in pak.chunks_of(dir) {
                let mins = vec3(
                    (chunk.aabb_min[0] as i32 + ms.ox) as f32,
                    chunk.aabb_min[1] as f32,
                    (chunk.aabb_min[2] as i32 + ms.oy) as f32,
                );
                let maxs = vec3(
                    (chunk.aabb_max[0] as i32 + ms.ox) as f32,
                    chunk.aabb_max[1] as f32,
                    (chunk.aabb_max[2] as i32 + ms.oy) as f32,
                );
                // Distance cap on top of the frustum: at the orbit rungs the
                // playable view depth is bounded, but the frustum's far plane
                // is effectively infinite (dist*4 + 4096), so a leaned camera
                // otherwise admits every chunk up-map. 2.5 view heights is
                // the mod's own north-reach cap for its shadow frustum; the
                // real PSP GE is the budget this protects (measured: Pallet
                // full-set 56 ms -> bounded set well under half). It is the
                // rung's `chunk_dist` dial now, held at 2.5 view heights on
                // every rung — see voxel-spec.ts §quality ladder.
                let (ccx, ccy) = (
                    (mins.x + maxs.x) * 0.5 - scene.cam_x as f32 / crate::spec::Q4 as f32,
                    (mins.z + maxs.z) * 0.5 - scene.cam_y as f32 / crate::spec::Q4 as f32,
                );
                let half = (maxs.x - mins.x).max(maxs.z - mins.z) * 0.5;
                let dist2 = ccx * ccx + ccy * ccy;
                if within_dist(dist2, half, dials.chunk_dist) && frustum.intersects_aabb(mins, maxs)
                {
                    visible.push(Visible {
                        slot: slot as u8,
                        ox: ms.ox,
                        oy: ms.oy,
                        chunk,
                        dist2,
                        half,
                    });
                }
            }
        }
    }

    let a = cam.a;
    let pull_card = card_pull(a);
    let pull_flower = (pull_card - FLOWER_PULL_SUB_PX * sinf(a)).max(0.0);
    // The rung's pull MODE (§quality ladder `pullDepthBias`): geometric —
    // the pull rides every vertex — or one NDC-depth bias per mesh with the
    // vertices drawn in place. Cards always pull geometrically (4 verts);
    // the bias is computed to match them exactly at the camera focus.
    let (grass_pull, grass_bias, flower_pull, flower_bias) = if dials.pull_depth_bias {
        (
            0.0,
            depth_bias(&cam, pull_card),
            0.0,
            depth_bias(&cam, pull_flower),
        )
    } else {
        (pull_card, 0.0, pull_flower, 0.0)
    };
    let anim_frame = |frames: u16| ((scene.tick / TILE_ANIM_DIV) % frames as u32) as u16;

    // The ground bake replaces an eligible chunk's terrain + grass + flower
    // past the rung's dial (§quality ladder `groundBakeDist`) — and only
    // where the bake is exact: field play at the rung-2 REST pitch, the
    // projection it was cooked at. A battle rig, another pitch rung or a
    // live tween falls back to full geometry: slower, never wrong.
    let bake_ok = !scene.battle.active
        && scene.pitch_rung == 2
        && scene.pitch_t >= spec::PITCH_TWEEN_TICKS;
    let baked = |v: &Visible<'_>| -> bool {
        bake_ok
            && v.chunk.bake_page != spec::BAKE_PAGE_NONE
            && v.chunk.meshes[mesh_kind::GROUND_BAKE as usize].index_count > 0
            && !within_dist(v.dist2, v.half, dials.ground_bake_dist)
    };
    // The bake quad binds the chunk's OWN page (the composited ground
    // image), not the map's terrain page; everything else rides the same
    // MeshDraw path, world palette included. It also RECEDES by one world
    // px of depth (a negative `pull_bias` through the same biased-VP both
    // backends share): everything that used to win a razor-thin depth
    // contest against the ground plane — biased grass, tree feet — now wins
    // it by a margin fatter than either backend's interpolation drift.
    // Against 8 px terrain quads the two rasterizers resolved those
    // contests identically; against the bake's 16 px spans they did not
    // (measured: ROUTE_1's grass field flipped per-pixel, AE 16k).
    let bake_bias = -depth_bias(&cam, 1.0);
    let push_bake = |items: &mut Vec<Item>, v: &Visible<'_>| {
        let m = &v.chunk.meshes[mesh_kind::GROUND_BAKE as usize];
        items.push(Item::ChunkMesh {
            slot: v.slot,
            kind: mesh_kind::GROUND_BAKE,
            mesh: MeshDraw {
                vert_base: m.vert_base,
                vert_count: m.vert_count,
                index_base: m.index_base,
                index_count: m.index_count,
                page: v.chunk.bake_page,
                frame: 0,
                off_x: v.ox,
                off_y: v.oy,
                pull: 0.0,
                pull_bias: bake_bias,
                pal: slot_pal[v.slot as usize],
            },
        });
    };

    // One chunk mesh of one kind, or nothing when that kind is empty here.
    let push_mesh = |items: &mut Vec<Item>, v: &Visible<'_>, kind: u16, pull: f32, bias: f32| {
        let m = &v.chunk.meshes[kind as usize];
        if m.index_count == 0 {
            return;
        }
        let page = slot_page[v.slot as usize];
        let frames = pak.atlases[page as usize].frames;
        items.push(Item::ChunkMesh {
            slot: v.slot,
            kind,
            mesh: MeshDraw {
                vert_base: m.vert_base,
                vert_count: m.vert_count,
                index_base: m.index_base,
                index_count: m.index_count,
                page,
                frame: anim_frame(frames),
                off_x: v.ox,
                off_y: v.oy,
                pull,
                pull_bias: bias,
                pal: slot_pal[v.slot as usize],
            },
        });
    };

    // `dist` is the rung's dial for this mesh kind: the chunk cap already
    // bounded the gather, so a kind-level dial only ever narrows it further.
    // Detail density: draw a PREFIX of the stream's quads. The cook packs
    // grass/flower evens-first, so the first ceil(n/N) quads of a mesh ARE
    // its every-Nth set; quads are 6 indices each in these streams (they
    // never merge), which is what makes the prefix computable from the
    // count alone.
    let density = dials.detail_density.max(1) as u32;
    let mesh_pass =
        |items: &mut Vec<Item>, kind: u16, pull: f32, bias: f32, dist: f32, skip_baked: bool| {
            if terrain_page.is_none() {
                return;
            }
            let thin = density > 1 && (kind == mesh_kind::GRASS || kind == mesh_kind::FLOWER);
            for v in &visible {
                if !within_dist(v.dist2, v.half, dist) {
                    continue;
                }
                if skip_baked && baked(v) {
                    continue;
                }
                let before = items.len();
                push_mesh(items, v, kind, pull, bias);
                if thin && items.len() > before {
                    if let Some(Item::ChunkMesh { mesh, .. }) = items.last_mut() {
                        let quads = mesh.index_count as u32 / 6;
                        let keep = quads.div_ceil(density);
                        mesh.index_count = (keep * 6) as u16;
                        // The prefix indices only reference the prefix
                        // vertices (evens pack first), so the geometric
                        // restage path shrinks with it.
                        mesh.vert_count = (keep * 4) as u16;
                    }
                }
            }
        };

    // 2. Terrain and its trees, then stamps (terrain sub-meshes; few,
    // unculled). Terrain and water carry no dial of their own — they ARE the
    // silhouette, so the chunk cap is the only distance that bounds them.
    //
    // The trees are the ladder's cook-time rung: a chunk inside
    // `tree_hull_dist` draws the carved hulls it was cooked with, and past it
    // the same cells as plain boxes — ~700 quads a cell against under ten.
    // Both levels ship in the pak and META says so; a pak that carries only
    // one (an older cook, or `VOXEL_TREE_BOXES=1`, which folds its boxes back
    // into the terrain stream) keeps drawing what it has. The tree mesh is
    // pushed inside this chunk's own iteration, immediately after its
    // terrain, because that is where those quads sat when they were part of
    // it: the top rung must not merely draw the same triangles but draw them
    // in the same order.
    let tree_lod = pak.has_tree_lod();
    let tree_coarse = pak.has_tree_coarse();
    if terrain_page.is_some() {
        for v in &visible {
            if baked(v) {
                push_bake(&mut items, v);
                // The kept structures — everything taller than the bake
                // line — draw as geometry on top of the painting.
                push_mesh(&mut items, v, mesh_kind::TERRAIN_KEEP, 0.0, 0.0);
            } else {
                push_mesh(&mut items, v, mesh_kind::TERRAIN, 0.0, 0.0);
            }
            // Three levels, two dials: fine inside `tree_hull_dist`, the
            // 2x2-px coarse carve inside `tree_coarse_dist`, boxes beyond.
            // A rung asking for a level the pak lacks climbs UP to the fine
            // hulls (slower, never treeless); a pak without LOD at all
            // draws the one stream its cook produced.
            let tree = if !tree_lod || within_dist(v.dist2, v.half, dials.tree_hull_dist) {
                mesh_kind::TREE_HULL
            } else if within_dist(v.dist2, v.half, dials.tree_coarse_dist) {
                if tree_coarse {
                    mesh_kind::TREE_COARSE
                } else {
                    mesh_kind::TREE_HULL
                }
            } else {
                mesh_kind::TREE_BOX
            };
            push_mesh(&mut items, v, tree, 0.0, 0.0);
        }
        for &(slot, map_id, ox, oy) in &shown_maps {
            let page = slot_page[slot as usize];
            let frames = pak.atlases[page as usize].frames;
            for stamp in pak.stamps_of(map_id) {
                if !scene.stamp_shown(map_id, stamp.cx, stamp.cy) {
                    continue;
                }
                let m = &stamp.mesh;
                if m.index_count == 0 {
                    continue;
                }
                items.push(Item::StampMesh {
                    slot,
                    mesh: MeshDraw {
                        vert_base: m.vert_base,
                        vert_count: m.vert_count,
                        index_base: m.index_base,
                        index_count: m.index_count,
                        page,
                        frame: anim_frame(frames),
                        off_x: ox,
                        off_y: oy,
                        pull: 0.0,
                        pull_bias: 0.0,
                        pal: slot_pal[slot as usize],
                    },
                });
            }
        }
    }

    // 3. Water.
    mesh_pass(
        &mut items,
        mesh_kind::WATER,
        0.0,
        0.0,
        spec::QUALITY_UNBOUNDED,
        false,
    );

    // 4. Shadow decals: field entities, then staged battle cards (which
    // darken harder — the cards need grounding).
    let ent_feet = |ent: &crate::scene::Ent| {
        vec3(
            ent.x as f32 / spec::Q4 as f32,
            ent.lift as f32,
            ent.y as f32 / spec::Q4 as f32,
        )
    };
    let card_w = CELL_PX as f32;
    for ent in scene.ents.iter().filter(|e| e.shown) {
        items.push(Item::ShadowDecal {
            corners: shadow_quad(ent_feet(ent), card_w),
            abgr: alpha_abgr(SHADOW_ALPHA_FIELD),
        });
    }
    let (ox0, oy0) = slot0_offset(scene);
    let cell_centre = |cx: i32, cy: i32| {
        vec3(
            (cx * CELL_PX + CELL_PX / 2 + ox0) as f32,
            0.0,
            (cy * CELL_PX + CELL_PX / 2 + oy0) as f32,
        )
    };
    if scene.battle.active {
        for card in scene.battle.cards.iter().filter(|c| c.shown) {
            if let Some(page) = page_at(pak, card.pic) {
                items.push(Item::ShadowDecal {
                    corners: shadow_quad(cell_centre(card.x, card.y), page.w as f32),
                    abgr: alpha_abgr(SHADOW_ALPHA_BATTLE),
                });
            }
        }
    }

    // 5. Player ghost (inverted depth), then 6. entity + battle cards.
    let sheet_uv = |page: &crate::pak::AtlasPage, frame: i32| -> [f32; 4] {
        // Walk sheets stack 16x16 frames vertically at x in [0, CELL_PX);
        // pages are padded wider than the content (the GE missamples
        // 16-px-wide pages), so U normalizes by the page width.
        let rows = (page.h as i32 / CELL_PX).max(1);
        let row = frame.rem_euclid(rows) as f32;
        let vh = 1.0 / rows as f32;
        let u1 = CELL_PX as f32 / (page.w as f32).max(CELL_PX as f32);
        [0.0, row * vh, u1, (row + 1.0) * vh]
    };
    for ent in scene.ents.iter().filter(|e| e.shown) {
        if ent.flags & ent_flag::GHOST != 0 {
            items.push(Item::Ghost {
                verts: card_verts(ent_feet(ent), card_w, card_w, a),
                pull: pull_card,
                abgr: GHOST_ABGR,
            });
        }
    }
    for ent in scene.ents.iter().filter(|e| e.shown) {
        let Some(page) = page_at(pak, ent.sheet) else {
            continue;
        };
        items.push(Item::Card {
            verts: card_verts(ent_feet(ent), card_w, card_w, a),
            page: ent.sheet as u16,
            uv: sheet_uv(page, ent.frame),
            mirror: ent.flags & ent_flag::MIRROR != 0,
            pull: pull_card,
        });
        if (1..=3).contains(&ent.emote) && pak.meta.emote_page != EMOTE_PAGE_NONE {
            let epage = pak.meta.emote_page as i32;
            if let Some(page) = page_at(pak, epage) {
                let feet = ent_feet(ent).add(vec3(0.0, EMOTE_LIFT_PX, 0.0));
                items.push(Item::Card {
                    verts: card_verts(feet, card_w, card_w, a),
                    page: epage as u16,
                    uv: sheet_uv(page, ent.emote as i32 - 1),
                    mirror: false,
                    pull: pull_card,
                });
            }
        }
    }
    if scene.battle.active {
        for card in scene.battle.cards.iter().filter(|c| c.shown) {
            let Some(page) = page_at(pak, card.pic) else {
                continue;
            };
            items.push(Item::Card {
                verts: card_verts(cell_centre(card.x, card.y), page.w as f32, page.h as f32, a),
                page: card.pic as u16,
                uv: [0.0, 0.0, 1.0, 1.0],
                mirror: false,
                pull: pull_card,
            });
        }
    }

    // 7./8. Grass then flower, with their baked pull biases and the rung's
    // fade distances: ankle-height detail past a few tiles is a texture, not
    // a silhouette, and on ROUTE_1 it is half the frame's triangles.
    // Grass and flowers draw OVER the baked ground on their own dials (the
    // v1 bake paints terrain only — see cook/groundbake.ts); `skip_baked`
    // stays for the painted-detail bake a later rung may cook.
    mesh_pass(
        &mut items,
        mesh_kind::GRASS,
        grass_pull,
        grass_bias,
        dials.grass_dist,
        false,
    );
    mesh_pass(
        &mut items,
        mesh_kind::FLOWER,
        flower_pull,
        flower_bias,
        dials.flower_dist,
        false,
    );

    // 9. The GB UI layer.
    ui::append_ui(scene, pak, &mut items);

    DrawList {
        cam,
        tint: scene.tint,
        palette: scene.palette,
        items,
    }
}

fn page_at<'p, 'a>(pak: &'p Pak<'a>, index: i32) -> Option<&'p crate::pak::AtlasPage<'a>> {
    if index < 0 {
        return None;
    }
    pak.atlases.get(index as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak;
    use crate::spec::{Q4, op};

    fn rank(item: &Item) -> u32 {
        match item {
            Item::SkyBands { .. } => 0,
            Item::ChunkMesh { kind, .. } => match *kind {
                // The tree streams ARE the terrain pass: they interleave with
                // it chunk by chunk, so they share its rank.
                k if k == mesh_kind::TERRAIN
                    || k == mesh_kind::GROUND_BAKE
                    || k == mesh_kind::TERRAIN_KEEP
                    || k == mesh_kind::TREE_HULL
                    || k == mesh_kind::TREE_COARSE
                    || k == mesh_kind::TREE_BOX =>
                {
                    1
                }
                k if k == mesh_kind::WATER => 3,
                k if k == mesh_kind::GRASS => 7,
                _ => 8,
            },
            Item::StampMesh { .. } => 2,
            Item::ShadowDecal { .. } => 4,
            Item::Ghost { .. } => 5,
            Item::Card { .. } => 6,
            Item::UiQuad { .. } => 9,
        }
    }

    fn shown_scene() -> Scene {
        let mut s = Scene::new();
        s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
        s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
        s
    }

    #[test]
    fn one_chunk_culls_in_and_out() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = shown_scene();
        let has_chunk = |list: &DrawList| {
            list.items
                .iter()
                .any(|i| matches!(i, Item::ChunkMesh { .. }))
        };
        assert!(has_chunk(&build(&s, &pak)), "camera over the chunk sees it");
        s.op(op::CAM, &[5000 * Q4, 5000 * Q4], None);
        assert!(
            !has_chunk(&build(&s, &pak)),
            "camera far away culls the chunk"
        );
        // Stamps follow the map, and toggle off.
        s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
        let has_stamp = |list: &DrawList| {
            list.items
                .iter()
                .any(|i| matches!(i, Item::StampMesh { .. }))
        };
        assert!(has_stamp(&build(&s, &pak)));
        s.op(op::STAMP, &[7, 2, 2, 0], None);
        assert!(!has_stamp(&build(&s, &pak)));
    }

    #[test]
    fn draw_order_is_stable_and_sorted() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = shown_scene();
        s.op(
            op::ENT,
            &[0, 1, 0, 64 * Q4, 64 * Q4, 0, ent_flag::GHOST as i32],
            None,
        );
        s.op(op::UI_TILE, &[2, 3, 5], None);
        let list = build(&s, &pak);
        assert_eq!(list.palette, -1, "no palette op = the grayscale ramp");
        s.op(op::PALETTE, &[2], None);
        assert_eq!(
            build(&s, &pak).palette,
            2,
            "the selected SGB palette rides the draw list"
        );
        let ranks: Vec<u32> = list.items.iter().map(rank).collect();
        let mut sorted = ranks.clone();
        sorted.sort_unstable();
        assert_eq!(ranks, sorted, "items appear in §3 draw order");
        assert!(matches!(list.items[0], Item::SkyBands { .. }));
        assert!(matches!(list.items.last(), Some(Item::UiQuad { .. })));
        assert!(list.items.iter().any(|i| matches!(i, Item::Ghost { .. })));
        // Deterministic: the same scene builds the same list.
        let again = build(&s, &pak);
        assert_eq!(list.items, again.items);
    }

    #[test]
    fn vcol_palette_outranks_the_sgb_selection() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::colored_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let world = pak::tests::COLORED_WORLD_PAL;
        let obj = pak::tests::COLORED_OBJ_PAL;
        // The precedence ladder, rung by rung (spec: VXPK_TAG.color).
        // 1. the item's own VCOL palette wins over everything, including a
        //    live SGB selection — which is the whole point: the map's roof
        //    colors must survive the guest's `palette(i)` at map entry.
        assert_eq!(
            resolve_pal(&pak, 0, atlas_kind::TERRAIN, world, 0),
            world as usize
        );
        // 2. no item palette -> the page's own page_pal (the sprite page).
        assert_eq!(
            resolve_pal(&pak, 1, atlas_kind::SPRITES, COLOR_PAL_NONE, 0),
            obj as usize,
            "a sprite sheet's OBJ CLUT also outranks the SGB selection"
        );
        // 3. neither -> the SGB selection, for non-ui kinds only.
        assert_eq!(
            resolve_pal(&pak, 0, atlas_kind::TERRAIN, COLOR_PAL_NONE, 0),
            SGB_PAL_BASE
        );
        // 4. ui never takes a VCOL palette or an SGB one.
        assert_eq!(
            resolve_pal(&pak, 2, atlas_kind::UI, COLOR_PAL_NONE, 0),
            atlas_kind::UI as usize
        );
        // Out-of-range indices are refused, never indexed (untrusted bytes).
        assert_eq!(
            resolve_pal(&pak, 0, atlas_kind::TERRAIN, 999, -1),
            atlas_kind::TERRAIN as usize
        );

        // The world palette reaches the draw list: every chunk/stamp mesh of
        // a shown map carries its map's CLUT.
        let mut s = shown_scene();
        s.op(op::PALETTE, &[0], None);
        let list = build(&s, &pak);
        let meshes: Vec<u16> = list
            .items
            .iter()
            .filter_map(|i| match i {
                Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => Some(mesh.pal),
                _ => None,
            })
            .collect();
        assert!(!meshes.is_empty());
        assert!(
            meshes.iter().all(|&p| p == world),
            "every mesh of map 7 binds its world palette"
        );
    }

    #[test]
    fn no_vcol_leaves_every_mesh_on_the_legacy_path() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let list = build(&shown_scene(), &pak);
        for item in &list.items {
            if let Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } = item {
                assert_eq!(mesh.pal, COLOR_PAL_NONE);
            }
        }
        assert_eq!(
            resolve_pal(&pak, 0, atlas_kind::TERRAIN, COLOR_PAL_NONE, -1),
            atlas_kind::TERRAIN as usize
        );
    }

    /// A two-chunk map: the chunk at the origin and one three chunks NORTH
    /// (the orbit camera stands to the south and looks -Z, so that is the
    /// direction distance is visible in), each carrying terrain + both tree
    /// levels + grass + flower. The far chunk is inside the chunk cap
    /// (384 px < 340 + 64) and outside every detail dial, so it is exactly
    /// the chunk a fade is supposed to strip and the cap is not.
    fn fading_pak_bytes(tree_lod: bool) -> alloc::vec::Vec<u8> {
        use crate::pak::builder::{ChunkDef, PakBuilder};
        use crate::pak::{MeshRange, PakVert};
        let mut b = PakBuilder::new();
        let pal = [0xff00_ff00u32; 256];
        for _ in 0..3 {
            b.palette(pal);
        }
        let texels = alloc::vec![1u8; 16 * 16];
        b.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&texels]);
        b.atlas_linear(16, 32, atlas_kind::SPRITES, &[&alloc::vec![1u8; 16 * 32]]);
        b.atlas_linear(16, 16, atlas_kind::UI, &[&texels]);
        let mut quad = |x0: i16, z0: i16, x1: i16, z1: i16| {
            let v = |x, z| PakVert {
                u: 8192, // 0.25 in the ÷32768 fixed point
                v: 8192,
                abgr: 0xffff_ffff,
                x,
                y: 0,
                z,
                pad: 0,
            };
            b.mesh(
                &[v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1)],
                &[0, 1, 2, 0, 2, 3],
            )
        };
        let chunk = |cy: i16, m: [MeshRange; spec::MESH_KINDS]| ChunkDef {
            cx: 0,
            cy,
            aabb_min: [0, 0, cy * 128],
            aabb_max: [128, 0, cy * 128 + 128],
            bake_page: spec::BAKE_PAGE_NONE,
            meshes: m,
        };
        let empty = MeshRange::default();
        // terrain | groundBake | terrainKeep | treeHull | treeCoarse |
        // treeBox | water | grass | flower. The coarse slot ships alongside
        // the others so the three-level selection is testable; the LOD-less
        // pak leaves all three empty but the hull.
        let near = [
            quad(0, 0, 128, 128),
            empty,
            empty,
            quad(8, 8, 24, 24),
            if tree_lod { quad(8, 8, 24, 24) } else { empty },
            if tree_lod { quad(8, 8, 24, 24) } else { empty },
            empty,
            quad(0, 0, 64, 64),
            quad(64, 64, 128, 128),
        ];
        // One chunk north (128 px): outside the psp rung's fine reach
        // (0 + half), inside its coarse reach (128 + half) — the middle ring.
        let mid = [
            quad(0, -128, 128, 0),
            empty,
            empty,
            quad(8, -120, 24, -104),
            if tree_lod { quad(8, -120, 24, -104) } else { empty },
            if tree_lod { quad(8, -120, 24, -104) } else { empty },
            empty,
            quad(0, -128, 64, -64),
            quad(64, -64, 128, 0),
        ];
        let far = [
            quad(0, -384, 128, -256),
            empty,
            empty,
            quad(8, -376, 24, -360),
            if tree_lod { quad(8, -376, 24, -360) } else { empty },
            if tree_lod { quad(8, -376, 24, -360) } else { empty },
            empty,
            quad(0, -384, 64, -320),
            quad(64, -320, 128, -256),
        ];
        b.map(7, &[chunk(-3, far), chunk(-1, mid), chunk(0, near)]);
        b.stamps(7, &[]);
        b.game(b"{}");
        if tree_lod {
            b.meta_flags(spec::VXPK_META_FLAG_TREE_LOD | spec::VXPK_META_FLAG_TREE_COARSE);
        }
        b.finish()
    }

    /// The rung's grass/flower dials strip the far chunk's DETAIL meshes and
    /// nothing else: the same chunk's terrain still draws, because terrain is
    /// the silhouette and only the chunk cap bounds it.
    #[test]
    fn detail_meshes_fade_with_the_rung() {
        let blob = pak::AlignedBlob::from_bytes(&fading_pak_bytes(true));
        let pak = pak::read(blob.bytes()).unwrap();
        let kinds = |tier: u8| -> alloc::vec::Vec<(u16, u32)> {
            let mut s = Scene::new();
            s.op(op::QUALITY, &[tier as i32], None);
            s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
            // Stand in the near chunk, looking straight down the row of them.
            s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
            s.op(op::PITCH, &[4], None);
            for _ in 0..spec::PITCH_TWEEN_TICKS {
                s.tick();
            }
            build(&s, &pak)
                .items
                .iter()
                .filter_map(|i| match i {
                    Item::ChunkMesh { kind, mesh, .. } => Some((*kind, mesh.vert_base)),
                    _ => None,
                })
                .collect()
        };
        let count = |v: &[(u16, u32)], kind: u16| v.iter().filter(|(k, _)| *k == kind).count();

        let top = kinds(spec::quality_tier::DESKTOP);
        assert_eq!(count(&top, mesh_kind::TERRAIN), 3, "all three chunks in view");
        assert_eq!(count(&top, mesh_kind::GRASS), 3, "top rung fades nothing");
        assert_eq!(count(&top, mesh_kind::FLOWER), 3);

        assert_eq!(
            count(&top, mesh_kind::TREE_HULL),
            3,
            "the top rung carves every tree in view FINE"
        );
        assert_eq!(count(&top, mesh_kind::TREE_COARSE), 0);
        assert_eq!(count(&top, mesh_kind::TREE_BOX), 0);

        let psp = kinds(spec::quality_tier::PSP);
        assert_eq!(
            count(&psp, mesh_kind::TERRAIN),
            3,
            "a detail dial never touches terrain — the silhouette must not move"
        );
        assert_eq!(count(&psp, mesh_kind::GRASS), 2, "the far grass faded");
        assert_eq!(count(&psp, mesh_kind::FLOWER), 2);
        // The psp rung's fine dial is OFF (`QUALITY_OFF`): every carved
        // tree in reach — the chunk underfoot included — is the coarse one,
        // and the far ring boxes. Swapped, never dropped.
        assert_eq!(
            count(&psp, mesh_kind::TREE_HULL),
            0,
            "fine never draws on this rung"
        );
        assert_eq!(
            count(&psp, mesh_kind::TREE_COARSE),
            2,
            "underfoot and the middle ring both carve at 2x2"
        );
        assert_eq!(count(&psp, mesh_kind::TREE_BOX), 1, "the far ring boxes");
    }

    /// `QUALITY_OFF` means off: the half-extent widening lets even a 0 dial
    /// reach the chunk underfoot, so "never" must survive the squared
    /// compare as a sign check, not a magnitude.
    #[test]
    fn a_negative_dial_admits_nothing() {
        assert!(!within_dist(0.0, 64.0, spec::QUALITY_OFF));
        assert!(
            within_dist(0.0, 64.0, 0.0),
            "a zero dial still reaches the chunk underfoot"
        );
    }

    /// A pak that carries only ONE tree level says so (no META flag), and
    /// every rung then draws the level it has. Losing the trees at distance
    /// because the pak predates the LOD cook would be a misrender; drawing
    /// the carved hull a rung did not ask for is merely slow.
    #[test]
    fn a_pak_without_the_lod_flag_keeps_the_level_it_carries() {
        let blob = pak::AlignedBlob::from_bytes(&fading_pak_bytes(false));
        let pak = pak::read(blob.bytes()).unwrap();
        assert!(!pak.has_tree_lod());
        for tier in [spec::quality_tier::PSP, spec::quality_tier::DESKTOP] {
            let mut s = Scene::new();
            s.op(op::QUALITY, &[tier as i32], None);
            s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
            s.op(op::CAM, &[64 * Q4, 64 * Q4], None);
            s.op(op::PITCH, &[4], None);
            for _ in 0..spec::PITCH_TWEEN_TICKS {
                s.tick();
            }
            let list = build(&s, &pak);
            let n = |kind: u16| {
                list.items
                    .iter()
                    .filter(|i| matches!(i, Item::ChunkMesh { kind: k, .. } if *k == kind))
                    .count()
            };
            assert_eq!(n(mesh_kind::TREE_HULL), 3, "every chunk keeps its hulls");
            assert_eq!(n(mesh_kind::TREE_COARSE), 0, "no coarse level to draw");
            assert_eq!(n(mesh_kind::TREE_BOX), 0, "there are no boxes to draw");
        }
    }

    /// The chunk the view centre stands in is inside EVERY rung's detail
    /// dials, at any position within it. That is what keeps the GB
    /// grass-over-feet trick alive at the player's own cell no matter how far
    /// down the ladder a machine sits, and it is a property of the numbers,
    /// not of a lucky camera: the farthest a point inside a chunk can be from
    /// that chunk's centre is half * sqrt(2).
    #[test]
    fn the_chunk_underfoot_never_fades_at_any_rung() {
        let half = spec::CHUNK_PX as f32 * 0.5;
        let worst_dist2 = 2.0 * half * half;
        for (rung, dials) in spec::QUALITY.iter().enumerate() {
            for (name, limit) in [
                ("grass", dials.grass_dist),
                ("flower", dials.flower_dist),
                // The tree that matters is CARVED at some level — fine or
                // coarse — never the box slab; the reach is their union.
                ("carve reach", dials.tree_hull_dist.max(dials.tree_coarse_dist)),
            ] {
                assert!(
                    within_dist(worst_dist2, half, limit),
                    "rung {rung}'s {name} dial ({limit}) drops the chunk underfoot"
                );
            }
        }
    }

    /// Every rung's chunk cap is the pre-ladder `CULL_DIST`, so the ladder
    /// cannot quietly widen or narrow what the frustum is allowed to admit.
    #[test]
    fn the_chunk_cap_is_the_pre_ladder_one_at_every_rung() {
        for dials in spec::QUALITY.iter() {
            assert_eq!(dials.chunk_dist, 2.5 * spec::WORLD_VIEW_H as f32);
        }
    }

    #[test]
    fn pull_formula_endpoints() {
        // Straight down: 6 + max(0, 16-8)/0.2 = 46 px (the 2D layering bias).
        assert!((card_pull(0.0) - 46.0).abs() < 1e-4);
        // Horizontal: 6 + max(0, -8)/1 = 6 px.
        assert!((card_pull(core::f32::consts::FRAC_PI_2) - 6.0).abs() < 1e-4);
    }
}
