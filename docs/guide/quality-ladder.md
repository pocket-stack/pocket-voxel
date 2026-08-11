# The Quality Ladder

Pocket Voxel runs on machines an order of magnitude apart in throughput, so
fidelity is a **ladder a machine climbs, not a build flag**. The rungs and
their dials are pinned in `contracts/spec/voxel-spec.ts` (`QUALITY_TIER`,
`QUALITY`); a host names its rung once with `quality(tier)` and the core
applies that rung's dials while it builds every frame.

Two rules make it a ladder and not a pile of switches:

::: tip Rule 1 — every dial is a RUNTIME dial
One cooked pak serves every rung. The rung is a **host** decision and never a
re-cook — no op stream and no pak byte differs between a PSP and a desktop.
Geometry that must differ per machine is cooked at *all* levels and picked
between at runtime, and the pak declares which levels it carries, so a
runtime asking for one it does not hold degrades instead of misrendering.
:::

::: tip Rule 2 — the top rung is the identity
The top rung draws exactly what this runtime drew before the ladder existed.
`tests/goldens/voxel/*-max.hashes` are the pre-ladder frame hashes, and
`check` replays both tapes at the top rung against them byte-for-byte — so no
later dial edit can quietly move the picture the ladder is supposed to
preserve.
:::

Because the **host** names the rung, the guest bundle inside the Vita VPK is
byte-identical to the one baked into the PSP EBOOT — no `#ifdef`, no second
build of the game.

## The dials

All distances are world px from the view centre to a chunk's own centre,
widened by the chunk's half-extent — one function, `draw::within_dist`, so a
dial added later cannot measure differently from these.

| rung | `grassDist` | `flowerDist` | `treeHullDist` | `treeCoarseDist` | `groundBakeDist` | `detailDensity` | `chunkDist` | `pullDepthBias` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `psp` (default) | unbounded | unbounded | off | unbounded | off (bake all) | 4 | 340 | on |
| `vita` | unbounded | unbounded | unbounded | unbounded | unbounded (never) | 1 | 340 | off |
| `desktop` | unbounded | unbounded | unbounded | unbounded | unbounded (never) | 1 | 340 | off |

`chunkDist` is 2.5 view-heights at **every** rung including the top: it is
the old hard-coded cull distance folded in — a pre-existing frame-budget cap,
not a fidelity dial. Widening it at the top would draw *more* than the
pre-ladder runtime instead of the same.

The `vita` rung is currently a labelled placeholder owed a number from the
machine itself — at these dials it is pixel-identical to the top rung across
both tapes on the v1 maps.

## The no-moving-boundary rule

The psp rung shipped one afternoon with finite detail distances, a
coarse/box tree boundary and a live-geometry bubble around the player — and
**every one of them became a device-visible walking artifact the same day**.
A distance boundary inside the visible field moves with each step, so the
swap it hides plays as flicker (a tree ring twinkling coarse↔box), popping
(grass at its fade line), or a jump (the road flipping baked↔live one cell
ahead of the player).

The rule this repo keeps: **no camera-relative representation change inside
the visible field — it never ships.** The psp rung keeps one representation
everywhere the frustum reaches and pays for the frame with **uniform** dials,
which cannot flicker because they never switch:

- **coarse-only trees** — the fine carve is off everywhere except the chunk
  underfoot (see below), coarse hulls everywhere else;
- **bake-everywhere ground** — never a distance-gated bubble;
- **detail density** — `detailDensity: 4` draws a prefix of each chunk's
  detail streams. The cook packs those streams *stratified* (round-robin by
  within-cell rank, cells in bit-reversed order), so any prefix is a
  spatially uniform sample. Packed row-major, "half density" had meant a bald
  south half per chunk — not thinner grass;
- **the coarse carve ships without its rear hemisphere** — a carved ball is
  convex and the camera is always south of and above it, so its north faces
  are self-occluded at every pitch rung. They were 25% of the coarse stream.

Composition at the route-1 checkpoint under these dials: coarse trees 15.4k,
keep 10.2k, grass 6.6k, bake 2.2k, flowers 1.5k — **~37k triangles against
the ~40k that holds a 33.3 ms present**.

## Why trees get three levels of detail

A carved tree hull is ~700 quads per cell; the plain box the same cell
extrudes to is under ten. At pitch rung 2, hulls were **55.7k of Pallet
Town's 96.8k triangles** — more than terrain, grass, flowers and water
together. So the cooker emits all three levels (fine carve / 2×2-px coarse
carve / boxes) and `draw::build` picks one per chunk against the tree dials.

`treeHullDist: 0` does **not** mean "no fine trees": `within_dist` widens
every limit by the chunk's half-extent, so the chunk under the view centre —
the tree the player stands next to, where 2-px quantisation would be most
visible — keeps the fine carve at any non-negative dial. The result is a
three-ring gradient: fine underfoot, coarse to the horizon (minus the rear
hemisphere), boxes beyond the cap.

## `pullDepthBias` — the one dial with a CPU story

The mod's camera-ward pull displaces every pulled vertex toward the eye along
its own ray — a depth trick whose screen position is unchanged by
construction. On the PSP that displacement must be re-staged on the CPU every
frame, and telemetry measured that restage at **65–73 ms of a ~100 ms Route-1
seam frame** — the single largest line in the whole frame.

With the dial on, grass and flowers draw their cooked vertices **in place**
and the pull becomes one constant NDC-depth bias per mesh, folded into the
projection matrix. The bias equals the geometric pull's depth shift exactly
*at the camera focus* — the player's own cell, or the arena centre — which is
precisely where grass-over-feet layering is a gameplay contract. Entity cards
keep the geometric pull at every rung (four vertices each), and the top rung
keeps it for everything, so the identity anchor never moves.

## Where the frame went

After the 2026-08-06 CPU work (autopilot phase telemetry over the story
tape): guest JS 16–19 ms, draw-list build ~0.7 ms, CPU record ~0.5–1 ms, GE
hidden under the guest's window, vblank ~5–8 ms. Pallet Town 102 → 81 ms, the
Pallet↔Route-1 seam 129 → 68 ms, Route 1 128 → 54 ms, interiors 33 ms.

The frame is now **GE-fetch-bound**: GE time scales with vertex/index bytes
fetched per frame, so the next rungs down the ladder are geometry diets — the
planned cook-time **ground bake** (low-relief chunks projected into one
textured quad each), hull instancing, far-chunk impostors — not draw-call or
culling tricks. The full accounting, including every measured plateau that
placed each dial's value, is in [VOXEL.md §4a](/VOXEL).
