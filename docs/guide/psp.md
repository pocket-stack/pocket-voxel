# Running on PSP

The PSP is the primary target: a real PSP-2000 at 480×272, 30 fps present
lock with 60 Hz game logic, sound through the ROM's own channel programs.

## Build

```sh
bun tools/voxel.ts psp --release
```

Extra arguments pass through to `cargo psp` (e.g. `--features capture`).
The command needs no toolchain setup of your own — the
[cargo-psp](https://github.com/overdrivenpotato/rust-psp) toolchain is
**resolved and pinned** by `tools/psp-toolchain.ts` from the vendored engine
commit, so every checkout builds with the same rustc and the same SDK.

What one build actually does:

1. **Prepare** — import if `gen/` is missing, re-cook the pak, run both tapes
   headless to refresh the traces.
2. **Bundle the guest** — `voxelmon/game/psp-main.ts` → `dist/voxelmon/game.js`
   via `bun build --format=iife --target=browser`: no module system, no
   Bun/node APIs. The bundle is baked into the EBOOT by `build.rs`.
3. **`cargo psp`** under the pinned toolchain.
4. **Re-pack the PBP with `MEMSIZE=1`.** cargo-psp's `Psp.toml` has no field
   for it, and without that flag a PSP grants only the 24 MB user partition —
   which the pak plus the QuickJS heap cannot share. The tool writes the
   PARAM.SFO itself (same layout, plus the one dword) and re-packs with the
   XMB cover art preserved.
5. **Copy the pak next to the EBOOT** — PPSSPP maps the EBOOT's directory as
   `host0:`, so the emulator finds it with zero configuration.

Output: `crates/pocketvoxel-psp/target/mipsel-sony-psp/release/EBOOT.PBP`
with `voxelmon.vxpak` beside it.

## Install on hardware

Put `EBOOT.PBP` and `voxelmon.vxpak` together in one folder under
`ms0:/PSP/GAME/` — that's the whole install.

For development, [PSPLINK](https://github.com/pspdev/psplinkusb) is the loop
that keeps the memory stick out of it: run the EBOOT over USB with the pak
served from `host0:`, and every rebuild is a relaunch, not a copy.

## Run in PPSSPP

```sh
bun tools/voxel.ts run   # build, then `open -a PPSSPPSDL <EBOOT>`
```

PPSSPP honors `MEMSIZE` from the PBP's PARAM.SFO. Note that **PPSSPP
headless runs as a PSP-1000 (24 MB)** — the e2e accounts for this; if you
script headless runs yourself, expect slim-model memory.

## The capture build

The e2e drives a special EBOOT that replays recorded input deterministically
under PPSSPP and hashes what the GE actually rendered:

```sh
bun tools/voxel.ts psp --release --features capture
```

`VOXEL_CAP_INPUT` / `VOXEL_CAP_MARKS` name the recorded input and the marks
to capture; `tests/e2e/voxel-ppsspp.ts` sets them for you and asserts
GE-vs-rasterizer agreement at all 11 story marks within a measured pixel
tolerance.

## GE discipline

Rules inherited from `pocket3d-gu` and const-asserted in the backend:

- the pak's 16-byte vertex — u16 fixed-point UVs, u32 colour, **i16
  positions** countered by a ×32768 model scale;
- inverted 16-bit depth (`GreaterOrEqual`, clear 0), GL-style −1..1
  projection;
- dcache writeback after every CPU write the GE reads; pool reset only after
  `sceGuSync`; 333 MHz set explicitly at boot.

Two rules this runtime **bisected on real hardware** (both failure modes draw
plausible-looking garbage, never crash):

::: warning Textured TRANSFORM_3D draws must use the i16 + indexed vertex
A textured `VERTEX_32BITF` card samples noise. Every billboard card and every
CPU-staged mesh goes through the pak's own vertex format.
:::

::: warning CLUT8 atlas pages must be at least 64 px wide
A 16-px-wide sprite sheet missamples into vertical-strip noise. The cooker
pads sprite and emote pages; card U coordinates normalize by page width.
:::

## The frame is fetch-bound

A finding worth internalizing before optimizing anything here: the GE on this
content is **fetch-bound, and what it fetches from matters less than whether
the CPU just wrote it**. Splicing index ranges through the frame pool looked
~17 ms/frame faster than drawing in place — but a boot-time copy of the same
bytes reproduced none of the win. The advantage was the *recency of the CPU
writes*, and it cost ~25 ms of CPU to produce. The shipped backend draws
index ranges **in place** (the cooker 16-byte-aligns each range) and spends
no per-frame CPU on geometry at all.

Consequence: performance work on this target means **geometry diets**
(fewer bytes fetched per frame — see [the quality ladder](/guide/quality-ladder)),
not draw-call or culling tricks.
