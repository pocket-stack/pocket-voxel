// Deterministic codegen: contracts/spec/voxel-spec.ts ->
// crates/pocketvoxel-core/src/spec.rs
//
// Run from PocketJS/:  bun contracts/spec/gen-voxel-rust.ts
//
// tests/voxel-contract.test.ts imports generateVoxelRust() and byte-compares
// its output against the committed spec.rs, so the generated file can never
// drift from voxel-spec.ts. Keep this generator free of anything
// non-deterministic (no dates, no env, insertion order only).

import {
  AO,
  ARENA_GAP_CELLS,
  ARENA_SHAPE,
  ATLAS_KIND,
  AUDIO_BANK_SIZE,
  AUDIO_DRUMS,
  AUDIO_EFFECT_MAX_SECONDS,
  AUDIO_ENGINES,
  AUDIO_FADE_LEVELS,
  AUDIO_FRAME_TICKS,
  AUDIO_GB_CLOCK,
  AUDIO_MIX_UNIT,
  AUDIO_MUSIC_FLAG,
  AUDIO_SFX_FLAG,
  AUDIO_SFX_TEMPO,
  AUDIO_TICKS_PER_SECOND,
  AUDIO_WAVES,
  BLOCK_PX,
  COLOR_PAL_NONE,
  BLOCK_TILES,
  CAM_FOCAL,
  CELL_PX,
  CHUNK_DRAW_DIST_PX,
  CHUNK_PX,
  CHUNK_TILES,
  CLASS_HEIGHT,
  CLEAR_EPS,
  CLEAR_LINES_Y,
  CLEAR_OFFMAP_H,
  CLEAR_STEP_PX,
  DIR,
  EMOTE,
  ENTS_MAX,
  ENT_FLAG,
  EVENT_CAP,
  EVENT_SIZE,
  FACE_SHADE,
  FLOWER_PULL_SUB_PX,
  GABLE_TOP_SHADE,
  GB_H,
  GB_W,
  GHOST_ABGR,
  GRASS_THICK_PX,
  MAX_VERTS_PER_CHUNK_MESH,
  MESH_KIND,
  MESH_KINDS,
  PITCH_RUNGS,
  PITCH_TWEEN_TICKS,
  PULL_BASE,
  PULL_MIN_SIN,
  PULL_NUM,
  PULL_SUB,
  Q4,
  Q8,
  QUALITY,
  QUALITY_TIER,
  QUALITY_TIER_DEFAULT,
  QUALITY_OFF,
  QUALITY_UNBOUNDED,
  RIG,
  RIG_DOLLY,
  RIG_DOLLY_TICKS,
  RIG_PAN_TICKS,
  RIG_PAN_YAW_DEG,
  RIG_PITCH_MAX_DEG,
  RIG_ZOOM_MAX,
  RIG_ZOOM_MIN,
  SHADOW_ALPHA_BATTLE,
  SHADOW_ALPHA_FIELD,
  TICK_HZ,
  TILE_PX,
  UI_COLS,
  UI_ROWS,
  VERTEX_STRIDE,
  VIEW_H,
  VIEW_W,
  WORLD_VIEW_H,
  WORLD_VIEW_W,
  VOLUME_MAX_ROWS,
  VOLUME_TOP_SHADE,
  VOX_BTN,
  VOX_OP,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
  VXPK_CHUNK_RECORD_SIZE,
  VXPK_COLOR_FLAG_WORLD,
  VXPK_COLOR_HEADER_SIZE,
  VXPK_COLOR_VERSION,
  VXPK_ENTRY_SIZE,
  VXPK_HEADER_SIZE,
  VXPK_MAGIC,
  BAKE_PAGE_NONE,
  VXPK_META_FLAG_GROUND_BAKE,
  VXPK_META_FLAG_TREE_COARSE,
  VXPK_META_FLAG_TREE_LOD,
  VXPK_META_SIZE,
  VXPK_TAG,
  VXPK_VERSION,
  WATER_DROP_PX,
} from "./voxel-spec.ts";

function hex(n: number, pad = 8): string {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

/** Rust f32 literal — always carries a decimal point. */
function f32(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

/** SCREAMING_SNAKE from a camelCase spec key. */
function screaming(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Emit a `pub mod <name> { pub const K: <ty> = v; }` block from a record. */
function constMod(
  put: (s?: string) => void,
  name: string,
  ty: string,
  table: Record<string, number>,
  doc: string[],
) {
  for (const line of doc) put(`/// ${line}`);
  put(`pub mod ${name} {`);
  for (const [k, v] of Object.entries(table)) {
    const lit = ty === "f32" ? f32(v) : `${v}`;
    put(`    pub const ${screaming(k)}: ${ty} = ${lit};`);
  }
  put("}");
  put("");
}

export function generateVoxelRust(): string {
  const L: string[] = [];
  const put = (s = "") => L.push(s);

  put(
    "//! GENERATED — do not edit; run `bun contracts/spec/gen-voxel-rust.ts` (from PocketJS/).",
  );
  put("//!");
  put(
    "//! Source of truth: contracts/spec/voxel-spec.ts — every constant here mirrors it.",
  );
  put(
    "//! tests/voxel-contract.test.ts regenerates this file in-memory and byte-compares;",
  );
  put(
    "//! if that fails, run `bun contracts/spec/gen-voxel-rust.ts` and commit the result.",
  );
  put("//!");
  put("//! See docs/VOXEL.md for the architecture this contract serves.");
  put("");
  put("#![allow(dead_code)]");
  put("#![allow(clippy::all)]");
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Geometry");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Graphics unit: an 8x8 pixel tile — also one voxel footprint.");
  put(`pub const TILE_PX: i32 = ${TILE_PX};`);
  put("/// Walk-grid unit: a 16x16 pixel cell = 2x2 tiles.");
  put(`pub const CELL_PX: i32 = ${CELL_PX};`);
  put("/// Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles.");
  put(`pub const BLOCK_PX: i32 = ${BLOCK_PX};`);
  put(`pub const BLOCK_TILES: usize = ${BLOCK_TILES};`);
  put("/// Chunk edge in tiles — the mesh/cull/stream granularity.");
  put(`pub const CHUNK_TILES: i32 = ${CHUNK_TILES};`);
  put(`pub const CHUNK_PX: i32 = ${CHUNK_PX};`);
  put("/// The GB UI layer, in GB pixels and tiles.");
  put(`pub const GB_W: i32 = ${GB_W};`);
  put(`pub const GB_H: i32 = ${GB_H};`);
  put(`pub const UI_COLS: usize = ${UI_COLS};`);
  put(`pub const UI_ROWS: usize = ${UI_ROWS};`);
  put("/// The PSP framebuffer the diorama renders at.");
  put(`pub const VIEW_W: i32 = ${VIEW_W};`);
  put(`pub const VIEW_H: i32 = ${VIEW_H};`);
  put("/// The world view in world px, rendered 2x; camera dist = WORLD_VIEW_H.");
  put(`pub const WORLD_VIEW_W: i32 = ${WORLD_VIEW_W};`);
  put(`pub const WORLD_VIEW_H: i32 = ${WORLD_VIEW_H};`);
  put("/// Fixed simulation step; the tick index is the only clock.");
  put(`pub const TICK_HZ: u32 = ${TICK_HZ};`);
  put("");
  constMod(put, "btn", "u32", VOX_BTN, [
    "The abstract button set; hosts map their physical buttons onto it, so",
    "one input tape replays on every host.",
  ]);
  constMod(put, "dir", "u8", DIR, [
    "Facing / movement direction. Matches the walk-sheet frame order.",
  ]);

  put("// ---------------------------------------------------------------------------");
  put("// Camera — the pitch ladder");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Orbit pitch rungs in degrees from straight down; rung 0 frames");
  put("/// identically to the flat 2D game.");
  put(
    `pub const PITCH_RUNGS: [f32; ${PITCH_RUNGS.length}] = [${PITCH_RUNGS.map(f32).join(", ")}];`,
  );
  put("/// Camera tween between rungs, in ticks (smoothstep).");
  put(`pub const PITCH_TWEEN_TICKS: u32 = ${PITCH_TWEEN_TICKS};`);
  put(
    "/// fov = 2*atan(1/(2*FOCAL)): a straight-down camera at dist = vh frames vh px.",
  );
  put(`pub const CAM_FOCAL: f32 = ${f32(CAM_FOCAL)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// The quality ladder — one cooked pak, many machines");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "quality_tier", "u8", QUALITY_TIER, [
    "Quality rungs, weakest first. Append-only, like op codes.",
  ]);
  put("/// The rung a scene boots at (and keeps across `reset`): the weakest,");
  put("/// so a host that never calls `quality` renders a frame it can hold.");
  put(`pub const QUALITY_TIER_DEFAULT: u8 = ${QUALITY_TIER_DEFAULT};`);
  put('/// "No limit" for a distance dial, in world px (a finite sentinel: the');
  put("/// widened compare `(limit + half)^2` must never reach a NaN).");
  put(`pub const QUALITY_UNBOUNDED: f32 = ${f32(QUALITY_UNBOUNDED)};`);
  put('/// "Never draws" for a distance dial: negative, refused explicitly by');
  put("/// `draw::within_dist` (a 0 dial still admits the chunk underfoot via");
  put("/// the half-extent widening; off needs its own value).");
  put(`pub const QUALITY_OFF: f32 = ${f32(QUALITY_OFF)};`);
  put("/// The chunk distance cap: 2.5 view-heights, held at every rung.");
  put(`pub const CHUNK_DRAW_DIST_PX: f32 = ${f32(CHUNK_DRAW_DIST_PX)};`);
  put("");
  put("/// One rung's dials. Distances are world px, measured from the view");
  put("/// centre to a chunk's own centre — all through `draw::within_dist`.");
  put("/// Adding a dial is appending a field here and to every QUALITY row.");
  put("#[derive(Clone, Copy, Debug, PartialEq)]");
  put("pub struct QualityDials {");
  put("    /// Grass chunk meshes past this distance are not drawn.");
  put("    pub grass_dist: f32,");
  put("    /// Flower chunk meshes past this distance are not drawn.");
  put("    pub flower_dist: f32,");
  put("    /// A chunk inside this distance draws its FINE carved hulls;");
  put("    /// between it and `tree_coarse_dist`, the 2x2-px coarse carve.");
  put("    pub tree_hull_dist: f32,");
  put("    /// A chunk inside this (but past `tree_hull_dist`) draws the");
  put("    /// coarse carve; past it, plain boxes (`mesh_kind::TREE_BOX`).");
  put("    pub tree_coarse_dist: f32,");
  put("    /// No chunk past this distance is drawn at all (any mesh kind).");
  put("    pub chunk_dist: f32,");
  put("    /// An ELIGIBLE chunk past this draws its baked ground quad");
  put("    /// (`mesh_kind::GROUND_BAKE`) instead of terrain+grass+flower.");
  put("    pub ground_bake_dist: f32,");
  put("    /// Draw every Nth grass/flower quad (1 = all; the cook packs");
  put("    /// evens first, so a prefix of the indices IS the sparse set).");
  put("    pub detail_density: u8,");
  put("    /// Pulled meshes (grass, flower) draw in place with one constant");
  put("    /// NDC-depth bias instead of per-vertex geometric displacement —");
  put("    /// exact at the camera focus, zero per-vertex CPU (`draw::depth_bias`).");
  put("    pub pull_depth_bias: bool,");
  put("}");
  put("");
  put("/// The dial table, indexed by `quality_tier`.");
  put(`pub const QUALITY: [QualityDials; ${QUALITY.length}] = [`);
  for (const [i, row] of QUALITY.entries()) {
    const tier = Object.entries(QUALITY_TIER).find(([, v]) => v === i)?.[0] ?? "?";
    put(`    // ${tier}`);
    put("    QualityDials {");
    put(`        grass_dist: ${f32(row.grassDist)},`);
    put(`        flower_dist: ${f32(row.flowerDist)},`);
    put(`        tree_hull_dist: ${f32(row.treeHullDist)},`);
    put(`        tree_coarse_dist: ${f32(row.treeCoarseDist)},`);
    put(`        chunk_dist: ${f32(row.chunkDist)},`);
    put(`        ground_bake_dist: ${f32(row.groundBakeDist)},`);
    put(`        detail_density: ${row.detailDensity},`);
    put(`        pull_depth_bias: ${row.pullDepthBias === 1},`);
    put("    },");
  }
  put("];");
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Diorama constants — baked at cook time, pinned so cooker and core agree");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "face_shade", "f32", FACE_SHADE, [
    "Per-face shade multipliers, sun in the southeast.",
  ]);
  put(`pub const VOLUME_TOP_SHADE: f32 = ${f32(VOLUME_TOP_SHADE)};`);
  put(`pub const GABLE_TOP_SHADE: f32 = ${f32(GABLE_TOP_SHADE)};`);
  put("");
  constMod(put, "ao", "f32", AO as unknown as Record<string, number>, [
    "Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded).",
  ]);
  put("/// Water surface sits below ground; the 2 px lip is the shoreline.");
  put(`pub const WATER_DROP_PX: i32 = ${WATER_DROP_PX};`);
  put(`pub const GRASS_THICK_PX: i32 = ${GRASS_THICK_PX};`);
  put("");
  constMod(put, "class_height", "i32", CLASS_HEIGHT, [
    "Tile-class fallback heights in world px; profile pins override per",
    "tileset at cook time.",
  ]);
  put("/// Volume measurement cap, in 8 px rows (48 px max).");
  put(`pub const VOLUME_MAX_ROWS: i32 = ${VOLUME_MAX_ROWS};`);
  put("");
  put("/// Billboard camera-ward pull, world px: PULL_BASE +");
  put("/// max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN),");
  put("/// applied along each vertex's own eye ray — a pure depth bias.");
  put(`pub const PULL_BASE: f32 = ${f32(PULL_BASE)};`);
  put(`pub const PULL_NUM: f32 = ${f32(PULL_NUM)};`);
  put(`pub const PULL_SUB: f32 = ${f32(PULL_SUB)};`);
  put(`pub const PULL_MIN_SIN: f32 = ${f32(PULL_MIN_SIN)};`);
  put("/// Flowers give up one tile row of depth advantage vs the cards.");
  put(`pub const FLOWER_PULL_SUB_PX: f32 = ${f32(FLOWER_PULL_SUB_PX)};`);
  put("");
  put("/// Ghost silhouette color (drawn with inverted depth test, no write).");
  put(`pub const GHOST_ABGR: u32 = ${hex(GHOST_ABGR)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Battle staging — solved rig constants");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "arena_shape", "u8", ARENA_SHAPE, [
    "Arena footprints; mons stand ARENA_GAP_CELLS apart.",
  ]);
  put(`pub const ARENA_GAP_CELLS: i32 = ${ARENA_GAP_CELLS};`);
  put(`pub const CLEAR_STEP_PX: f32 = ${f32(CLEAR_STEP_PX)};`);
  put(
    `pub const CLEAR_LINES_Y: [f32; ${CLEAR_LINES_Y.length}] = [${CLEAR_LINES_Y.map(f32).join(", ")}];`,
  );
  put(`pub const CLEAR_EPS: f32 = ${f32(CLEAR_EPS)};`);
  put(`pub const CLEAR_OFFMAP_H: f32 = ${f32(CLEAR_OFFMAP_H)};`);
  put("");
  constMod(
    put,
    "rig_tele",
    "f32",
    RIG.tele as unknown as Record<string, number>,
    ["The solved long-lens rig (offsets in world px from the arena midpoint)."],
  );
  constMod(
    put,
    "rig_wide",
    "f32",
    RIG.wide as unknown as Record<string, number>,
    ["The solved wide rig, for rooms the long lens cannot stand back from."],
  );
  put(`pub const RIG_PAN_YAW_DEG: f32 = ${f32(RIG_PAN_YAW_DEG)};`);
  put(`pub const RIG_PAN_TICKS: u32 = ${RIG_PAN_TICKS};`);
  put(`pub const RIG_DOLLY: f32 = ${f32(RIG_DOLLY)};`);
  put(`pub const RIG_DOLLY_TICKS: u32 = ${RIG_DOLLY_TICKS};`);
  put(`pub const RIG_PITCH_MAX_DEG: f32 = ${f32(RIG_PITCH_MAX_DEG)};`);
  put(`pub const RIG_ZOOM_MIN: f32 = ${f32(RIG_ZOOM_MIN)};`);
  put(`pub const RIG_ZOOM_MAX: f32 = ${f32(RIG_ZOOM_MAX)};`);
  put(`pub const SHADOW_ALPHA_FIELD: f32 = ${f32(SHADOW_ALPHA_FIELD)};`);
  put(`pub const SHADOW_ALPHA_BATTLE: f32 = ${f32(SHADOW_ALPHA_BATTLE)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Entities");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Max simultaneously shown entity billboards (player is slot 0).");
  put(`pub const ENTS_MAX: usize = ${ENTS_MAX};`);
  put("");
  constMod(put, "ent_flag", "u32", ENT_FLAG, ["Entity billboard flags."]);
  constMod(put, "emote", "u8", EMOTE, ["Emote bubble kinds."]);

  put("// ---------------------------------------------------------------------------");
  put("// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "op", "u32", VOX_OP, [
    "Op codes. See contracts/spec/voxel-spec.ts for the argument contract.",
  ]);
  put("/// Fixed-point scales used by op args.");
  put(`pub const Q4: i32 = ${Q4};`);
  put(`pub const Q8: i32 = ${Q8};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// The chip synth (ChipSynth.lua's own constants)");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// One ROM sound bank: the window a program address is read inside.");
  put(`pub const AUDIO_BANK_SIZE: usize = ${AUDIO_BANK_SIZE};`);
  put("/// Sound-engine table slots. Red uses ids 1..3; slot 0 is never pinned.");
  put(`pub const AUDIO_ENGINES: usize = ${AUDIO_ENGINES};`);
  put("/// Drum ids per sound engine.");
  put(`pub const AUDIO_DRUMS: usize = ${AUDIO_DRUMS};`);
  put("/// Wave instruments a sound engine exposes (5 read + 1 shared by 6..9).");
  put(`pub const AUDIO_WAVES: usize = ${AUDIO_WAVES};`);
  put("/// The channel-program tick clock durations are counted in.");
  put(`pub const AUDIO_TICKS_PER_SECOND: u64 = ${AUDIO_TICKS_PER_SECOND};`);
  put("/// One frame of the GB sound driver, in program ticks.");
  put(`pub const AUDIO_FRAME_TICKS: u32 = ${AUDIO_FRAME_TICKS};`);
  put("/// The GB master clock the noise LFSR divides down.");
  put(`pub const AUDIO_GB_CLOCK: u64 = ${AUDIO_GB_CLOCK};`);
  put("/// The plain SFX tempo byte (ChipAudio.lua:418).");
  put(`pub const AUDIO_SFX_TEMPO: u32 = ${AUDIO_SFX_TEMPO};`);
  put("/// rAUDVOL levels a fade walks down through (Music.lua:312).");
  put(`pub const AUDIO_FADE_LEVELS: u32 = ${AUDIO_FADE_LEVELS};`);
  put("/// Longest one-shot the reference renders (ChipSynth.lua:849).");
  put(`pub const AUDIO_EFFECT_MAX_SECONDS: u32 = ${AUDIO_EFFECT_MAX_SECONDS};`);
  put("/// One channel at full scale, in the integer mix's units (lcm(15, 32)).");
  put(`pub const AUDIO_MIX_UNIT: i32 = ${AUDIO_MIX_UNIT};`);
  put("");
  constMod(put, "music_flag", "u32", AUDIO_MUSIC_FLAG, ["`music(…, flags)`."]);
  constMod(put, "sfx_flag", "u32", AUDIO_SFX_FLAG, ["`sfx(…, flags)`."]);

  put("// ---------------------------------------------------------------------------");
  put("// Events — core -> guest facts. No kinds defined yet; wire pinned.");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Bytes per packed event record: u16 kind | u16 a | i32 b | i32 c | i32 d.");
  put(`pub const EVENT_SIZE: usize = ${EVENT_SIZE};`);
  put(`pub const EVENT_CAP: usize = ${EVENT_CAP};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// VXPK — the cooked content container");
  put("// ---------------------------------------------------------------------------");
  put("");
  put(`pub const VXPK_MAGIC: u32 = ${hex(VXPK_MAGIC)}; // 'VXPK'`);
  put(`pub const VXPK_VERSION: u16 = ${VXPK_VERSION};`);
  put(`pub const VXPK_HEADER_SIZE: usize = ${VXPK_HEADER_SIZE};`);
  put(`pub const VXPK_ENTRY_SIZE: usize = ${VXPK_ENTRY_SIZE};`);
  put(`pub const VXPK_ALIGN: usize = ${VXPK_ALIGN};`);
  put("/// The META record: eight u32 counts/dims, then flags and a pad word.");
  put(`pub const VXPK_META_SIZE: usize = ${VXPK_META_SIZE};`);
  put("/// META flag bit 0: chunks carry BOTH tree levels of detail, so the");
  put("/// runtime may pick one per chunk (`QualityDials::tree_hull_dist`).");
  put(`pub const VXPK_META_FLAG_TREE_LOD: u32 = ${VXPK_META_FLAG_TREE_LOD};`);
  put("/// META flag bit 1: chunks also carry the MIDDLE tree level — the");
  put("/// 2x2-px coarse carve (`mesh_kind::TREE_COARSE`). Without it a rung");
  put("/// asking for coarse draws the fine hulls: slower, never treeless.");
  put(`pub const VXPK_META_FLAG_TREE_COARSE: u32 = ${VXPK_META_FLAG_TREE_COARSE};`);
  put("/// META flag bit 2: eligible chunks carry a baked ground quad + page.");
  put(`pub const VXPK_META_FLAG_GROUND_BAKE: u32 = ${VXPK_META_FLAG_GROUND_BAKE};`);
  put('/// `Chunk.bake_page` value for "no baked ground".');
  put(`pub const BAKE_PAGE_NONE: u16 = ${hex(BAKE_PAGE_NONE, 4)};`);
  put("/// The AUDI payload's own header (json_len, program_len, two pad words).");
  put(`pub const VXPK_AUDIO_HEADER_SIZE: usize = ${VXPK_AUDIO_HEADER_SIZE};`);
  put("/// The VCOL payload's own header (version, counts, flags, two pad words).");
  put(`pub const VXPK_COLOR_HEADER_SIZE: usize = ${VXPK_COLOR_HEADER_SIZE};`);
  put("/// VCOL payload format version.");
  put(`pub const VXPK_COLOR_VERSION: u16 = ${VXPK_COLOR_VERSION};`);
  put("/// VCOL flag bit 0: the terrain page carries per-tile RED++ groups.");
  put(`pub const VXPK_COLOR_FLAG_WORLD: u16 = ${VXPK_COLOR_FLAG_WORLD};`);
  put('/// "no VCOL palette here" — fall through to the legacy binding.');
  put(`pub const COLOR_PAL_NONE: u16 = ${hex(COLOR_PAL_NONE, 4)};`);
  put("");
  constMod(put, "tag", "u32", VXPK_TAG, ["Section tags (4CC, LE u32)."]);
  constMod(put, "atlas_kind", "u16", ATLAS_KIND, ["Atlas page kinds."]);
  put("/// The GE world vertex: f32 u | f32 v | u32 abgr | i16 x,y,z | i16 pad.");
  put(`pub const VERTEX_STRIDE: usize = ${VERTEX_STRIDE};`);
  put("/// A batch seals before u16 index overflow.");
  put(`pub const MAX_VERTS_PER_CHUNK_MESH: usize = ${MAX_VERTS_PER_CHUNK_MESH};`);
  put("");
  constMod(put, "mesh_kind", "u16", MESH_KIND, [
    "Mesh kinds inside a chunk — draw order is their numeric order.",
  ]);
  put(`pub const MESH_KINDS: usize = ${MESH_KINDS};`);
  put("/// Bytes per CHNK chunk record: coords + AABB + a range per kind.");
  put(`pub const VXPK_CHUNK_RECORD_SIZE: usize = ${VXPK_CHUNK_RECORD_SIZE};`);
  put("");

  return L.join("\n");
}

if (import.meta.main) {
  const out = new URL(
    "../../crates/pocketvoxel-core/src/spec.rs",
    import.meta.url,
  );
  await Bun.write(out, generateVoxelRust() + "\n");
  console.log(`wrote ${out.pathname}`);
}
