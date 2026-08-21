# Getting Started

This page takes you from a clean checkout to a cooked pak, verified goldens,
and the game running in PPSSPP — no console hardware required. Device builds
are covered in [Running on PSP](/guide/psp) and [Running on PS Vita](/guide/vita).

## What you need

| Tool | Needed for | Notes |
| --- | --- | --- |
| [Bun](https://bun.sh) ≥ 1.2 | everything | the importer, cooker, headless sim and test runner all run under Bun |
| Rust (stable) + Cargo | `check`, `shots`, device builds | `pocketvoxel-sim` is a desktop crate; `cargo` must be on `PATH` |
| LuaJIT | optional | the RED++ colour dump and the oracle tests; absent → the cooker prints a reason and cooks **without colour**, oracle suites skip |
| [PPSSPP](https://www.ppsspp.org) (SDL build) | optional | `bun tools/voxel.ts run` launches the EBOOT; the e2e uses PPSSPP headless |
| cargo-psp toolchain | PSP builds only | resolved and **pinned for you** by `tools/voxel.ts` — do not install your own |
| VitaSDK + cargo-vita | Vita builds only | see [Running on PS Vita](/guide/vita) |

## You bring the ROM

The repository is **ROM-fed**: the only game-content input is a canonical US
Gen-1 ROM you already own (Red, 1 MiB, SHA-1
`ea9bcae617fdf159b045185467ae58b2e4a48b9a`). The importer verifies that hash
before decoding a single byte. Everything decoded lands under git-ignored
`dist/` and **no ROM-derived byte is ever committed** — no cooked pak, no
extracted art, no decoded text. Rendering goldens are frame *hashes*, never
pixels.

Two **reference checkouts** are inputs the same way the ROM is:

- [gen1recomp](https://github.com/bryanthaboi/gen1recomp) supplies
  `tools/rom_manifest.json` (the symbol table the importer is driven by) and
  `data/palettes_gbc.lua` (the RED++ colour pack — pokered-gbc-derived, MIT,
  *not* ROM-derived).
- [DramaticShapeVoxelMod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
  supplies `data/voxel_heights.lua` (tile class profiles, building templates)
  and `data/battle_arenas.lua`.

Anything that needs an input you don't have **skips with a printed reason**
instead of failing into a half-decoded state. CI never sees the ROM or the
checkouts — ROM-gated test suites skip there by design.

## Clone and configure

```sh
git clone --recursive https://github.com/pocket-stack/pocket-voxel
cd pocket-voxel && bun install
```

Forgot `--recursive`? Run `bun run setup` (it runs
`git submodule update --init`). The engine arrives as a pinned submodule at
`vendor/pocketjs`; the PSP host library, the audio module and the toolchain
pins all come from that one engine commit.

Then point the pipeline at its inputs:

```sh
export VOXELMON_ROM=/path/to/your/rom.gb        # SHA-1 verified before any decode
export VOXELMON_G1R=~/code/gen1recomp           # default: ~/code/gen1recomp
export VOXELMON_VOXELMOD=~/code/DramaticShapeVoxelMod  # default: ~/code/DramaticShapeVoxelMod
```

## First run of the pipeline

```sh
bun tools/voxel.ts import   # ROM → dist/voxelmon/gen/ (17 JSON datasets + gfx.bin + programs.bin)
bun tools/voxel.ts cook     # gen/ → dist/voxelmon/voxelmon.vxpak
bun tools/voxel.ts check    # replay both tapes, assert both rungs' frame hashes
```

`check` is the full acceptance path: it imports if `gen/` is missing,
**always re-cooks** (a stale pak is the one failure that looks like an engine
bug), runs the story and battle tapes headless in Bun to record op traces,
then replays each trace through the real Rust core and software rasterizer at
**both** pinned quality rungs, comparing frame hashes against the committed
goldens. Green `check` means the whole pipeline — importer, cooker, guest,
core, rasterizer — agrees with the committed picture.

Where things land (all git-ignored):

```text
dist/voxelmon/gen/              imported datasets (JSON + gfx.bin + programs.bin)
dist/voxelmon/voxelmon.vxpak    the cooked pak — the one artifact every machine loads
dist/voxelmon/trace/*.vtrace    recorded op traces, one per tape
dist/voxelmon/shots-*/          PNG frames, only when you ask for them
```

## See it, without hardware

```sh
bun tools/voxel.ts shots    # render PNG frames for every mark, both rungs
bun tools/voxel.ts run      # build the EBOOT and launch it in PPSSPP
bun tools/voxel.ts wav      # render any song/sfx/cry to dist/voxelmon/audio/*.wav
```

`shots` writes to `dist/voxelmon/shots-<tape>-<tier>/` — the reading material
for judging a rung visually. `run` builds the PSP EBOOT and opens it in
PPSSPP (macOS `open -a PPSSPPSDL`); PPSSPP maps the EBOOT's own directory as
`host0:`, so the pak is found automatically.

## Run the tests

```sh
bun test                        # 226 tests; ROM-gated suites skip with a reason
bun tools/voxel.ts check        # both quality rungs' frame hashes
bun tests/e2e/voxel-ppsspp.ts   # GE-vs-sim parity at 11 story marks
```

See [Testing & Determinism](/guide/testing) for what each layer proves.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `voxel import: skipped — …` | an input is missing or the ROM failed its SHA-1 gate. You need the **canonical US Red** ROM — other revisions and languages hash differently and are rejected before decode. |
| cooker prints "cooking without colour" | LuaJIT or the gen1recomp checkout is absent, so the RED++ pack can't be dumped. The pak still cooks; the world renders in SGB palettes. |
| `check` mismatches at the `-max` tier | the top rung stopped being the identity. **Never re-record `-max` goldens** — fix the dials. See [the golden ceremony](/guide/testing#the-golden-ceremony). |
| ROM-gated tests skip | expected whenever `VOXELMON_ROM` / reference checkouts are absent — the `POCKET3D_TEST_MAPS` convention. CI always runs this way. |
| `voxel vita: incomplete VitaSDK` / `libvitaGL.a missing` | set `VITASDK`, and run `vdpm vitaGL` — the build checks both before starting. |
| a second worktree wants the pak | symlink `dist` — but note `.gitignore` lists both `/dist` and `dist/` **on purpose**, because a trailing slash matches directories only and a `dist` *symlink* would otherwise slip into a commit. |
