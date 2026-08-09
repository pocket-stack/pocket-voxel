# pocketvoxel-3ds

The **Rust half of the Pocket Voxel runtime on the Nintendo 3DS**, and the 3DS
sibling of `crates/pocketvoxel-psp` (the PSP EBOOT). It owns the pak, the
retained `Scene` the QuickJS guest drives through the `voxel` op surface, the
per-present `draw::build` call, and the handover to `pocketvoxel-pica`. It owns
nothing about the machine.

Standalone crate, excluded from the root workspace, exactly like
`pocketvoxel-gu`, `pocketvoxel-pica` and `pocketvoxel-psp`: it is built for
`armv6k-nintendo-3ds` with `-Z build-std`, and workspace membership would drag
that target into desktop `cargo check`.

## The split, and why QuickJS is on the other side of it

The PSP EBOOT registers its QuickJS C functions from Rust, because
`libquickjs-sys` builds the library as a cargo dependency. On the 3DS QuickJS is
compiled with devkitARM inside the container, so this host follows the PocketJS
3DS host (`hosts/3ds/src/qjs.c`) and unwraps JSValues in C.

| Rust (this crate) | C (the host) |
| --- | --- |
| the pak, the `Scene`, the op table and its argument marshalling, `draw::build`, the counters | QuickJS, citro3d, `linearAlloc`, the frame lifecycle, input, present |

The surface stays authoritative here — op codes, arities, the argument
defaulting, the warp-landing and audio-intent flags are all in `src/voxel.rs`
and `src/host.rs` — but it **crosses as data plus plain C entry points**, so
**no JSValue ever crosses the boundary** and the 16-byte `JS_NO_NAN_BOXING`
JSValue ABI is expressed in exactly one place. `pv3ds_op_count` /
`pv3ds_op_at` hand the C side the whole table; `include/pocketvoxel_3ds.h`
carries the registration sketch it walks.

`crates/pocketvoxel-psp/src/voxel.rs` is the authority for op numbers, arities
and semantics, and `src/tests.rs` transcribes that file's `register()` line by
line and asserts this table against it. The same guest bundle runs on both
consoles, so a divergence here is a divergence in the game.

## What the surface inherits from the PSP host

Three behaviours look like bugs and are none:

- **A missing argument reads as 0.** The PSP host collects exactly the op's
  declared arity through `arg_i32`, which answers 0 past the guest's own `argc`,
  so `voxel.cam(4)` moves the camera to (4, 0) rather than throwing. Native
  hosts are the non-strict kind, and the core's dispatch is defensive by
  contract because the op stream crosses a trust boundary.
- **`mapShow` reads argument 0 before dispatch.** Slot 0 re-showing is a warp
  landing — the guest holds the world frozen through the fade, which is the one
  moment a ~175 ms collection is an invisible held cut rather than a hitch
  mid-walk. `pv3ds_take_map_swapped` is what a C-side garbage-collection policy
  reads, and the flag comes off the same defaulted argument, so a no-argument
  call trips it exactly as it does on the PSP.
- **Seven ops mean "this run intends to sound".** `pv3ds_audio_wanted` is up
  before the first `frame()` of a run with audio, because the guest pins its
  engine tables at boot.

## The quality rung

There is **no `quality` op** in the table and no entry point that sets one, so
the Scene stays on **tier 0, the `psp` rung** — `QUALITY_TIER_DEFAULT`, and the
rung the shipped goldens were recorded at. That is the PSP EBOOT's behaviour,
which registers no such binding either. `PvVox3dsStats.quality_tier` reports the
rung in force so the claim is observable at runtime rather than only in a
comment.

The ladder must not gain a 3DS rung instead: tier ids are dense and in
declaration order, climbing is non-decreasing, and the last rung is the identity
anchored by the `-max.hashes` goldens, so inserting a weaker rung would renumber
`desktop`.

## Memory

Two facts set the budget, and they pull in opposite directions:

- The pak is **32,108,464 bytes** and is consumed **in place**: its vertex,
  index and texel pools are borrowed, never copied, so the blob lives in the
  malloc heap for the whole run. `pv3ds_load_pak` requires it **16-byte
  aligned** — the alignment every VXPK section offset is a multiple of, and the
  one the reader's 2/4-byte pool checks assume. `memalign(16, len)` and never
  free.
- `pocketvoxel-pica` needs **linear** memory for everything the GPU reads:
  12 MiB of vertex/index arena (two 6 MiB banks) plus **12.70 MiB** of expanded
  RGBA5551 textures, measured over this pak.

On the 3DS that split is decided **before `main()`**: libctru carves the linear
heap out of APPMEMALLOC at startup and the rest becomes the malloc heap. So the
C side owns the sizing (`__ctru_linear_heap_size`, `envGetLinearHeapSize`), and
it has to be chosen against ~25 MiB of linear demand and ~31 MiB of pak plus
whatever the QuickJS heap and the 1.15 MB gamedata graph want. **On an Old 3DS's
64 MiB that does not obviously fit, and it is the first thing to measure on
hardware.** The levers, in the order they cost least: shrink the texture set (it
is built lazily, so a run that never enters a battle never expands the pic
CLUTs), shrink the arena against the measurement below, cook a slimmer pak (the
PSP already ships a slim one for the same reason), or require a New 3DS.

The arena number is measured rather than assumed. Sweeping the camera over
**every chunk of every map of the shipped pak** at pitch rung 4 (the rung that
puts the horizon on screen):

```
167 frames swept; worst frame 2400 KB of the 6144 KB bank (39%),
129380 verts, 35 draws, 32 items; dropped 0 arena / 0 texture
```

That is `cargo test --release -- --nocapture the_shipped_pak`, and it skips
itself when `dist/` has not been cooked. It is a coarse sweep, not the story
tape, and it carries no entities, cards or UI — but those stage 4 vertices each,
so the 6 MiB bank has room over the worst frame this content can produce.

## Audio

The 3DS build **renders no PCM**: no audio module is mounted, and nothing calls
`Scene::render_audio`. The audio ops still reach the Scene — the chip synth's
state advances with the tick clock — exactly as it does in a PSP capture build,
so gameplay that waits on an audio op behaves the same. Adding sound later needs
two things this crate does not do yet: `Scene::audio.set_rate` before the first
audio op (the default is 44100 and every event's span is measured in samples, so
changing it later drops what is playing), and a per-tick pump on the C side.

## Building

```
# host tests (from the repo root: the crate's .cargo/config.toml is
# discovered from the WORKING directory, so running cargo inside the crate
# would build the tests for the 3DS)
cargo test --manifest-path crates/pocketvoxel-3ds/Cargo.toml

# the staticlib the C side links
cd crates/pocketvoxel-3ds && cargo build --release --locked
#   -> target/armv6k-nintendo-3ds/release/libpocketvoxel_3ds.a

# the C half of the ABI check: _Static_asserts + a real devkitARM link
bun crates/pocketvoxel-3ds/abi/check.ts
```

`.cargo/config.toml` carries the target and the `-Z build-std` block, so the
cross build is one command with no flags; `rust-toolchain.toml` pins the
nightly the 3DS host was proven on. The archive exports this crate's
`pv3ds_*` entry points **and** `pocketvoxel-pica`'s `pv_pica_*` ones, because
pica is an rlib linked into it — the C side needs one `-l` and both headers.

Undefined symbols the C side supplies: `malloc`, `realloc`, `free`, `abort`
(newlib), and the `__aeabi_*` helpers, which compiler-builtins already defines
weakly inside the archive.

## What the tests prove, and what they cannot

Covered, host-side, in `src/tests.rs` (30 tests):

- the op table against `pocketvoxel-psp/src/voxel.rs`'s `register()` — name,
  code, arity, declared JS length, kind, and which ops carry audio intent;
- the argument marshalling, compared against `Scene::op` driven with the padded
  list, so the oracle is the core's own dispatch;
- the warp-landing flag, the audio-intent flag, the string op's UTF-8 refusal,
  and that each op has exactly one entry point;
- pak loading: the 16-byte alignment refusal, a truncated blob, loading before
  the arena is adopted, and that a load starts a fresh Scene;
- the tick/present cadence: that the tick clock is the Scene's, that ticks and
  presents are independent, that a present without a pak is refused, and that a
  present records a frame whose command stream reflects the ops before it;
- that the rung stays tier 0 across every op and a `reset`;
- the C ABI's layout, which `abi/abi_probe.c` `_Static_assert`s again under
  devkitARM.

**Not covered, because it is on the other side of the ABI or needs a GPU:** that
the C side registers the table it is handed and unwraps JSValues the way the
header's sketch says; that the guest bundle boots against this surface; that the
recorded command stream draws the frame; and every memory figure above, which is
an arithmetic budget until a device or an emulator runs it.
