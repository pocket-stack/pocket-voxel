# Glossary

This project has a working vocabulary of its own. Terms link to the page
that owns them.

| Term | Meaning |
| --- | --- |
| **guest** | the TypeScript game running in QuickJS (in Bun when headless). Owns the game state, the RNG and the save. [Architecture](/guide/architecture) |
| **core** | `pocketvoxel-core`, the Rust scene library. Owns only presentation: chunks, entities, cameras, the draw list, the chip synth. |
| **surface** | the pinned op vocabulary between guest and core. [The Voxel Surface](/reference/surface) |
| **op** | one numeric call across the boundary (`cam`, `ent`, `uiTile`, …). Steady state is ~10–40 per tick. |
| **backend** | a consumer of the core's ordered draw list: `pocketvoxel-gu` (PSP GE), `pocketvoxel-gxm` (Vita), the sim's software rasterizer. |
| **pak** | `voxelmon.vxpak` — the one cooked artifact every machine loads. [Data & Formats](/reference/formats) |
| **cook** | the offline voxelizer run: classify → volumes → mesh → atlas → colour → cull → pack. Byte-deterministic. [The Asset Pipeline](/guide/pipeline) |
| **rung** | one step of the quality ladder (`psp` / `vita` / `desktop`), named by the **host** at boot — never by the guest, never a re-cook. [The Quality Ladder](/guide/quality-ladder) |
| **dial** | one runtime fidelity setting inside a rung (`treeHullDist`, `detailDensity`, …). All distances measure through one function. |
| **identity (rung / anchor)** | the top rung, which must draw exactly the pre-ladder picture; `*-max.hashes` pin it and are never re-recorded for a dial edit. |
| **tape** | an intent script (`walk`, `press`, `wait`, `mark`) — never frame counts. One tape drives every host. [Formats](/reference/formats#tape-intent-tapes) |
| **trace / `.vtrace`** | the recorded op stream a headless run produced; what the sim replays through the real core. |
| **mark** | a named checkpoint in a tape where the sim renders and hashes a frame. 11 story + 4 battle. |
| **golden** | a committed frame hash (fnv1a64 of RGBA). Never a pixel. |
| **the ceremony** | what re-basing the identity goldens costs: a named legitimate event plus a pixel-diff proof. [Testing](/guide/testing#the-golden-ceremony) |
| **no-moving-boundary rule** | no camera-relative representation change inside the visible field ships — moving boundaries play as flicker on device. |
| **bank slot** | how audio ops name a ROM bank: its index in the manifest's `bankOrder`, i.e. the position of its 0x4000-byte window in `programs.bin`. |
| **channel program** | the GB sound driver's bytecode for one channel; the core interprets these to PCM directly — no register emulation. |
| **RED++ / pokered-gbc** | the per-tile colour model, baked into the terrain texel index at cook time (`texel = group*4 + shade`). |
| **SuperPalette** | one named SGB four-colour palette from the RED++ pack; the pak carries 37 plus the RED++ tail. |
| **stamp** | a pre-cooked removable sub-mesh (cut tree, moved boulder) the guest toggles at runtime. |
| **ghost** | the player's occluded silhouette, drawn with an inverted depth test and no depth write. |
| **oracle** | the unmodified Lua reference running under LuaJIT, used as ground truth — trace-for-trace for gameplay, sample-exact for audio. |
| **capture EBOOT** | the `--features capture` build that replays recorded input under PPSSPP and hashes what the GE drew — the hardware half of the e2e. |
| **manifest-driven** | the importer reads gen1recomp's `rom_manifest.json` (symbols, charmap, map metadata) instead of hardcoding offsets. |
| **content boundary** | the legal line: ROM-derived bytes live only under git-ignored `dist/`, verified by SHA-1 before any decode. [Getting Started](/guide/getting-started#you-bring-the-rom) |
