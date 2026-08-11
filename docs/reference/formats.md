# Data & Formats

Every format the pipeline hands off through, in pipeline order. The source of
truth for the byte layouts is `contracts/spec/voxel-spec.ts`; for the data
interfaces, `voxelmon/SCHEMA.md` in the repo.

## `dist/voxelmon/gen/` — the imported dataset

One JSON file per gen1recomp `data/generated` module, **same field names and
record shapes as the Lua tables** so parity diffing is mechanical:

```text
constants, tilesets, maps, font, sprites, moves, items, type_chart,
palettes, pokemon, trainers, encounters, text, text_pointers,
trainer_headers, field, audio
```

Normalization rules (Lua → JSON):

- Lua arrays (dense `1..n`) become JSON arrays, order preserved — **every
  index shifts down by one**; consumers index 0-based.
- Map-shaped tables become objects; numeric keys become strings.
- Absent optional fields are omitted, never `null`.
- No floats are introduced; integers stay integers.

**Graphics** don't become PNGs. `gen/gfx.bin` is one blob of indexed
bitmaps — 1 byte per pixel: `0..3` = GB shade (0 = lightest), `0xff` =
transparent — and `gen/gfx.json` is its directory (offset, width, height per
key, keys mirroring the upstream asset paths). `shots --gen` can dump any
entry to a local PNG for eyeballing.

**Sound** is two files. `gen/programs.bin` is the ROM's sound banks
concatenated in `bankOrder`, 0x4000 bytes each. `gen/audio.json` is the
manifest: `songs` / `sfx` / `cries` (name → bank, address, engine),
`mapSongs`, `battle`, `waveBanks`, `noiseHeaders`. `cries` is keyed by
internal species slot — 154 entries, the 151 dex species plus the three
cry-owning glitch slots.

`gen/palettes_gbc.json` is the one file the importer does *not* produce: the
cooker dumps the gen1recomp checkout's `palettes_gbc.lua` through a LuaJIT
one-shot, re-dumping whenever the source is newer. Index bases after the
dump are pinned by a test — getting them wrong recolours the world by one
group and never throws.

## `.tape` — intent tapes {#tape-intent-tapes}

`voxelmon/tapes/*.tape`: one command per line, `#` comments. Tapes describe
**intent, never frame counts**:

```text
walk <u|d|l|r> <cells>     # hold the direction until that many steps LAND
press <a|b|start|select|u|d|l|r>   # tap: one tick down, then released
wait <ticks>
mark <name>                # checkpoint: the sim renders + hashes here
```

A turn-in-place is not a step; `walk` counts landed steps and releases the
direction when `landed + in-flight == target`, so walks never overshoot.

## `.vtrace` — the op trace

The Bun headless run records everything that crossed the boundary;
`pocketvoxel-sim` replays it through the real core and rasterizer. Text,
line-oriented, at `dist/voxelmon/trace/<name>.vtrace`:

```text
voxtrace 1
t <tick> <buttons>          # starts a tick; buttons = VOX_BTN mask that tick
o <code> <i32> <i32> ...    # one op, numeric args in order
s <code> <i32> <i32> <json-string>   # ops carrying a string arg
m <name>                    # checkpoint marker: sim renders + hashes here
```

Ticks are contiguous from 0. At every `m` the sim appends
`<name> <fnv1a64-of-rgba>` to its hash report; `--shots` writes the PNG
locally. **Committed goldens are the hash lines only** — each tape pins
`<tape>.hashes` (shipped rung) and `<tape>-max.hashes` (the identity;
never re-recorded).

## `voxelmon.vxpak` — the cooked pak

A MONPAK-style container: magic, section table, 16-byte alignment, and a
validated **zero-copy** reader core-side. Current version: **4** (version 3
paks lack the two extra tree-LOD mesh ranges per chunk and are rejected
instead of mis-read). A META flags word states what the pak carries — e.g.
`VXPK_META_FLAG_TREE_LOD` — so a runtime never guesses.

| Section | Carries |
| --- | --- |
| META | version, flags, counts |
| CHNK | per-chunk mesh directory: terrain, grass, flower, water, stamp ranges — plus the tree hull / coarse / box ranges the rung picks between |
| ATLS | pre-swizzled CLUT8 atlas pages, one terrain copy per animation frame |
| VPAL | the palette list: 4 kind defaults, 37 SGB SuperPalettes, then the RED++ tail (world CLUTs, OBJ, pic). **The prefix never moves** |
| VCOL | per-map and per-page colour bindings (below) |
| STMP | removable sub-meshes (cut trees, boulders) toggled by the `stamp` op |
| CMAP | the charmap: glyph → UI tile code |
| GAME | the gameplay dataset the guest parses once at boot |
| AUDI | `audio.json` + `programs.bin`, verbatim |

### VCOL, the per-tile colour bindings

The cooker bakes the RED++ palette group into the terrain page's texel index
(`texel = group * 4 + shade`, `0xff` transparent) and VCOL says which VPAL
entry each draw resolves that index through:

```text
 0  u16 version = 1
 2  u16 map_count        == the CHNK map count
 4  u16 page_count       == the ATLS page count
 6  u16 flags            bit0 = the terrain page is group-baked
 8  u32 pad = 0 | 12 u32 pad = 0
16  map_count  * 8 : u32 map_id | u16 world_pal | u16 terrain_page
..  page_count * 2 : u16 page_pal
```

`0xffff` (`COLOR_PAL_NONE`) anywhere means "no binding — legacy path". Map
records carry `map_id` explicitly, so the section is order-independent, and
the core range-validates every index. A pak cooked *without* the colour pack
still writes the section, all indices `COLOR_PAL_NONE`, and renders exactly
as a pre-colour pak did.

### GAME and AUDI

**GAME** packs the gameplay subset of `gen/` as JSON bytes, plus two
cook-time products: `atlas` (page-index maps) and `mapPalette` (map →
SGB palette — the static port of pokered's `SetPal_Overworld` rule). The
guest calls `gamedata()` once and never crosses for data again. In Bun the
same object loads straight from `gen/` — one loader, two transports.

**AUDI** is a 16-byte header (`u32 json_len | u32 program_len | pad`), the
JSON manifest, then the program banks at the next 16-byte boundary. The
guest parses only the JSON half; the core reads the program bytes in place
(`Pak::audio_programs`). Every audio op names a bank by its **slot** in
`bankOrder` — the window's position in the concatenation.

## UI tile ids {#ui-tile-ids}

`uiTile`/`uiFill` values and CMAP's outputs **are** the GB tile codes: the
cooker packs the UI atlas so font glyphs sit at their charmap codes
(`0x80..0xff`) and the border/arrow/HP-bar tiles at `0x60..0x7f`. Tile id 0
is transparent (cell unset). Multi-character charmap entries (`'s` and
friends — one glyph to the game, two characters to a string) get minted code
points at `LIGATURE_BASE`, so the string that crosses the boundary is
**cell-exact**.

## The vertex

The cooked vertex is **16 bytes**: u16 fixed-point UVs (÷32768), u32 ABGR
(face shade × baked AO), i16 positions + pad. Every backend reads it in
place — the GE with a ×32768 model scale, GXM as `S16`/`S16N`/`U8N`
attributes at two offsets into one buffer, the rasterizer directly. Changing
this format is the canonical identity-anchor re-basing event and pays for
itself with a pixel-diff proof — see
[the golden ceremony](/guide/testing#the-golden-ceremony).
