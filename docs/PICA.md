# PICA200 parity checklist

The Nintendo 3DS backend (`crates/pocketvoxel-pica`) is the **third**
implementation of one `DrawList`. The other two already exist and already had
to agree with each other:

- `crates/pocketvoxel-sim/src/raster.rs` — the software rasterizer. Its 480×272
  RGBA output is what the committed hashes are taken from
  (`tests/goldens/voxel/*.hashes`), so **it is the visible contract**.
- `crates/pocketvoxel-gu/src/lib.rs` — the PSP GE backend. Not the contract, but
  the worked example: it solved the same problems against fixed-function
  hardware, and every place it had to bend is a place the PICA200 will too.

This document lists every behaviour where those two had to agree, cites the line
in each that implements it, states how the GE expressed it, and gives the
PICA200 equivalent. Where there is no equivalent, it says so and names the
substitute. It closes with a verification plan whose checks are ordered so that
a failure is visible in a single captured frame wherever that is possible.

**Where the prose and the code disagree, the code is authoritative.** §5 lists
every stale statement found while writing this. None of them were edited; they
are reported so the lead can fix them in one pass.

PICA200 facts marked **(brief)** were proven end to end before the
implementation brief was written. Facts marked **(derived)** followed from those
plus the citro3d API; every one of them has since been **checked on Azahar** and
is annotated with the measurement below.

### The readback, and the one thing that was actually broken

The first bring-up rendered a scrambled diorama. The render was never wrong.
**`C3D_SyncDisplayTransfer` asked for `GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGBA8)`
out of the 240×400 tiled colour buffer, and the PPF returns rows that are each
individually correct and progressively misregistered** — output row 4k slips a
further 64 texels, so the picture shreds into vertical slivers while the same
frame presents perfectly on the screen. Measured against a known probe rectangle
read three ways from one frame:

| readback | matches the probe rectangle |
|---|---|
| PPF, `OUT_FORMAT RGBA8` | 74.6 % |
| PPF, `OUT_FORMAT RGB8`, widened on device | **100.0 %** |
| the top screen framebuffer citro3d presented to (read one swap later, so it is not a drop-in for the capture) | **100.0 %** |
| CPU `memcpy` of the colour buffer, untiled 8×8 Morton at width 240 | **exact** (24000 of 24000 texels) |

`hosts/3ds/src/main.c` therefore transfers with `GX_TRANSFER_FMT_RGB8` and widens
B,G,R back into the A,B,G,R capture word itself. RGB8 is also the format
citro3d's own presentation transfer uses, so the capture now travels the path
the screen travels, and the alpha byte the format drops was never read — the
driver's decode takes R, G and B only.

---

## 1. Frame-level contracts

### 1.1 Draw order, and who owns an equal-depth contest

**Contract.** `DrawList.items` is consumed in list order. No reordering, no
merging across kinds, no sorting by state or by depth.

| | |
|---|---|
| built | `draw.rs:338-761` (`build`), order asserted at `draw.rs:839-867` |
| sim | `raster.rs:423` — `for item in &list.items` |
| GE | `gu/lib.rs:313` — `for item in &list.items` |

The order is sky → terrain (each chunk immediately followed by its own tree
mesh) → stamps → water → shadow decals → ghost → cards → grass → flower → UI
(`draw.rs:7-12`). Order matters because it, not depth, resolves ties, and the
two backends **break ties in opposite directions**:

- the sim passes a fragment on strict `z < stored` (`raster.rs:291`), so at
  equal depth the **first** draw keeps the pixel;
- the GE uses `DepthFunc::GreaterOrEqual` (`gu/lib.rs:289`) in its inverted
  range, so at equal depth the **last** draw keeps the pixel.

**PICA200.** `C3D_Init` defaults to `GPU_GREATER` **(brief)**, which under the
negated depth map (§1.2) is the strict test and therefore **matches the sim, not
the GE**. Keep it. Do not "fix" it to `GPU_GEQUAL` for GE similarity: the
acceptance target is the sim oracle.

This is not a theoretical difference. The stratified detail-stream pack order
moved 60 pixels across fifteen golden frames purely through equal-depth
contests on grass crossings and cell borders (`docs/VOXEL.md:652-657`).

### 1.2 The depth range, and the three depth behaviours

**Contract.** Three behaviours, and only three:

| behaviour | items | test | depth write |
|---|---|---|---|
| test + write | `ChunkMesh`, `StampMesh`, `Card` | nearer wins | yes |
| test, no write | `ShadowDecal` | nearer wins | no |
| inverted test, no write | `Ghost` | draws only where **occluded** | no |

| | sim | GE |
|---|---|---|
| enum | `raster.rs:84-93` (`LessWrite` / `LessNoWrite` / `GreaterNoWrite`) | — |
| test | `raster.rs:290-296` | `gu/lib.rs:289` frame default, `gu/lib.rs:624` ghost |
| write | `raster.rs:323-325` (only `LessWrite`) | `gu/lib.rs:290` / `622` / `656` (`sceGuDepthMask`) |
| decal | `raster.rs:489` | `gu/lib.rs:613-661` with `ghost = false` |
| ghost | `raster.rs:507` | `gu/lib.rs:613-661` with `ghost = true` |

The sim keeps GL NDC z (−1 near, +1 far) and clears to `+inf`
(`raster.rs:8`, `raster.rs:33`). The GE inverts: `sceGuDepthRange(65535, 0)`,
`GreaterOrEqual`, clear 0 (`gu/lib.rs:288-289`, `gu/lib.rs:445`). Both crate
docs state plainly that **the visible result is the contract, not the depth
encoding** (`raster.rs:8-12`, `gu/lib.rs:11-15`).

**PICA200.** The PICA is closer to the GE than to the sim.

- Usable depth is negative: `C3D_DepthMap(true, -1.0f, 0.0f)` **(brief)**, which
  maps clip `z/w = -1` (near) to window depth 1 and `z/w = 0` (far) to 0. Clear
  depth **0** = far, nearer = larger, `GPU_GREATER` = nearer wins. That is the
  GE's arrangement with 24 bits instead of 16.
- **The PICA clip volume is `z ∈ [-w, 0]`, not `[-w, w]` (CONFIRMED on Azahar).**
  A captured outdoor mark shows near geometry occluding far geometry throughout —
  the fold plus `GPU_GREATER` resolves the whole diorama, and no fragment past
  the middle of the depth range is missing. The core's
  VP is a GL matrix (`math.rs:174-184`, `perspective_gl`), so **feeding it to the
  PICA unchanged discards every fragment past the middle of the depth range**.
  The fix is a fixed fold on the clip-space z row, applied to the matrix rather
  than in the shader because it is linear:

  ```text
  row2' = (row2 - row3) / 2        // z' = (z - w) / 2
  ```

  With `Mat4` column-major (`math.rs:123-128`), that is
  `m[c*4 + 2] = (m[c*4 + 2] - m[c*4 + 3]) * 0.5` for `c` in `0..4` — the same
  shape as `draw::biased_vp` (`draw.rs:154-160`). The map `z/w → (z/w − 1)/2` is
  increasing, so **every depth comparison in the list is preserved**.
- Do not use `Mtx_PerspTilt` to rebuild the camera. The VP comes from the core
  (`cam.rs:43-61`) and both existing backends transform through exactly that
  matrix (`gu/lib.rs:282`, `raster.rs:401`). The landscape rotation that
  `*Tilt` normally supplies belongs in the ortho used for the screen-space
  passes and in the viewport rectangle.
- Depth write is the `C3D_DepthTest` writemask, not a separate call:
  `GPU_WRITE_ALL` for meshes and cards, `GPU_WRITE_COLOR` for decals and the
  ghost. Inverted test = `GPU_LESS` (strict — both existing backends are strict
  here, `raster.rs:292` and `gu/lib.rs:624`).

### 1.3 Alpha test

**Contract.** A textured fragment whose **palette alpha is below 0x80 writes
neither colour nor depth**.

| | |
|---|---|
| sim | `raster.rs:188-199` (`sample` returns `None`), consumed at `raster.rs:310-311` with the comment "alpha-tested: no color, no depth" |
| GE | `gu/lib.rs:308` `sceGuAlphaFunc(Greater, 0x7f, 0xff)`, enabled per textured pass at `gu/lib.rs:504`, `682`, `755` |
| UI | same cutoff, hand-written at `raster.rs:596` |

The test is enabled **only on textured passes**. The sky, shadow decals and the
ghost run with it off (`gu/lib.rs:455`, `gu/lib.rs:628`) and the sim never
applies it to an untextured draw (`raster.rs:316`). This is load-bearing, not
tidiness: `SHADOW_ALPHA_FIELD` is 0.4 → `alpha_abgr` yields **102**
(`spec.rs:277`, `draw.rs:290-292`), which is below the 0x80 cutoff, so a field
shadow drawn with the alpha test still on **disappears entirely** while the
battle decal at 0.68 → 173 (`spec.rs:278`) survives.

**PICA200.** `C3D_AlphaTest(true, GPU_GREATER, 0x7f)`. Two consequences:

- The CLUT8 → RGBA5551 expansion (§3.1) collapses palette alpha to 1 bit, so
  the runtime test only has to reject alpha 0. The **cutoff is evaluated at
  expansion time**: an entry expands opaque iff `(abgr >> 24) & 0xff >= 0x80`.
- **Early depth test must stay off (CONFIRMED on Azahar, kept off).** With it off,
  alpha-killed sprite texels leave no occluder: the captured `encounter-seen` mark
  shows grass and the trainer sprite reading through each other's bounding boxes
  exactly as the oracle does. The PICA runs the alpha test
  before the depth test in the fragment pipeline, which is what makes "no
  colour, no depth" free — unless `C3D_EarlyDepthTest` is enabled, which moves
  the depth write ahead of the kill.

### 1.4 Double-sided drawing

**Contract.** No back-face culling, anywhere.

| | |
|---|---|
| sim | `raster.rs:282-286` — barycentrics divided by the **signed** area, then all-weights-non-negative; the comment at `raster.rs:280-281` names it double-sided |
| GE | `gu/lib.rs:292` `sceGuDisable(GuState::CullFace)`, with the measurement at `gu/lib.rs:506-512`: culling wins ~40% of the frame (66 ms → 40 ms outdoors) and **visibly eats faces**, because the cooked streams do not share one winding |

**PICA200.** `C3D_CullFace(GPU_CULL_NONE)`. **`C3D_Init` defaults to
`GPU_CULL_BACK_CCW`**, so this is an explicit call the backend must make, not a
default it inherits.

### 1.5 SkyBands owns the frame clear

**Contract.** `Item::SkyBands` carries `colors: [u32; 4]` and `horizon_row`
(`draw.rs:195-198`). It clears the frame to `colors[SKY_BANDS - 1]` and paints
four gradient bands over rows `[0, horizon_row)`, with no depth test.

| | |
|---|---|
| sim | `raster.rs:425-436`: `y0 = hr * i / 4`, `y1 = hr * (i+1) / 4`, `fill`, then `frame.color[hr * W ..].fill(colors[3])` |
| GE | `gu/lib.rs:443-487`: `sceGuClearColor(colors[3])`, `sceGuClearDepth(0)`, `sceGuClear(COLOR | DEPTH)`, then four 2D sprites |

Details that must carry across exactly:

- **The row arithmetic is integer division in the 272-row logical frame**, four
  equal slices, `hr` clamped to `[0, VIEW_H]` (`raster.rs:429`,
  `gu/lib.rs:448`). `horizon_row` itself comes from the core
  (`cam.rs:89-103`), never re-derived.
- A band with `y1 <= y0` is skipped (`gu/lib.rs:459-461`); `hr == 0` paints the
  whole frame in `colors[3]` (`gu/lib.rs:448-450`, and by construction in the
  sim's fill loop).
- **The band colours arrive pre-tinted.** `build` modulates them before pushing
  the item (`draw.rs:344-347`). A backend that tints them again darkens the sky
  twice.

**PICA200.**

- The clear is `C3D_RenderTargetClear(target, C3D_CLEAR_ALL, clearWord, 0)`.
  Depth clear **0** is the far value under §1.2. (`C3D_RenderTargetSetClear` does
  not exist in this citro3d.)
- **The clear word is `__builtin_bswap32` of the ABGR colour.** A PICA RGBA8
  target stores bytes A,B,G,R and the word reads back `R<<24 | G<<16 | B<<8 | A`
  **(brief)**; the DrawList colour is `A<<24 | B<<16 | G<<8 | R`
  (`draw.rs:251-256`). Those are byte reversals of each other.
- The PICA has **no sprite primitive**. The GE's two-vertex `GuPrimitive::Sprites`
  (`gu/lib.rs:479-485`) becomes two triangles per band. Emit them in the
  **logical 480×272 screen space** through an ortho covering exactly that
  rectangle, and let the 400×226 viewport do the letterbox scaling — recomputing
  band boundaries in device rows would land them on different rows than the
  oracle.
- Set the target clear inside `C3D_FrameBegin` and before `C3D_FrameDrawOn`.
  `build` always emits `SkyBands` as item 0 (`draw.rs:348`), so its colours are
  known before the frame opens.
- **Confirmed on Azahar.** A captured outdoor mark reads `#c0e0f0` across the two
  7 px letterbox bars, which is `colors[3] = 0xfff0e0c0` byte-reversed — the
  bswap is right, and the bars carry nothing but the clear, so the PICA does clip
  primitives to the viewport rectangle and the letterbox needs no scissor.

---

## 2. Geometry contracts

### 2.1 The pull displacement: operation order and truncation

**Contract.** For `pull != 0`, displace each vertex toward `cam.eye` along its
own ray: **scale by `1/len`, then by `pull`** — two multiplies, in that order.

| | |
|---|---|
| sim | `raster.rs:361-367` → `pos.add(eye.sub(pos).normalize().scale(pull))`, with `normalize` = `scale(1.0/len)` at `math.rs:89-97` |
| GE | `gu/lib.rs:209-221` — `d.scale(1.0 / len).scale(pull)`, with the comment at `gu/lib.rs:206-208` pinning the order "so the result stays bit-identical to the sim's" |

Folding to `d.scale(pull / len)` is one multiply fewer and a different f32
result. Do not.

Degenerate guard: `len > 1e-12` on both sides (`gu/lib.rs:216`,
`math.rs:92`), otherwise the position is unchanged.

**Truncation.** A **textured** pulled vertex truncates toward zero to integer
**before** the transform; **untextured** pulled geometry stays f32.

| | |
|---|---|
| sim | `raster.rs:350-359` (the doc comment states why), `raster.rs:363-367` (`p.x.trunc()`), applied with `i16_trunc = true` for meshes (`raster.rs:468`) and cards (`raster.rs:548`), and `false` for the ghost and decals (`raster.rs:341-343`, used at `raster.rs:478` and `raster.rs:496`) |
| GE | `gu/lib.rs:581-589` (`pos.x as i16` into `PakVert`) and `gu/lib.rs:709-717` for cards; the ghost/decal path keeps f32 (`gu/lib.rs:630-646`, `FlatVert`) |

The full order for a pulled mesh vertex is fixed:

```text
world = (pv.x + off_x, pv.y, pv.z + off_y)     // seam offset FIRST
pulled = world + normalize(eye - world) * pull  // then the pull
staged = trunc(pulled)                          // then the truncation
clip   = VP * staged                            // then the transform
```

`gu/lib.rs:571-590` and `raster.rs:453-470` both implement exactly that.

**PICA200.** The PICA has no format constraint forcing the truncation — a
textured `GPU_FLOAT` position is legal here. **Keep the truncation anyway**: it
is baked into the oracle at `raster.rs:363-367`, so dropping it moves grass and
card depth against every committed hash. This is the one item on this list that
exists for no hardware reason on the target.

### 2.2 `pull_bias` and `biased_vp`

**Contract.** Exactly one of `pull` / `pull_bias` is non-zero on a pulled mesh,
and both are 0 everywhere else (`draw.rs:180-188`). With `pull_bias != 0` the
vertices draw **in place** and the VP carries a constant NDC-z bias.

| | |
|---|---|
| formulation | `draw::biased_vp`, `draw.rs:154-160` — `z_clip += bias * w_clip`, one function both backends call |
| sim | `raster.rs:445-449` |
| GE | `gu/lib.rs:539-545` (swap the Projection slot around the draw) and `gu/lib.rs:559-561` (restore it) |

Two producers: the grass/flower bias at `draw.rs:427-436` (the `psp` rung has
`pull_depth_bias: true`, `spec.rs:137`), and the ground bake's **negative**
one-world-pixel recession at `draw.rs:463` (`bake_bias = -depth_bias(&cam, 1.0)`),
whose reason is recorded at `draw.rs:454-463`: against the bake's 16 px spans the
two rasterizers stopped agreeing on razor-thin depth contests, AE 16k.

**PICA200.** Call `draw::biased_vp` on the core VP, **then** apply the §1.2
z-row fold to the result. Order matters only for clarity — both are linear row
operations on the same matrix — but doing the bias in GL space keeps one
formulation shared with the other two backends and keeps `bias` in the units the
spec talks about.

Note the shipped default rung is `psp` (`spec.rs:86`, `QUALITY_TIER_DEFAULT = 0`)
and the brief pins the 3DS to it, so **`pull_bias` is the hot path and geometric
`pull` on meshes is not** — cards keep the geometric pull at every rung
(`draw.rs:424-426`).

### 2.3 Vertex format, attribute conversion, and the model matrix

**Contract.** The cooked world vertex is `PakVert`: **16 bytes, `repr(C)`, NOT
packed, 4-byte aligned** (`pak.rs:148-158`, const-asserted at `pak.rs:173-174`
and re-asserted in the GE backend at `gu/lib.rs:84-86`).

```text
offset 0  u16 u        page-normalized fixed point, round(uv * 32768)
offset 2  u16 v
offset 4  u32 abgr     baked face shade + AO
offset 8  i16 x, y, z  world px
offset 14 i16 pad
```

`PakVert::uf()` / `vf()` (`pak.rs:160-171`) are the one conversion both backends
share; the sim calls them at `raster.rs:466`.

**The GE's implicit ÷32768 has no PICA equivalent.** On the GE, `TEXTURE_16BIT`
UVs and `VERTEX_16BIT` positions are both divided by 32768 in `TRANSFORM_3D`, so
the backend counters the position normalization with a **×32768 model scale**
(`gu/lib.rs:168-176`, `world_model`) and lets the UV normalization stand. The
PICA converts s16 attributes as **raw integers (brief)**. That inverts both
halves:

- **Positions need no scale at all.** The pak's i16 values are already world px,
  so the model matrix is the seam translation alone: `off_x` into column 3 row 0
  and `off_y` into column 3 row 2 (`gu/lib.rs:173-175`). The ×32768 rows go away.
- **UVs need an explicit multiply.** Fold it into the same uniform as the POT
  envelope rescale (§3.2): `uv_scale = (w / (pw * 32768), h / (ph * 32768))`.
- **Vertex colour needs an explicit ÷255 (CONFIRMED on Azahar).** As a
  4×`GPU_UNSIGNED_BYTE` attribute the bytes arrive as 0..255 floats — the GPU does
  not normalize them. Measured: with the shader's `÷255` in place a captured mark
  agrees with the CPU model on 55.8 % of pixels exactly and on the rest within the
  TEV's own ±1 rounding; a model that drops the divide (every modulate saturated)
  agrees on 0.8 %. Convenient: `abgr`'s little-endian
  bytes are already **R, G, B, A** in that order, which is exactly what
  `abgr_to_rgba_f` extracts (`raster.rs:330-337`).

Attribute layout for a `BufInfo_Add` over the pak vertex, stride 16:

| attr | type | count | offset |
|---|---|---|---|
| 0 uv | `GPU_SHORT` | 2 | 0 |
| 1 rgba | `GPU_UNSIGNED_BYTE` | 4 | 4 |
| 2 xyz | `GPU_SHORT` | 3 | 8 |

`u` and `v` are declared **unsigned** in the pak but must be fed as `GPU_SHORT`.
That is safe only because the cook insets UVs (the 0.02-texel inset noted at
`docs/VOXEL.md:648-650`) and never emits 32768; the GE relies on the same thing,
and the card path clamps explicitly at `gu/lib.rs:706` (`.min(32767)`).

### 2.4 Index addressing

**Contract.** Indices are `u16` **relative to `vert_base`** (`pak.rs:250-257`,
`pak.rs:82-84`), and the pak reader has already validated **every index against
that mesh's `vert_count`** (`pak.rs:561-566`), so a backend needs no clamping.

| | |
|---|---|
| sim | `raster.rs:454` — `pak.indices[idx0 + t*3 + k] as usize + base` |
| GE | `gu/lib.rs:550` — the vertex pointer is offset by `vert_base` and the raw indices are passed through |

**PICA200.** Same trick as the GE: `BufInfo_Add` with the vertex pointer already
offset by `vert_base * 16`, then `C3D_DrawElements` over the raw index range.
Two constraints replace the GE's:

- `BufInfo_Add` rejects any pointer below physical `0x18000000` **(brief)**, so
  neither pool can live in heap memory (§4.3).
- **Indices must sit in the same linear block as the vertices, ABOVE them
  (CONFIRMED on Azahar)** — `C3D_DrawElements` writes the index offset as
  `phys(indices) - BufInfo.base_paddr`, and `base_paddr` is the first buffer
  added, i.e. this draw's own vertex block. The staging arena allocates the two
  in that order and every mark draws with the right topology; a wrong index base
  would show as slivers spanning whole chunk meshes.

`detailDensity` shrinks `index_count` **and** `vert_count` on grass and flower
meshes (`draw.rs:536-544`) because the cook packs those streams so that a prefix
of the indices references only a prefix of the vertices. A backend that stages
vertices must copy `vert_count`, not the whole mesh (`gu/lib.rs:569-570`).

---

## 3. Texture and colour contracts

### 3.1 Palette resolution and the tint

**Contract.** Every textured draw resolves its CLUT through **one** function,
`draw::resolve_pal` (`draw.rs:59-76`), and makes no palette decision of its own.
The precedence is: the item's own VCOL palette → the page's `page_pal` →
the `palette` op's SGB selection (`VPAL[SGB_PAL_BASE + i]`, non-UI kinds only)
→ the page kind's own ramp.

| | |
|---|---|
| sim | `raster.rs:409-411` (`pal_index`), used at `raster.rs:419` (meshes) and `raster.rs:528` (cards) |
| GE | `gu/lib.rs:410` inside `bind`, with the "makes no palette policy decision at all" note at `gu/lib.rs:363-366` |
| meshes pass | `mesh.pal` — the owning map's world CLUT (`draw.rs:171-175`) |
| cards pass | `COLOR_PAL_NONE` — a card's CLUT is a property of the **page** (`gu/lib.rs:684-686`, `raster.rs:525-528`) |
| UI passes | `COLOR_PAL_NONE` with kind `UI`, which short-circuits to the kind ramp (`draw.rs:63-74`) |

**The day tint is a palette modulation.** `draw::modulate_rgb`
(`draw.rs:251-256`) with integer rounding `(c*t + 127) / 255`, applied to every
CLUT entry, alpha untouched.

| | |
|---|---|
| sim | `raster.rs:390-400` — the whole palette table is tinted once per frame |
| GE | `gu/lib.rs:377-382` — `clut_for(.., tinted)` writes a tinted CLUT into the frame pool |

**The GB UI layer is exempt.** The sim samples `pak.palettes[cp.kind]` raw
(`raster.rs:567`, comment "UI: untinted"); the GE binds with `tinted = false`
(`gu/lib.rs:757`). The `Renderer` therefore keeps **two** CLUT caches
(`gu/lib.rs:236-237`).

**PICA200. There is no paletted texture format at all (brief).** The CLUT
must be resolved into the texels at load, which turns a per-frame 1 KB CLUT
rewrite into a per-page expansion:

- Expand to **RGBA5551**, which keeps the 1-bit cutout alpha at 16 bpp
  **(brief)** and makes the alpha test (§1.3) a load-time decision.
- The expansion key is **`(page, frame, resolved VPAL index, tinted, tint value)`**.
  The GE's bind key is `(page, frame, tinted, resolved index)` (`gu/lib.rs:229`,
  `gu/lib.rs:411`); the tint value joins it here because a tint change
  invalidates every tinted expansion instead of costing one CLUT rewrite.
- `Scene::tint` defaults to `0xffffffff` (`scene.rs:176`) and **no shipped guest
  path emits `op::TINT`** — the only writer is `scene.rs:324`, and
  `voxelmon/game/host.ts:129` has no caller in the v1 game. So in practice the
  expansion set is built once. Handle the change correctly anyway, and measure
  it: a guest that ramps the tint would re-expand every live page every frame.
- Budget the expansion honestly. The live **CLUT** count is small (~3 world, 4
  OBJ, 10 pic), but the live **page** count is not: the `psp` rung has
  `ground_bake_dist` at `QUALITY_OFF` (`spec.rs:135`), which through
  `draw.rs:451` means **every eligible chunk draws its own bake page**. At
  128×128 CLUT8 per bakeable chunk (`docs/VOXEL.md:349-351`) over 122 chunks,
  the expanded set is ~3.9 MB of RGBA5551 against a 32 MiB linear heap.

### 3.2 Atlas frames, the POT envelope, and the UV scale

**Contract.**

- The atlas frame is `mesh.frame`, computed by the core
  (`draw.rs:437`, `TILE_ANIM_DIV = 30` at `draw.rs:31`). **Never re-derive it.**
  Both backends wrap past `frames`: `pak.rs:234-238` (`AtlasPage::frame`) and
  `raster.rs:414` (`% page.frames.len()`).
- **Cards always bind frame 0** — the walk frame is a V offset inside one image,
  not an animation frame (`gu/lib.rs:686`, `raster.rs:522`, with the row
  arithmetic in `draw.rs:670-679`).

| | |
|---|---|
| sim | linearizes every page once at load (`raster.rs:66-81`, `AtlasCache::new` → `pak::unswizzle`) |
| GE | samples the pak's **PSP-swizzled** bytes in place (`gu/lib.rs:419-428`) |

Pages are **not power-of-two** (terrain 128×184, ground bake 128×256, pics
40×40). The GE declares a po2 envelope and bridges the pak's actual-size
normalized UVs with `sceGuTexScale(w/pw, h/ph)` (`gu/lib.rs:180-187` for `po2`,
`gu/lib.rs:433`), clamping the wrap mode so a precision spill cannot reach the
padding (`gu/lib.rs:297-299`).

**PICA200.**

- Textures must be **power-of-two, each dimension in [8, 1024], in PICA tiled
  layout (8×8 tiles row-major, Morton order within a tile), and the source
  flipped vertically first (brief)**. So the pak's 16×8 PSP swizzle
  (`pak.rs:177-218`) has to be undone and re-tiled. `pak::unswizzle` is already
  the linearizing half and the sim uses it (`raster.rs:73-74`); write the
  PICA-tiling half against it, not against the swizzled bytes directly.
- There is **no `sceGuTexScale` equivalent**. The rescale becomes a vertex-shader
  uniform, folded together with the ÷32768 from §2.3.
- `GPU_NEAREST` in both directions (pixel art, no mips —
  `gu/lib.rs:295-296`) and `GPU_CLAMP_TO_EDGE` in both axes
  (`gu/lib.rs:297-299`). The sim's sampler wraps with `rem_euclid`
  (`raster.rs:191-192`), but no cooked UV leaves `[0, actual/po2]`, so clamp and
  repeat agree on every real draw.

### 3.3 Cards

**Contract** (`draw.rs:216-222`): verts are **bl, br, tr, tl** in world space,
`uv` is `[u0, v0, u1, v1]` with **v0 the texture top**, and `mirror` swaps
**u0/u1** (not v).

| | |
|---|---|
| sim | `raster.rs:530-537` — `(u0,u1) = mirror ? (uv[2],uv[0]) : (uv[0],uv[2])`, `(v0,v1) = (uv[1],uv[3])`, `uvs = [(u0,v1),(u1,v1),(u1,v0),(u0,v0)]` |
| GE | `gu/lib.rs:688-691` — the identical four lines |

**U normalizes by the PAGE width, not the cell width** (`draw.rs:670-679`):
`u1 = CELL_PX / max(page.w, CELL_PX)`, because pages are padded wider than their
content. The reason is a GE hardware quirk (§4.5) but the arithmetic is core-side
and every backend inherits it. Battle pic cards instead take the whole page,
`uv = [0,0,1,1]`, sized `page.w × page.h` in world px (`draw.rs:719-726`).

Both backends draw the quad as `(0,1,2)(0,2,3)` (`gu/lib.rs:719`,
`raster.rs:380-383`). The GE additionally re-quantizes card UVs to the pak's u16
fixed point (`gu/lib.rs:706`); the PICA can carry f32 UVs, which is **closer to
the oracle** — the quantization is a ≤1/32768-of-a-page shift. Whichever is
chosen, record it: the same quantization moved 590 pixels across fifteen frames
when the vertex format changed (`docs/VOXEL.md:645-651`).

### 3.4 `UiQuad`

**Contract** (`draw.rs:224-231`): screen space, no depth test, nearest sampling,
**untinted** palette, composited last.

| | |
|---|---|
| geometry | `ui.rs:34-43` — `x = UI_ORIGIN_X + cx * UI_TILE_PX`, `y = cy * UI_TILE_PX`, `w = h = UI_TILE_PX` |
| scale | `ui.rs:26` — `UI_SCALE = VIEW_H / GB_H = 272/144 ≈ 1.8889`, **non-integer by design** (`ui.rs:3-8`) |
| tile addressing | `cols = max(page.w / TILE_PX, 1)`; `tx0 = (tile % cols) * 8`; `ty0 = (tile / cols) * 8` — sim `raster.rs:568-570`, GE `gu/lib.rs:759`, `gu/lib.rs:766-767` |
| sampling | sim `raster.rs:575-599` per pixel; GE raw-texel UVs on a 2D sprite, `gu/lib.rs:772-789` |
| palette | sim `raster.rs:567` raw kind ramp; GE `gu/lib.rs:757` `tinted = false` |
| output | sim forces the pixel opaque and does not blend (`raster.rs:599`); GE modulates by white, which is identity under `(t*255 + 127)/255` |

`cols` divides the **actual** page width; the UV divides by the **POT-padded**
width. Those are different numbers, and using one where the other belongs
shifts every glyph index in the layer.

The GE rounds each sprite corner to the nearest device pixel
(`gu/lib.rs:813-816`, `round_i16`) while the sim resolves the same edge
per-pixel; the recorded envelope is **≤ 1 px of seam** (`gu/lib.rs:768-771`).

**PICA200.** Two triangles per tile, positions as f32 in the logical 480×272
space through the same ortho as the sky (§1.5) — **no rounding needed**, which
lands closer to the oracle than the GE does. Depth test off, alpha test on,
blending off, texture-only TEV. The UI page needs its **own raw (untinted)
expansion** even when the same page is also used tinted elsewhere.

The GE batches the whole layer into one upload and one draw because per-tile
uploads cost 145 ms against 17 ms on a dialogue frame (`gu/lib.rs:336-343`,
`gu/lib.rs:737-739`). The `UiQuad`s are contiguous at the tail of the list, so
the same batching applies. Measure before assuming it is needed on this part.

---

## 4. What cannot carry over

### 4.1 The GE's implicit ÷32768

Covered in §2.3. **This difference reaches every attribute of every vertex in
the pak**: the GE divides s16 attributes by 32768 in `TRANSFORM_3D`, the PICA
converts them as raw integers **(brief)**. Positions lose their ×32768 counter-scale; UVs gain
an explicit ÷32768; colours gain an explicit ÷255.

### 4.2 The texture-cache flush discipline

`sceGuTexImage` does **not** invalidate the GE texture cache, so the GE backend
calls `sceGuTexFlush()` on **every** bind (`gu/lib.rs:429-432`) — emulators hide
the stale-cache bug, hardware does not.

There is no PICA analogue of that bug: texture unit state is part of the command
list. What **does** carry over is the other half of the GE discipline, the CPU
cache writeback: every CPU write the GE reads is
`sceKernelDcacheWritebackRange`d before the referencing command is queued
(`pool.rs:69-76`, `gu/lib.rs:382`, `gu/lib.rs:591-594`, `gu/lib.rs:792-795`).
The PICA equivalent is `GSPGPU_FlushDataCache` over any CPU-written linear
buffer (and `C3D_TexFlush` for texture data) before the frame's draws.

### 4.3 Paletted textures, and the zero-copy pak

The GE draws the 32 MB pak **in place**: texels are pak-borrowed
(`gu/lib.rs:420-428`), and index ranges are drawn from the pak whenever the cook
16-byte-aligned them (`gu/lib.rs:529-534`). That choice was measured, not
guessed: the per-frame splice buys the GE ~17 ms a Pallet frame but costs the
CPU ~25 ms, and a boot-time copy reproduced neither effect
(`gu/lib.rs:519-528`, `docs/VOXEL.md:558-575`).

None of it survives. `BufInfo_Add` rejects any pointer below physical
`0x18000000` **(brief)**, and the pak is heap memory, so **every vertex and
index byte the PICA draws must be copied into `linearAlloc`**. The `FramePool`
shape (`pool.rs`) is the model — bump arena, blocks retained across frames,
`reset()` only after the GPU has consumed the frame (`pool.rs:39-43`) — with
two adjustments: the 1 MB block assert (`pool.rs:19`, `pool.rs:49`) is sized for
the GE's transient-only traffic and is far too small here, and the "after
`sceGuSync`" rule becomes "after `C3D_FrameSync`".

**Note for the lead, not a requirement:** the vertex and index pools are static
for the run. A one-time copy of both into linear memory at load would restore
in-place drawing and leave the per-frame arena carrying only pulled meshes,
cards, sky, UI, decals and the ghost. Whether that fits alongside the ~3.9 MB of
expanded bake pages (§3.1) inside the Old 3DS's 32 MiB linear heap is a
measurement, not an assumption.

### 4.4 The `VERTEX_32BITF` restage

A textured `VERTEX_32BITF` draw samples garbage on the real GE, so every card
and every pull-displaced mesh re-stages through the pak's own i16 format
(`gu/lib.rs:562-566`, `gu/lib.rs:692-696`, `docs/VOXEL.md:549-556`).

The PICA has no such restriction — `GPU_FLOAT` textured attributes are fine. The
restage is therefore **not needed as a format workaround**, but the **truncation
it caused is now part of the oracle** (`raster.rs:350-359`) and must be kept
(§2.1). Do the truncation; skip the i16 round-trip if f32 staging is simpler.

### 4.5 The CLUT8 ≥ 64 px width rule

A 16-px-wide CLUT8 page missamples into vertical-strip noise on the real GE, so
the cooker pads sprite and emote pages and the card U normalizes by page width
(`docs/VOXEL.md:553-556`, `gu/lib.rs:692-696`).

The PICA's equivalent constraints are different — **power-of-two, each dimension
in [8, 1024] (brief)** — and are satisfied by the same padded pages. Keep
honouring the card U convention regardless: it lives in the core
(`draw.rs:670-679`) and is not negotiable per backend.

### 4.6 The sprite primitive

The GE draws sky bands and UI tiles as two-vertex `GuPrimitive::Sprites`
(`gu/lib.rs:479-485`, `gu/lib.rs:796-802`). The PICA has triangles only; expand
each to two triangles with the same corner UVs.

---

## 5. Where the prose contradicts the code

The code is authoritative in every case below. **None of these were edited.**

| stale statement | where | what the code says |
|---|---|---|
| "20-byte world vertex" | `docs/VOXEL.md:417`, `:543`, `:553`; `gu/lib.rs:82`, `:489` | 16 bytes: `VERTEX_STRIDE = 16` (`spec.rs:446`), const-asserted at `pak.rs:173` and `gu/lib.rs:84-85`. `docs/VOXEL.md:648` itself says "the v8 16-byte vertex" |
| "20 B/vertex" in the budget | `docs/VOXEL.md:781` | same |
| "24 B each" for pull-staged verts | `pool.rs:7-8` | 16 B; the 580 KB figure is ~384 KB |
| "f32 u \| f32 v \| u32 abgr \| i16 x,y,z \| i16 pad" | `spec.rs:445` (generated from `contracts/spec/voxel-spec.ts`) | u16 u, u16 v (`pak.rs:150-158`); the described layout would be 24 bytes, not the 16 the next line declares |
| mesh-kind list of **8** names, `terrainKeep` missing | `pak.rs:80-81`, `pak.rs:271-272` | `MESH_KINDS = 9` (`spec.rs:463`), full list at `spec.rs:451-461`; `draw.rs:983-985` has the correct nine |
| draw order omits stamps | `docs/VOXEL.md:122-126` | stamps draw in the terrain pass (`draw.rs:593-621`, rank 2 at `draw.rs:795`); `draw.rs:7-12` lists them |
| "The ground bake (planned, the 60 fps rung)", "psp ≈ 64–96, measured before shipping" | `docs/VOXEL.md:334-353` | shipped, and the dial is `QUALITY_OFF` = bake **everywhere** eligible (`spec.rs:135`, inverted at `draw.rs:451`). The §4a table at `docs/VOXEL.md:204` is already correct |
| "the future sceGu backend", "the GE backend will" | `draw.rs:3`, `raster.rs:1-2` | `crates/pocketvoxel-gu` shipped |

One inversion worth stating plainly because it reads like a bug: **`ground_bake_dist`
is the only dial whose test is negated.** `baked()` requires
`!within_dist(.., dials.ground_bake_dist)` (`draw.rs:451`), so a chunk bakes when
it is **outside** the dial, and `QUALITY_OFF` means every eligible chunk bakes.

---

## 6. Verification plan

Ordered so that the earliest failures are the ones a single captured frame shows
without a diff. Each check names what is observed when the backend gets that item
wrong. Frames come from the acceptance capture, not from an interactive run.

**Structural — one frame, no oracle needed**

1. **Texture retiling** (§3.2). A page re-tiled without the PICA 8×8 Morton
   order, or without the vertical flip, draws as a coherent 8×8 mosaic of
   shuffled blocks, and the ground reads as noise at tile granularity rather
   than as terrain.
2. **Depth-range fold** (§1.2). Without the `(z − w)/2` row fold, everything past
   the middle of the depth range is clipped away: the frame shows only the
   nearest geometry against the sky-band backdrop, with a hard depth-plane cut
   across the terrain.
3. **Back-face culling left at the `C3D_Init` default** (§1.4). `GPU_CULL_BACK_CCW`
   removes roughly half of every column top, gable, water slab and grass quad;
   the world reads as see-through with holes that move with the camera.
4. **Vertex colour not scaled by 1/255** (§2.3). Raw 0..255 attribute values
   saturate the modulate: the whole diorama draws at full texel colour with no
   AO or face shading, which reads as flat and bright.
5. **UV scale wrong** (§2.3, §3.2). A missing ÷32768 collapses every mesh to one
   texel (uniform colour per page); a missing POT rescale samples the padding, so
   the right and bottom of every page bleed into the geometry.
6. **Sky clear word not byte-reversed** (§1.5). Passing the ABGR word straight
   through lands R←a, G←b, B←g, A←r, so the horizon band `0xfff0e0c0` (light
   blue, r=0xc0 g=0xe0 b=0xf0) clears as (255, 240, 224) — a warm cream
   backdrop below the horizon with the band gradient above it unchanged.
7. **Alpha test left enabled on the untextured passes** (§1.3). Field shadow
   decals vanish (alpha 102 < 0x80) while battle decals stay (alpha 173): a
   frame with entities on it shows cards standing on nothing.
8. **Blending left disabled on the decal and ghost passes** (§1.3, §7 below).
   Shadow RGB is 0, so an unblended decal paints a **solid black quad** under
   every entity.
9. **Alpha test disabled, or its reference wrong, on the textured passes** (§1.3).
   Sprite cutouts fill in: every NPC and the player draw as an opaque rectangle
   of their sheet's background.
10. **Early depth test enabled** (§1.3). Alpha-killed texels still write depth, so
    each sprite leaves an invisible rectangular occluder — grass and terrain
    behind a card get holes in the shape of the card's bounding box.
11. **Viewport not set after `C3D_FrameDrawOn`** (brief §1). `C3D_FrameDrawOn`
    resets it, so the frame renders full-screen at 400×240: the letterbox bars
    are absent and the aspect is stretched by 240/226.

**Walked on Azahar, 2026-08-08, story tape seed 17, all 11 marks**

The bring-up failure was none of these: the render was correct from the first
run and the readback was destroying it (see the preamble). Checks 1–11 were
walked against the corrected capture.

| # | check | result |
|---|---|---|
| 1 | texture retiling | **pass** — terrain, roofs, sprite sheets and the GB UI all read as themselves; no 8×8 mosaic anywhere |
| 2 | depth-range fold | **pass** — near occludes far across the whole diorama, no depth-plane cut |
| 3 | cull mode | **pass** — `GPU_CULL_NONE` is set every frame; no missing column tops, gables, water or grass |
| 4 | vertex colour ÷255 | **pass** — face shading and AO are present; the saturated model matches the capture on 0.8 % of pixels, the correct one on 55.8 % exactly |
| 5 | UV scale | **pass** — no single-texel meshes, no padding bleed on the non-POT terrain (128×184) or pic (40×40) pages |
| 6 | clear-word byte reversal | **pass** — the letterbox bars read `#c0e0f0`, the byte reversal of `colors[3] = 0xfff0e0c0` |
| 7 | alpha test on untextured passes | **pass** — field shadows are present under the player and NPCs |
| 8 | blend off on decal/ghost | **pass** — no solid black quad under any entity |
| 9 | alpha test on textured passes | **pass** — sprite cutouts are cut; no opaque sheet backgrounds |
| 10 | early depth test | **pass** — kept off; no rectangular occluders behind cards |
| 11 | viewport after `C3D_FrameDrawOn` | **pass** — 7 px bars top and bottom carry the clear alone, so the letterbox is applied and the PICA clips primitives to the viewport rectangle |

**Contract — one frame, compared against the rescaled oracle**

12. **Card UV convention** (§3.3). A swapped v0/v1 draws every sprite upside
    down; `mirror` applied to v instead of u flips the walk sheet vertically
    instead of horizontally; the bl/br/tr/tl order rotated by one draws sprites
    on their side.
13. **`sheet_uv` re-derived instead of consumed** (§3.2, §3.3). Cards binding an
    animation frame instead of frame 0, or normalizing U by cell width instead of
    page width, draw the wrong walk frame or a horizontally squashed sprite with
    a slice of the neighbouring column.
14. **Palette resolution not routed through `resolve_pal`** (§3.1). Maps that
    share the terrain page and differ only in their world CLUT come out with each
    other's roof colours; a sprite sheet that should take its OBJ CLUT draws
    grayscale.
15. **Tint applied anywhere but the palette** (§3.1). Applied as a vertex colour
    or a post-pass it double-modulates against the baked AO and reaches the GB UI
    layer, which must stay raw — visible as a tinted textbox.
16. **Bind key missing `frame`** (§3.2). Animated water and flower pages freeze
    on one frame, or flicker between pages when two draws in a frame want
    different frames of the same page.
17. **Depth write not masked off for `ShadowDecal`** (§1.2). The decal writes
    depth under the entity, and the card drawn afterwards loses its lower rows to
    the decal it is standing on — feet cut off at the decal's plane.
18. **Ghost test not inverted, or writing depth** (§1.2). Not inverted: the
    silhouette paints over the player's own card as a dark quad. Writing depth:
    the ghost occludes the grass drawn after it.
19. **Equal-depth test using `GPU_GEQUAL`** (§1.1). Coplanar contests flip to
    last-draw-wins: a few dozen to a few hundred pixels on grass crossings and
    chunk-border lines, exactly the population the stratified-pack rebase moved
    (`docs/VOXEL.md:652-657`). Needs a pixel diff, not an eye.
20. **Pull operation order folded to one multiply** (§2.1). Sub-pixel depth drift
    on grass and cards; shows as intermittent grass-over-feet failures rather
    than a constant offset, so check it against the story marks and not one
    frame.
21. **Truncation dropped on textured pulled vertices** (§2.1). Grass and card
    depth move by up to a world pixel against every committed hash; the
    grass-over-feet contract at the player's own cell is the sensitive case.
22. **`pull_bias` not folded through `biased_vp`** (§2.2). On the `psp` rung the
    grass and flower meshes are bias-only, so an omitted bias sinks the whole
    detail layer into the ground plane and a doubled one floats it.
23. **Bake recession lost** (§2.2). `bake_bias` is negative; without it the baked
    ground quad wins razor-thin contests against biased grass and tree feet, and
    the previously measured failure mode is per-pixel flicker across a grass
    field at AE 16k (`draw.rs:454-463`).
24. **Sky band rows computed in device rows** (§1.5). Band boundaries land on
    different rows than the oracle. Only visible with the horizon in frame — the
    orbit rungs keep it out until rung 4 (`cam.rs:267-280`), so pick a mark whose
    pitch reaches it.
25. **UI tile addressing** (§3.4). `cols` taken from the padded width instead of
    the actual width shifts every glyph index: text renders as a different, stable
    set of glyphs — legible garbage, which is the tell.
26. **UI tinted, or depth-tested** (§3.1, §3.4). A tinted textbox, or a textbox
    the diorama draws through.

**Memory and lifecycle — visible as instability across frames**

27. **Vertex or index data outside linear memory** (§4.3). `BufInfo_Add` refuses
    the pointer; the affected mesh silently does not draw. Whole chunks missing
    with everything else correct is the signature.
28. **Indices in a different block from the vertices** (§4.3). Triangles fan to
    the origin — long thin wedges from the world toward (0,0,0).
29. **Data cache not flushed before the draws** (§4.2). Intermittent: a mesh
    draws with a previous frame's contents, most visible on the pulled/staged
    geometry, and clears up if a debugger stalls the CPU between write and draw.
30. **Arena rewound before the GPU consumed the frame** (§4.3, `pool.rs:39-43`).
    Torn geometry on alternate frames — the same tell the GE crate documents.
31. **Expansion cache not keyed on the tint** (§3.1). Only observable if a guest
    emits `op::TINT`; v1 does not, so this is a code review item rather than a
    frame check.

**Acceptance**

32. **Resolution honesty.** The 3DS renders 480×272 logical into a 400×226
    viewport, so the oracle frame must be rescaled to the same geometry before
    comparison and the AE tolerance restated. The PSP driver's number —
    `AE_TOLERANCE = 12000` of 130560 pixels at `-fuzz 2%`, from a measured worst
    mark of 4867 (`tests/e2e/voxel-ppsspp.ts:51-60`) — **does not transfer**: a
    0.833× resample of nearest-neighbour pixel art generates its own error before
    any backend difference is counted. Measure the whole set of marks, state the
    worst, and state the headroom.

    **Measured, 2026-08-08** (Azahar, story seed 17, all 11 marks; the PICA's
    400×226 letterbox against the sim's 480×272 shot point-resized to 400×226,
    `magick compare -metric AE -fuzz 2%`, of 90400 frame pixels):

    | mark | AE | | mark | AE |
    |---|---|---|---|---|
    | bedroom | 2504 | | route-1 | 16036 |
    | downstairs | 2744 | | mid-route | 15346 |
    | pallet-town | 9500 | | encounter-seen | 15991 |
    | sign-read | 9698 | | viridian | **16230** |
    | oaks-lab | 3846 | | done | 14331 |
    | lab-exit | 10522 | | | |

    **The resample dominates the number.** Point-resizing the same oracle shot
    with its sampling grid shifted by one source pixel moves more pixels than the
    backend disagreement does, at every mark measured: bedroom 5930 vs 2504,
    pallet-town 16992 vs 9500, route-1 25270 vs 16036, viridian 24932 vs 16230.
    The PICA agrees with the rasterizer more closely than two point resamples of
    the oracle agree with each other, so the honest tolerance is set by the
    comparison's own resolution and not by the backend. **AE_TOLERANCE 24000 of
    90400 (26.5 %)** sits above the worst measured mark (16230, 48 % headroom)
    and below the resample floor, which keeps a real regression — a lost pass, a
    stale bind, a depth-state leak, each tens of thousands of pixels — well
    outside it.

    The tighter comparison is still available and still worth taking: capturing
    from an off-screen **480×272** render target and letterboxing only for
    display removes the resample from the comparison entirely and would let the
    PSP driver's own 9.2 % envelope carry over. The cost is a second pass to
    present and ~1 MB more of the 6 MiB VRAM budget; the letterbox decision is
    about what the top screen shows, which that does not change.

33. **Marks and tape.** Same tape, same story and battle marks as
    `tests/e2e/voxel-ppsspp.ts`. The rung is `psp` (tier 0, the default —
    `spec.rs:86`), so the comparison targets `story.hashes` / `battle.hashes`,
    **not** the `-max` identity anchors, which are never re-recorded
    (`docs/VOXEL.md:641-645`).

**A run that stops**

34. **The run wedges.** Not one of the failures above: nothing is drawn wrong,
    the console simply stops. The top screen holds its last frame, HOME stops
    responding because `aptMainLoop` is never reached again, and no error file
    appears — the run is blocked, not failing, so `fail()` never happens.

    Two files name it. `sdmc:/pocketvoxel-3ds/hb.txt` carries the last tick, the
    stage and the frame's counters, rewritten on every stage change past the
    first frame. If a deadline expires, the error file carries the same facts
    plus which wait it was: `frame-sync` is the vblank counters (this process
    has stopped receiving GSP events), `frame-begin` is the command queue (the
    GPU never finished the previous frame). A halted console can be read
    directly instead: `p voxel_host_stage`, `p voxel_host_tick`.

    An hb.txt that never appears at all is its own finding — the card is
    unwritable, since the file is created before the first frame runs.

---

## 7. State the backend must set, per pass

Consolidated from `gu/lib.rs:270-356` (frame base state) and the per-item
methods. `C3D_Init` defaults that must be overridden are marked.

Culling is `GPU_CULL_NONE` for every pass, set once at frame start — it
overrides the `C3D_Init` default of `GPU_CULL_BACK_CCW` (§1.4).

| pass | depth test | depth write | alpha test | blend | texture |
|---|---|---|---|---|---|
| `SkyBands` | off | — | off | off | none |
| `ChunkMesh` / `StampMesh` | `GPU_GREATER` | on | `GPU_GREATER, 0x7f` | off | page, nearest, clamp |
| `ShadowDecal` | `GPU_GREATER` | **off** | off | src-α / 1−src-α | none |
| `Ghost` | **`GPU_LESS`** | **off** | off | src-α / 1−src-α | none |
| `Card` | `GPU_GREATER` | on | `GPU_GREATER, 0x7f` | off | page, nearest, clamp |
| `UiQuad` | off | — | `GPU_GREATER, 0x7f` | off | UI page **untinted** |

TEV: textured passes modulate `GPU_TEXTURE0` by `GPU_PRIMARY_COLOR` on both
colour and alpha (the GE's `TextureEffect::Modulate` / `Rgba`, `gu/lib.rs:294`);
untextured passes replace from `GPU_PRIMARY_COLOR`. The blend equation is
`GPU_BLEND_ADD` with `GPU_SRC_ALPHA` / `GPU_ONE_MINUS_SRC_ALPHA`
(`gu/lib.rs:300-306`), matching the sim's
`(s*a + d*(255−a) + 127) / 255` (`raster.rs:212-218`).

**Disabling the blender is not `C3D_AlphaBlend` with identity factors
(derived)** — the PICA has a blender or a logic op, not both, so the off state is
`C3D_ColorLogicOp(GPU_LOGICOP_COPY)`. Verify on the emulator; getting it wrong
shows up as check 8.

Two divergences are expected and bounded, and belong in the acceptance
tolerance rather than in a fix:

- **Modulate rounding.** The sim computes `(t*v + 127) / 255` in integers
  (`raster.rs:203-210`) and the PICA rounds in its own 8-bit pipeline; expect
  ±1 per channel on shaded texels.
- **UI seams.** The non-integer `UI_SCALE` of 272/144 (`ui.rs:26`) resolves tile
  edges per-vertex on a GPU and per-pixel in the sim; the GE's recorded envelope
  is ≤ 1 px (`gu/lib.rs:768-771`), and the PICA's should be no worse since it
  needs no corner rounding (§3.4).

---

## 8. Frame lifecycle

The backend **records only**. The host owns the frame:

```text
C3D_FrameBegin
  C3D_FrameDrawOn(target)
  C3D_SetViewport(...)            // AFTER FrameDrawOn (brief)
  renderer.render(&draw::build(&scene, &pak), &pak)
C3D_FrameEnd
C3D_FrameSync
renderer.reset_arena()            // ONLY after the sync
```

That is the GE composition (`gu/lib.rs:17-26`, and the shipped loop at
`crates/pocketvoxel-psp/src/main.rs:437-445`) with `sceGuStart`/`Finish`/`Sync`
/`SwapBuffers` replaced. The rewind rule is unchanged and is the reason it is
written out: the GPU reads the arena asynchronously (`pool.rs:39-43`).

`C3D_FrameBegin` above is **two waits, and neither ends on its own**:
`C3D_FrameSync` waits for both screens' vblank counters, which needs the process
to still be receiving GSP events, and the queue wait waits for the GPU to finish
the previous frame, which is what the rewind rule depends on. The host runs the
two halves itself against a deadline — `C3D_FrameCounter` for the first,
`C3D_FrameBegin(C3D_FRAME_NONBLOCK)` polled for the second — so a GPU or a GSP
that stops signalling produces an error file naming the stage and the tick
rather than a black screen. The queue wait is unchanged in meaning, so the
rewind rule holds exactly as written.

Capture uses the explicit transfer, not `gfxGetFramebuffer` after `C3D_FrameEnd`
— that buffer has already been swapped and reads back black **(brief)**.
