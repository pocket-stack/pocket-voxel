---
layout: home
title: Pocket Voxel
titleTemplate: A Game Boy RPG as a voxel diorama on real handhelds

hero:
  name: Pocket Voxel
  text: A Game Boy RPG, carved into a voxel diorama.
  tagline: One cooked pak, one guest bundle — running on a real PSP, a real PS Vita, and your desktop. Deterministic to the byte.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture
    - theme: alt
      text: Design Record
      link: /VOXEL

features:
  - icon: 🕹️
    title: Hardware first
    details: Every screenshot on this page is a capture from a real PSP-2000 over PSPLINK. The same build installs on a stock HENkaku Vita as a single VPK — no extra runtime, no shader compiler.
    link: /guide/psp
    linkText: Run it on a PSP
  - icon: 🧊
    title: One pak, many machines
    details: Fidelity is a runtime ladder, not a build flag. The same pak serves the PSP rung, the Vita rung and the desktop identity rung — the host names its rung, the guest never knows.
    link: /guide/quality-ladder
    linkText: The quality ladder
  - icon: 🔁
    title: Inverted ownership
    details: Game state lives in the TypeScript guest — world, battle, script VM, saves, RNG. The Rust core owns only the retained scene. Steady-state boundary traffic is ~10–40 ops per tick.
    link: /guide/architecture
    linkText: The split
  - icon: 🎲
    title: Deterministic to the byte
    details: Two cooks are byte-identical. Intent tapes drive every host; committed goldens are frame hashes, and re-basing one is a ceremony that pays with a pixel-diff proof.
    link: /guide/testing
    linkText: Testing & determinism
  - icon: 🎵
    title: Sample-exact chip audio
    details: The ROM's own sound programs, interpreted core-side and rendered to PCM. All 45 songs, 104 effects and 154 cries verified sample-exact against the reference — ~200 million samples, zero differences.
    link: /guide/architecture#audio-names-in-the-guest-bytes-in-the-core
    linkText: How audio works
  - icon: 🔐
    title: ROM-fed, never committed
    details: The only game-content input is a ROM you already own, SHA-1 verified before one byte is decoded. Everything derived lands under git-ignored dist/ — no cooked pak, no extracted art, no pixels.
    link: /guide/getting-started#you-bring-the-rom
    linkText: The content boundary
---

<figure class="pv-hero-shot">
  <img src="./shots/psp-pallet-town.png" alt="Pallet Town as a voxel diorama on a real PSP — carved trees, gabled roofs, an NPC and the player between the houses." />
  <figcaption>Pallet Town on a PSP-2000 — carved tree hulls, template-matched buildings, baked ambient occlusion.</figcaption>
</figure>

<div class="pv-badges">
  <span>226 tests</span>
  <span>15 golden marks × 2 rungs</span>
  <span>303/303 audio programs sample-exact</span>
  <span>~37k triangles under a 33.3 ms present lock</span>
  <span>480×272 logical · 960×544 on Vita</span>
</div>

## The same build, everywhere the ladder reaches

<div class="pv-gallery">
  <figure>
    <img src="./shots/psp-bedroom.png" alt="The player's bedroom: bookshelves, bed, SNES and a potted plant, voxelized." />
    <figcaption>The player's bedroom — pinned props from the mod's template tables.</figcaption>
  </figure>
  <figure>
    <img src="./shots/psp-route-1.png" alt="Route 1: tall encounter grass, ledges, fences, and rows of carved trees." />
    <figcaption>Route 1 — encounter grass, ledges, and the three-ring tree gradient.</figcaption>
  </figure>
</div>

## One pipeline, three machines

<div class="pv-pipeline">
  <div class="pv-stage">
    <div class="pv-stage-title">Cook time <span>Bun · your machine</span></div>
    <div class="pv-node">
      <b>import</b>
      <small>ROM → <code>gen/</code> — SHA-1 gated, manifest-driven</small>
    </div>
    <div class="pv-arrow"><i>↓</i></div>
    <div class="pv-node">
      <b>cook</b>
      <small>classify tiles · carve trees · match 42 building templates · bake AO &amp; colour · pack chunks</small>
    </div>
    <div class="pv-arrow"><i>↓</i></div>
    <div class="pv-node pv-node-pak">
      <b>voxelmon.vxpak</b>
      <small>one cooked pak — every machine, every rung</small>
    </div>
  </div>
  <div class="pv-flow"><i>➜</i></div>
  <div class="pv-stage">
    <div class="pv-stage-title">Run time <span>on the device</span></div>
    <div class="pv-node">
      <b>QuickJS guest</b>
      <small>the gameplay port — one <code>frame(buttons)</code> per tick</small>
    </div>
    <div class="pv-arrow"><i>↓</i><em>~10–40 ops / tick</em></div>
    <div class="pv-node">
      <b>pocketvoxel-core</b>
      <small>culling · camera rungs · retained scene · chip synth</small>
    </div>
    <div class="pv-arrow"><i>↓</i><em>one ordered draw list</em></div>
    <div class="pv-machines">
      <div class="pv-machine"><b>pocketvoxel-gu</b><small>PSP · sceGu</small></div>
      <div class="pv-machine"><b>pocketvoxel-gxm</b><small>Vita · raw GXM</small></div>
      <div class="pv-machine"><b>pocketvoxel-sim</b><small>desktop raster</small></div>
    </div>
  </div>
</div>

<div class="pv-pipeline-foot">

The acceptance path: intent tapes drive the same run on every host, pinned by
[15 golden marks × 2 quality rungs](/guide/testing) — committed as frame
hashes, never pixels.

</div>

The gameplay is a TypeScript port of the [gen1recomp](https://github.com/bryanthaboi/gen1recomp)
Lua engine running in an embedded QuickJS guest; the presentation is a Rust
reimplementation of the [DramaticShape Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
diorama renderer. Both upstreams are MIT-licensed, and both serve as
**executable specifications, not vendored code** — every ported formula cites
the Lua it ports, and the reference implementations run under LuaJIT as
oracles in the test suite.

Pocket Voxel is a specialized runtime of [PocketJS](https://github.com/pocket-stack/pocketjs):
the same `⟨ core, surface, guest ⟩` composition as OpenStrike, with the
ownership split inverted. Start with the [architecture overview](/guide/architecture),
or go straight to [getting the pipeline running](/guide/getting-started).
