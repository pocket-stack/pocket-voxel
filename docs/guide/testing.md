# Testing & Determinism

The frame is a pure function of `(tick index, buttons)`. The tick clock is
the only clock; tile animation and menu cursors derive from it. Everything on
this page exists to keep that sentence true across four executables — the Bun
headless sim, the Rust software rasterizer, the PSP's GE and the Vita's GXM.

## The commands

```sh
bun test                        # 226 tests; ROM-gated suites skip with a reason
bun tools/voxel.ts check        # the full acceptance path (below)
bun tools/voxel.ts record       # re-record the SHIPPED-rung goldens only
bun tools/voxel.ts shots        # PNG frames per mark, per rung — the reading material
bun tools/voxel.ts parity       # importer output vs the reference extractor
bun tests/e2e/voxel-ppsspp.ts   # GE-vs-rasterizer parity at 11 story marks
```

`check` = import-if-missing + **always re-cook** + run both tapes headless +
rasterize each trace at **both** pinned rungs against the committed hashes.

## Five layers of verification

1. **Importer parity** — the TS importer's 16 datasets deep-compared,
   field for field, against what gen1recomp's own Python extractor produces
   from the same ROM.
2. **Gameplay tests** — Bun suites porting the reference test semantics
   (formula tables, timing budgets, collision/ledge/warp parity cases)
   against the ROM-decoded dataset, plus a fixture dataset so CI runs
   ROM-free.
3. **Oracle runs** — the Lua reference executes headless under LuaJIT
   (110/110 engine suites green on this ROM). Targeted modules are driven
   with identical inputs and compared trace for trace. The audio oracle is
   the strictest: rendered PCM must be **sample-exact** against the
   unmodified reference synth — all 303 programs, ~200 million samples, zero
   differences — *and* clear a loudness floor, because sample-exact silence
   would still be a bug.
4. **One tape, every host** — [intent tapes](/reference/formats#tape-intent-tapes)
   drive the Bun sim, which records the per-frame op stream. `pocketvoxel-sim`
   replays that stream through the real core + software rasterizer into frame
   hashes (committed) and PNGs (local only). The capture EBOOT replays the
   same recorded input under PPSSPP, and the GE must agree with the
   rasterizer within a measured pixel tolerance at every story mark.
5. **Two rungs, one tape** — a tape is a *guest* op stream and the quality
   rung is a *host* decision, so every tape pins two golden files:
   `<tape>.hashes` at the shipped `psp` rung, and `<tape>-max.hashes` at the
   top rung.

The marks: 11 story checkpoints and 4 battle checkpoints, each hashed at both
rungs — 15 marks, 30 committed hash lines, zero committed pixels.

## The golden ceremony

The two golden files per tape have **opposite lifecycles**, and the
distinction is the backbone of the whole regression story:

- **`<tape>.hashes` (shipped rung)** legitimately move when a dial moves —
  that is the point of recording them. `bun tools/voxel.ts record` rewrites
  them. The discipline is the *accounting*: a change that moves them owes a
  statement of **which marks moved, and why each one had to** — e.g. tree LOD
  moved 1 story mark and all 4 battle marks; the depth-bias pull moved the 8
  outdoor story marks, verified against shots and the PPSSPP e2e.
- **`<tape>-max.hashes` (identity anchor)** are the pre-ladder frame hashes
  and are **never re-recorded for a dial edit** — `record` refuses to write
  them, only re-proves them. A mismatch there means the ladder's top rung
  stopped being the identity, and the fix is the dials, never the file.

Three events may legitimately re-base the identity anchor, and each **pays
with a pixel-diff proof**:

| Event | The proof it paid |
| --- | --- |
| a vertex **format** change | the 16-byte vertex (u16 UVs) moved 590 pixels across all fifteen max-tier frames, worst 0.195%, every one a texel-boundary flip |
| a **pack order** change | the stratified detail-stream order moved 60 pixels across fifteen frames, every one on an equal-depth crossing line — and a rank-preserving order was tried first specifically to avoid the ceremony |
| a **gameplay** change | the only event that moves *both* rungs for the same reason: the tape is intent, so a legitimately different op stream moves every hash downstream. The 2026-08-07 parity pass moved 3 of 15 marks and documented why each had to move — and the other twelve being byte-identical is itself evidence the remaining changes were behavioural, not pictorial |

::: danger Never "fix" a red `-max` check by re-recording
The failure message says so explicitly, because the wrong fix is obvious and
cheap and the right one is not. If the top rung stopped drawing the
pre-ladder picture, a dial is measuring differently — find it.
:::

## Tapes are intent, never frame counts

A tape line is `walk u 3`, `press a`, `wait 30`, `mark route-1` — never "hold
up for 47 frames". `walk` counts **landed** steps and releases the direction
when `landed + in-flight == target`, so walks never overshoot and a
turn-in-place is not a step. This is what lets one tape drive every host and
survive timing changes that don't change behaviour.

Both tapes run against a pinned seed (`STORY_SEED = 17` in `tools/voxel.ts`);
their routes are plotted against it. The guest partitions **three seeded RNG
streams** (route / ambience / battle) so ambience cannot perturb the route —
a deliberate divergence from upstream's single stream, kept because changing
the topology would move every committed hash to buy nothing a player could
see.

## What CI sees

CI has no ROM and no reference checkouts, ever. ROM-gated suites skip with a
printed reason (the `POCKET3D_TEST_MAPS` convention); the fixture dataset
keeps the gameplay suites meaningful. Everything hash-based that CI *can*
check, it checks — the contract drift guard, the fixture gameplay tests, and
the toolchain pins.
