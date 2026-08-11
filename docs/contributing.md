# Contributing

The codebase is opinionated in a few places where being casual has already
been measured to hurt. Read this page before your first PR; it is short and
every rule on it has a story behind it (usually in [VOXEL.md](/VOXEL)).

## The hard rules

1. **No ROM-derived byte is ever committed.** No cooked pak, no extracted
   art, no decoded text, no golden PNG. Goldens are frame *hashes*. If your
   change wants to commit a picture, capture real hardware output (the XMB
   art standard) or don't.
2. **The identity anchor is not yours to move.** `*-max.hashes` are never
   re-recorded for a dial edit. The three legitimate re-basing events — a
   vertex format change, a pack order change, a gameplay change — each pay
   with a pixel-diff proof: which marks moved, by how many pixels, and why
   each had to. See [the golden ceremony](/guide/testing#the-golden-ceremony).
3. **No camera-relative representation change inside the visible field.** A
   distance boundary that moves with the player plays as flicker on device.
   New fidelity work uses uniform dials, or cooks all levels and keeps the
   boundary out of the frustum. See
   [the no-moving-boundary rule](/guide/quality-ladder#the-no-moving-boundary-rule).
4. **The 24 px underside cull is a pak invariant.** Anything that lowers a
   camera eye below 24 world px — a new rig, a lower rig height, a new pitch
   rung — invalidates every cooked pak, not just the cooker. Say so in the PR
   if you touch a rig.
5. **Gameplay formulas cite their provenance.** Every ported rule carries a
   citation to the Lua it ports. A change to a rules module either matches
   the reference at its cited lines or declares an adaptation the way
   `rules/status.ts` does.
6. **The surface changes by ceremony.** Edit `contracts/spec/voxel-spec.ts`,
   regenerate the Rust (`gen-voxel-rust.ts`), commit both — the byte-compare
   drift guard fails the build otherwise.

## Before you push

```sh
bun run tsc                  # typecheck
bun test                     # 226 tests; ROM-gated suites skip without inputs
bun tools/voxel.ts check     # both tapes, both rungs, against the goldens
```

If your change legitimately moves the **shipped**-rung picture (a dial
change), run `bun tools/voxel.ts record`, commit the updated hashes, and put
the accounting in the PR: which marks moved and why each one had to. Use
`bun tools/voxel.ts shots` to eyeball, and the PPSSPP e2e to prove the GE
agrees.

If `check` goes red at the `-max` tier: stop. The fix is in your change,
never in the golden file.

## Layout

```text
crates/pocketvoxel-core     scene core (no_std + alloc, zero deps)
crates/pocketvoxel-sim      desktop headless host: rasterizer, PNGs, hashes
crates/pocketvoxel-gu       PSP sceGu backend
crates/pocketvoxel-psp      the EBOOT shell
crates/pocketvoxel-gxm      Vita raw-GXM backend
crates/pocketvoxel-vita     the VPK shell
voxelmon/import             ROM importer (TS)
voxelmon/cook               voxelizer + atlas packer + VXPK writer (TS)
voxelmon/game               the gameplay port (TS) — Bun headless and QuickJS
voxelmon/tapes              intent tapes
contracts/spec              the surface spec + Rust codegen
tools/voxel.ts              the pipeline command
tests/                      suites + goldens (hashes only)
vendor/pocketjs             the engine, pinned as a submodule
```

The submodule pin moves deliberately: the PSP host library, the audio module
and the toolchain pins all come from one mainline engine commit.

## Working on these docs

The site lives in `docs/` and builds with VitePress:

```sh
bun run docs:dev       # local dev server with hot reload
bun run docs:build     # production build (also validates links)
bun run docs:preview   # serve the built site
```

`docs/VOXEL.md` is the design record — a decision log, not a manual. Keep it
append-oriented and let these pages stay the readable layer that links into
it; don't duplicate a fact in both places when a link will do.
