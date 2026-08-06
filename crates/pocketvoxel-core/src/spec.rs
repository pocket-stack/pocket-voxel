//! GENERATED — do not edit; run `bun contracts/spec/gen-voxel-rust.ts` (from PocketJS/).
//!
//! Source of truth: contracts/spec/voxel-spec.ts — every constant here mirrors it.
//! tests/voxel-contract.test.ts regenerates this file in-memory and byte-compares;
//! if that fails, run `bun contracts/spec/gen-voxel-rust.ts` and commit the result.
//!
//! See docs/VOXEL.md for the architecture this contract serves.

#![allow(dead_code)]
#![allow(clippy::all)]

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Graphics unit: an 8x8 pixel tile — also one voxel footprint.
pub const TILE_PX: i32 = 8;
/// Walk-grid unit: a 16x16 pixel cell = 2x2 tiles.
pub const CELL_PX: i32 = 16;
/// Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles.
pub const BLOCK_PX: i32 = 32;
pub const BLOCK_TILES: usize = 4;
/// Chunk edge in tiles — the mesh/cull/stream granularity.
pub const CHUNK_TILES: i32 = 16;
pub const CHUNK_PX: i32 = 128;
/// The GB UI layer, in GB pixels and tiles.
pub const GB_W: i32 = 160;
pub const GB_H: i32 = 144;
pub const UI_COLS: usize = 20;
pub const UI_ROWS: usize = 18;
/// The PSP framebuffer the diorama renders at.
pub const VIEW_W: i32 = 480;
pub const VIEW_H: i32 = 272;
/// The world view in world px, rendered 2x; camera dist = WORLD_VIEW_H.
pub const WORLD_VIEW_W: i32 = 240;
pub const WORLD_VIEW_H: i32 = 136;
/// Fixed simulation step; the tick index is the only clock.
pub const TICK_HZ: u32 = 60;

/// The abstract button set; hosts map their physical buttons onto it, so
/// one input tape replays on every host.
pub mod btn {
    pub const UP: u32 = 1;
    pub const DOWN: u32 = 2;
    pub const LEFT: u32 = 4;
    pub const RIGHT: u32 = 8;
    pub const A: u32 = 16;
    pub const B: u32 = 32;
    pub const START: u32 = 64;
    pub const SELECT: u32 = 128;
}

/// Facing / movement direction. Matches the walk-sheet frame order.
pub mod dir {
    pub const DOWN: u8 = 0;
    pub const UP: u8 = 1;
    pub const LEFT: u8 = 2;
    pub const RIGHT: u8 = 3;
}

// ---------------------------------------------------------------------------
// Camera — the pitch ladder
// ---------------------------------------------------------------------------

/// Orbit pitch rungs in degrees from straight down; rung 0 frames
/// identically to the flat 2D game.
pub const PITCH_RUNGS: [f32; 5] = [0.0, 15.0, 35.0, 50.0, 75.0];
/// Camera tween between rungs, in ticks (smoothstep).
pub const PITCH_TWEEN_TICKS: u32 = 15;
/// fov = 2*atan(1/(2*FOCAL)): a straight-down camera at dist = vh frames vh px.
pub const CAM_FOCAL: f32 = 1.0;

// ---------------------------------------------------------------------------
// The quality ladder — one cooked pak, many machines
// ---------------------------------------------------------------------------

/// Quality rungs, weakest first. Append-only, like op codes.
pub mod quality_tier {
    pub const PSP: u8 = 0;
    pub const VITA: u8 = 1;
    pub const DESKTOP: u8 = 2;
}

/// The rung a scene boots at (and keeps across `reset`): the weakest,
/// so a host that never calls `quality` renders a frame it can hold.
pub const QUALITY_TIER_DEFAULT: u8 = 0;
/// "No limit" for a distance dial, in world px (a finite sentinel: the
/// widened compare `(limit + half)^2` must never reach a NaN).
pub const QUALITY_UNBOUNDED: f32 = 1000000000.0;
/// "Never draws" for a distance dial: negative, refused explicitly by
/// `draw::within_dist` (a 0 dial still admits the chunk underfoot via
/// the half-extent widening; off needs its own value).
pub const QUALITY_OFF: f32 = -1.0;
/// The chunk distance cap: 2.5 view-heights, held at every rung.
pub const CHUNK_DRAW_DIST_PX: f32 = 340.0;

/// One rung's dials. Distances are world px, measured from the view
/// centre to a chunk's own centre — all through `draw::within_dist`.
/// Adding a dial is appending a field here and to every QUALITY row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QualityDials {
    /// Grass chunk meshes past this distance are not drawn.
    pub grass_dist: f32,
    /// Flower chunk meshes past this distance are not drawn.
    pub flower_dist: f32,
    /// A chunk inside this distance draws its FINE carved hulls;
    /// between it and `tree_coarse_dist`, the 2x2-px coarse carve.
    pub tree_hull_dist: f32,
    /// A chunk inside this (but past `tree_hull_dist`) draws the
    /// coarse carve; past it, plain boxes (`mesh_kind::TREE_BOX`).
    pub tree_coarse_dist: f32,
    /// No chunk past this distance is drawn at all (any mesh kind).
    pub chunk_dist: f32,
    /// An ELIGIBLE chunk past this draws its baked ground quad
    /// (`mesh_kind::GROUND_BAKE`) instead of terrain+grass+flower.
    pub ground_bake_dist: f32,
    /// Draw every Nth grass/flower quad (1 = all; the cook packs
    /// evens first, so a prefix of the indices IS the sparse set).
    pub detail_density: u8,
    /// Pulled meshes (grass, flower) draw in place with one constant
    /// NDC-depth bias instead of per-vertex geometric displacement —
    /// exact at the camera focus, zero per-vertex CPU (`draw::depth_bias`).
    pub pull_depth_bias: bool,
}

/// The dial table, indexed by `quality_tier`.
pub const QUALITY: [QualityDials; 3] = [
    // psp
    QualityDials {
        grass_dist: 1000000000.0,
        flower_dist: 1000000000.0,
        tree_hull_dist: -1.0,
        tree_coarse_dist: 1000000000.0,
        chunk_dist: 340.0,
        ground_bake_dist: -1.0,
        detail_density: 4,
        pull_depth_bias: true,
    },
    // vita
    QualityDials {
        grass_dist: 1000000000.0,
        flower_dist: 1000000000.0,
        tree_hull_dist: 1000000000.0,
        tree_coarse_dist: 1000000000.0,
        chunk_dist: 340.0,
        ground_bake_dist: 1000000000.0,
        detail_density: 1,
        pull_depth_bias: false,
    },
    // desktop
    QualityDials {
        grass_dist: 1000000000.0,
        flower_dist: 1000000000.0,
        tree_hull_dist: 1000000000.0,
        tree_coarse_dist: 1000000000.0,
        chunk_dist: 340.0,
        ground_bake_dist: 1000000000.0,
        detail_density: 1,
        pull_depth_bias: false,
    },
];

// ---------------------------------------------------------------------------
// Diorama constants — baked at cook time, pinned so cooker and core agree
// ---------------------------------------------------------------------------

/// Per-face shade multipliers, sun in the southeast.
pub mod face_shade {
    pub const EAST: f32 = 0.84;
    pub const WEST: f32 = 0.72;
    pub const UP: f32 = 1.0;
    pub const DOWN: f32 = 0.55;
    pub const SOUTH: f32 = 0.9;
    pub const NORTH: f32 = 0.68;
}

pub const VOLUME_TOP_SHADE: f32 = 0.85;
pub const GABLE_TOP_SHADE: f32 = 0.95;

/// Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded).
pub mod ao {
    pub const STEP: f32 = 0.216;
    pub const EDGE: f32 = 0.664;
    pub const CORNER: f32 = 0.441;
    pub const GROUND: f32 = 0.288;
    pub const RISE_PX: f32 = 6.0;
    pub const FLOOR: f32 = 0.25;
}

/// Water surface sits below ground; the 2 px lip is the shoreline.
pub const WATER_DROP_PX: i32 = 2;
pub const GRASS_THICK_PX: i32 = 2;

/// Tile-class fallback heights in world px; profile pins override per
/// tileset at cook time.
pub mod class_height {
    pub const GROUND: i32 = 0;
    pub const WATER: i32 = -2;
    pub const VOID: i32 = 0;
    pub const LEDGE: i32 = 6;
    pub const FENCE: i32 = 10;
    pub const SIGN: i32 = 12;
    pub const WALL: i32 = 16;
    pub const CLIFF: i32 = 32;
    pub const TREE: i32 = 16;
    pub const ROOF: i32 = 28;
    pub const COUNTER: i32 = 8;
    pub const TABLE: i32 = 12;
    pub const DESK: i32 = 24;
    pub const PROP: i32 = 16;
    pub const CYLINDER: i32 = 16;
    pub const CANOPY: i32 = 32;
    pub const STUMP: i32 = 16;
    pub const GRASS: i32 = 0;
    pub const FLOWER: i32 = 0;
}

/// Volume measurement cap, in 8 px rows (48 px max).
pub const VOLUME_MAX_ROWS: i32 = 6;

/// Billboard camera-ward pull, world px: PULL_BASE +
/// max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN),
/// applied along each vertex's own eye ray — a pure depth bias.
pub const PULL_BASE: f32 = 6.0;
pub const PULL_NUM: f32 = 16.0;
pub const PULL_SUB: f32 = 8.0;
pub const PULL_MIN_SIN: f32 = 0.2;
/// Flowers give up one tile row of depth advantage vs the cards.
pub const FLOWER_PULL_SUB_PX: f32 = 8.0;

/// Ghost silhouette color (drawn with inverted depth test, no write).
pub const GHOST_ABGR: u32 = 0x80484242;

// ---------------------------------------------------------------------------
// Battle staging — solved rig constants
// ---------------------------------------------------------------------------

/// Arena footprints; mons stand ARENA_GAP_CELLS apart.
pub mod arena_shape {
    pub const WIDE: u8 = 0;
    pub const NARROW: u8 = 1;
}

pub const ARENA_GAP_CELLS: i32 = 3;
pub const CLEAR_STEP_PX: f32 = 4.0;
pub const CLEAR_LINES_Y: [f32; 3] = [1.0, 8.0, 16.0];
pub const CLEAR_EPS: f32 = 1.5;
pub const CLEAR_OFFMAP_H: f32 = 32.0;

/// The solved long-lens rig (offsets in world px from the arena midpoint).
pub mod rig_tele {
    pub const SIDE: f32 = 78.79;
    pub const BACK: f32 = 144.96;
    pub const HEIGHT: f32 = 37.88;
    pub const LOOK_X: f32 = -0.26;
    pub const LOOK_Y: f32 = 0.34;
    pub const FRAME_H: f32 = 34.11;
}

/// The solved wide rig, for rooms the long lens cannot stand back from.
pub mod rig_wide {
    pub const SIDE: f32 = 41.98;
    pub const BACK: f32 = 41.16;
    pub const HEIGHT: f32 = 28.48;
    pub const LOOK_X: f32 = -3.24;
    pub const LOOK_Y: f32 = -1.35;
    pub const FRAME_H: f32 = 55.62;
}

pub const RIG_PAN_YAW_DEG: f32 = 2.0;
pub const RIG_PAN_TICKS: u32 = 1560;
pub const RIG_DOLLY: f32 = 0.02;
pub const RIG_DOLLY_TICKS: u32 = 2220;
pub const RIG_PITCH_MAX_DEG: f32 = 45.0;
pub const RIG_ZOOM_MIN: f32 = 0.45;
pub const RIG_ZOOM_MAX: f32 = 2.0;
pub const SHADOW_ALPHA_FIELD: f32 = 0.4;
pub const SHADOW_ALPHA_BATTLE: f32 = 0.68;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/// Max simultaneously shown entity billboards (player is slot 0).
pub const ENTS_MAX: usize = 16;

/// Entity billboard flags.
pub mod ent_flag {
    pub const MIRROR: u32 = 1;
    pub const GHOST: u32 = 2;
    pub const WALKER: u32 = 4;
}

/// Emote bubble kinds.
pub mod emote {
    pub const NONE: u8 = 0;
    pub const SHOCK: u8 = 1;
    pub const QUESTION: u8 = 2;
    pub const HAPPY: u8 = 3;
}

// ---------------------------------------------------------------------------
// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.
// ---------------------------------------------------------------------------

/// Op codes. See contracts/spec/voxel-spec.ts for the argument contract.
pub mod op {
    pub const GAMEDATA: u32 = 1;
    pub const STATS: u32 = 2;
    pub const RESET: u32 = 3;
    pub const QUALITY: u32 = 4;
    pub const AUDIODATA: u32 = 17;
    pub const MAP_SHOW: u32 = 10;
    pub const MAP_HIDE: u32 = 11;
    pub const CAM: u32 = 12;
    pub const PITCH: u32 = 13;
    pub const TINT: u32 = 14;
    pub const STAMP: u32 = 15;
    pub const PALETTE: u32 = 16;
    pub const ENT: u32 = 30;
    pub const ENT_HIDE: u32 = 31;
    pub const EMOTE: u32 = 32;
    pub const UI_TILE: u32 = 50;
    pub const UI_FILL: u32 = 51;
    pub const UI_TEXT: u32 = 52;
    pub const UI_REVEAL: u32 = 53;
    pub const UI_CLEAR: u32 = 54;
    pub const ARENA: u32 = 70;
    pub const CARD: u32 = 71;
    pub const CARD_HIDE: u32 = 72;
    pub const BATTLE_CAM: u32 = 73;
    pub const ARENA_END: u32 = 74;
    pub const MUSIC: u32 = 18;
    pub const MUSIC_STOP: u32 = 19;
    pub const MUSIC_FADE: u32 = 20;
    pub const SFX: u32 = 21;
    pub const CRY: u32 = 22;
    pub const AUDIO_WAVES: u32 = 23;
    pub const AUDIO_DRUM: u32 = 24;
}

/// Fixed-point scales used by op args.
pub const Q4: i32 = 16;
pub const Q8: i32 = 256;

// ---------------------------------------------------------------------------
// The chip synth (ChipSynth.lua's own constants)
// ---------------------------------------------------------------------------

/// One ROM sound bank: the window a program address is read inside.
pub const AUDIO_BANK_SIZE: usize = 16384;
/// Sound-engine table slots. Red uses ids 1..3; slot 0 is never pinned.
pub const AUDIO_ENGINES: usize = 4;
/// Drum ids per sound engine.
pub const AUDIO_DRUMS: usize = 32;
/// Wave instruments a sound engine exposes (5 read + 1 shared by 6..9).
pub const AUDIO_WAVES: usize = 9;
/// The channel-program tick clock durations are counted in.
pub const AUDIO_TICKS_PER_SECOND: u64 = 15360;
/// One frame of the GB sound driver, in program ticks.
pub const AUDIO_FRAME_TICKS: u32 = 256;
/// The GB master clock the noise LFSR divides down.
pub const AUDIO_GB_CLOCK: u64 = 4194304;
/// The plain SFX tempo byte (ChipAudio.lua:418).
pub const AUDIO_SFX_TEMPO: u32 = 128;
/// rAUDVOL levels a fade walks down through (Music.lua:312).
pub const AUDIO_FADE_LEVELS: u32 = 7;
/// Longest one-shot the reference renders (ChipSynth.lua:849).
pub const AUDIO_EFFECT_MAX_SECONDS: u32 = 5;
/// One channel at full scale, in the integer mix's units (lcm(15, 32)).
pub const AUDIO_MIX_UNIT: i32 = 480;

/// `music(…, flags)`.
pub mod music_flag {
    pub const LOOP: u32 = 1;
}

/// `sfx(…, flags)`.
pub mod sfx_flag {
    pub const DUCK: u32 = 1;
}

// ---------------------------------------------------------------------------
// Events — core -> guest facts. No kinds defined yet; wire pinned.
// ---------------------------------------------------------------------------

/// Bytes per packed event record: u16 kind | u16 a | i32 b | i32 c | i32 d.
pub const EVENT_SIZE: usize = 16;
pub const EVENT_CAP: usize = 64;

// ---------------------------------------------------------------------------
// VXPK — the cooked content container
// ---------------------------------------------------------------------------

pub const VXPK_MAGIC: u32 = 0x4b505856; // 'VXPK'
pub const VXPK_VERSION: u16 = 8;
pub const VXPK_HEADER_SIZE: usize = 16;
pub const VXPK_ENTRY_SIZE: usize = 16;
pub const VXPK_ALIGN: usize = 16;
/// The META record: eight u32 counts/dims, then flags and a pad word.
pub const VXPK_META_SIZE: usize = 40;
/// META flag bit 0: chunks carry BOTH tree levels of detail, so the
/// runtime may pick one per chunk (`QualityDials::tree_hull_dist`).
pub const VXPK_META_FLAG_TREE_LOD: u32 = 1;
/// META flag bit 1: chunks also carry the MIDDLE tree level — the
/// 2x2-px coarse carve (`mesh_kind::TREE_COARSE`). Without it a rung
/// asking for coarse draws the fine hulls: slower, never treeless.
pub const VXPK_META_FLAG_TREE_COARSE: u32 = 2;
/// META flag bit 2: eligible chunks carry a baked ground quad + page.
pub const VXPK_META_FLAG_GROUND_BAKE: u32 = 4;
/// `Chunk.bake_page` value for "no baked ground".
pub const BAKE_PAGE_NONE: u16 = 0xffff;
/// The AUDI payload's own header (json_len, program_len, two pad words).
pub const VXPK_AUDIO_HEADER_SIZE: usize = 16;
/// The VCOL payload's own header (version, counts, flags, two pad words).
pub const VXPK_COLOR_HEADER_SIZE: usize = 16;
/// VCOL payload format version.
pub const VXPK_COLOR_VERSION: u16 = 1;
/// VCOL flag bit 0: the terrain page carries per-tile RED++ groups.
pub const VXPK_COLOR_FLAG_WORLD: u16 = 1;
/// "no VCOL palette here" — fall through to the legacy binding.
pub const COLOR_PAL_NONE: u16 = 0xffff;

/// Section tags (4CC, LE u32).
pub mod tag {
    pub const META: u32 = 1096041805;
    pub const PALETTE: u32 = 1279348822;
    pub const ATLAS: u32 = 1397511233;
    pub const CHUNKS: u32 = 1263421507;
    pub const STAMPS: u32 = 1347245139;
    pub const CHARMAP: u32 = 1346456899;
    pub const GAME: u32 = 1162690887;
    pub const AUDIO: u32 = 1229215041;
    pub const COLOR: u32 = 1280262998;
}

/// Atlas page kinds.
pub mod atlas_kind {
    pub const TERRAIN: u16 = 0;
    pub const SPRITES: u16 = 1;
    pub const UI: u16 = 2;
    pub const PICS: u16 = 3;
}

/// The GE world vertex: f32 u | f32 v | u32 abgr | i16 x,y,z | i16 pad.
pub const VERTEX_STRIDE: usize = 16;
/// A batch seals before u16 index overflow.
pub const MAX_VERTS_PER_CHUNK_MESH: usize = 65532;

/// Mesh kinds inside a chunk — draw order is their numeric order.
pub mod mesh_kind {
    pub const TERRAIN: u16 = 0;
    pub const GROUND_BAKE: u16 = 1;
    pub const TERRAIN_KEEP: u16 = 2;
    pub const TREE_HULL: u16 = 3;
    pub const TREE_COARSE: u16 = 4;
    pub const TREE_BOX: u16 = 5;
    pub const WATER: u16 = 6;
    pub const GRASS: u16 = 7;
    pub const FLOWER: u16 = 8;
}

pub const MESH_KINDS: usize = 9;
/// Bytes per CHNK chunk record: coords + AABB + a range per kind.
pub const VXPK_CHUNK_RECORD_SIZE: usize = 128;

