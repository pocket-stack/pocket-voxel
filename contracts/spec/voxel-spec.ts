// Pocket Voxel spec — THE single source of truth for the `voxel` surface.
//
// Same contract discipline as contracts/spec/spec.ts and mon-spec.ts:
// everything the Rust core (crates/pocketvoxel-core/), the
// cooker (voxelmon/cook/), the guest (voxelmon/game/) and the PSP
// EBOOT agree on is pinned HERE, in plain data.
// `contracts/spec/gen-voxel-rust.ts` deterministically generates
// `crates/pocketvoxel-core/src/spec.rs` from this file;
// `tests/voxel-contract.test.ts` regenerates it in-memory and byte-compares
// against the committed file, so TS and Rust can never drift.
//
// Conventions (inherited, non-negotiable):
//   - Little-endian everywhere.
//   - Colors are u32 ABGR (0xAABBGGRR) — the PSP GE COLOR_8888 layout.
//   - Op codes are append-only: never renumber, never reuse. 0 is reserved.
//
// See docs/VOXEL.md for the architecture this contract serves, including the
// content boundary (ROM-fed like upstream gen1recomp; nothing ROM-derived is
// ever committed).

// ---------------------------------------------------------------------------
// Geometry — coordinate units (upstream contract: docs/VOXEL.md §5)
// ---------------------------------------------------------------------------

/** Graphics unit: an 8x8 pixel tile — also one voxel footprint. */
export const TILE_PX = 8;
/** Walk-grid unit: a 16x16 pixel cell = 2x2 tiles. Every actor/warp coord. */
export const CELL_PX = 16;
/** Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles. */
export const BLOCK_PX = 32;
/** Tiles per block edge. */
export const BLOCK_TILES = 4;
/** Chunk edge in tiles — the mesh/cull/stream granularity. */
export const CHUNK_TILES = 16;
/** Chunk edge in world pixels (128). */
export const CHUNK_PX = CHUNK_TILES * TILE_PX;

/**
 * World space is world pixels, matching the upstream mod: +X east, +Y up,
 * +Z south, right-handed; a resting character faces +Z (south). Tile (tx,ty)
 * occupies x in [tx*8, tx*8+8), z in [ty*8, ty*8+8). Height is world px.
 */
export const WORLD_AXES = "y-up +z-south right-handed" as const;

/** The GB UI layer, in GB pixels and tiles. Composited over the diorama. */
export const GB_W = 160;
export const GB_H = 144;
export const UI_COLS = 20;
export const UI_ROWS = 18;

/** The PSP framebuffer the diorama renders at. */
export const VIEW_W = 480;
export const VIEW_H = 272;

/**
 * The world view in world pixels: the diorama frames 240x136 and renders 2x
 * into 480x272 (the Pocket Mon viewport choice — no integer scale fits
 * 160x144 on 480x272, so the view widens instead of blurring). Camera
 * distance = WORLD_VIEW_H, so rung 0 frames exactly these world pixels.
 */
export const WORLD_VIEW_W = 240;
export const WORLD_VIEW_H = 136;

/** Fixed simulation step: 60 Hz. The tick index is the only clock. */
export const TICK_HZ = 60;

// ---------------------------------------------------------------------------
// Input — one abstract button set for every host and every tape
// ---------------------------------------------------------------------------

export const VOX_BTN = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7,
} as const;

/** Facing / movement direction. Matches the walk-sheet frame order. */
export const DIR = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
} as const;

// ---------------------------------------------------------------------------
// Camera — the pitch ladder (upstream VoxelState, minus the FULL preset)
// ---------------------------------------------------------------------------

/**
 * Orbit pitch rungs in degrees measured from straight down: rung 0 frames
 * identically to the flat 2D game. The projection derives fov so a
 * straight-down camera at dist = vh frames exactly vh world pixels
 * (fov = 2*atan(1/(2*FOCAL)), FOCAL = 1).
 */
export const PITCH_RUNGS = [0, 15, 35, 50, 75] as const;
/** Camera tween between rungs, in ticks (0.25 s at 60 Hz), smoothstep. */
export const PITCH_TWEEN_TICKS = 15;
export const CAM_FOCAL = 1;

// ---------------------------------------------------------------------------
// The quality ladder — one cooked pak, many machines
// ---------------------------------------------------------------------------
//
// This runtime is ported to machines that differ by an order of magnitude in
// throughput, so fidelity is a LADDER a machine climbs, not a build flag. A
// host names the rung its hardware holds (`quality(tier)`) and the core reads
// that rung's dials out of `QUALITY` while it builds each frame.
//
// Every dial here is a RUNTIME dial: one cooked pak serves every rung, so the
// rung is a host decision and never a re-cook. Rungs are append-only exactly
// like op codes — a machine may be added, none may be renumbered — and the
// default rung is the WEAKEST one, so a host that never calls `quality` gets
// the cheapest frame rather than the dearest.
//
// **The top rung is the identity.** It draws what this runtime drew before
// the ladder existed, pixel for pixel; `tests/goldens/voxel/*-max.hashes` are
// the pre-ladder frame hashes, replayed at the top rung and asserted
// byte-for-byte, so no later rung edit can quietly move the picture the
// ladder is supposed to preserve. That is also why `chunkDist` holds
// `CHUNK_DRAW_DIST_PX` at every rung including the top: it is a pre-existing
// frame-budget cap being folded in from `draw.rs` (where it was the
// hard-coded `CULL_DIST`), not a new fidelity dial, and widening it at the
// top would draw MORE than the pre-ladder runtime rather than the same.
//
// Distances are world px, measured from the view centre to a chunk's own
// centre and widened by that chunk's half-extent. Every dial goes through the
// same arithmetic in `draw::within_dist`, so a dial added later cannot
// measure differently from the ones the goldens were recorded against.
//
// **A dial here is still a runtime dial when the GEOMETRY differs.** Tree LOD
// cooks BOTH levels of detail into every chunk — the carved hull in mesh kind
// `treeHull`, the same cells as plain boxes in `treeBox` — and the runtime
// picks one per chunk through `treeHullDist`. One pak still serves every rung.
// What the pak must then state is which levels it actually carries, and that
// is a META flag (`VXPK_META_FLAG_TREE_LOD`), not an entry in this table: a
// pak cooked without the box level renders every tree carved at every rung
// instead of misrendering, and a pak cooked with `VOXEL_TREE_BOXES=1` (the
// ladder's predecessor: a global cook switch) carries neither level and draws
// its boxes out of the terrain stream, as it always did.

/**
 * The rungs, weakest first. Append-only: never renumber, never reuse.
 * `QUALITY[tier]` is that rung's dials, so the array and this table are one
 * data structure in two halves (`tests/voxel-contract.test.ts` pins that).
 */
export const QUALITY_TIER = {
  /** PSP-class. Measured GE throughput ~1.1 M tri/s = ~18 k tris at 60 fps. */
  psp: 0,
  /** PS Vita-class: the same geometry with roughly four times the budget. */
  vita: 1,
  /** Desktop, and the identity rung: exactly the pre-ladder picture. */
  desktop: 2,
} as const;

/**
 * The rung a scene boots at, and the rung it returns to after `reset()` only
 * if the host never picked one. The weakest rung is the default on purpose:
 * an unported host renders a frame its machine can hold.
 */
export const QUALITY_TIER_DEFAULT = QUALITY_TIER.psp;

/**
 * "No limit" for a distance dial, in world px. A finite sentinel rather than
 * an infinity so the generated Rust stays a plain `f32` literal and the
 * widened compare (`(limit + half)^2`) can never produce a NaN; 1e9 px is six
 * orders of magnitude past the diagonal of the largest map this pipeline
 * cooks.
 */
export const QUALITY_UNBOUNDED = 1e9;

/**
 * "This level never draws" for a distance dial. Negative on purpose and
 * handled EXPLICITLY in `draw::within_dist` (a negative limit admits
 * nothing): the half-extent widening means any non-negative dial — even 0 —
 * still admits the chunk under the view centre, so "off" needs its own
 * value, not a small number.
 */
export const QUALITY_OFF = -1;

/**
 * The chunk distance cap: 2.5 view-heights, the mod's own north-reach cap for
 * its shadow frustum. The frustum's far plane is effectively infinite
 * (dist*4 + 4096), so without this a leaned camera admits every chunk up-map.
 * Held at every rung — see the identity note above.
 */
export const CHUNK_DRAW_DIST_PX = 2.5 * WORLD_VIEW_H;

/**
 * The dials, indexed by `QUALITY_TIER`. Adding a dial is appending a field to
 * every row; adding a machine is appending a row.
 *
 * `grassDist` / `flowerDist` fade the two ankle-height detail meshes: past a
 * few tiles a grass tuft is a texture, not a silhouette, and the cooker emits
 * two standing slabs per grass cell and a cutout per flower cell across the
 * whole field. On ROUTE_1 at pitch rung 2 those two meshes are 40 k of the
 * frame's 80 k triangles — half the frame spent below the ankle.
 *
 * `treeHullDist` / `treeCoarseDist` pick a chunk's tree geometry from THREE
 * cooked levels: inside `treeHullDist` the fine carve (`MESH_KIND.treeHull`,
 * 1x1-px voxels, ~700 quads a cell), between it and `treeCoarseDist` the
 * coarse carve (`MESH_KIND.treeCoarse`, 2x2-px voxels, ~1/4 the quads with
 * the SAME full-resolution art on the faces), past both the plain box
 * (`MESH_KIND.treeBox`, under ten). Trees are the largest single item on the
 * ladder — fine hulls are 53 k of PALLET_TOWN's 97 k triangles at pitch rung
 * 2 and 34 k of ROUTE_1's 80 k, more than grass, flowers and water together,
 * and ROUTE_1 is a corridor whose trees are all NEAR, which is why the psp
 * rung's near level is the coarse carve (`treeHullDist: 0`): no distance
 * dial reaches near trees, only a cheaper carve does.
 *
 * `pullDepthBias` (0/1) changes HOW the pulled meshes (grass, flower) get
 * their camera-ward depth trick, not how many draw. Geometric pull — the
 * mod's own — displaces every vertex toward the eye along its own ray, which
 * on the PSP means re-staging every pulled vertex on the CPU each frame:
 * **measured 65-73 ms of a 100 ms Route-1 seam frame at ~1.15 µs per vertex**
 * (2026-08-06 autopilot, docs/VOXEL.md §4a). With the dial on, those meshes
 * draw their cooked vertices IN PLACE and the pull becomes one constant
 * NDC-depth bias per mesh, folded into the projection matrix
 * (`draw::depth_bias`) — zero per-vertex work. The bias is computed to equal
 * the geometric pull's depth shift exactly AT THE CAMERA FOCUS, which is the
 * player's own cell under the orbit rig and the arena centre under a battle
 * rig — precisely where grass-over-feet layering is a gameplay contract.
 * Away from the focus plane the bias drifts from the geometric value
 * sub-pixel-ward; the top rung keeps the geometric path, so the anchor
 * stands.
 */
export const QUALITY = [
  // psp — retuned 2026-08-06 for the 30 fps present lock, under one rule the
  // 60 fps push had traded away: NO camera-relative representation change
  // inside the visible field. A distance dial whose boundary sits in view
  // moves with every step, and the swap it hides becomes a walking artifact
  // — the roadside light-tree ring twinkled coarse<->box at 96 px, the
  // ground flipped baked<->live at the live-bubble's edge one cell ahead of
  // the player, and grass popped in and out at its 96 px fade line (all
  // three device-reported the same afternoon). Every distance dial on this
  // rung is now either unbounded (ONE representation everywhere the frustum
  // reaches) or off; what remains of the 60 fps savings are the UNIFORM
  // dials — half density, coarse-only trees, bake-everywhere — which cannot
  // flicker because they never switch. The measurements that priced the
  // moving boundaries live on in docs/VOXEL.md §4a and §7.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    // Every carved tree this rung draws is the COARSE one (fine is OFF —
    // measured 2026-08-06 over the ring report: the underfoot fine ring
    // alone was 10 968 triangles on ROUTE_1 and 11 630 on PALLET_TOWN
    // against ~3 400 as coarse). Coarse is uniform across the field; the
    // box level never shows on this rung and remains the fallback for a
    // pak cooked without the coarse stream.
    treeHullDist: QUALITY_OFF,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 1,
    // OFF makes every eligible chunk draw the baked quad — including the
    // ground underfoot. The bake is exact at the rung-2 rest pitch by
    // construction and CHEAPER than the live terrain it replaces; the live
    // bubble the old 0 dial kept around the player protected near-field
    // relief, but its edge crossed a chunk seam one step ahead of the
    // player and the baked<->live swap read as the road jumping.
    groundBakeDist: QUALITY_OFF,
    // Draw every FOURTH grass/flower quad (the cook packs each chunk's
    // detail quads in bit-reversed order, so any prefix of the index range
    // is a stratified — spatially uniform — sample of the field). Unlike a
    // fade distance this is uniform: no boundary, nothing to pop. It is
    // also what pays for the unbounded dials above: within the route-1
    // chunk reach the raw detail streams are 52k+20k triangles, the
    // largest slices of the frame; 4 (with the coarse carve's rear
    // hemisphere dropped at cook) holds the measured worst outdoor
    // segments at the 33.3 ms present slot that 2 and 3 missed.
    detailDensity: 4,
  },
  // vita — a placeholder, not a measurement. It was 192 px dials that were
  // measured pixel-identical to the top rung on the v1 maps; under the
  // no-moving-boundary rule above the honest spelling of "identical" is the
  // top rung's own dials, so a bigger map cannot quietly re-introduce a
  // boundary that today's tapes never crossed.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    treeHullDist: QUALITY_UNBOUNDED,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 0,
    groundBakeDist: QUALITY_UNBOUNDED,
    detailDensity: 1,
  },
  // desktop — the identity rung: every mesh unbounded, as before the ladder.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    treeHullDist: QUALITY_UNBOUNDED,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 0,
    groundBakeDist: QUALITY_UNBOUNDED,
    detailDensity: 1,
  },
] as const;

// ---------------------------------------------------------------------------
// Diorama constants — baked at cook time, pinned here so cooker and any
// future on-device mesher can never disagree (upstream Voxel3D/ChunkMesher)
// ---------------------------------------------------------------------------

/** Per-face shade multipliers, sun in the southeast. Index = face id. */
export const FACE_SHADE = {
  east: 0.84, // +X
  west: 0.72, // -X
  up: 1.0, // +Y
  down: 0.55, // -Y
  south: 0.9, // +Z (the drawing itself, full brightness on volume runs)
  north: 0.68, // -Z
} as const;
export const VOLUME_TOP_SHADE = 0.85;
export const GABLE_TOP_SHADE = 0.95;

/** Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded). */
export const AO = {
  step: 0.216, // per crowding neighbour on a top corner, max 3
  edge: 0.664, // crease multiplier on a side face
  corner: 0.441, // inside-corner multiplier (edge^2, floored)
  ground: 0.288, // prop ground-contact term
  risePx: 6, // px over which the ground term releases
  floor: 0.25, // shade never drops below this
} as const;

/** Water surface sits below ground; the -2 px lip is the shoreline. */
export const WATER_DROP_PX = 2;
/** Grass tuft slabs: thickness and per-cell placement (two rows per cell). */
export const GRASS_THICK_PX = 2;

/**
 * Tile-class fallback heights in world px (upstream voxel_heights defaults).
 * Profile pins from the reference checkout override per tileset at cook time.
 */
export const CLASS_HEIGHT = {
  ground: 0,
  water: -2,
  void: 0,
  ledge: 6,
  fence: 10,
  sign: 12,
  wall: 16,
  cliff: 32,
  tree: 16,
  roof: 28,
  counter: 8,
  table: 12,
  desk: 24,
  prop: 16,
  cylinder: 16,
  canopy: 32,
  stump: 16,
  grass: 0,
  flower: 0,
} as const;

/** Volume measurement caps (upstream Structures MAX_ROWS). */
export const VOLUME_MAX_ROWS = 6;

/**
 * Billboard camera-ward pull, world px: pull(a) = PULL_BASE +
 * max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN).
 * Applied along each vertex's own eye ray — a pure depth bias.
 */
export const PULL_BASE = 6;
export const PULL_NUM = 16;
export const PULL_SUB = 8;
export const PULL_MIN_SIN = 0.2;
/** Flowers give up one tile row of depth advantage vs the cards. */
export const FLOWER_PULL_SUB_PX = 8;

/** Ghost silhouette: flat color + alpha, drawn with inverted depth test. */
export const GHOST_ABGR = 0x80484242;

// ---------------------------------------------------------------------------
// Battle staging (upstream BattleArena/BattleCam, solved constants)
// ---------------------------------------------------------------------------

/** Arena footprints in cells; mons stand 3 cells = 48 px apart. */
export const ARENA_SHAPE = {
  /** 3x6 cells, enemy at (1,1), player at (1,4), 1-cell apron. */
  wide: 0,
  /** 1x4 cells, enemy at (0,0), player at (0,3). */
  narrow: 1,
} as const;
export const ARENA_GAP_CELLS = 3;
/** Clearance walk: sample step and the three sight lines per mon (px). */
export const CLEAR_STEP_PX = 4;
export const CLEAR_LINES_Y = [1, 8, 16] as const;
export const CLEAR_EPS = 1.5;
/** Off-map ground height during clearance — the border ring is trees. */
export const CLEAR_OFFMAP_H = 32;

/** The two solved over-the-shoulder rigs (offsets in world px). */
export const RIG = {
  tele: {
    side: 78.79,
    back: 144.96,
    height: 37.88,
    lookX: -0.26,
    lookY: 0.34,
    frameH: 34.11,
  },
  wide: {
    side: 41.98,
    back: 41.16,
    height: 28.48,
    lookX: -3.24,
    lookY: -1.35,
    frameH: 55.62,
  },
} as const;
/** Idle drift: yaw ±2° over 26 s, dolly ±2% over 37 s (in ticks). */
export const RIG_PAN_YAW_DEG = 2;
export const RIG_PAN_TICKS = 1560;
export const RIG_DOLLY = 0.02;
export const RIG_DOLLY_TICKS = 2220;
/** Player steering clamps. */
export const RIG_PITCH_MAX_DEG = 45;
export const RIG_ZOOM_MIN = 0.45;
export const RIG_ZOOM_MAX = 2.0;
/** Battle shadow decals darken harder than free-roam (cards need grounding). */
export const SHADOW_ALPHA_FIELD = 0.4;
export const SHADOW_ALPHA_BATTLE = 0.68;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Max simultaneously shown entity billboards (player is slot 0). */
export const ENTS_MAX = 16;

export const ENT_FLAG = {
  /** Mirror the card on X (right-facing / alternating walk step). */
  mirror: 1 << 0,
  /** Draw the ghost silhouette pass for this entity (the player). */
  ghost: 1 << 1,
  /** Card is a 16x16 grass-occluded walker (draw before grass mesh). */
  walker: 1 << 2,
} as const;

/** Emote bubble kinds (upstream field.emotionBubbles order for Red). */
export const EMOTE = {
  none: 0,
  shock: 1,
  question: 2,
  happy: 3,
} as const;

// ---------------------------------------------------------------------------
// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.
// ---------------------------------------------------------------------------
//
// All args are i32 unless noted. String args exist only where marked (the
// QuickJS host passes them as interned C strings; ops stay synchronous).
//
//   system
//     gamedata() -> ArrayBuffer            the pak GAME section (boot, cold)
//     stats() -> ArrayBuffer               frame counters (debug)
//     reset()                              drop scene state to boot
//     audiodata() -> ArrayBuffer | null    the pak AUDIO section (boot, cold):
//                                          the chip synth's program banks +
//                                          their manifest. Null where the pak
//                                          carries no audio — the guest then
//                                          runs silent. Same one-cold-read
//                                          discipline as gamedata()
//     quality(tier)                        climb the quality ladder to
//                                          QUALITY_TIER `tier`: the core
//                                          applies that rung's QUALITY dials
//                                          while it builds every later frame
//                                          (grass and flower draw distances,
//                                          the chunk distance cap). HOST
//                                          configuration, not guest state —
//                                          the host knows the machine, the
//                                          guest does not, and one cooked pak
//                                          serves every rung, so no op stream
//                                          and no pak byte differs between
//                                          tiers. `reset()` KEEPS the rung,
//                                          exactly as it keeps the synth's
//                                          rate. An out-of-range tier is a
//                                          no-op, so a host naming a rung
//                                          this core does not carry keeps the
//                                          rung it had instead of guessing.
//                                          Boots at QUALITY_TIER_DEFAULT
//   world
//     mapShow(slot, mapId, ox, oy)         slot 0 current, 1..4 neighbours;
//                                          ox/oy = seam offset in world px
//     mapHide(slot)
//     cam(x, y)                            view centre, world px (Q4 fixed:
//                                          value = px*16, so scroll is smooth)
//     pitch(rung)                          PITCH_RUNGS index; tweens
//     tint(abgr)                           global day tint (CLUT rewrite)
//     stamp(mapId, cx, cy, on)             toggle a removable stamp
//     palette(index)                       selects the SGB palette for the
//                                          terrain/sprites/pics CLUTs: index
//                                          into the pak's SGB set (sampled
//                                          from VPAL[4 + index]); -1 restores
//                                          the GB grayscale ramp; ui always
//                                          keeps the raw ramp. A pak carrying
//                                          per-tile RED++ color (VXPK_TAG
//                                          .color) overrides this per map and
//                                          per page — see that tag's
//                                          precedence rule. Color is a pak
//                                          capability, not a guest concern:
//                                          the wire is unchanged either way
//   entities
//     ent(slot, sheet, frame, x, y, lift, flags)   x/y world px Q4; lift px
//     entHide(slot)
//     emote(slot, kind)                    EMOTE; kind 0 clears
//   ui (the GB tile layer; tile ids index the cooked UI atlas)
//     uiTile(x, y, tile)
//     uiFill(x, y, w, h, tile)
//     uiText(x, y, str)                    STRING arg; charmap-resolved.
//                                          THE one live typewriter run: the
//                                          core retains only the last, gated
//                                          by uiReveal — static labels go
//                                          into the grid via uiTile instead
//     uiReveal(n)                          glyphs of the last uiText shown
//     uiClear()
//   overlay (retained screen-space pixels, composited after the GB ui)
//     uiRect(x, y, w, h, abgr)             append a solid screen-pixel rect
//     uiLabel(x, y, scale, abgr, str)      STRING arg; transparent 5x7 font
//     uiOverlayClear()                     clear every retained overlay item
//   battle
//     arena(mapId, x, y, shape, rig)       stage at cell (x,y); ARENA_SHAPE,
//                                          rig = 0 tele, 1 wide
//     card(side, pic, x, y)                side 0 player, 1 enemy; pic =
//                                          atlas page; cell coords
//     cardHide(side)
//     battleCam(orbit, pitch, zoom)        Q8 fixed 0..256 = 0..1 (zoom Q8 x)
//     arenaEnd()
//   audio (the chip synth; the core interprets the ROM's channel programs and
//         renders PCM — the guest states WHAT to play, never a sample)
//     Every arg is a number the GUEST resolved out of the AUDI manifest: the
//     core parses no JSON and knows no names. `bank` is always a BANK SLOT —
//     the index of a 0x4000-byte window inside the AUDI programs half, i.e.
//     the position of that ROM bank in the manifest's `bankOrder`. `addr` is
//     the program's GB address inside that window (0x4000..0x7fff), and
//     `engine` is the sound-engine id whose wave/drum tables the program
//     uses (1..3 in Red).
//     music(bank, addr, engine, flags)     start a song; flags = MUSIC_FLAG
//                                          (loop = the reference's
//                                          allowLoops, ChipSynth.lua:429).
//                                          Replaces whatever was playing:
//                                          "the same song does not restart"
//                                          is guest policy (Music.lua:239)
//     musicStop()                          drop the song, keep the stream
//     musicFade(ticks)                     Music.lua:312 fadeOut: rAUDVOL
//                                          steps AUDIO_FADE_LEVELS -> 0, one
//                                          level every `ticks` ticks, and the
//                                          song stops at 0. ticks <= 0 stops
//                                          immediately
//     sfx(bank, addr, engine, pitch, tempo, flags)
//                                          a one-shot over the music
//                                          (ChipAudio.lua:414 newSfx): pitch
//                                          = wFrequencyModifier added to
//                                          every tone register, tempo = the
//                                          SFX frame length (the reference
//                                          passes 0 and AUDIO_SFX_TEMPO for
//                                          the plain form). flags = SFX_FLAG;
//                                          `duck` is the FANFARE rule
//                                          (Sound.lua:55, Music.lua:102) —
//                                          the song PAUSES for the jingle and
//                                          resumes after it, which is what
//                                          stealing the music's channels
//                                          sounds like
//     cry(bank, addr, engine, pitch, length)
//                                          the species cry (ChipAudio.lua:425
//                                          newCry): pitch = the cry table's
//                                          frequency modifier, length = its
//                                          tempo byte, which becomes every
//                                          non-noise channel's frame length
//     audioWaves(engine, bank, addr)       pin a sound engine's 6-entry wave
//                                          instrument table (manifest
//                                          waveBanks[engine], ChipSynth.lua
//                                          :685). Boot-time, once per engine
//     audioDrum(engine, drum, bank, addr)  pin one drum program of a sound
//                                          engine (manifest
//                                          noiseHeaders[engine][drum],
//                                          ChipSynth.lua:645). Boot-time; a
//                                          music noise note names a drum by
//                                          this id
//
// Audio PCM leaves through the PocketJS audio module (contracts/spec/audio.ts,
// capability `audio.pcm`), not through this surface: the host pumps
// `Scene::render_audio` for exactly the frames its ring wants. A host that
// mounts no audio module never calls it and the identical op stream runs
// silent.

export const VOX_OP = {
  gamedata: 1,
  stats: 2,
  reset: 3,
  quality: 4,
  audiodata: 17,

  mapShow: 10,
  mapHide: 11,
  cam: 12,
  pitch: 13,
  tint: 14,
  stamp: 15,
  palette: 16,

  ent: 30,
  entHide: 31,
  emote: 32,

  uiTile: 50,
  uiFill: 51,
  uiText: 52,
  uiReveal: 53,
  uiClear: 54,
  uiRect: 55,
  uiLabel: 56,
  uiOverlayClear: 57,

  arena: 70,
  card: 71,
  cardHide: 72,
  battleCam: 73,
  arenaEnd: 74,

  music: 18,
  musicStop: 19,
  musicFade: 20,
  sfx: 21,
  cry: 22,
  audioWaves: 23,
  audioDrum: 24,
} as const;

/** Fixed-point scales used by op args. */
export const Q4 = 16;
export const Q8 = 256;

// ---------------------------------------------------------------------------
// The chip synth — constants the core, the cooker and the guest share
// ---------------------------------------------------------------------------
//
// The synth is a port of gen1recomp `src/core/ChipSynth.lua`; these are that
// file's own constants, pinned here so the Rust core and any TypeScript that
// resolves the manifest agree on them exactly.

/** One ROM sound bank: the window a program address is read inside. */
export const AUDIO_BANK_SIZE = 0x4000;
/** Sound-engine table slots. Red uses ids 1..3; slot 0 is never pinned. */
export const AUDIO_ENGINES = 4;
/** Drum ids per sound engine (Red's tables reach 19). */
export const AUDIO_DRUMS = 32;
/** Wave instruments a sound engine exposes: 5 read + 1 shared across 6..9
 *  (ChipSynth.lua:685-707 — the ROM's table is short and the driver clamps). */
export const AUDIO_WAVES = 9;
/** The channel-program tick clock durations are counted in (ChipSynth.lua:18). */
export const AUDIO_TICKS_PER_SECOND = 15360;
/** One frame of the GB sound driver, in program ticks (ChipSynth.lua:19). */
export const AUDIO_FRAME_TICKS = 256;
/** The GB master clock the noise LFSR divides down (ChipSynth.lua:20). */
export const AUDIO_GB_CLOCK = 4194304;
/** The plain SFX tempo byte (ChipAudio.lua:418 `0x80 + (tempo or 0x80)`). */
export const AUDIO_SFX_TEMPO = 0x80;
/** rAUDVOL levels a fade walks down through (Music.lua:312 fadeOut). */
export const AUDIO_FADE_LEVELS = 7;
/** Longest one-shot the reference renders (ChipSynth.lua:849). */
export const AUDIO_EFFECT_MAX_SECONDS = 5;
/**
 * The synth's integer mix unit: one channel at full scale is AUDIO_MIX_UNIT.
 * 480 = lcm(15, 32), so both a pulse at volume v (v/15) and a wave nibble at
 * output level 1/4 ((n-8)/8 * 1/4) land on an integer — which is what lets
 * the whole mix run without a float and still quantize to the same s16 the
 * reference's doubles do.
 */
export const AUDIO_MIX_UNIT = 480;

/** `music(…, flags)`. */
export const AUDIO_MUSIC_FLAG = {
  /** Honor `sound_loop 0` instead of ending the channel (ChipSynth.lua:429). */
  loop: 1 << 0,
} as const;

/** `sfx(…, flags)`. */
export const AUDIO_SFX_FLAG = {
  /** A FANFARE: pause the song for the jingle (Sound.lua:55, Music.lua:102). */
  duck: 1 << 0,
} as const;

// ---------------------------------------------------------------------------
// Events — core -> guest facts, drained as one batch per tick. APPEND ONLY.
// ---------------------------------------------------------------------------
//
// Wire layout: a u32 count, then `count` records of EVENT_SIZE bytes:
//   u16 kind | u16 a | i32 b | i32 c | i32 d
// No kinds are defined yet: the core currently states no fact the guest does
// not already know. The channel is pinned so streaming/timing facts can
// append later without a wire change.

export const VOX_EVENT = {} as const;

export const EVENT_SIZE = 16;
export const EVENT_CAP = 64;

// ---------------------------------------------------------------------------
// VXPK — the cooked content container
// ---------------------------------------------------------------------------
//
// Layout (MONPAK discipline):
//   0   u32  MAGIC ('VXPK' LE)
//   4   u16  VERSION
//   6   u16  section count
//   8   u32  total byte length
//   12  u32  reserved (0)
//   16  section table: `count` entries of VXPK_ENTRY_SIZE bytes:
//              u32 tag | u32 offset | u32 length | u32 count
//   ..  section payloads, each aligned to VXPK_ALIGN
//
// Every offset is from the start of the blob. Sections appear in tag order.
// The core is the only untrusted-byte reader: it validates every range and
// never indexes unchecked.

export const VXPK_MAGIC = 0x4b505856; // 'VXPK'
/**
 * 4 grew the chunk record by the two tree levels of detail and META by a
 * flags word; 5 grew the record again by the MIDDLE tree level
 * (`MESH_KIND.treeCoarse`); 6 by the baked-ground quad
 * (`MESH_KIND.groundBake`) and its per-chunk bake page; 7 by the baked
 * chunk's kept-structure stream (`MESH_KIND.terrainKeep`); 8 shrank the
 * vertex to 16 bytes (u16 fixed-point UVs). The shapes are
 * pinned below and both readers validate them, so an older pak is
 * rejected, never mis-read.
 */
export const VXPK_VERSION = 8;
export const VXPK_HEADER_SIZE = 16;
export const VXPK_ENTRY_SIZE = 16;
export const VXPK_ALIGN = 16;
/** The META record: eight u32 counts/dims, then a flags word and a pad word. */
export const VXPK_META_SIZE = 40;
/**
 * META flag bit 0: every chunk carries BOTH tree levels of detail — the
 * carved hulls in `MESH_KIND.treeHull` and the same cells as plain boxes in
 * `MESH_KIND.treeBox` — so a runtime may pick one per chunk (`treeHullDist`).
 * A pak WITHOUT this flag carries at most one level, and a runtime that wants
 * the other draws whichever the pak holds instead of dropping the trees.
 */
export const VXPK_META_FLAG_TREE_LOD = 1 << 0;
/**
 * META flag bit 1: the chunks also carry the MIDDLE tree level — the same
 * hulls carved at 2x2-px voxels (`MESH_KIND.treeCoarse`, ~1/4 the quads; the
 * art on the faces stays full-resolution because only geometry coarsens).
 * Without it, a rung asking for the coarse level draws the fine hulls
 * instead: more triangles, never fewer trees.
 */
export const VXPK_META_FLAG_TREE_COARSE = 1 << 1;
/**
 * META flag bit 2: eligible chunks carry a baked ground quad + page
 * (`MESH_KIND.groundBake`). Without it, `groundBakeDist` draws geometry
 * everywhere — slower, never wrong.
 */
export const VXPK_META_FLAG_GROUND_BAKE = 1 << 2;
/** The AUDI payload's own header (json_len, program_len, two pad words). */
export const VXPK_AUDIO_HEADER_SIZE = 16;
/** The VCOL payload's own header (version, counts, flags, two pad words). */
export const VXPK_COLOR_HEADER_SIZE = 16;
/** VCOL payload format version. */
export const VXPK_COLOR_VERSION = 1;
/** VCOL flag bit 0: the terrain page carries per-tile RED++ group indices. */
export const VXPK_COLOR_FLAG_WORLD = 1 << 0;
/** "no VCOL palette here" — fall through to the legacy binding. */
export const COLOR_PAL_NONE = 0xffff;

/** Section tags (4CC, LE u32). */
export const VXPK_TAG = {
  /** u32 counts + view meta; see cook/pak.ts for the packed shape. */
  meta: 0x4154454d, // 'META'
  /**
   * CLUT palettes: u16 count, then count * 256 u32 ABGR entries. The list
   * is the 4 ATLAS_KIND default (GB grayscale) palettes followed by the SGB
   * set; the `palette` op selects an SGB entry that REPLACES the color ramp
   * for non-ui kinds (ui always samples its own default).
   */
  palette: 0x4c415056, // 'VPAL'
  /**
   * Atlas pages: u16 count, then per page a 16-byte header
   * (u16 w | u16 h | u16 kind | u16 frames | u32 offset | u32 len) with
   * pre-swizzled CLUT8 texels; animated pages store `frames` variants
   * back-to-back.
   */
  atlas: 0x534c5441, // 'ATLS'
  /**
   * Per-map chunk meshes: map directory, then per chunk a header
   * (i16 cx | i16 cy | AABB i16[6] | per-mesh-kind vert/index ranges) over
   * shared 20-byte-vertex and u16-index pools. One range per `MESH_KIND`.
   */
  chunks: 0x4b4e4843, // 'CHNK'
  /** Removable stamps: per map, per (cx,cy) a small vert/index range. */
  stamps: 0x504d5453, // 'STMP'
  /** GB charmap -> UI atlas tile, u16 pairs (for uiText). */
  charmap: 0x50414d43, // 'CMAP'
  /** The gameplay dataset the guest parses at boot (JSON bytes). */
  game: 0x454d4147, // 'GAME'
  /**
   * The chip synth's input, returned verbatim by the `audiodata` op:
   *   0  u32 json_len       audio.json (UTF-8), the header/song tables
   *   4  u32 program_len    programs.bin, the concatenated ROM sound banks
   *   8  u32 pad = 0 | 12 u32 pad = 0
   *   16 json bytes, then 16-aligned, program bytes
   * Both halves may be empty (a pak cooked without audio); the guest then
   * runs silent. See voxelmon/game/audio/banks.ts for the reader.
   */
  audio: 0x49445541, // 'AUDI'
  /**
   * Per-tile color bindings — RED++ / pokered-gbc parity, entirely pak-side
   * (no op, no guest change). The cooker bakes the RED++ palette GROUP into
   * the terrain texel index (`texel = group * 4 + shade`, 0..31; 0xff stays
   * transparent) and this section says which VPAL entry each draw resolves
   * that index through:
   *
   *   0  u16 version = VXPK_COLOR_VERSION
   *   2  u16 map_count      == the CHNK map count
   *   4  u16 page_count     == the ATLS page count
   *   6  u16 flags          VXPK_COLOR_FLAG_WORLD when the terrain page is
   *                         group-baked (so a world_pal is mandatory for
   *                         every map whose sheet was baked)
   *   8  u32 pad = 0 | 12 u32 pad = 0
   *   16 map_count * 8: u32 map_id | u16 world_pal | u16 terrain_page
   *   .. page_count * 2: u16 page_pal
   *
   * Every u16 palette/page index is either COLOR_PAL_NONE or a valid index;
   * the core range-validates all of them. Map records carry `map_id`
   * explicitly, so the section is order-independent of the CHNK directory.
   *
   * PRECEDENCE, for every textured draw: the item's own VCOL palette (a
   * chunk/stamp mesh takes its map slot's `world_pal`) wins, else the page's
   * `page_pal`, else the `palette` op's SGB selection (`VPAL[SGB_PAL_BASE +
   * i]`, non-ui kinds only), else the page kind's GB grayscale ramp. The ui
   * kind never takes a VCOL palette. A pak whose VCOL is all COLOR_PAL_NONE
   * renders exactly as a v2 pak did.
   */
  color: 0x4c4f4356, // 'VCOL'
} as const;

/** Atlas page kinds. */
export const ATLAS_KIND = {
  terrain: 0,
  sprites: 1,
  ui: 2,
  pics: 3,
} as const;

/**
 * The GE world vertex (v8):
 *   u16 u | u16 v | u32 abgr | i16 x | i16 y | i16 z | i16 pad  = 16 bytes.
 * UVs are page-normalized fixed point — round(uv * 32768), clamped to
 * 32767 — matching the GE's TEXTURE_16BIT semantics in TRANSFORM_3D (the
 * hardware divides by 32768; the software rasterizer divides identically,
 * so both backends sample the same quantized coordinate). i16 positions
 * are countered by a x32768 model scale on the GE. The 20-byte f32-UV
 * vertex this replaces cost 25% more GE fetch bytes on a fetch-bound part.
 */
export const VERTEX_STRIDE = 16;
/** A batch seals before u16 index overflow. */
export const MAX_VERTS_PER_CHUNK_MESH = 65532;

// ---------------------------------------------------------------------------
// Mesh kinds inside a chunk — draw order is their numeric order
// ---------------------------------------------------------------------------

export const MESH_KIND = {
  terrain: 0,
  /**
   * The chunk's BAKED GROUND: one textured quad drawn INSTEAD of this
   * chunk's terrain + grass + flower meshes past `groundBakeDist` (§quality
   * ladder). The texture is the cook's oblique projection of those quads
   * onto the y=0 plane at the rung-2 rest pitch, composited in CLUT-index
   * space on the chunk's own bake page (`Chunk.bake_page`), so palettes and
   * the day tint apply unchanged. Only low-relief chunks bake (docs §4a);
   * a chunk with an empty range here is ineligible and always draws its
   * geometry.
   */
  groundBake: 1,
  /**
   * A baked chunk's KEPT structures: every terrain quad taller than the
   * bake line (fences, signs, the border tree walls, buildings), duplicated
   * out of the full terrain stream at pack time. Drawn WITH the bake quad
   * in place of `terrain`; the full stream stays untouched for the rungs
   * (and moments) that draw geometry, so the identity anchor never moves.
   */
  terrainKeep: 2,
  /**
   * Carved round-scenery hulls (trees), the NEAR level of detail. Cooked out
   * of the terrain stream into their own range so the runtime can swap them
   * per chunk; drawn immediately after their own chunk's terrain, which is
   * exactly where they sat inside it.
   */
  treeHull: 3,
  /**
   * The MIDDLE level: the same hulls carved at 2x2-px voxels — ~1/4 the
   * quads, full-resolution art on the faces (UVs interpolate the original
   * texels; only the silhouette quantises to 2 px). The three tree kinds are
   * alternatives inside the terrain pass: a chunk draws exactly one, chosen
   * by `treeHullDist`/`treeCoarseDist`.
   */
  treeCoarse: 4,
  /** The same cells as plain extruded boxes: the FAR level of detail. */
  treeBox: 5,
  water: 6,
  grass: 7,
  flower: 8,
} as const;
export const MESH_KINDS = 9;

/**
 * Bytes per CHNK chunk record: i16 cx | i16 cy | i16 AABB[6] | u16
 * bake_page (0xffff = no bake) | u16 pad | one 12-byte mesh range per
 * MESH_KIND. Both writers size the directory with this.
 */
export const VXPK_CHUNK_RECORD_SIZE = 20 + MESH_KINDS * 12;
/** `Chunk.bake_page` value for "this chunk has no baked ground". */
export const BAKE_PAGE_NONE = 0xffff;
