# Pocket Voxel

<p align="center">
  <img src="docs/shots/psp-pallet-town.png" width="720" alt="Pallet Town as a voxel diorama on a real PSP — carved trees, gabled roofs, an NPC and the player between the houses." />
</p>

<p align="center">
  <img src="docs/shots/psp-bedroom.png" width="352" alt="The player's bedroom: bookshelves, bed, SNES and a potted plant, voxelized." />
  <img src="docs/shots/psp-route-1.png" width="352" alt="Route 1: tall encounter grass, ledges, fences, and rows of carved trees." />
</p>

<p align="center"><em>All three screenshots are captures from a real PSP-2000 over PSPLINK.</em></p>

A Game Boy creature-RPG, presented as a voxelized 3D diorama on PSP-class
hardware. The gameplay is a TypeScript port of the
[gen1recomp](https://github.com/bryanthaboi/gen1recomp) Lua engine running in
an embedded QuickJS guest; the presentation is a Rust reimplementation of the
[DramaticShape Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
diorama renderer. Both upstreams are MIT-licensed; both serve here as
executable specifications, not vendored code.

Pocket Voxel is a specialized runtime of
[PocketJS](https://github.com/pocket-stack/pocketjs) — the same
`⟨ core, surface, guest ⟩` composition as
[OpenStrike](https://github.com/pocket-stack/open-strike), with the ownership
split inverted: **the game state lives in the guest** (world, battle, script
VM, menus, saves — every formula cites the Lua it ports), and the Rust core
owns only the retained scene — cooked voxel chunks, entity billboards, camera
rungs, the battle stage, a GB UI tile layer, and the chip synth that renders
the ROM's own sound programs to PCM. Steady-state boundary traffic is a few
ops per tick against a measured QuickJS budget of ~8k ops per frame.

## You bring the ROM

This repository is **ROM-fed, exactly like upstream gen1recomp**: the only
game-content input is a canonical US Gen-1 ROM you already own. The importer
verifies its SHA-1 before decoding one byte, everything decoded lands under
git-ignored `dist/`, and **no ROM-derived byte is ever committed** — no
cooked pak, no extracted art, no decoded text; the rendering goldens are
frame *hashes*, never pixels. The screenshots above are hardware captures of
the running device, the same standard as the EBOOT's XMB art.

## How it works

```text
cook time (Bun, your machine)            run time (PSP)
├─ import/  ROM → gen/ (SHA-1 gated)     ├─ QuickJS guest: the gameplay port,
├─ cook/    voxelizer: classify tiles,   │    one frame(buttons) per tick
│    carve trees, place 42 building      ├─ voxel surface: ~10-40 ops/tick
│    templates, bake ground+facades,     │    drive the retained scene
│    pack chunks → voxelmon.vxpak        ├─ pocketvoxel-core: culling, camera
└─ tapes/   intent tapes → .vtrace       │    rungs, draw list, chip synth
     (the acceptance path)               └─ the backend for this machine:
                                              pocketvoxel-gu  (PSP, sceGu)
                                              pocketvoxel-gxm (Vita, GXM)
```

- **One pak, many machines.** Fidelity is a runtime *ladder*, not a build
  flag: the same 31 MB pak serves the PSP rung (30 fps present lock, 60 Hz
  logic), the Vita rung, and the desktop identity rung — which replays the
  pre-ladder picture pixel-for-pixel and is pinned by committed frame hashes
  no dial edit may move. The rung is named by the HOST, not the guest, so the
  bundle in the VPK is byte-identical to the one in the EBOOT.
- **No camera-relative representation change inside the visible field.** The
  PSP rung pays its frame budget with uniform dials only (coarse-carved
  trees, ground baked to per-chunk pages, stratified detail density) — a
  distance boundary that moves with the player plays as flicker, and this
  repo's rule is that it never ships.
- **Deterministic to the byte.** Two cooks are byte-identical; gameplay is a
  fixed 60 Hz step with tape-recorded intent; the software rasterizer and
  the GE resolve the same draw list within a measured pixel tolerance,
  enforced by a PPSSPP-headless e2e at every story checkpoint.

## Quick start

Needs [Bun](https://bun.sh), a Rust toolchain, and for device builds the
[cargo-psp](https://github.com/overdrivenpotato/rust-psp) toolchain (resolved
and pinned automatically by `tools/voxel.ts`).

```sh
git clone --recursive https://github.com/pocket-stack/pocket-voxel
cd pocket-voxel && bun install

export VOXELMON_ROM=/path/to/your/rom.gb   # SHA-1 verified before any decode
export VOXELMON_G1R=~/code/gen1recomp      # reference checkouts: the manifest
export VOXELMON_VOXELMOD=~/code/DramaticShapeVoxelMod  # and the tile profiles

bun tools/voxel.ts import   # ROM → dist/voxelmon/gen/
bun tools/voxel.ts cook     # gen/ → dist/voxelmon/voxelmon.vxpak
bun tools/voxel.ts check    # replay the tapes, assert both rungs' hashes
bun tools/voxel.ts psp --release   # the EBOOT
```

Put `EBOOT.PBP` and `voxelmon.vxpak` in one folder under `ms0:/PSP/GAME/`, or
develop over [PSPLINK](https://github.com/pspdev/psplinkusb) with the pak
served from `host0:`.

### PS Vita

The Vita runs the same guest bundle and the same cooked pak; a second backend
(`crates/pocketvoxel-gxm`, raw GXM) draws the same draw list at the native
960x544 raster while the logical viewport stays 480x272. Needs
[VitaSDK](https://vitasdk.org) and
[cargo-vita](https://github.com/vita-rust/cargo-vita).

```sh
export VITASDK=~/vitasdk
bun tools/voxel.ts vita --release   # dist/voxelmon/voxelmon.vpk
```

The VPK carries the pak inside it, so installing that one file is the whole
install: copy it to the console (VitaShell's `SELECT` starts USB or FTP),
press `X` on it, confirm. The VPK is self-contained — it ships libvita2d's
precompiled GXM shaders, so a stock HENkaku console needs nothing else on it.

```sh
bun test                    # 208 tests; ROM-gated suites skip with a reason
bun tests/e2e/voxel-ppsspp.ts   # GE-vs-sim parity at 11 story marks
```

## Architecture notes

The full design record is [docs/VOXEL.md](docs/VOXEL.md): the content
boundary, the guest/core split, the VXPK format, the quality ladder and its
identity anchor, the fetch-bound GE findings, and the determinism ceremony
that governs when a committed hash may ever be re-based. The engine arrives
as a pinned git submodule (`vendor/pocketjs`), the OpenStrike pattern: the
PSP host library, the audio module and the toolchain pins all come from one
engine commit — a mainline commit, moved forward deliberately.

## License

MIT. The ROM, and everything derived from it, stays yours and stays local.
