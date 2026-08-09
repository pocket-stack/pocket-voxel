# hosts/3ds — Pocket Voxel on the PICA200

The Nintendo 3DS host: QuickJS running the gameplay guest, citro3d driving the
GPU, and the diorama drawn by **hardware instead of the software rasterizer**.
It is the 3DS counterpart of `crates/pocketvoxel-psp`, the PSP EBOOT.

## What lives where

Three pieces, and the split is not the PSP's. citro3d is a C library that is
largely `static inline`, so on this console the GPU calls belong in C and
QuickJS comes with it — where the PSP puts both in Rust through
`libquickjs-sys`.

| | owns |
| --- | --- |
| `crates/pocketvoxel-3ds` (Rust staticlib) | the pak, the retained `Scene`, the VOX_OP table and its marshalling, `draw::build` |
| `crates/pocketvoxel-pica` (Rust rlib) | the frame lowering: the command stream, the matrix table, the texel expansion and retiling |
| `hosts/3ds` (this directory, C) | QuickJS, citro3d, `linearAlloc`, the frame lifecycle, input, present, capture |

The two crate headers are the whole contract this host compiles against —
`pocketvoxel_3ds.h` for the Scene and the op table, `pocketvoxel_pica.h` for
the recorded commands. **No JSValue ever crosses into Rust**, so the 16-byte
`JS_NO_NAN_BOXING` JSValue ABI cannot be got wrong in two places.

```
src/main.c       boot, the memory budget, the frame loop, the capture path
src/voxel_gfx.c  the command walker: the PvPicaCmd stream through citro3d
src/qjs.c        globalThis.voxel, built from the crate's op table
src/input.c      3DS keys onto VOX_BTN
src/vshader.v.pica  the vertex shader (there is no fragment shader on a PICA200)
Makefile         runs INSIDE the devkitARM container, driven by tools/voxel-3ds.ts
```

## Building

```
bun tools/voxel-3ds.ts                  dist/3ds/voxelmon.3dsx
bun tools/voxel-3ds.ts --capture        dist/3ds/voxelmon-capture.3dsx
```

The toolchain spans two environments. The Rust half cross-compiles on macOS —
`armv6k-nintendo-3ds` is a built-in rustc target and the app crate's own
`.cargo/config.toml` carries the target and `-Z build-std`. The C half compiles
inside `devkitpro/devkitarm:latest`, which owns `arm-none-eabi-gcc`, libctru,
citro3d, `picasso`, `smdhtool` and `3dsxtool`. QuickJS is compiled in the same
container from the revision `crates/pocketvoxel-psp/Cargo.toml` pins, and cached
under `dist/3ds/quickjs/` behind a stamp over the sources, the flags and the
image id.

The guest bundle and the 32 MB pak ride in the .3dsx's **RomFS**, so there is
one file to install and a run cannot pick up a stale pak sitting next to a fresh
binary. Everything the build reads and writes lives under git-ignored `dist/`:
**no ROM-derived byte ever commits.**

`--capture` builds the deterministic e2e binary. Its input tape and its mark
ticks are extracted from a recorded `.vtrace` and **baked into the binary**, the
same derivation `tests/e2e/voxel-ppsspp.ts` performs for the PSP EBOOT, so both
consoles replay one recorded run. Those values reach the C sources as `-D`
defines, and the objects depend on a stamp carrying the flags themselves —
without it a changed tape would linger in cached objects behind unchanged source
mtimes and produce a plausible binary that dumps the wrong frames.

## The screen

The pak is hard-rejected unless its META says 480x272, and `VIEW_W`/`VIEW_H`
also fix the camera aspect, the UI scale and the sky horizon row. So the diorama
is **not re-cooked** for this console: it renders through the existing 480x272
camera into a **400x226 letterboxed viewport** on the 400x240 top screen, which
preserves the cooked aspect exactly and costs 7 px of bar top and bottom.
Fitting by height instead would crop 24 px horizontally, and the GX blit only
offers 2x and 2x2 downscale, so the fit belongs in the viewport rectangle.

Two consequences worth knowing before reading a frame:

- The render target is created **rotated** — `C3D_RenderTargetCreate(240, 400)`
  — because that is how the top screen's framebuffer is laid out. Framebuffer
  row is landscape x; framebuffer column is `239 - landscape y`.
  `voxel_gfx_viewport` converts the crate's landscape rectangle into that
  space, and `voxel_gfx.c` pre-multiplies citro3d's screen tilt over the
  crate's matrix table each frame — the one transform the crate deliberately
  does not fold in, because it cannot build it without guessing its sign.
- `C3D_FrameDrawOn` **resets the viewport**, so `C3D_SetViewport` comes after
  it. Getting that wrong renders full-screen at 400x240 with no bars and the
  aspect stretched by 240/226.
- The frame clear covers the whole framebuffer, so **the letterbox bars carry
  the sky pass's clear colour**, not black. `Item::SkyBands` owns that clear and
  the crate hands it over as `PvPicaCmd.clear_abgr`; black bars would need a
  full-viewport quad this host does not synthesize.

## Memory

An Old 3DS gives an application about 64 MiB, and libctru splits it into a
malloc heap and a linear heap **before `main()`**. The pak is 30.6 MiB of the
malloc heap, and the linear heap has to hold three things: the staging arena
(12 MiB in two banks by default), the expanded textures (541 of them, 12.70 MiB
measured over the shipped pak, never evicted) and the GPU command buffer.

Every number is a build-time knob, all of them prefixed `PV3DS_HOST_` so they
cannot collide with the crate's own contract values:

| knob | default | what it does |
| --- | --- | --- |
| `--arena-mib` | 0 = `PV3DS_ARENA_BYTES` | the staging arena |
| `--banks` | 0 = `PV3DS_ARENA_BANKS` | banks it is split into |
| `--texture-mib` | 14 | linear memory held back for the expanded textures |
| `--heap-mib` / `--linear-mib` | 0 | libctru's split; zero is its automatic one |
| `--frame-wait-ms` | 4000 | deadline on each of the frame's two GPU waits |
| `--heartbeat` | 1, and 0 for `--capture` | write `sdmc:/pocketvoxel-3ds/hb.txt` |
| `--heartbeat-ticks` | 30 | the heartbeat's tick cadence |

The arena claim is adaptive: it asks for the crate's budget, holds back the
texture reserve, and halves down to a 2 MiB floor rather than refusing to boot —
because the crate **drops a draw it cannot stage and counts it** in
`PvPicaStats.dropped_arena`, and a smaller arena with a measurable hole beats a
console that will not start. What it actually got is printed on the bottom
screen along with the per-frame counters.

`--heap-mib` and `--linear-mib` are set **together or not at all**: libctru only
takes its automatic split when neither is given, so a lone override leaves the
other heap at zero bytes. The build command refuses the half-set pair.

## When a run stops

A wedged run is not an erroring run: `fail()` never happens, so nothing is
written, the top screen keeps its last frame, `aptMainLoop` is never reached
again so HOME stops responding, and the bottom screen's counter line only
refreshes every 30 ticks. A run that stops inside the first 30 therefore used to
say nothing at all about where it stopped. Three things now make it talk.

**Every step of the frame names itself** in `voxel_host_stage` before it runs —
`guest-frame`, `tick`, `record`, `gfx-prepare`, `frame-sync`, `frame-begin`,
`clear`, `draw-walk`, `frame-end`, `readback`, `apt`. It is a store into a
global, not a syscall, so it costs nothing per frame and a debugger on a halted
console reads it directly: `p voxel_host_stage`, `p voxel_host_tick`.

**The heartbeat writes the same facts to the SD card**, one truncated line in
`sdmc:/pocketvoxel-3ds/hb.txt`, so a wedge is readable over FTP with no
debugger:

```
tick 1334 stage frame-end scene 1335 items 15 rung 0 draws 14 verts 1455 idx 4590 …
```

It writes every 30 ticks and, once the first frame is behind it, on every stage
change — because the wedge this was built for happened inside the first 30
ticks, where a tick cadence names neither the frame nor the step. That costs one
SD write per stage change and does not hold 60 Hz; `--heartbeat 0` turns the
file off and leaves the free part. This is the PSP capture path's mechanism
(`crates/pocketvoxel-psp/src/capture.rs`) with the stage and the counters added.

**Neither of the frame's waits on the GPU can block forever.**
`C3D_FrameBegin(C3D_FRAME_SYNCDRAW)` is two waits and neither ends on its own:
`C3D_FrameSync` blocks until both screens' vblank counters advance, which needs
the process to still be receiving GSP events, and the queue wait blocks until
the GPU has drained the previous frame's commands — which is what makes the
arena bank the next record rewinds safe. So the host does the two halves itself,
each polled against a deadline: the vblank counters through `C3D_FrameCounter`,
the queue through `C3D_FrameBegin(C3D_FRAME_NONBLOCK)`. On expiry the run writes
an error naming the stage, the tick and the counters, then parks exactly as
`fail()` does:

```
the GPU never finished the previous frame within 1000 ms: stage frame-begin, tick 0, …
```

The deadline is four seconds by default — about 240 frames — and it is measured
in **system ticks** (`svcGetSystemTick`, `SYSCLOCK_ARM11`), not wall time, so
neither a heavy frame nor a slow emulator approaches it. A run at 20 ms, 200x
tighter, still completed 1334 ticks under Azahar without tripping. The deadline
also restarts while `aptIsActive()` is false, so the HOME menu and sleep — which
stop this process's vblank events on purpose — cannot be mistaken for a wedge.
`--frame-wait-ms 0` expires at once, which is the drill.

## Acceptance

```
bun run e2e:3ds               compare against tests/goldens/voxel/story-3ds.hashes
UPDATE_3DS=1 bun run e2e:3ds  re-record (then look at the PNGs in dist/)
```

The driver makes **three separate claims**, because one of them cannot be a
pixel comparison against the oracle. The 3DS draws the pak's 480×272 camera into
a 400×226 letterboxed band, so comparing pixels means resampling one side, and
the resample costs more than the backends differ by: against the oracle resized
to the band, worst-mark AE is 62118 of 90400 at `-fuzz 2%`, while the
comparison's own floor — the oracle against nothing but a trip through the same
grid — is 61215. At that fuzz the floor is **99 % of the signal**, so a pixel-AE
tolerance would be measuring ImageMagick's filter choice.

So `story-3ds.hashes` is FNV-1a64 over each decoded mark and proves
**determinism and regression, not parity**; a mean-RGB gate compares the band's
channel averages against the *untouched* 480×272 oracle, which has no resampling
floor at all (worst 1.41 of 255, tolerance 3.0); and a coarse-structure gate
box-averages both sides to a common 100×56 grid (worst 759 of 5600, floor 136,
nearest wrong scene 3571, tolerance 1700). Capturing from an off-screen 480×272
target would remove the resample and let the PSP driver's pixel comparison
transfer unchanged — that is the route to real parity, and it is not done.

The hashes belong to one renderer: Azahar's Vulkan and software backends hash
differently on all 11 marks, so the fixture pins `graphics_api=0`.

## Capture

`--capture` replaces the hardware input with the baked tape and renders **only
the mark ticks** — the scene state is a pure function of (tick, buttons) on the
CPU side and `draw::build` is pure, so the picture at a mark is identical either
way and the in-between frames would cost an hour of emulator time proving
nothing. That is the PSP capture build's arrangement.

At each mark the render target is read back with an explicit
`C3D_SyncDisplayTransfer` — **not** `gfxGetFramebuffer` after `C3D_FrameEnd`,
which reads back black because the buffer has already been swapped — and written
as exactly `400 * 240 * 4` bytes to `sdmc:/pocketvoxel-3ds/fNNNN.raw`, named by
**mark index**, which is what `tests/e2e/voxel-ppsspp.ts` already compares
against.

**That transfer's output format is `GX_TRANSFER_FMT_RGB8`, and the host widens
B,G,R into the A,B,G,R capture word itself.** Asking the PPF for a 32-bit linear
output out of this 240×400 tiled colour buffer returns rows that are each
individually correct and progressively misregistered — every fourth output row
slips a further 64 texels — which reads as a shredded diorama while the same
frame presents perfectly on the screen. Measured over one frame against a known
probe rectangle: RGBA8 out 74.6 %, RGB8 out 100.0 %, the presented screen
framebuffer 100.0 %, a CPU untile of the colour buffer exact. RGB8 is the format
citro3d's own presentation transfer uses, so the capture travels the path the
screen travels; the alpha byte it drops was never read, because the decode takes
R, G and B only. After the last mark it writes `done` and parks: Azahar does not stop
when the app returns from `main`, and a still process is what a driver kills.
Any failure path writes `error.txt` and parks, so a broken run surfaces as its
own message rather than as a timeout.

A mark whose frame dropped a draw fails the run. A hole must never become a
golden.

The whole directory is deleted by the driver before each run — Azahar has no
working per-run isolation, so a previous run's files would otherwise satisfy a
count check and stale pixels get compared.

## Verified on Azahar, not yet on hardware

The story tape's 11 marks render as the diorama, checked against the software
rasterizer's shots for the same marks: `docs/PICA.md` §6 records the walk of the
11 structural checks and the per-mark AE. **The screen tilt's sign, the TEV
configuration, both attribute permutations, the depth compare, the alpha cutoff,
the letterbox viewport and the memory split are all confirmed.** A real console
is still unproven — Azahar's PICA and PPF emulation is not the silicon, and the
memory split in particular is a budget an Old 3DS may refuse.

`docs/PICA.md` §6 lists what a first run must check and what each failure
looks like.
