# Running on PS Vita

The Vita runs the **same guest bundle, the same cooked pak and the same
core** as the PSP. What's new is a second backend for the one draw list
(`crates/pocketvoxel-gxm`, raw SceGxm) and a second application shell around
it (`crates/pocketvoxel-vita`). It rasterizes at native **960×544** while the
logical viewport stays the PSP's 480×272 — the cameras, the UI layout and
every golden are unchanged; only the pixel count moves.

## Build

Needs [VitaSDK](https://vitasdk.org) and
[cargo-vita](https://github.com/vita-rust/cargo-vita), plus vitaGL's static
library (the build checks for it and tells you the fix — `vdpm vitaGL`):

```sh
export VITASDK=~/vitasdk
bun tools/voxel.ts vita --release        # → dist/voxelmon/voxelmon.vpk
```

Extra arguments pass to `cargo vita`. `--tier <psp|vita|desktop>` overrides
the quality rung the shell asks the core for (default `vita`) — an A/B
measurement knob, not a build variant; the guest bundle never changes.

The Rust nightly comes from the vendored Vita host's own
`rust-toolchain.toml` — one pinned source both this VPK and PocketJS build
against, so they cannot drift into two nightlies.

## Install: one file

**The VPK carries the pak inside it** (read from `app0:` at runtime) and
needs nothing else on the console:

1. Copy `voxelmon.vpk` over (VitaShell's `SELECT` starts USB or FTP).
2. Press `X` on it, confirm.

That is the whole install. It also ships libvita2d's **precompiled GXM
shaders**, so a stock HENkaku console does not need Sony's runtime shader
compiler (`libshacccg.suprx`) the way most Vita 3D homebrew does.

Buttons match the EBOOT: `CIRCLE` confirms, `CROSS` cancels, the left stick
walks one axis at a time.

## Why the shaders arrive precompiled

There is no OpenGL on this machine. The native API, SceGxm, has **no
fixed-function pipe at all** — every draw needs a compiled vertex/fragment
program pair, and compiling on the console means the firmware module Sony
does not install by default. So the backend brings programs that are already
compiled: libvita2d's five, read out of `pocket3d-vita`'s `shaders/`
directory — one copy, one attribution, the technique OpenStrike established.

Two consequences shape the whole backend:

- **The textured program carries no per-vertex colour**, so an opaque mesh
  draws twice over the same indices — the texel, then the pak's baked AO
  through the colour program with a `dst * src` blend. That pair is what one
  `TextureEffect::Modulate` gets the GE for free.
- The vertex attribute formats read the cooked 16-byte `PakVert` **in place,
  with no repacking**: `S16` takes the i16 positions as integers (no ×32768
  scale needed), `S16N` reads the fixed-point UVs as 0..1, `U8N` reads the
  ABGR straight. One GPU buffer, two attribute offsets.

## What the missing alpha test costs

GXM has no alpha test, and precompiled shaders cannot `discard`. The GE cuts
sprite art out with a hardware alpha test; here alpha resolves by blending
and draw order, so the passes split by whether their art is cut out:

| Pass | Behaviour on Vita |
| --- | --- |
| Solid geometry (terrain, all tree levels, water) | opaque, depth-written, takes its AO pass — silhouette is carved into the mesh, **nothing lost** |
| Cut-out geometry (grass, flowers, billboards) | alpha-blended, depth-preserving, **no AO pass** — a texture-less multiply would darken transparent texels into visible rectangles; losing AO on a grass tuft is the cheaper error |
| GB UI layer | 2D, drawn last, never depth-tested — blending is exactly what the GE's cutout produced, **nothing lost** |

This is the one honest visual difference from the PSP picture. A vitaGL
backend that reproduced the GE exactly was built first and then **removed**:
vitaGL compiles even its fixed-function shaders on the console, which made
`libshacccg.suprx` a hard prerequisite and broke the one-file install. It is
recoverable from history if the cut-out fidelity is ever worth that.

## Memory and the frame

The shell composes inside vita2d's scene (vita2d owns process-level GXM: the
context, shader patcher, render target, swap). With std, a real allocator and
hundreds of megabytes, three things the PSP shell spends effort on are simply
absent: no partition arithmetic (the pak is read into one aligned heap block
and leaked), no pipelined present, no arena-pressure heuristic.

The pak's vertex and index pools are copied **once** into GXM-mapped blocks —
the GPU cannot read the heap — and that is the only copy the port makes.
Atlas pages upload as `LinearStrided` textures (any width, no power-of-two
envelope). Because GXM binds one palette per texture object and RED++ samples
one page through several palettes within a frame, the CLUT is resolved on the
CPU into a 24 MB-budgeted RGBA cache keyed by (page, frame, palette, tinted);
eviction is **deferred three frames** so a texture is never freed while the
GPU may still be reading it. Atlases sample POINT, so the art stays crisp at
4× the pixels instead of blurring.

## A boot that cannot fail silently

A console has no console. Graphics come up **first**, before the pak and
before QuickJS, and every later boot stage owns a colour:

| Screen | Meaning |
| --- | --- |
| amber | pak not found |
| magenta | pak failed validation |
| grey | pools would not fit |
| cyan | the guest threw (exception text on screen) |

Every stage also appends to `ux0:data/voxelmon/boot.txt`, and the first
frames log what they actually drew — so "running but blank" and "never got
there" cannot look alike.
