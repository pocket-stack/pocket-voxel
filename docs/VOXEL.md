# Pocket Voxel

A specialized PocketJS runtime that presents a Game Boy creature-RPG as a
voxelized 3D diorama on PSP-class hardware. The gameplay is a TypeScript port
of the [gen1recomp](https://github.com/bryanthaboi/gen1recomp) Lua engine; the
presentation is a Rust reimplementation of the
[DramaticShape Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
diorama renderer. Both upstreams are MIT-licensed; both serve here as
executable specifications, not vendored code.

The runtime instance is `⟨ pocketvoxel-core, the voxel surface, the voxelmon
guest ⟩` in the RUNTIMES.md sense. What is new relative to every prior
instance: **the game state lives in the guest**, and the core owns only the
presentation domain. Pocket Mon put world+battle in Rust and authored content
in TS; Pocket Voxel puts world+battle in TypeScript and gives Rust the scene.
That is the same relationship the `ui` surface has with its guest — a retained
scene core-side, intent ops guest-side — applied to a 3D diorama.

## 1. The content boundary

This runtime takes the **opposite legal stance from Pocket Mon**, and the two
must never blur:

- `engine/pocketmon` (branch `feat/pocketmon-runtime`) is clean-room: no ROM
  path exists, and a test enforces it. Its content is original.
- `crates` is **ROM-fed, exactly like upstream gen1recomp**: the
  only game-content input is a canonical US Gen-1 ROM the player already owns.
  The importer verifies SHA-1 (`ea9bcae617fdf159b045185467ae58b2e4a48b9a` for
  Red) before decoding one byte. Everything decoded lands under `dist/` and is
  **git-ignored — no ROM-derived byte is ever committed**: no cooked pak, no
  extracted art, no decoded text, and no golden PNG (goldens are frame hashes;
  PNG dumps stay local).

Reference checkouts are inputs the same way the ROM is. `tools/voxel.ts`
resolves them from `VOXELMON_G1R` (default `~/code/gen1recomp`) and
`VOXELMON_VOXELMOD` (default `~/code/DramaticShapeVoxelMod`):

- the gen1recomp checkout supplies `tools/rom_manifest.json` — the symbol
  table (3274 name→[bank,addr] entries), charmap, and per-map metadata the
  importer is driven by. The importer is **manifest-driven, not
  offset-hardcoded**; we consume that manifest verbatim rather than
  transcribing a megabyte of addresses.
- the same checkout supplies `data/palettes_gbc.lua` — the RED++ colour
  pack: 239 named SuperPalettes, 151 species→name entries, and the
  `world` table (per-tileset tile→palette-group vectors, per-group colours,
  the per-town roof pairs, 8 OBJ palettes and their ROM-picture-id
  assignment). It is **pokered-gbc-derived, not ROM-derived**: Pokémon Red
  ships no CGB code, so **there is no `CGBBasePalettes` for Red at all** —
  every colour in this file comes from the pokered-gbc source tree, and
  gen1recomp commits the generated table under its own MIT licence. It
  converts at cook time exactly like the VoxelMod tables, into git-ignored
  `dist/voxelmon/gen/palettes_gbc.json`.
- the VoxelMod checkout supplies `data/voxel_heights.lua` (tile class
  profiles, 55 building templates) and `data/battle_arenas.lua` (94 authored
  arena entries), converted at cook time.

Tests that need the ROM or a reference checkout skip when absent — the
`POCKET3D_TEST_MAPS` convention. CI never sees any of it.

## 2. Layout

```
crates/
  pocketvoxel-core/   scene core: VXPK reader, chunk registry, entities,
                      camera rungs, battle staging, GB UI tile layer, draw
                      list, chip synth. no_std + alloc, f32 (libm on PSP),
                      zero deps.
  pocketvoxel-sim/    headless host: software rasterizer, PNG out, op-trace
                      replay, frame hashes. (desktop workspace member)
  pocketvoxel-gu/     sceGu backend. Consumes the draw list; never touches
                      list lifecycle (the pocket3d-gu contract). (standalone)
  pocketvoxel-psp/    the EBOOT: QuickJS realm + voxel surface + gu backend.
                      (standalone, hosts/psp toolchain pins)
  pocketvoxel-gxm/    raw-GXM backend (§12). Same draw list, same contract as
                      the gu backend. (standalone)
  pocketvoxel-vita/   the VPK: QuickJS realm + voxel surface + gl backend +
                      the PCM ring. (standalone, cargo-vita)
voxelmon/
  import/             ROM importer (TS): manifest-driven decode of tilesets,
                      maps, sprites, species, moves, text, encounters, pics,
                      sound programs.
  cook/               voxelizer + atlas packer + VXPK writer (TS).
  game/               the gameplay port (TS): world, script VM, text, menus,
                      battle, audio. Runs in Bun headless and in QuickJS on
                      device.
  tapes/              intent tapes (walk/press/wait — never frame counts).
contracts/spec/voxel-spec.ts     the surface, single source of truth
contracts/spec/gen-voxel-rust.ts → crates/.../spec.rs (drift-guarded)
tools/voxel.ts                   import | cook | sim | check | record | shots
                                 | wav | psp | run | vita | parity
docs/VOXEL.md                    this file
tests/voxel-*.test.ts            contract drift + importer parity + gameplay
tests/goldens/voxel/             frame HASHES only
```

## 3. The split

**Guest (TypeScript)** — the entire gen1recomp gameplay surface, ported
module-for-module with the Lua as executable spec: fixed 60 Hz step,
edge-per-step input, map loading and connections, grid movement and collision
(bottom-left-tile rule), ledges, warps, doors, NPC wander and scripted moves,
trainer sight, encounters, the script runner and its verbs, text pagination,
menus, party/bag/save, and the battle engine (damage, crit, accuracy, type
chart, status, catch, exp — each formula carrying a provenance citation to the
Lua it ports). The guest owns the RNG and the save. One guest turn per host
tick: `frame(buttons)`, exactly once.

**Core (Rust)** — presentation only, zero gameplay:

- loads the VXPK, owns chunk meshes zero-copy in place, culls per frame
  (frustum over chunk AABBs — the `pocket3d-gu` world path with chunks in
  place of PVS faces);
- retains the scene the guest drives through ops: camera, pitch rung, tint,
  up to 16 entity billboards, removable stamps, emotes, the battle stage, and
  a retained GB UI tile grid (20×18) with a reveal counter for typewriter
  text, plus a bounded native-pixel overlay for coloured modal application
  chrome;
- interprets the ROM's sound programs and renders PCM on demand (§8): the
  guest names a song, an effect or a cry in numbers and the core does the
  synthesis, because the same interpreter in QuickJS costs 2.3 s of CPU per
  second of audio on this part;
- resolves every textured draw's CLUT through one function,
  `draw::resolve_pal` — the pak's per-map world palette, then the page's own
  palette, then the `palette` op's SGB selection, then the page kind's GB
  ramp. Both backends call it, so the software rasterizer and the GE can
  never bind different colours for the same draw;
- builds one ordered draw list per frame. Draw order (from the mod, minus
  shader-bound passes): outdoor sky bands (or opaque-black indoor clear bands)
  → terrain chunks, each followed by its own
  tree mesh at the level of detail this rung picked (§4a) → water (flat,
  animated atlas) → shadow decals → player ghost (inverted depth, no write) →
  entity cards → grass mesh → flower mesh → GB UI quads → optional
  host-video quad → native overlay rectangles.

Per-frame boundary traffic is **~10–40 ops** (camera + moving entities +
a reveal counter); menu opens burst a few hundred `ui*` ops once. Against the
measured QuickJS wall (~1.7 µs/op, ~8k ops/frame at 333 MHz) that is noise.

## 4. The voxel surface

Pinned in `contracts/spec/voxel-spec.ts`, codegen'd to Rust, byte-compare
drift guard — the `mon-spec.ts` discipline unchanged. Op groups:

- **world** — `mapShow(slot, mapId, ox, oy)` / `mapHide(slot)` (slot 0 =
  current, 1..4 = connected neighbours at their seam offsets), `cam(x, y)`,
  `pitch(rung)`, `tint(abgr)`, `sky(on)`, `stamp(mapId, cx, cy, on)` (cut tree, moved
  boulder — pre-cooked removable sub-meshes toggled at runtime),
  `palette(index)` (the SGB SuperPalette for the map, index into the pak's
  SGB set). On a pak cooked with the RED++ pack the per-map and per-page
  bindings in the `VCOL` section outrank `palette(index)` entirely, and
  **the guest emits the identical op stream either way** — no op, no flag
  and no gamedata field differs between the two colour models. Which model
  a build uses is decided by the cook, not by the guest. `sky` is append-only
  op 75 and retained, defaults visible for old guests/traces, and is emitted
  only when the map identity changes. `sky(0)` keeps black, zero-horizon
  `SkyBands` in the draw list so PSP clears colour/depth and Vita/Web/sim see
  the same tint-independent indoor void.
- **entities** — `ent(slot, sheet, frame, x, y, lift, flags)`, `entHide`,
  `emote(slot, kind)`. Billboards lean back by camera pitch and pull toward
  the eye along each vertex's own ray — the mod's projection-invariant depth
  bias, ported exactly. `lift` is the entity's absolute feet height above the
  map plane: the tile's cooked support height plus any active hop lift.
- **ui** — `uiTile(x, y, tile)`, `uiFill(x, y, w, h, tile)`,
  `uiText(x, y, str)` (glyphs resolved core-side through the cooked charmap),
  `uiReveal(n)`, `uiClear()`. The GB UI is a retained tile layer composited
  over the diorama, scaled to fit 480×272.
- **overlay** — `uiRect(x, y, w, h, abgr)`,
  `uiLabel(x, y, scale, abgr, str)`, `uiOverlayClear()`. These commands retain
  native 480×272 pixel rectangles and transparent 5×7 labels, clipped and
  capped at the core boundary, then composite them after the GB UI. The
  bedroom PC uses this layer for its centred colour window while leaving the
  world visible around it.
- **host video** — `remotePlane(x, y, w, h)` retains one destination rectangle
  between the GB UI and the native overlay. The guest owns only its geometry
  and the modal `WAITING`/`LIVE` state. `remoteOpen()`, `remoteTick()` and
  `remoteClose()` bind a host-owned video-only stream; no captured audio enters
  the chip-synth path. A non-positive plane size removes it.
- **battle** — `arena(mapId, x, y, shape, rig)`, `card(side, pic, x, y)`,
  `cardHide(side)`, `battleCam(orbit, pitch, zoom)`, `arenaEnd()`. The two
  solved camera rigs (tele / wide) and the spread correction come from the
  mod's constants. Battles stage on the map; **nothing moves the player** —
  the camera goes to the arena, exactly as upstream.
- **audio** — `music(bank, addr, engine, flags)`, `musicStop()`,
  `musicFade(ticks)`, `sfx(bank, addr, engine, pitch, tempo, flags)`,
  `cry(bank, addr, engine, pitch, length)`, plus the two boot-time table
  pins `audioWaves(engine, bank, addr)` and
  `audioDrum(engine, drum, bank, addr)`. Every argument is a number the guest
  resolved out of the AUDI manifest: `bank` is a **bank slot** (that ROM
  bank's index in the manifest's `bankOrder`) and `addr` the program's GB
  address inside its 0x4000-byte window. **The core parses no JSON and knows
  no name; the guest reads no sample.**
- **system** — `gamedata()` (returns the pak's GAME section to the guest at
  boot: one cold JSON parse, then the guest never crosses for data again),
  `audiodata()` (the pak's AUDI section; the guest parses only its JSON half,
  and the program half stays in the pak, where the core reads it),
  `stats()` (frame counters), `reset()`, `quality(tier)` (§4a).

### 4a. The quality ladder

This runtime is ported to machines an order of magnitude apart in
throughput, so fidelity is a **ladder a machine climbs, not a build flag**.
The rungs and their dials are pinned in `voxel-spec.ts` (`QUALITY_TIER`,
`QUALITY`); a host names its rung once with `quality(tier)` and the core
applies that rung's dials while it builds every frame.

Two rules make it a ladder and not a pile of switches:

- **Every dial here is a RUNTIME dial.** One cooked pak serves every rung, so
  the rung is a host decision and never a re-cook — no op stream and no pak
  byte differs between a PSP and a desktop. Geometry that must itself differ
  per machine is cooked at BOTH levels and picked between at runtime, and the
  pak declares which levels it carries so a runtime asking for one it does not
  hold degrades instead of misrendering (`treeHullDist`, below). The
  `VOXEL_TREE_BOXES=1` cook flag is the shape this replaces.
- **The top rung is the identity.** It draws exactly what this runtime drew
  before the ladder existed. `tests/goldens/voxel/*-max.hashes` are the
  pre-ladder frame hashes and `bun tools/voxel.ts check` replays every tape at
  the top rung against them byte-for-byte, so no later dial edit can quietly
  move the picture the ladder is supposed to preserve.

The dials, all distances in world px from the view centre to a chunk's own
centre, widened by the chunk's half-extent — one function, `draw::within_dist`,
so a dial added later cannot measure differently from these:

| rung | `grassDist` | `flowerDist` | `treeHullDist` | `treeCoarseDist` | `groundBakeDist` | `detailDensity` | `chunkDist` | `pullDepthBias` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `psp` (default) | unbounded | unbounded | off | unbounded | off (bake all) | 4 | 340 | on |
| `vita` | unbounded | unbounded | unbounded | unbounded | unbounded (never) | 1 | 340 | off |
| `desktop` | unbounded | unbounded | unbounded | unbounded | unbounded (never) | 1 | 340 | off |

`chunkDist` is 2.5 view-heights at **every** rung including the top: it is
`draw.rs`'s old hard-coded `CULL_DIST` folded in, a pre-existing frame-budget
cap rather than a new fidelity dial, and widening it at the top would draw
*more* than the pre-ladder runtime instead of the same.

**The no-moving-boundary rule (2026-08-06).** The psp rung shipped one
afternoon with finite detail distances (96 px), a coarse/box tree boundary
(96 px) and a live-geometry bubble around the player (`groundBakeDist` 0),
and every one of them became a device-visible walking artifact the same day:
a distance boundary inside the visible field moves with each step, so the
swap it hides plays as flicker (the roadside light-tree ring twinkled
coarse↔box), popping (grass at its fade line) or a jump (the road flipping
baked↔live one cell ahead of the player). Under the 30 fps present lock the
rung now keeps **one representation everywhere the frustum reaches**: every
distance dial is unbounded or off, and the frame is paid for with the
UNIFORM dials — coarse-only trees, bake-everywhere, detail density, and
the coarse carve shipping without its rear hemisphere (a carved ball is
convex and the camera is always south of and above it, so its north faces
are self-occluded at every pitch rung; they were 25% of the coarse
stream) — which cannot flicker because they never switch. `detailDensity`
draws a prefix of each chunk's detail streams; the cook packs those
streams stratified (round-robin by within-cell rank, cells in bit-reversed
order), so any prefix is a spatially uniform sample — packed row-major,
"half density" had meant a bald south half per chunk, not thinner grass.
Composition at the route-1 checkpoint under these dials (the
`VOXEL_TRIS=1` probe in pocketvoxel-sim): coarse trees 15.4k, keep 10.2k,
grass 6.6k, bake 2.2k, flower 1.5k — ~37k against the ~40k that holds a
33.3 ms present.

**Why the grass and flower distances were 96 px in the 60 fps push
(historical — the rung now draws them unbounded).** The end-to-end
pipeline measured ~1.1 M triangles/s when these dials were set (the figure
folded in CPU submission costs that have since been removed — the GE alone
sustains ~1.3 M/s on this content, still fetch-bound, see §6), so 60 fps
budgets ≈18 k triangles a frame. The cooker
emits two standing slabs per grass cell and a cutout per flower cell across
the whole field, and on ROUTE_1 at pitch rung 2 those two meshes are **40 226
of the frame's 80 428 triangles** — half the frame spent below the ankle.

Culling is chunk-granular (128 px chunks), and that quantises the dial hard.
Measured over the story trace at the three ROUTE_1 checkpoints, grass+flower
cost is **flat from 48 px to 96 px and jumps at 112 px**: at `mid-route` it is
27 686 triangles anywhere in 48..96 and 34 130 at 112; at `route-1` it is
22 632 anywhere in 64..96 and the full 32 224 at 112. **96 px is the largest
distance that still buys the whole first-ring saving**, which is why it is the
shipped number — every larger value costs picture and buys nothing. It takes
30–34% off the two detail meshes at the ROUTE_1 checkpoints and 5–17% off
those whole frames.

It does not reach 18 k, and **no distance dial can**: even deleting grass and
flowers outright leaves the worst story frame at 99 176 triangles against
131 432 today.

**Why the tree dials are 0/128, and what the cook had to carry for them.**
A carved tree hull is **~700 quads per cell**; the plain box the same cell
extrudes to is **under ten**. That is why trees, not detail meshes, are the
frame: at pitch rung 2 the hulls are **55 754 of PALLET_TOWN's 96 836
triangles and 34 732 of ROUTE_1's 80 428**, more than terrain, grass, flowers
and water together. So the cooker emits all THREE levels — the fine carve
into `MESH_KIND.treeHull`, the same drawing carved at 2×2-px voxels into
`MESH_KIND.treeCoarse` (trees.ts runs the identical algorithm on a
half-resolution canvas; ~1/3 the packed quads, and the art on the faces
stays full-resolution because UVs span the real texels), the cells
re-extruded as boxes into `MESH_KIND.treeBox` — and `draw::build` picks one
per chunk against `treeHullDist`/`treeCoarseDist`, drawing it immediately
after that chunk's own terrain.

The psp rung's `treeHullDist: 0` is not "no fine trees": `within_dist`
widens every limit by the chunk's half-extent, so the chunk under the view
centre — the tree the player is standing next to, where 2-px quantisation
would be most visible — keeps the fine carve at ANY non-negative dial. The
result is a three-ring gradient: fine underfoot, coarse to 128 px, boxes
beyond. Measured over the story trace with this rung's other dials held
(geostat, per-checkpoint): ROUTE_1 98 184 → **69 832** triangles (trees
52 760 → 24 408, −54%), PALLET_TOWN 89 496 → **67 124**, `mid-route`
59 656 → 41 868, the worst sampled frame 110 144 → **81 792** (−26%). The
coarse level costs the pak the CHNK growth of one more mesh range per chunk
plus its quads (ROUTE_1 75 294 → 85 374 packed quads, ~+13%).

Measured over the story and battle tapes at every tick, with the other dials
held at this rung: the worst frame is **flat at 110 144 triangles from 128 px to 144 px and
jumps to 117 272 at 160 px**. 128 px is the point in that plateau where every
pixel the swap costs sits at the horizon or the frame's top edge — 886 px of a
480×272 frame at `battle-intro`, 438 px in an 11-px strip at the top of
`encounter-seen`, and nothing at all at the nine other story checkpoints.
Below it the boundary walks into the near field: at 96 px Pallet Town's whole
roadside tree column turns to slabs (1908 px at `sign-read`) and so does the
boulder beside the battle stage (9824 px). The rung takes **15% off the mean
story frame (57 339 → 48 959 triangles) and 11% off the worst (124 392 →
110 144)**, and costs **+173 888 pak bytes, 0.84%** — the box level is 3 716
triangles over all seven maps, against 159 036 carved.

Two facts the pak states so a runtime never has to guess. The **META flags
word** (`VXPK_META_FLAG_TREE_LOD`) says the chunks carry both levels; without
it — an older pak, or one cooked with `VOXEL_TREE_BOXES=1`, which carves
nothing and leaves its boxes in the terrain stream — every rung draws the one
level the pak holds rather than losing its trees. And the **chunk record grew
two mesh ranges**, which is a VXPK version bump (3 → 4), so a stale pak is
rejected instead of mis-read.

VXPK v9 assigns the CHNK record's former reserved `u16` to chunk flags
without changing the 128-byte record size. `VXPK_CHUNK_FLAG_BORDER_RING`
(bit 0) marks geometry that belongs only to the current map's protective
border; unknown bits fail pak validation. This lets the same map record be
safe as slot 0 and as a neighbouring slot without duplicating its body mesh.
The core, browser exporter and WASM console packager all require v9 exactly:
v8 has no compatibility reader and must be re-cooked. Code and assets therefore
ship as one version; GAME/save semantics did not change, so existing saves need
no migration.

**Where the two levels do not line up.** A quad joins the chunk its centroid
falls in, and a hull is a ball wider than the cell it stands on, so a tree at
a chunk seam can put a few of its hull quads in the neighbouring chunk while
its box stays in its own. Over the seven v1 maps that is **3 chunks of 122**:
one carries 2080 hull triangles and no box (those quads vanish when that chunk
goes far), two carry 8 box triangles each and no hull. The visible effect is
bounded by the goldens' own pixel counts above; the fix, if it ever shows, is
to bin a hull by its stamp centre rather than per quad — which is a change to
the near level's quad order and therefore to the identity rung, so it needs
the `-max` goldens re-proved, not re-recorded.

The `vita` rung is a placeholder, not a measurement: at 192 px it is
pixel-identical to the top rung across the story and battle tapes on the v1
maps, because 128 px chunks inside a 340 px cap leave room for only two distinct settings
here. It is a labelled rung owed a number from the machine itself.

**What is still over budget after this rung.** With the coarse carve in
(and the fine dial then turned OFF on the psp rung — `QUALITY_OFF`, the
carve ring at 96), the worst sampled story frame at the shipped rung is
~70 k triangles: grass ~26 k, terrain ~22 k, coarse trees ~15 k, flowers
~5 k. Trees stopped being the largest item; **grass and terrain now are**,
and the ring report (geostat) says both are NEAR-dominated — ROUTE_1's
grass sits entirely inside 64 px and most of its terrain inside 96 px, so
no distance dial reaches either. The planned next rung is the
**ground bake**, below.

**The ground bake (planned, the 60 fps rung).** At cook time, every chunk
whose terrain stays low-relief (max height ≤ 16 px — no buildings) also
gets a BAKED GROUND IMAGE: its terrain, grass and flower quads obliquely
projected along the rung-2 view direction onto the y=0 plane (`z' = z −
y·tan 35°`, x unchanged — the projection is exact for the pitch the game
plays at), composited in draw order **in CLUT-index space** (the bake page
stays in the terrain page's palette domain, so RED++ world palettes and the
day tint keep working unchanged), at half resolution (1 texel = 2 world
px ≈ 1 screen px at the 2× view scale). At runtime a `groundBakeDist` dial
(psp ≈ 64–96, measured before shipping; top rung unbounded-off) draws one
textured quad instead of that chunk's terrain + grass + flower meshes —
trees, water and stamps stay geometry on top. The bake is gated to the
rung-2 rest pitch and to field play (any pitch tween, another rung, or an
active battle rig falls back to full geometry — slower, never wrong).
What it buys, from the ring report: ~11 k terrain triangles on ROUTE_1 and
~15 k on PALLET_TOWN at a 64 px dial, plus painted-in grass and flowers
where today's rung draws bare ground beyond 96 px. What it costs: one
128×128 CLUT8 page per bakeable chunk (~16 KB, ~1–2 MB over the seven v1
maps), no AO variation in the baked ground, and ledge steps painted rather
than stepped beyond the dial. Buildings chunks are simply ineligible.
After it: hull instancing through the STMP shape (also the pak lever:
carved hulls are 7.3 MB of chunk data), and a 16-byte vertex (u16 UVs) for
a ~20% cut in GE fetch bytes across every stream.

**Why `pullDepthBias` exists, and what it changes.** The mod's camera-ward
pull displaces every pulled vertex toward the eye along its own ray — a
depth trick whose screen position is unchanged by construction. On the PSP
that displacement has to be re-staged on the CPU each frame (textured
TRANSFORM_3D draws must use the pak's i16 vertex format, §6), and the
autopilot telemetry measured that restage at **65–73 ms of a ~100 ms
Route-1 seam frame — 54–63 k pulled vertices at ~1.15 µs each**, the single
largest line in the whole frame. With the dial on, grass and flower draw
their cooked vertices IN PLACE and the pull becomes one constant NDC-depth
bias per mesh, folded into the projection matrix (`draw::depth_bias` +
`draw::biased_vp` — the software rasterizer and the GE transform through
the SAME biased matrix). The bias equals the geometric pull's depth shift
exactly **at the camera focus** — the player's own cell under the orbit
rig, the arena centre under a battle rig — which is precisely where
grass-over-feet layering is a gameplay contract; away from the focus plane
it drifts sub-pixel-ward. Entity cards keep the geometric pull at every
rung (four vertices each), and the top rung keeps it for everything, so the
identity anchor never moves. Shipping this dial re-recorded the psp-rung
goldens (8 outdoor story marks, 2 battle marks — grass depth quantises
differently off-focus) with the PPSSPP e2e green at every mark.

**Where the frame went after the 2026-08-06 CPU work** (autopilot phase
telemetry, story tape, means per 300-tick window): guest JS 16–19 ms, draw
list build ~0.7 ms, CPU record ~0.5–1 ms, GE (hidden under the guest's
window, surfacing as sync wait) 0–53 ms, vblank ~5–8 ms. Pallet Town
102 → 81 ms, the Pallet↔Route-1 seam 129 → 68 ms, Route 1 128 → 54 ms,
interiors 33 ms; the arena-pressure JS collections that used to hitch
mid-walk (2 × 175 ms a run) now never fire outside boot, because the
delta-emit gates stopped allocating (scene.ts — numeric and identity gates
where per-tick key strings used to be). The frame is now **GE-fetch-bound**
(§6): the next rungs are the hull carve-resolution dial and far-chunk
impostors, both geometry diets the ladder was built to hold.

PCM leaves through the PocketJS `audio` module (`contracts/spec/audio.ts`,
capability `audio.pcm`), not through this surface: the host pumps
`Scene::render_audio` for exactly the frames its ring wants and writes them
under credit. A host that pumps nothing runs the identical op stream silent.

Events are the standard packed batch wire (`u16 kind | u16 a | i32 b | i32 c
| i32 d`) with **no kinds defined yet** — the core currently states no fact
the guest does not already know. The channel exists so mesh-streaming or
host-side timing facts can append later without a wire change.

### 4b. The remote-computer stream

The macOS companion captures one selected AVFoundation screen through FFmpeg,
scales it to a **512×128 RGB332 CLUT8 frame at 12 fps**, and assigns each
file session or PKNT connection a non-zero stream epoch. The stored frame is
anamorphic: the device stretches it into the bedroom PC's 360×180 plane,
restoring the captured display's proportions while keeping each update near
65 KiB. The fixed-size
eight-slot ring bounds both disk use and reader work.

PPSSPP and PSPLINK use the PocketJS service filesystem at
`pocket-svc/voxelmon/media/desktop.pkst`. The PSP reads at most 26 KiB per
game tick, validates a slot sequence before and after the chunked read, and
copies complete CLUT8 pixels into persistent GE memory only after `sceGuSync`.
The Vita uses PocketJS's PKNT transport over Wi-Fi: `streamOpen` installs the
same ring image in RAM and video slots use latest-only backpressure. Network
discovery and screen broadcast are enabled only by the daemon's explicit
`--tcp` option; the default daemon writes only to the local PPSSPP/usbhostfs
directory.

The companion unlinks `desktop.pkst` when capture stops because the ring holds
recent screenshots. Selecting the remote PC freezes the overworld in a normal
modal game state, retries an absent companion without falling back to the local
mock desktop, and releases the host stream on `B` or `START`.

## 5. The asset pipeline

`bun tools/voxel.ts import` — TS port of the gen1recomp extractor, driven by
the same `rom_manifest.json`: SHA-1 gate, bank arithmetic, 2bpp/1bpp tile
decode, the Gen-1 pic RLE+delta decompressor, text-command VM, the lot.
Output: `dist/voxelmon/gen/*.json` + raw indexed bitmaps. **Parity is
testable**: the reference checkout's `tools/build_rom_data.py` produces the
same datasets independently, and `tools/voxel.ts parity` deep-compares.

`bun tools/voxel.ts cook` — the VoxelMod's analysis, run once on the Mac
instead of every session on the handheld:

1. classify every tile position (profile pins → cell rules → wall fallback;
   the class/height table ported verbatim);
2. measure volumes (repeat-aware column heights, region consensus, roof
   split), match building templates, place pinned props;
3. mesh per **16×16-tile chunk** into GE-ready buffers: 20-byte vertices
   (`u,v f32 | color u32 | x,y,z i16 + pad`), u16 indices, face shade ×
   baked AO folded into vertex color, grass/flower/water split into their
   own meshes, side faces cut into 8 px bands with cropped (never stretched)
   art. Round scenery is meshed **twice** — the carved hull and the plain box
   the same cells extrude to — into the two tree mesh kinds a runtime picks
   between (§4a). The hulls ride the terrain stream through the analysis, the
   cull and the u16 batching and are split out only at pack time, so a
   chunk's hull vertices land immediately after its own terrain vertices and
   the near level of detail keeps the exact quad order it had before tree LOD
   existed;
4. pack atlases as pre-swizzled CLUT8 — one terrain atlas copy per animation
   frame (water, flowers), so tile animation on device is a texture bind, not
   a texel write; day tint is a CLUT rewrite, the GB's own trick;
5. bake RED++ colour into the terrain page and resolve the bindings
   (`cook/redpp.ts`, below);
6. drop the faces no camera can reach (below);
7. write `dist/voxelmon/voxelmon.vxpak` (MONPAK-style container: magic,
   section table, 16-byte alignment, validated zero-copy reader in the core)
   including the GAME section the guest reads at boot, the AUDI section
   carrying `audio.json` + `programs.bin` verbatim, and the VCOL section
   naming each map's and each page's CLUT.

### Connected-map border rings

The Lua `ChunkMesher` keeps a protective wall around a map only where no
loaded direct neighbour owns the other side. The cooker now makes that
ownership explicit without duplicating body vertices:

- only direct neighbours present in this cook open a mask; an exit to an
  uncooked map stays closed and keeps its wall;
- tile quads use the Lua strict/open mask, object quads use its closed mask,
  and `own` eaves, outward boundary facades and round-tree stamp tests keep
  their upstream ownership rules;
- each quad is routed once to body or ring. Pure ring chunks carry
  `VXPK_CHUNK_FLAG_BORDER_RING`; slot 0 draws body + ring, while neighbour
  slots 1–4 reject ring records before every terrain, water and tree LOD pass;
- ring records carry no ground-bake page and no grass/flower stream, preventing
  the PSP bake from smuggling the removed neighbour wall back into the frame.

Pallet Town ↔ Route 1, Route 1 ↔ Viridian City and Viridian City ↔ Route 2
are pinned in both directions. Their body/ring quads are disjoint, while a
synthetic uncooked exit remains sealed.

### The hidden-face cull

Every quad the cooker emits names the direction its front points in
(`cook/geom.ts` `FACE`, the mesher's own `SIDES` numbering), and one rule —
`visibleFacing` — decides which of them no camera can reach. The rule is
applied at exactly one site, `runGeometry`'s return, after the shading and
ground votes have read the full face set. `VOXEL_KEEP_HIDDEN=1` restores
every face and re-cooks a byte-identical pre-cull pak, which is how the rule
is A/B'd.

The rule is **-Y faces topping out at or below 24 world px are dropped**. A
downward face is front-facing only when the eye is under it, and eye height
depends on the rung or rig alone, never on where the player stands:
`WORLD_VIEW_H * cos 75°` = 35.20 px for the field camera, 37.12 px for the
tele rig, 27.91 px for the wide rig at minimum dolly and zero pitch steer
(steer only raises it). **This cuts 5.2% of the cooked quads and 4.6% of the
pak — 210143 → 199175 quads, 21809312 → 20797312 bytes over the seven v1
maps — with all 11 story and 4 battle hash goldens byte-identical.**

Two neighbouring ideas were measured and rejected, and stay rejected:

- **North-facing (-Z) quads are not hidden.** A north wall is front-facing
  wherever `z > eye.z = cy + dist·sin a`, and at rung 0 `eye.z` is the middle
  of the frame — the southern half of a top-down frame shows the north walls
  of everything in it. Dropping them moves 16 of a 30-frame pitch-ladder
  sweep (20916 pixels, 7076 in the worst frame) and breaks the `route-1`
  story golden.
- **The pulled streams keep every face.** GRASS and FLOWER draw with a
  camera-ward `pull` (46 px at rung 0) that displaces each vertex along its
  OWN eye ray — not a rigid transform, so a quad's cooked facing is not its
  drawn facing. Culling them costs 4380 (grass) and 415 (flower) pixels over
  the same sweep and breaks six story and two battle goldens. TERRAIN, WATER
  and the stamps draw with `pull = 0.0` and are the streams the rule acts on.

**The cull is not pixel-exact, by 6 pixels in 3916800.** The rasterizer draws
double-sided with no top-left tie-break, so both triangles sharing an edge
cover a pixel centre that lands on it, and the depth test is strict: a
back-facing underside that ties with the flank it shares an edge with can win
that pixel. Removing the underside hands those 6 pixels — 4 frames of the
30-frame sweep, all at rungs 0 and 1, all single isolated pixels on a
building eave or a tree-hull rim — to the neighbouring face. This is a
property of the renderer, not of the height threshold: a threshold of 2 px,
which drops almost nothing, still leaves 3 of them.

**A free-roam or orbiting field camera deletes this optimisation, it does not
work around it.** Anything that lowers a camera's eye below 24 px — a new
rig, a smaller `RIG.*.height`, a sixth pitch rung past 75° — invalidates the
cooked pak, not just `cook/geom.ts`.

### Per-tile colour (RED++ / pokered-gbc)

pokered-gbc assigns one of **8 four-colour palettes to every tile GRAPHIC
id** of a tileset — by tile id, not by map position — and swaps only the
ROOF slot per town. gen1recomp's ADVANCED mode CPU-recolours the whole
tileset atlas per map from that data. We reach the same colours without
recolouring anything, by moving the group into the texel index:

```
texel = group * 4 + shade     // 0..31
0xff  = transparent           // unchanged
```

8 groups × 4 shades = **32 of the CLUT's 256 entries**, and a tileset's
whole RED++ colour set is 18–20 distinct colours (measured), so the entire
per-tile assignment fits inside the byte the page already stored: **zero
delta in page dimensions, texel count, texture format, fill rate, vertex
count, draw calls and guest ops**. The CLUT bound for a chunk mesh becomes
the shown map's world palette, so Pallet Town's white roofs and Viridian's
green roofs share one terrain page and cost one CLUT load each. The runtime
cost is a few extra 1 KB pool-staged CLUTs per frame.

The roof swap replaces **only colours 1 and 2** of the ROOF group;
colour 0 (sky through the gaps) and colour 3 (outline black) keep the
tileset's own base, exactly as `LoadTownPalette` writes
`W2_BgPaletteData + $32`. Sprites take one of 8 OBJ palettes keyed by ROM
picture id, and battle pics take their species' named palette — both
per-page bindings the backends resolve at bind time, so no entity op
changes. **v1 measures 3 world CLUTs, 4 OBJ and 10 pic over the seven
cooked maps: +17 KB of VPAL and 824 bytes of VCOL on a 13.9 MB pak.**

Parity is claimed **at the CLUT, not at the framebuffer**: our terrain
modulates the CLUT colour by baked AO × face shade, so no pixel can match a
flat 2D reference. `tests/voxel-cook.test.ts` runs gen1recomp's own
`PaletteFX.worldGroupAt`/`worldGroupColors` under LuaJIT and compares all
2688 resolved colours (7 maps × 96 tile ids × 4 shades) against the cook.

## 6. What renders on PSP, and what deliberately does not

Kept from the mod, verbatim where possible: the class/height tables, volume
measurement, gables and hips, band-cropped side art, `FACE_SHADE` and the AO
constants, billboard lean + camera-ward pull, the ghost silhouette (inverted
depth test), the arena shapes + three-line clearance walk + authored arena
table, both battle rigs, the horizon-at-infinity derivation, the orbit
projection (framing-identical to the flat view at every zoom).

Substituted or dropped, per the mod's own fallbacks: shadow **decals** instead
of the shadow map; **flat animated water** instead of screen-space
reflections; hardware alpha test (`sceGuAlphaFunc`) for sprite cutouts; no
world curve, no wireframe, no supersampling, no glass glints, no tilt-shift
in v1. First/third-person free-roam and the detected-object segmentation pass
(flood-fill standee discovery) are later rungs; v1 ships the orbit pitch
ladder (0/15/35/50/75) and pinned props only.

GE discipline inherited from pocket3d-gu, const-asserted: 20-byte world
vertex, i16 positions countered by a ×32768 model scale, inverted 16-bit
depth (`GreaterOrEqual`, clear 0), GL-style −1..1 projection, dcache
writeback after every CPU write the GE reads, pool reset only after
`sceGuSync`, 333 MHz set explicitly at boot.

Two more GE rules this runtime bisected on real hardware (PPSSPP's software
renderer agrees on the second — both draw plausible-looking garbage, never
crash): **textured TRANSFORM_3D draws must use the i16+indexed WORLD
vertex** (a textured `VERTEX_32BITF` card samples noise; every card and
pull-displaced mesh re-stages through the pak's own 20-byte format), and
**CLUT8 atlas pages must be at least 64 px wide** (a 16-px-wide sprite
sheet missamples into vertical-strip noise; the cooker pads sprite and
emote pages and the card U normalizes by page width).

A third finding, from the autopilot phase telemetry (2026-08-06 device
A/B/A over the story tape), is about WHERE the frame's time actually goes:
**the GE here is fetch-bound, and what it fetches from matters less than
whether the CPU just wrote it.** Splicing each mesh's index range through
the frame pool made the GE ~17 ms/frame faster on Pallet Town than drawing
the same bytes in place from the pak — but a boot-time copy of the whole
index pool into its own block reproduced NONE of that win (GE time
identical to in-place), so the splice's advantage was the recency of its
CPU writes, not the block it lived in, and it cost the CPU ~25 ms of the
same frame to produce. The shipped backend therefore draws index ranges
**in place** (the cooker 16-byte-aligns each range, `cook/pak.ts
appendMesh`, as cheap insurance; `pocketvoxel-gu` splices only ranges an
older pak left unaligned) and spends no per-frame CPU on geometry at all.
The consequence worth remembering: with submission costs at ~1 ms, **GE
time scales with vertex/index bytes fetched per frame, so the next rungs
down this ladder are geometry diets (hull carve resolution, far-chunk
impostors), not draw-call or culling tricks** — back-face culling saves
raster work but the fetches and transforms are already paid by then.

### What per-tile colour does NOT reproduce in v1

Every item here is a deliberate limit with a stated reason:

- **The GB UI, menus, textboxes and the battle screen stay grayscale.** The
  native overlay is a separate ABGR layer and does not recolour GB tiles.
  RED++ colours them through named SuperPalettes over SGB zones, which needs
  a `uiPal(x, y, w, h, pal)` op — a new op, so a new spec round. HP-bar
  colour by fill (`GetHealthBarColor`) waits on the same op.
- **Dark caves.** `wMapPalOffset`/`FadePal2` shifts the palettes feeding the
  bake, not a shader. v1's seven maps contain no dark map.
- **The Celadon Mart tile exceptions and the `$37 → $5a` alias tiles.** v1
  bakes ONE terrain page shared by every map, so a per-map tile-id exception
  cannot apply; `cook/redpp.ts` carries the reference's tables and the
  cooker **refuses to cook** a map that needs one rather than mis-colouring
  it silently.
- **The Route 6 / Saffron roof y-split.** The reference's own atlas path
  skips it too, so skipping it *is* parity with RED++ as implemented.
- **Per-NPC `"random"` sprite palettes.** The reference resolves the
  `"random"` sentinel from a stable per-instance seed; the CLUT here belongs
  to the sprite PAGE, so v1 resolves it once per sheet at cook time (seeded
  by the sheet key, through the reference's own `h = h*31 + byte` hash).
  Individual NPCs may therefore draw a different one of the four colours
  than gen1recomp does on the same map.
- **Per-tileset terrain page splitting.** Two tilesets may share a sheet only
  if their 96-entry group vectors agree — 0 of v1's 4 sheets disagree, 2 of
  the whole game's 19 do (`gate.png`, `pokecenter.png`). A disagreement is a
  cook-time error; the VCOL map record already reserves a `terrain_page`
  field so the splitter lands without a format change.
- **No user-facing colour mode.** The pak carries one colour model; changing
  it is a re-cook, not a toggle.

## 7. Determinism and verification

The frame is a pure function of (tick index, buttons). The tick clock is the
only clock; tile animation and menu cursors derive from it.

1. **Importer parity** — TS output deep-compared against the Python reference
   extractor's output for the same ROM (`tools/voxel.ts parity`).
2. **Gameplay tests** — bun tests port the reference suite semantics
   (`tests/engine/formulas.lua`, timing budgets, collision/ledge/warp parity
   cases) against the ROM-decoded dataset, plus the fixture dataset for
   ROM-free CI.
3. **Oracle runs** — the Lua reference executes headless under LuaJIT
   (verified: 110/110 engine suites, 832/837 content checks on this ROM;
   the 5 failures are one audio-dependent suite the Python extractor does not
   feed). Targeted modules are driven with identical inputs and compared
   trace-for-trace.
4. **One tape, every host** — intent tapes drive the Bun headless sim, which
   records the per-frame op stream + input. `pocketvoxel-sim` replays that op
   stream through the real core + software rasterizer into frame hashes
   (committed) and PNGs (local only). The capture EBOOT replays the same
   recorded input under PPSSPP and must agree with the rasterizer — the
   Pocket Mon `--emit-psp` pattern.
5. **Two rungs, one tape** — a tape is a guest op stream and the quality rung
   is a host decision, so `bun tools/voxel.ts check` replays each recorded
   trace twice through `pocketvoxel-sim --quality`. `story.hashes` /
   `battle.hashes` are recorded at the **shipped `psp` rung**, so they carry
   that rung's dials (§4a) and legitimately move when a dial does. The grass
   and flower fade moved 5 of 11 story marks and all 4 battle marks, every one
   of them in the far field; tree LOD then moved 1 story mark
   (`encounter-seen`) and all 4 battle marks, and nothing else; the
   depth-bias pull (§4a `pullDepthBias`) moved the 8 outdoor story marks and
   2 battle marks — grass depth quantises differently away from the focus
   plane — with the grass-over-feet contract verified intact in the psp-rung
   shots and the PPSSPP e2e green at every mark (worst AE 4963 of 12000).
   `story-max.hashes` / `battle-max.hashes` are the identity anchor,
   asserted at the top rung and **never re-recorded for a dial edit** — a
   mismatch there means the top rung stopped being the identity, and the fix
   is the dials, not the file. A VERTEX FORMAT change is the one legitimate
   re-basing event, and it pays for the file rewrite with a pixel-diff
   proof: the v8 16-byte vertex (u16 fixed-point UVs, ÷32768 — at most a
   1/64-texel sampling shift against the 0.02-texel INSET) moved **590
   pixels across all fifteen max-tier frames** (worst 255 in one frame,
   0.195%; nine frames under 10), every one a texel-boundary flip, and the
   anchors were re-recorded 2026-08-06 with that bound in hand. A PACK
   ORDER change ranks the same way: the stratified detail-stream order
   (§4a `detailDensity`) re-sequences grass slabs whose crossing lines are
   equal-depth contests, where draw order owns the shared pixels — the
   stratified pack moved **60 pixels across all fifteen frames** (worst 23,
   0.018%), every one on a tuft's crossing or cell-border line, and the
   anchors were re-based 2026-08-06 with that bound in hand. (A
   rank-preserving order was tried first specifically to hold the anchor;
   neighbour-cell border ties move regardless, so the ceremony was paid
   rather than the uniformity constraint weakened.) A **GAMEPLAY** change is
   the third and plainest re-basing event, and it is the only one that moves
   both rungs for the same reason: the tape is intent, so when the guest
   legitimately does something different the op stream itself is different
   and every hash downstream of it follows. It still owes the same proof —
   which marks moved, and why each one had to. The 2026-08-07 parity pass
   (§11) moved **3 of the 15 marks**: `battle-intro` at both rungs, because
   a two-line message page now shows BOTH of its lines (the finished row
   went from a clobbered `uiText` to grid tiles); and `encounter-seen` /
   `escaped` at both rungs, because the battle screen is now torn down
   before the post-battle hold instead of staying up through it, so the
   mark lands on the map rather than on the battle. The other twelve are
   byte-identical, which is itself the evidence that the overworld changes
   in that pass — cues, deferred seam music, the bump poll, the map-script
   dispatch — are audible or behavioural but not pictorial.

## 8. Audio

Sound is the ROM's own **channel programs** — short bytecode streams the GB's
sound driver interprets a frame at a time — run by an interpreter in the
**Rust core** (`pocketvoxel-core/src/audio.rs`, a port of gen1recomp's
`ChipSynth.lua`) that renders straight to PCM. There is no register-level
emulation: the interpreter tracks each channel's note, envelope, duty,
vibrato, slide, sweep and noise LFSR itself, and the four channels sum,
divide by four and clamp.

The split is the same one the rest of this runtime uses. The guest owns
names, the core owns bytes:

- `game/audio/banks.ts` — the manifest. It resolves a song label, an sfx name
  or a species into the numbers an audio op carries, including the **bank
  slot**: the index of that ROM bank in `bankOrder`, which is where the
  core's 0x4000-byte program window starts. Two transports, one loader (the
  `data.ts` discipline): Bun reads `gen/audio.json`, the device takes the
  JSON half of the pak's AUDI section from the `audiodata` op.
- `game/audio/music.ts` — the policy (a port of `Music.lua` + `Sound.lua`):
  one op per state transition, and nothing else.
- `pocketvoxel-core/src/audio.rs` — the interpreter, the mixer and the
  program bytes, read in place out of the pak's AUDI section. The host pumps
  `Scene::render_audio(pak, frames, out)` for exactly the frames its ring
  wants; rendering is a pure function of (the ops applied so far, the frames
  asked for), so splitting a tick's frames across two calls writes the same
  bytes.

**Why it moved.** Measured on real PSP hardware, one PCM frame of the
four-channel interpreter cost **~0.21 ms** in QuickJS, so 11.025 kHz wanted
**~2.3 seconds of CPU per second of audio**: the guest could never reach the
ring's lead and the frame collapsed to ~9 fps while the music played slow and
gapped. Compiled, the same interpreter renders a whole tick's 184 frames in
**~6.5 µs on a desktop** (measured over 600 s of audio at 11.025 kHz), which
extrapolates to a few hundred microseconds on the Allegrex — **~2% of the
16.7 ms frame**, not 230% of it.

The arithmetic is integer wherever the reference's doubles are integer
underneath: the envelope, the noise LFSR and its clock divider, the NR10
sweep, the durations, the tick snapping, and the whole mix. Two places keep
the reference's double on purpose and both are off the per-sample path — the
60 Hz frame index, where the reference's double disagrees with the exact
rational and the ROM is timed against the reference, and the frequency, which
is recomputed only when the register moves (≤128 times a second per channel)
and lands in a 64-bit fixed-point phase accumulator that advances by integer
addition.

The synth runs at whatever rate the host sets (`Audio::set_rate`), and every
`AUDIO_RATES` value divides 44.1 kHz exactly, so a host resamples with
integer math. The highest note the ROM's pitch table reaches (~2 kHz) sits
inside Nyquist at **11.025 kHz**, the device rate; the cost of a tick is
linear in the rate.

**The pump on device.** The EBOOT is the audio module's client, not the
guest: `pocketvoxel-psp/src/main.rs::audio_pump` runs once per tick, between
`frame(buttons)` and `scene.tick()`, so no PCM crosses the JS boundary at
all. It drains the module's event batch (a `credit` event resets its
free-frame mirror), asks for this tick's `audioFramesForTick` frames plus
whatever it takes to reach a **100 ms lead**, caps that at **three ticks
(552 frames)** so one catch-up cannot blow the frame budget, renders into a
bss buffer sized for that worst tick, and writes it with one `write_pcm`.
The stream opens on the first audio op the guest emits and plays only after
the first accepted write, so a guest with audio off (`setAudio(null)` in
`psp-main.ts`) never reserves a hardware channel. The sim pumps the same
`Scene::render_audio` on its virtual clock (`--wav`), which is what makes a
recorded `.wav` and a device run the same sequence.

What plays where, straight from the reference's own call sites: the map's
theme on map entry (`Music.lua:339`), the wild-battle theme and the enemy's
cry on an encounter (`BattleState.lua:1458`, `:1496`), the victory theme the
moment the win is decided (`:370`), the map theme again when the battle
closes (`:407`), and the `Press_AB` beep on a textbox advance or close
(`TextBox.lua:269`, `:284`).

`bun tools/voxel.ts wav` renders any song, sfx or cry to
`dist/voxelmon/audio/*.wav` with its peak and RMS printed, so "it renders"
and "it is audible" stay two different claims. It goes through the same core
synth as the game does: a one-program `.vtrace` replayed by
`pocketvoxel-sim --wav`.

### Verification: the reference is the oracle

`tests/voxel-audio.test.ts` renders the same program twice — once through the
REFERENCE `ChipSynth.lua` under LuaJIT (`tests/fixtures/voxelmon/oracle/
chipsynth-oracle.lua`, a two-function `love` stub around the unmodified
file), once through the core over the real op stream — and requires the PCM
to be **sample-exact**, not within a tolerance. It also asserts the level:
sample-exact silence would still be a bug, so music has to clear 30% of full
scale.

Measured over the whole ROM at 44.1 kHz, five seconds each: **45 songs, 104
sound effects and 154 cries, all sample-exact** — ~200 million samples, zero
differences. Reaching that took three fixes the sweep found and no unit test
would have: the quantizer's tie at exactly ±2.0 channel-sum, where the
reference's double falls off the boundary its own rounding chose; the phase
step, which must be the reference's double rather than the exact rational,
because a register like 1920 is 1024 Hz exactly and lands ON a duty boundary
every 11025 samples; and the phase accumulator's own rounding, reproduced by
normalizing and rounding the fixed-point sum to 53 significant bits.

## 9. Budgets

16.7 ms/frame at 60 Hz. Guest JS ≤ 2 ms typical (measured OpenStrike idle is
1.4 ms with a far chattier HUD); chunk splice + draw well under the GE's
measured sub-30 µs world cost at OpenStrike scale; a route-scale map cooks to
~1.5–2.5 MB of vertex data (indexed, 20 B/vertex — the mod's 10–20 MB is
unindexed f32 at window resolution and not comparable). Per-map + neighbours
stream from the pak into one reused aligned buffer, the OpenStrike map-swap
pattern. VRAM: 512×272 double-buffered 8888 + 16-bit Z ≈ 1.39 MB; textures
sample swizzled from main RAM.

## 10. Scope ladder

v1 (this tree, delivered): Red only. Import (16 datasets at field-level
parity with the reference extractor) + cook (42/42 non-desk building
templates, carved tree hulls at two levels of detail, 8 baked tile-animation
frames) + the overworld
slice — walk, collide, ledges, grass, warps, doors, signs, NPCs, an 8-verb
script runner, the textbox typewriter — and the wild-battle core (damage /
accuracy / crit / status / catch / run / exp through the oracle-verified
rules; the early-route effect set; unknown effects degrade via the
reference's own fallbacks) staged in the voxel arena with the classic GB
battle screen composited over it. Three intent tapes drive Bun, the Rust
rasterizer (committed hash goldens: 11 story + 4 battle + 7 bedroom-computer
marks, at two quality rungs each — §4a) and the PSP capture EBOOT. Sound is
the ROM's own channel programs, interpreted and rendered to PCM core-side
(`pocketvoxel-core/src/audio.rs`, sample-exact against the reference over all
303 of them): map themes, the wild-battle and victory
themes, the textbox beep and species cries. Colour is RED++ / pokered-gbc
**per tile**, baked into the terrain texel index and bound per map (§5),
oracle-checked against the reference's own `PaletteFX`; the GB UI layer
stays grayscale, independently of the native colour overlay.

Field entity feet also use the VoxelMod's cooked positive tile support:
player hop lift is added to the source cell until landing, while NPCs and
items use the cell height directly. The four shipped interiors explicitly
request the black void; this is visibility state only, not a DayNight system.

Later rungs, in dependency order: the GB UI colour layer (a `uiPal` op — the
one piece of RED++ parity that needs a new op); pak slimming for the
PSP-1000's 24 MB and the frame budget together
(hull instancing over the STMP per-cell range, which is the only cut left for
the carved trees the distance dial cannot reach; per-map streaming);
**neighbour-map NPC ghosts** (§11); the arena
clearance walk (needs cook-time heights in gamedata) and the authored arena
table; the rest of the script verb set and the story cutscenes (§11);
trainer battles + AI
layers; the desk-set templates, stairs, and detected props; battle move
animations; the box system, marts, and the start menu; Blue/Yellow manifests;
first/third person; link play never.

Stadium battle models are **permanently out of scope** — they require an N64
ROM this pipeline does not accept.

## 11. The parity pass (2026-08-07)

A line-by-line re-read of the port against `gen1recomp` at HEAD `f0ed2ef`,
subsystem by subsystem, with every claimed divergence checked twice at its
cited lines on both sides. The rules modules came through clean — damage,
crit, accuracy, the type chart, catching, exp, growth, collision, ledges and
connections are the Lua's arithmetic verbatim. Everything the pass found was
in the glue: a surface contract used the wrong way, registry entries never
made, and cues fired from the wrong moment.

**Fixed here.**

- **`uiText` is one live run, and a finished row is not it.** The spec says
  the core retains only the last `uiText` (§ui). The guest emitted one per
  row, so on every two-line page the first line went blank the instant the
  second began typing — nearly every sign, NPC line and battle message in
  the shipped maps. Finished rows are stamped into the retained grid now
  (glyph codes ARE ui tile ids), and only the typing row is a `uiText`. The
  YES/NO labels had the same shape; they are grid tiles too.
- **The string that crosses the boundary is cell-exact.** `'s` is one glyph
  to the guest (Font.lua:262 matches digraphs greedily) and two characters
  to the surface, so a reveal stopped one cell short and a padded row ran
  one cell wide: "Can't escape!" printed as "Can't escape". The cook mints a
  code point per multi-character charmap entry (`LIGATURE_BASE + code`) and
  `toCells` emits it.
- **Two reachable move effects were unregistered.** `SPEED_DOWN1_EFFECT`
  (WEEDLE's STRING SHOT, Route 2 grass) printed "But, it failed!" every
  time and never touched the speed stage; `POISON_SIDE_EFFECT1` (POISON
  STING) could never poison. The census was re-derived from the cooked map
  set rather than patched — `DEFENSE_UP1_EFFECT`, `FLINCH_SIDE_EFFECT1`,
  `TWO_TO_FIVE_ATTACKS_EFFECT` and `FOCUS_ENERGY_EFFECT` become reachable
  once a caught mon grinds, and are registered too.
- **`EvolveAfterBattle` was never wired.** `battle.leveledUp` was written
  and never read, so a SQUIRTLE that reached 16 on Route 1 stayed a
  SQUIRTLE forever (the offer is gated on levelling *this* battle, so there
  is no catching up later). `Evolution.checkParty`'s decision half is
  ported; `game.ts` runs the pages, the apply and the evolved species'
  exact-level learn check on the way out of a battle.
- **The hand-ported map scripts have a call site.** The 8-verb runner had
  no caller: `showMapText` went straight to extracted text, and a text_asm
  pointer extracts only its FIRST branch — so Mom offered the wake-up line
  to a trainer who already had a starter, forever, and Oak never stopped
  barring the grass. `world/mapscripts.ts` carries the scripts for the maps
  this pak cooks, transcribed from `data/scripts/`, and the verb set grew
  to what they invoke (`check_flag`, `jump`/`jump_if_true`/`jump_if_false`,
  `label`, `face_player`, `heal_party`, `play_once`, `fade`). Jump targets
  resolve by row, by label and by `"end"`; a re-entrant `resume` lands the
  pending yield instead of throwing; an unknown verb logs the row it drops.
- **Cues fire where the reference fires them.** The battle now queues its
  audio at the Lua's own call sites and the shell drains that queue, which
  fixed three orderings at once: the wild mon's cry sounded before the
  silhouettes had landed, the victory theme a text box late, the map theme
  ten ticks after teardown. The field cues that were simply absent are in:
  `Collision` on a wall bonk (with its 16-frame cooldown), `Ledge` on a
  hop, `Go_Inside`/`Go_Outside` on a door warp. A connection crossing
  defers the new map's theme to the frame the seam step LANDS.
- **The post-battle hand-back is the map's, not the battle's.** The battle
  screen is torn down at teardown, and it is the map that pays
  POST_BATTLE_RETURN and then MapEntryAfterBattle's 24 frames.
- **YES/NO answers hold.** Both branches of `DisplayTwoOptionMenu` hold 15
  frames with the menu up, and B snaps the cursor to NO first — in the
  overworld box and in the battle's, which also owed the A/B beep.
- **Smaller ones.** The content-boundary bump ends the direction poll
  instead of continuing it (a held diagonal walked on the other axis, and
  the turn-in-place flag re-armed mid-hold); a locked warp no longer leaks
  `doorWarp` into the next one, and resumes a parked script instead of
  stranding it; border-extended tile reads use a floored modulo, as Lua's
  `%` does; the ball chain hides the wild mon while the ball shakes
  (`HIDEPIC`/`SHOWPIC` are engine state, not animation state).

**Found, not fixed, and why.**

- **Neighbour-map NPC ghosts.** Upstream keeps connected maps' objects
  alive and ticking so a connected map is not empty and an NPC that
  wandered while you were away is where it should be at the seam
  (`OverworldController.lua:533` ghosts, ticked at :1039, drawn at :4738).
  The port builds only the current map's list. The port already draws the
  neighbours' terrain, so the gap is visible — but the fix spends entity
  slots against a 16-slot budget on a machine whose frame is already
  locked, so it wants its own pass with a hardware measurement, not a
  drive-by.
- **`TWINEEDLE_EFFECT` and `SWITCH_AND_TELEPORT_EFFECT`.** Reachable at
  L19-20 on a caught mon. The first wants the per-hit seam its poison
  reroute uses; the second ends the wild battle from inside a move, which
  is a battle-exit path this slice does not have.
- **Item balls, and the ball supply.** ROUTE_2's two item-ball objects are
  inert, and with no reachable ball source the fully-ported catch path is
  dead content in the shipped build. Both want the item-object interaction
  upstream has, which is the same seam marts and the start menu sit behind.
- **ROM wording for three lines.** The learn-move, confusion-wears-off and
  paralysis lines print the Lua's own fallback templates rather than
  resolving the ROM label. The port declares this adaptation for the pure
  rules modules (`rules/status.ts`); making it consistent means porting
  `RomText` and sweeping every call site, which is a pass of its own.
- **One RNG stream vs three.** Upstream runs every gameplay roll through
  one generator; the port partitions three seeded streams so ambience and
  battles cannot perturb the route. Changing the topology would move every
  committed hash to buy nothing a player could see. Kept, deliberately.

### 11a. Scene parity repairs (2026-08-13)

This pass compared gen1recomp `f0ed2efe` and DramaticShapeVoxelMod
`8ef4d290` against the Pocket hosts, then fixed three presentation regressions
without changing tall-grass classification, encounters, battle arena support,
neighbour NPCs or DayNight.

- **The screenshot's green obstruction was not generated grass.** It was a
  connected map's tree boundary ring drawn over the current map body. The
  v9 ring flag and the mask/slot rules in §5 remove only that duplicate;
  uncooked exits remain protected.
- **Entities recover Lua `groundAt`.** GAME tilesets carry a tile-id support
  table derived from the same `TileShape` analysis. Missing shapes, stairs,
  water/non-positive heights and off-map reads are zero. Mom and Daisy resolve
  to 5 px; the Oak Lab balls and Pokédexes plus Blue's House Town Map resolve
  to 6 px. A moving player keeps the departure cell until landing and adds
  `hopLift`; NPCs and items do not.
- **Interiors recover the Lua void.** `REDS_HOUSE_1F`, `REDS_HOUSE_2F`,
  `OAKS_LAB` and `BLUES_HOUSE` send `sky(0)`; Pallet Town, the routes and
  Viridian City send `sky(1)`. The state is delta-emitted on map identity,
  defaults visible for old traces, and always clears through black bands when
  hidden.

The golden rebase was reviewed as PNG before/after pairs, not recorded blind.
Counts below are RGB-changed pixels out of 130,560 per image; `psp` is the
shipped rung and `desktop` the identity rung. Across all 30 images, 25 changed:
415,775 pixel positions and RGB absolute error 139,221,079. Every non-zero
pixel fell into one of the ring/bake, entity-foot or indoor-void regions.

| tape / mark | psp px | desktop px | reviewed cause |
| --- | ---: | ---: | --- |
| story / bedroom | 0 | 0 | mark occurs before the pitch exposes the retained indoor void |
| story / downstairs | 17,350 | 16,114 | black indoor void; Mom at 5 px support |
| story / pallet-town | 5,911 | 9,398 | Route 1 neighbour ring removed at the top edge; PSP live-ring bake edge |
| story / sign-read | 917 | 2,382 | neighbour ring removed at the top edge |
| story / oaks-lab | 1,902 | 623 | black indoor void; 6 px item supports |
| story / lab-exit | 68 | 0 | PSP Pallet protective ring no longer ground-baked |
| story / route-1 | 47,201 | 54,551 | duplicate connected-map tree ring removed from the active view |
| story / mid-route | 3,609 | 0 | PSP Route 1 east protective ring rendered live, matching desktop |
| story / encounter-seen | 3,881 | 1,957 | neighbour top ring removed; PSP east ring rendered live |
| story / viridian | 49,488 | 58,368 | duplicate connected-map tree ring removed from the active view |
| story / done | 41,161 | 46,554 | duplicate connected-map tree ring removed from the active view |
| battle / grass-edge | 3,608 | 0 | PSP Route 1 east protective ring rendered live |
| battle / battle-intro | 11,586 | 11,695 | duplicate neighbour ring removed from the arena background |
| battle / post-fight | 10,739 | 10,874 | duplicate neighbour ring removed from the arena background |
| battle / escaped | 3,881 | 1,957 | same returned Route 1 frame as `encounter-seen` |

The final deterministic cook is 29,689,744 bytes, 2,418,720 bytes (7.53%)
smaller than the 32,108,464-byte pre-fix baseline; body vertices were not
copied and ring records have zero baked pages. Both quality-rung tapes,
the six directional connection checks, the eight named support objects,
retained sky backend tests, Web playback, and PSP/Vita package assembly use
the same v9 pak.

### 11b. Player occlusion silhouette (2026-08-13)

The player hint behind tall scenery now reuses the live card's atlas page,
frame UVs, mirror flag, geometry and camera pull as an alpha mask. Visible
sprite texels become the single translucent ghost colour; transparent card
texels stay absent. This replaces the old untextured 16x16 quad, whose empty
corners appeared as a grey rectangle above the player. The ordinary foot
shadow is a separate decal and is unchanged.

The software renderer samples the source alpha before substituting the flat
colour. PSP binds a one-draw silhouette CLUT, while Vita caches an RGBA atlas
variant keyed by the same flat colour; both retain the existing occluded-only
depth test and never write depth.

The story golden update was reviewed as RGB PNG diffs against the immediately
preceding scene-repair baseline. Only six marks per quality rung changed, and
every changed pixel lay inside the former player-card rectangle. The other
five story marks and all eight battle hashes were byte-identical.

| story mark | psp px | desktop px |
| --- | ---: | ---: |
| downstairs | 149 | 149 |
| pallet-town | 211 | 211 |
| lab-exit | 153 | 158 |
| route-1 | 65 | 53 |
| viridian | 65 | 53 |
| done | 65 | 53 |
| **total** | **708** | **677** |

## 12. The PS Vita port

The Vita runs the same guest bundle, the same cooked pak and the same core as
the PSP. What is new is a second backend for the one draw list
(`crates/pocketvoxel-gxm`) and a second application shell around it
(`crates/pocketvoxel-vita`). Build it with `bun tools/voxel.ts vita --release`;
the result is `dist/voxelmon/voxelmon.vpk`, which **carries the pak inside
it**, so installing that one file in VitaShell is the whole install and the
console needs nothing else on it.

**One bundle, two machines, because the HOST names the rung.** `psp-main.ts`
never mentions a console. The quality rung is a host decision the shell makes
once at boot (`op::QUALITY`, §4a), which is why the guest that ships in the
VPK is byte-identical to the one baked into the EBOOT. `--tier
<psp|vita|desktop>` overrides the rung for an A/B measurement without editing
the spec.

### GXM is shader-only, so the shaders arrive already compiled

There is no OpenGL on this machine. The native API is **SceGxm**, and it has
no fixed-function pipe at all: every draw needs a compiled vertex/fragment
program pair. Compiling on the console means Sony's `libshacccg.suprx`, a
firmware module that is not installed by default — so the way to need no
compiler is to bring programs that are already compiled.

libvita2d's five are, and `pocket3d-vita` — the backend OpenStrike ships —
established both the technique and the provenance record for reusing them.
This backend reads the same `.gxp` binaries out of that crate's `shaders/`
directory, so the tree keeps one copy and one attribution.

What those five give, and what they cost:

```text
color_v    aPosition, aColor    + uniform wvp
texture_v  aPosition, aTexcoord + uniform wvp
```

- **The textured program carries no per-vertex colour**, so an opaque mesh
  draws TWICE over the same indices — the texel, then the pak's AO through
  `color_v` with a `dst * src` blend. That pair is what one
  `TextureEffect::Modulate` gets the GE.
- **GXM has no alpha test**, and these shaders cannot discard. The GE cuts
  sprite art out with `AlphaFunc::Greater 0x7f`; here alpha is resolved by
  blending and draw order instead, so the passes split by whether their art is
  cut out (below).

The vertex attribute FORMAT is where the cooked layout survives unchanged:
`S16` takes the pak's i16 world positions as the integers they are — the GE
needs a ×32768 model scale to undo its own normalization and nothing here
does — `S16N` reads the fixed-point UVs as 0..1, and `U8N` reads the ABGR
straight. The 16-byte `PakVert` is therefore read twice out of one GPU buffer
at different attribute offsets, with no repacking.

Depth needs no contortion either. The core projects with
`Mat4::perspective_gl`, so `LESS_EQUAL` against a buffer cleared to far IS the
rasterizer's "less wins", and the player ghost's occluded-only pass is
`GREATER` — where the GE backend has to express both through its inverted
16-bit range.

### What the missing alpha test actually costs

- **Solid geometry** — terrain, the ground bake, all three tree levels, water
  — draws opaque with depth writes and takes its AO pass. Its silhouette is
  carved into the mesh, not into the texture, so nothing is lost.
- **Cut-out geometry** — grass, flowers, billboard cards — draws
  alpha-blended and depth-preserving, in the list's own order, and takes **no
  AO pass**. The multiply pass carries no texture, so where a texel was
  transparent it would darken the background into a visible rectangle; losing
  the AO on a grass tuft is the cheaper error. Depth-preserving means cut-out
  geometry does not occlude other cut-out geometry.
- **The GB UI layer** loses nothing at all: it is 2D, drawn last and never
  depth-tested, so blending is exactly what the GE's cutout produced.

`crates/pocketvoxel-gl`, a vitaGL backend that reproduces the GE picture
exactly (its GL ES 1.1 fixed function has hardware alpha test, per-vertex
modulate and a texture matrix), was built first and then removed: vitaGL
compiles even its fixed-function shaders on the console, which made
`libshacccg.suprx` a hard prerequisite and broke the one-file install every
other Pocket app on this machine offers. It is recoverable from this branch's
history if the cut-out fidelity above is ever worth a prerequisite.

### Memory and the frame

vita2d owns process-level GXM — the context, the shader patcher, the render
target, the shared depth buffer, the per-frame GPU pool and the swap — and
this backend composes inside its scene, exactly as `pocket3d-vita` does:

```text
vita2d_start_drawing() / vita2d_clear_screen()
  renderer.render(&draw::build(&scene, &pak), &pak)
vita2d_end_drawing() / vita2d_swap_buffers()
```

The clear colour is the sky's below-horizon band and has to be set before the
scene opens, which is the one place the GE's sky pass (which owns its own
clear) and this one differ in shape rather than degree.

The pak's vertex and index pools are copied once into GXM-mapped blocks — the
GPU cannot read the heap the pak was loaded into, and that copy is the only
one the port makes. After it every chunk draws from its cooked bytes in place.
Atlas pages upload as `LinearStrided` textures, which take any width, so a
cooked page needs no power-of-two envelope and no `sceGuTexScale` counterpart;
the CLUT is resolved on the CPU into a 24 MB budgeted RGBA cache keyed by
(page, frame, palette, tinted), because GXM binds only one palette per texture
object and RED++ samples one page through several within a frame. Cache
eviction is **deferred three frames** so a texture is never freed while the
GPU may still be reading the frame that referenced it.

**The raster is native 960x544.** The logical viewport stays 480x272 — the
camera, the UI layout and every golden are defined there — and only the
physical viewport doubles, so geometry is transformed once and rasterized at
four times the pixels. Atlases sample POINT, so the art reads as the same
picture rather than a blurred one, and the GB UI layer keeps its fractional
logical position instead of rounding to a device pixel as the GE backend must.

### The shell

No PocketJS host library sits underneath. The Vita has std, a real allocator
and hundreds of megabytes, so the arena trio and worker thread `pocketjs-psp`
exists to provide have no counterpart to reuse; what is borrowed is a design,
not code — the PCM ring in `src/audio.rs` follows
`vendor/pocketjs/hosts/vita/src/audio.rs`, where its disciplines (single
writer, starvation sleeps rather than queued silence, the port opened and
released on the main thread) were earned.

Three things the PSP shell spends effort on are simply absent:

- **no partition arithmetic.** The 32 MB pak is read straight into one
  16-byte-aligned heap block and leaked. There is no MEMSIZE flag and no
  power-of-two allocation class to dodge.
- **no pipelined present.** The swap queues the flip and paces the loop
  against vblank; the PCM pump runs after it, while the GPU is still consuming
  the frame.
- **no arena-pressure heuristic.** The collection still runs on a warp
  landing, where the guest holds the world frozen through the fade and the
  stall is an invisible held cut, but the trigger is the landing itself rather
  than a bump high-water mark.

Buttons match the EBOOT: CIRCLE confirms, CROSS cancels, and the left stick
walks one axis at a time.

### A boot that cannot fail silently

A console has no console. There is no log a player can read, and a memory card
needs a USB session and a working machine to inspect — so graphics come up
FIRST, before the pak and before QuickJS, and every later stage owns a colour:
amber for a pak that was not found, magenta for one that did not validate,
grey for pools that would not fit, cyan for a guest that threw (with the
exception text). Every stage also appends to `ux0:data/voxelmon/boot.txt`, and
the first frames log what they actually drew, so "running but blank" and
"never got there" cannot look alike.
