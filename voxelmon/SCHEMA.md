# voxelmon data interfaces

The three stages hand off through `dist/voxelmon/` (git-ignored — every byte
under it derives from the player's ROM):

```
ROM + rom_manifest.json --import--> dist/voxelmon/gen/   --cook--> dist/voxelmon/voxelmon.vxpak
                                    (JSON + gfx.bin)               (VXPK, includes GAME section)
```

Inputs are resolved by `tools/voxel.ts`:

- `VOXELMON_ROM` — the canonical US Red ROM (1 MiB, SHA-1
  `ea9bcae617fdf159b045185467ae58b2e4a48b9a`). No default is committed;
  the local developer default lives in `tools/voxel.ts`.
- `VOXELMON_G1R` — a gen1recomp checkout (default `~/code/gen1recomp`);
  supplies `tools/rom_manifest.json`, the parity reference (`data/generated/`
  built by its `tools/build_rom_data.py`), and `data/palettes_gbc.lua` — the
  RED++ colour pack (pokered-gbc-derived, MIT, **not ROM-derived**).
- `VOXELMON_VOXELMOD` — a DramaticShapeVoxelMod checkout (default
  `~/code/DramaticShapeVoxelMod`); supplies `data/voxel_heights.lua` and
  `data/battle_arenas.lua` for the cooker.

Anything needing these inputs **skips with a printed reason** when they are
absent. CI never sees them.

## `dist/voxelmon/gen/` — the imported dataset

One JSON file per gen1recomp `data/generated` module, **same field names and
record shapes as the Lua tables** so parity diffing is mechanical:

`constants.json, tilesets.json, maps.json, font.json, sprites.json,
moves.json, items.json, type_chart.json, palettes.json, pokemon.json,
trainers.json, encounters.json, text.json, text_pointers.json,
trainer_headers.json, field.json, audio.json`

Normalization rules (Lua → JSON):

- Lua arrays (dense 1..n) become JSON arrays, order preserved. **Every index
  shifts down by one**; consumers index 0-based.
- Map-shaped tables become objects; numeric keys become strings.
- Absent optional fields are omitted, never `null`.
- No floats are introduced; everything the Lua stored as integers stays
  integer.

Graphics do not become PNGs. `gen/gfx.bin` is a single blob of indexed
bitmaps — **1 byte per pixel**: `0..3` = GB shade (0 = white/lightest),
`0xff` = transparent. `gen/gfx.json` is the directory:

```json
{ "tilesets/overworld": { "off": 0, "w": 128, "h": 48 },
  "sprites/red":        { "off": 6144, "w": 16, "h": 96, "walker": true },
  "battle/front/pikachu": { "off": ..., "w": 56, "h": 56 }, ... }
```

Keys mirror the upstream `assets/generated/` relative paths (without
extension). `tools/voxel.ts shots --gen` can dump any entry to a local PNG
for eyeballing; PNGs never land in `gen/`.

Sound is two files. `gen/programs.bin` is the ROM's sound banks ($02, $08,
$1F for Red) concatenated in `bankOrder`, **0x4000 bytes each** — the windows
the channel-program interpreter reads through. `gen/audio.json` is the
manifest's audio block plus what the importer resolves from the ROM:

```json
{ "bankOrder": [2, 8, 31], "programFile": "programs.bin", "runtime": true,
  "songs":  { "Music_PalletTown": { "bank": 2, "address": 16969, "engine": 1 }, ... },
  "sfx":    { "Press_AB": { "bank": 2, "address": 16816, "engine": 1 }, ... },
  "cries":  { "PIDGEY": { "header": {...}, "pitch": 0, "length": 0 }, ... },
  "mapSongs": { "PALLET_TOWN": "Music_PalletTown", ... },
  "battle":   { "wild": "Music_WildBattle", "wildWin": "Music_DefeatedWildMon", ... },
  "waveBanks": { "1": { "bank": 2, "address": 17267 }, ... },
  "noiseHeaders": { "1": { "1": {...}, ... }, ... } }
```

`cries` is keyed by INTERNAL species slot, so it carries 154 entries — the
151 Pokedex species plus `FOSSIL_KABUTOPS`, `FOSSIL_AERODACTYL` and
`MON_GHOST`, which have cries but no dex entry. MISSINGNO/UNUSED rows are
read (the index must advance) and dropped.

`gen/palettes_gbc.json` is the one file here the importer does NOT produce:
the cooker dumps `$VOXELMON_G1R/data/palettes_gbc.lua` through the same
LuaJIT one-shot the profile uses, re-dumping whenever the source is newer.
Absent checkout or absent `luajit` → the cooker prints a reason and cooks
without colour. **Index bases after the dump** (`cook/redpp.ts` pins this in
a test — getting it wrong recolours the world by one group and never
throws): `groupColors[TILESET]` is a dense 1..8 Lua table, so it becomes an
8-element JSON **array indexed directly by group 0..7** (Lua's
`base[ROOF + 1]` is our `base[ROOF]`), while `tileGroups[TILESET]`,
`spritePalettes`, `spriteAssignment` and `roofByMapIndex` are 0-keyed and
become **objects with string keys**, unshifted.

## Parity

`tools/voxel.ts parity` deep-compares the 16 datasets that have a reference
counterpart against `$VOXELMON_G1R/data/generated/*.lua`. `audio.json` is
excluded: the reference extractor that built `data/generated/` produces no
`audio.lua` (only the Lua runtime's own extractor writes one), so there is
nothing to diff it against. Its ground truths are pinned by
`tests/voxel-audio.test.ts` instead. The comparison (dumped to JSON through a LuaJIT
one-shot, `voxelmon/import/lua-dump.lua`, applying the same
normalization). Field-for-field equality is the bar; the diff prints the
first N mismatching paths.

## `audiodata` — the chip synth's input at boot

The cooker splices `audio.json` and `programs.bin` into the pak's own AUDI
section (`contracts/spec/voxel-spec.ts` §VXPK_TAG.audio): a 16-byte header
(`u32 json_len | u32 program_len | two pad words`), the JSON, then the
program banks at the next 16-byte boundary. The guest calls
`voxel.audiodata()` once at boot and parses the JSON half, which is the
manifest it resolves names through; the PROGRAM half never crosses, because
the core reads it in place (`Pak::audio_programs`) and every audio op names
a bank by its **slot** — that bank's index in `bankOrder`, which is the
window's position in the concatenation. In Bun the manifest loads straight
from `gen/audio.json` — one loader, two transports, like `gamedata`.

## `VCOL` — the per-tile colour bindings

The cooker bakes the RED++ palette group into the terrain page's texel index
(`texel = group * 4 + shade`, `0xff` still transparent) and writes one
section saying which VPAL entry each draw resolves that index through
(`contracts/spec/voxel-spec.ts` §VXPK_TAG.color):

```
 0  u16 version = 1
 2  u16 map_count        == the CHNK map count
 4  u16 page_count       == the ATLS page count
 6  u16 flags            bit0 = the terrain page is group-baked
 8  u32 pad = 0 | 12 u32 pad = 0
16  map_count  * 8 : u32 map_id | u16 world_pal | u16 terrain_page
..  page_count * 2 : u16 page_pal
```

`0xffff` (`COLOR_PAL_NONE`) anywhere means "no binding, use the legacy
path". Map records carry `map_id` explicitly, so the section is
order-independent of the CHNK directory, and the core range-validates every
index against the palette and page counts. The VPAL list grows a tail after
the 4 kind defaults and the 37 SGB SuperPalettes — world CLUTs, then OBJ,
then pic — but that **prefix never moves**, so `draw::SGB_PAL_BASE = 4` and
`mapPalette` stay valid. Cooking without the colour pack still writes the
section, with every index `COLOR_PAL_NONE`; the pak then renders exactly as
a pre-colour pak did.

## `gamedata` — what the guest parses at boot

The cooker packs the gameplay subset of `gen/` into the pak's GAME section as
JSON bytes: constants, maps (layout + collision-relevant tileset fields +
warps/signs/objects/connections), encounters, moves, pokemon, items,
type_chart, trainers, text, text_pointers, trainer_headers, field, plus two
cook-time products: `atlas` (the page-index maps) and `mapPalette` (map id →
SGB palette index into the pak's SGB set — the static port of pokered's
SetPal_Overworld rule; the guest emits `palette(mapPalette[map] ?? -1)` at
map entry). The guest
calls `voxel.gamedata()` once, `JSON.parse`s, and never crosses the boundary
for data again. In Bun (headless sim) the same object is loaded straight from
`gen/` by `voxelmon/game/data.ts` — one loader, two transports.

## UI tile ids — the GB VRAM convention

`uiTile`/`uiFill` tile ids and the CMAP section's values ARE the GB tile
codes: the cooker packs the UI atlas so `fonts/font` glyphs sit at their
charmap codes (`mainBase 0x80..0xff`) and `fonts/font_extra`
(textbox borders, arrows, HP bar) at `extraBase 0x60..0x7f`. Tile id 0 is
transparent (UI cell unset). Guest-side names for the border/arrow tiles
live in `voxelmon/game/ui/tiles.ts`; the cooker owns the packing and
must satisfy this mapping.

## `.tape` — intent tapes

`voxelmon/tapes/*.tape` describe intent, never frame counts (the
Pocket Mon lesson): one command per line, `#` comments.

```
walk <u|d|l|r> <cells>     # hold the direction until that many steps LAND
press <a|b|start|select|u|d|l|r>   # tap: one tick down, then released
wait <ticks>
mark <name>                # checkpoint: the sim renders + hashes here
```

A turn-in-place is not a step; `walk` counts landed steps and releases the
direction when `landed + in_flight == target` so walks never overshoot.

## `.vtrace` — the op trace, one tape on every host

The Bun headless run records everything that crossed the boundary;
`pocketvoxel-sim` replays it through the real core and rasterizer. Text,
line-oriented, `dist/voxelmon/trace/<name>.vtrace`:

```
voxtrace 1
t <tick> <buttons>          # starts a tick; buttons = VOX_BTN mask that tick
o <code> <i32> <i32> ...    # one op, numeric args in order
s <code> <i32> ... <json-string>      # numeric args then a string arg
m <name>                    # checkpoint marker: sim renders + hashes here
```

Ticks are contiguous from 0. The sim renders at every `m`, appends
`<name> <fnv1a64-of-rgba>` to its hash report, and `--shots` writes the PNG
locally. Committed goldens are the hash lines only.

A tape carries the GUEST op stream, so the quality rung — a HOST decision
(docs/VOXEL.md §4a) — arrives beside it as `pocketvoxel-sim --quality`. Each
tape therefore pins two golden files: `tests/goldens/voxel/<tape>.hashes` at
the shipped `psp` rung, and `<tape>-max.hashes` at the top rung, which are the
pre-ladder hashes and are never re-recorded.
