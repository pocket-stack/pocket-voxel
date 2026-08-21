# The Voxel Surface

The op vocabulary the guest drives the scene with. It is pinned in
`contracts/spec/voxel-spec.ts` — the single source of truth — code-generated
into Rust (`contracts/spec/gen-voxel-rust.ts` → `spec.rs`), and guarded by a
**byte-compare drift test**: if the checked-in Rust ever disagrees with what
the spec generates, the build fails. Changing the surface is therefore a
three-step ceremony: edit the spec, regenerate, commit both.

Steady-state traffic is ~10–40 ops per tick. Every op argument is a number;
strings cross only in `uiText` (and are resolved core-side through the cooked
charmap).

## world

| Op | Semantics |
| --- | --- |
| `mapShow(slot, mapId, ox, oy)` | show a map in a slot: 0 = current, 1..4 = connected neighbours at their seam offsets |
| `mapHide(slot)` | drop a slot |
| `cam(x, y)` | move the view centre |
| `pitch(rung)` | pick a rung on the pitch ladder (0/15/35/50/75°) |
| `tint(abgr)` | day tint — resolved as a CLUT rewrite, the GB's own trick |
| `stamp(mapId, cx, cy, on)` | toggle a pre-cooked removable sub-mesh: the cut tree, the moved boulder |
| `palette(index)` | the map's SGB SuperPalette. On a RED++-cooked pak the per-map VCOL bindings outrank this op entirely — and **the guest emits the identical stream either way**: which colour model a build uses is decided by the cook, never by the guest |

## entities

| Op | Semantics |
| --- | --- |
| `ent(slot, sheet, frame, x, y, lift, flags)` | place/update one of 16 billboards. Cards lean back by camera pitch and pull toward the eye along each vertex's own ray — the mod's projection-invariant depth bias, ported exactly |
| `entHide(slot)` | hide a billboard |
| `emote(slot, kind)` | the exclamation/heart/sleep bubble over an entity |

## ui

The GB UI is a retained 20×18 tile layer composited over the diorama, scaled
to fit 480×272. Tile ids **are** the GB tile codes (see
[Data & Formats](/reference/formats#ui-tile-ids)).

| Op | Semantics |
| --- | --- |
| `uiTile(x, y, tile)` | set one cell |
| `uiFill(x, y, w, h, tile)` | fill a rect |
| `uiText(x, y, str)` | **one live run** — the core retains only the last `uiText`; it exists for the row being typed. Finished rows are stamped into the grid as tiles (glyph codes are tile ids) |
| `uiReveal(n)` | the typewriter counter for the live run |
| `uiClear()` | clear the layer |

## battle

Battles stage **on the map** — nothing moves the player; the camera goes to
the arena, exactly as upstream.

| Op | Semantics |
| --- | --- |
| `arena(mapId, x, y, shape, rig)` | stage the battle arena |
| `card(side, pic, x, y)` / `cardHide(side)` | the two battle pics |
| `battleCam(orbit, pitch, zoom)` | drive the solved rig (tele / wide — the mod's constants) |
| `arenaEnd()` | tear the stage down |

## audio

Every argument is a number the guest resolved out of the AUDI manifest:
`bank` is a **bank slot** (that ROM bank's index in `bankOrder`) and `addr`
the program's GB address inside its 0x4000-byte window. The core parses no
JSON and knows no name; the guest reads no sample.

| Op | Semantics |
| --- | --- |
| `music(bank, addr, engine, flags)` | start a song |
| `musicStop()` / `musicFade(ticks)` | stop / fade |
| `sfx(bank, addr, engine, pitch, tempo, flags)` | one-shot effect |
| `cry(bank, addr, engine, pitch, length)` | a species cry |
| `audioWaves(engine, bank, addr)` | boot-time wave-table pin |
| `audioDrum(engine, drum, bank, addr)` | boot-time drum-table pin |

PCM itself leaves through the PocketJS `audio` module
(capability `audio.pcm`), not through this surface: the host pumps
`Scene::render_audio` for exactly the frames its ring wants. A host that
pumps nothing runs the identical op stream silent.

## system

| Op | Semantics |
| --- | --- |
| `gamedata()` | returns the pak's GAME section at boot — one cold JSON parse, then the guest never crosses for data again |
| `audiodata()` | the AUDI section; the guest parses only its JSON half — the program bytes stay in the pak where the core reads them |
| `stats()` | frame counters |
| `reset()` | reset the scene |
| `quality(tier)` | the host names its [quality rung](/guide/quality-ladder), once, at boot |

## events

The core→guest channel is the standard packed batch wire
(`u16 kind | u16 a | i32 b | i32 c | i32 d`) with **no kinds defined yet** —
the core currently states no fact the guest does not already know. The
channel exists so mesh-streaming or host-side timing facts can append later
without a wire change.
