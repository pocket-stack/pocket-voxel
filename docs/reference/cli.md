# CLI — `tools/voxel.ts`

One command drives the whole pipeline. Every subcommand is safe to re-run;
anything missing an input **prints a reason and exits** rather than failing
into a half-decoded state.

```sh
bun tools/voxel.ts <command> [args]
```

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `VOXELMON_ROM` | the canonical US Red ROM (SHA-1 gated) | none committed |
| `VOXELMON_G1R` | gen1recomp checkout — manifest, parity reference, RED++ pack | `~/code/gen1recomp` |
| `VOXELMON_VOXELMOD` | DramaticShapeVoxelMod checkout — tile profiles, arenas | `~/code/DramaticShapeVoxelMod` |
| `VITASDK` | VitaSDK root (Vita builds) | `~/vitasdk` |

## Commands

### Pipeline

| Command | What it does |
| --- | --- |
| `import` | decode the ROM into `dist/voxelmon/gen/` (SHA-1 gated; 17 datasets + `gfx.bin` + `programs.bin`) |
| `parity` | deep-compare `gen/*.json` against the reference extractor's output, field for field |
| `cook` | voxelize + pack `dist/voxelmon/voxelmon.vxpak`; extra args pass to the cooker |
| `sim` | run the story tape headless → `dist/voxelmon/trace/story.vtrace` |

### Verdicts

Each of these prepares first — import if `gen/` is missing, **always
re-cook**, re-run both tapes (`story`, `battle`) at the pinned seed:

| Command | What it does |
| --- | --- |
| `check` | rasterize both traces at **both** rungs and assert against the committed hashes: `<tape>.hashes` (shipped `psp` rung) and `<tape>-max.hashes` (the identity) |
| `record` | rewrite the **shipped** goldens only, then re-prove — never rewrite — the `-max` identity anchor |
| `shots` | write PNG frames to `dist/voxelmon/shots-<tape>-<tier>/`; `--tier <name>` picks one rung, default both |
| `wav` | render any song/sfx/cry through the real core synth to `dist/voxelmon/audio/*.wav`, printing peak and RMS — so "it renders" and "it is audible" stay two different claims |

### Device builds

Both prepare the pak + traces and bundle the guest
(`voxelmon/game/psp-main.ts` → one IIFE, no module system) before invoking
cargo:

| Command | What it does |
| --- | --- |
| `psp` | `cargo psp` under the **pinned** toolchain, then re-pack the PBP with `MEMSIZE=1` (full PSP-2000 memory — the pak + QuickJS heap cannot share the 24 MB partition) and copy the pak next to the EBOOT. Extra args go to cargo: `--release`, `--features capture` |
| `run` | `psp`, then launch the EBOOT in PPSSPP (`open -a PPSSPPSDL`) |
| `vita` | `cargo vita build vpk` on the nightly pinned by the vendored Vita host; packages the pak **inside** the VPK. `--tier <psp\|vita\|desktop>` names the rung the shell requests (default `vita`); other args go to cargo |

## package.json aliases

```sh
bun run setup    # git submodule update --init
bun run import   # = tools/voxel.ts import
bun run cook     # = tools/voxel.ts cook
bun run check    # = tools/voxel.ts check
bun run shots    # = tools/voxel.ts shots
bun run psp      # = tools/voxel.ts psp --release
bun run vita     # = tools/voxel.ts vita --release
bun run e2e      # = bun tests/e2e/voxel-ppsspp.ts
bun test         # the whole suite
bun run tsc      # typecheck, no emit
```

## Notes worth knowing

- **Every verdict re-cooks.** A stale pak is the one failure that looks like
  an engine bug; the re-cook is cheap insurance and cooks are byte-identical
  anyway.
- **The tape seed is pinned** (`STORY_SEED = 17`): both tapes' routes are
  plotted against it. Changing it invalidates every committed hash.
- **`record` cannot damage the identity.** It refuses to rewrite
  `-max.hashes` by construction; a red `-max` after `record` means a dial
  broke the identity rung — see
  [the golden ceremony](/guide/testing#the-golden-ceremony).
- The cook flags (`VOXEL_KEEP_HIDDEN=1`, `VOXEL_TREE_BOXES=1`) are documented
  in [The Asset Pipeline](/guide/pipeline#cook-time-flags).
