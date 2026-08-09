# pocketvoxel-pica

The **PICA200 (Nintendo 3DS) backend** for the Pocket Voxel diorama, and the
sibling of `pocketvoxel-gu`, the PSP GE backend. It consumes the same
`pocketvoxel_core::draw::DrawList` the software rasterizer
(`pocketvoxel-sim/src/raster.rs`) and the GE backend consume, in the same order,
through the same `draw::resolve_pal`, with the same camera-ward pull, the same
alpha-test cutoff and the same three depth behaviours.

Standalone crate, excluded from the root workspace, exactly like
`pocketvoxel-gu`: it builds for `armv6k-nintendo-3ds` with `-Z build-std`, and
workspace membership would drag that target into desktop `cargo check`.

## The split: Rust resolves the frame, C issues the citro3d calls

citro3d is a C library that is largely `static inline`, so the division of
labour is the opposite of the PSP's — where `pocketvoxel-gu` calls sceGu
directly from Rust — and matches `hosts/iphone2g`, a pure-C host over a Rust
staticlib.

| Rust | C |
| --- | --- |
| the pak, the DrawList, the frame lowering, the texel layout | citro3d, `linearAlloc`, the `C3D_Tex` array, the frame lifecycle, present |

`Renderer::record` walks the DrawList once and produces three flat `#[repr(C)]`
arrays — commands, matrices, texture keys — plus staged vertex and index bytes
in the host's linear arena. Nothing in this crate touches the GPU, allocates
linear memory, or decides when a frame begins. The C side reads the result
through `include/pocketvoxel_pica.h`, which also documents the GPU state each
command's flags stand for.

Recording is driven from the host's own Rust glue, which owns the QuickJS guest
and the retained `Scene`:

```rust
pocketvoxel_pica::global().record(&draw::build(&scene, pak), pak)
```

## The three things the PICA200 forces

**1. No paletted texture format at all.** The GE applies the day tint by
rewriting a 256-entry CLUT and rebinding. Here every `(page, frame, resolved
VPAL, tinted)` pair has to become its own expanded image. The target format is
**RGBA5551**: 16 bpp, and its single alpha bit is exactly the 1-bit cutout the
rasterizer's `palette alpha < 0x80` test needs.

Measured over the shipped 32 MB pak (`cargo test the_expansion_set_over_the_shipped_pak -- --nocapture`):

```
518 atlas pages, 58 palettes -> 541 distinct textures
12.70 MiB of linear memory (1.12 MiB of it POT padding)
largest single texture 65536 bytes
```

That is the whole reachable set — 142 baked ground pages at one world palette
each, the terrain page at 3 world palettes x 8 animation frames, 374 sprite and
battle pages at their own OBJ and pic CLUTs, one GB UI page untinted — so
nothing is ever evicted and slot ids are stable for the life of the process.
12.70 MiB of textures plus the 12 MiB vertex arena fits the Old 3DS's 32 MiB
linear heap.

**2. s16 vertex attributes convert as RAW INTEGERS.** There is no implicit
÷32768 like the GE's `TRANSFORM_3D`. So the model matrix drops the GE backend's
×32768 counter-scale, and the pak's fixed-point UVs are scaled by the per-draw
`uv_scale` a command carries instead of by `sceGuTexScale` — which also folds in
the power-of-two envelope, since the PICA has no texture matrix.

**3. Vertex data must live in linear memory.** `BufInfo_Add` rejects any pointer
below physical `0x18000000`, so the PSP's zero-copy "point the GE at the pak in
place" is impossible: every visible vertex and index is staged into the host's
`linearAlloc` arena each frame. The arena is banked — one bank per frame — so
with two banks and a host loop that waits for the GPU command queue to drain in
`C3D_FrameBegin` (either flag spelling: blocking, or `C3D_FRAME_NONBLOCK`
polled) the bank being rewound is two frames old and provably idle.

The arena cannot grow (only the host can call `linearAlloc`), so an allocation
that does not fit **drops that draw and counts it** in `Stats::dropped_arena`
rather than panicking. A hole in one frame beats a dead handheld.

## Textures: three layouts that do not agree

`src/tex.rs` stands between the pak and a bindable texture:

- **the pak is PSP-swizzled** — 16-byte by 8-row blocks, row-major;
- **the PICA wants 8x8 tiles, row-major, Morton order inside a tile**, and
  power-of-two dimensions in `[8, 1024]`;
- **tiled row 0 is sampled at `v = 1`**, so the image is flipped vertically on
  the way in and a `v` of 0 then samples the image's top row, exactly as the
  rasterizer's `ty = v * h` does.

`C3D_TexUpload` is a plain `memcpy`: get any of the three wrong and the GPU
uploads plausible garbage rather than failing. The packing, the Morton
permutation and the tile order were therefore **read out of devkitPro's own
`tex3ds` encoder**, not from memory — probe images encoded with `tex3ds --raw
-z none -f rgba5551` and decoded byte by byte:

- a texel is a little-endian `u16`, `R<<11 | G<<6 | B<<1 | A`
  (solid red encodes to `0xf801`, green `0x07c1`, blue `0x003f`);
- within an 8x8 tile, texel `(x, y)` sits at
  `(x&1) | ((y&1)<<1) | ((x&2)<<1) | ((y&2)<<2) | ((x&4)<<2) | ((y&4)<<3)`;
- tiles run row-major.

(`tex3ds --raw` writes a 4-byte header before the texels — an 8x8 RGBA5551
image is 132 bytes, not 128 — which is worth knowing before decoding one.)

The one thing that is **modelled rather than measured** is how the GPU expands a
5-bit channel back to 8 bits: `expand5` assumes bit replication, and the 8-to-5
table is derived from it by exhaustive nearest-match. `tex3ds` itself truncates
(`c >> 3`); this crate rounds, because truncation costs up to **7/255 = 2.7%**
per channel and the acceptance run compares against the 8-bit CPU oracle at
`-fuzz 2%`, while rounding costs at most **4/255 = 1.6%**.

## Depth

The core builds one GL-convention VP that the rasterizer and the GE backend both
consume, and the PICA's usable depth range is negative, so `cmd::pica_clip`
remaps the halfspace: `z' = (z - w) / 2`. Paired with the host's
`C3D_DepthMap(true, -1.0f, 0.0f)` this lands the near plane at depth 1 and the
far plane at 0, which makes:

- **`GPU_GREATER`** — `C3D_Init`'s own default — mean "nearer wins";
- **clear depth 0** mean "far", which is what the sky pass writes;
- an **equal-depth contest go to whichever draw came first**, exactly as the
  rasterizer's strict `z < depth` resolves it, which is why draw order is never
  disturbed.

The `pullDepthBias` rung's bias is applied in GL space first, where
`draw::biased_vp`'s one formulation lives, and the remap runs after — so the two
backends stay one bias rather than two implementations. The conventions read
opposite (GL: smaller z wins; PICA: larger depth wins), and `cmd.rs` pins that
the sign survives the crossing.

## Viewport

The pak is hard-rejected unless META says 480x272, and `VIEW_W`/`VIEW_H` also
fix the camera aspect, the UI scale and the sky horizon row — so the diorama is
**not re-cooked** for this screen. It renders through the existing 480x272 camera
into a **400x226 letterboxed viewport** on the 400x240 top screen, which
preserves the cooked aspect and costs 7 px of bar top and bottom. Fitting by
height instead would crop 24 px horizontally, and the GX blit only offers 2x and
2x2 downscale, so the fit belongs in the viewport rectangle rather than the
transfer.

## Building

No `.cargo/config.toml` lives here, so `cargo test` stays on the host and the
3DS target is named explicitly (the app crate that links this one owns the
target configuration):

```
# host tests
cargo test

# the real target
cargo +nightly build --release --target armv6k-nintendo-3ds \
  -Z build-std=core,alloc,compiler_builtins \
  -Z build-std-features=compiler-builtins-mem
```

The crate is an **rlib**, not a staticlib: the app crate owns the
`#[panic_handler]`, the `#[global_allocator]` and the final link, which is the
`pocketvoxel-gu` posture. Its `#[no_mangle]` entry points survive into the app's
staticlib. `panic = "abort"` is set for both profiles because the target
defaults to unwind and has no unwinder.

`pocketvoxel-core` arrives with `libm` for the device and, through a
dev-dependency, additionally with `std` under `cargo test` — that is what puts
`pak::builder` and `pak::AlignedBlob` in reach of the host tests.

## What the tests prove, and what they cannot

The PICA200 cannot be exercised on a workstation, so the oracle the tests hold
this backend to is the **software rasterizer's own arithmetic**: where
`raster.rs` decides something the picture depends on, the test transcribes that
expression from its source and asserts this crate agrees with it exactly.

Covered: the pull displacement bit for bit (including the pinned
scale-by-`1/len`-then-by-`pull` order, which is a different f32 from the fused
form); the i16 truncation of textured pulled vertices and the f32 the ghost
keeps; the sky band row slicing and the clear it owns; `biased_vp` and the depth
remap's direction; palette resolution through `draw::resolve_pal` and the tint
as a `modulate_rgb` palette modulation that never reaches the GB UI; the
DrawList-to-command correspondence item by item; the PSP-to-PICA retiling
against the core's own `unswizzle` and against `tex3ds`; the arena's banking and
its degradation; and the C ABI's layout, which `_Static_assert`s the same
numbers under devkitARM.

**Not covered, because it needs a GPU:** that the recorded stream actually draws
the frame. Rasterization, filtering, the depth compare, the screen tilt, the TEV
configuration and the attribute permutations are all C-side and unverified until
an emulator or a device runs them.
