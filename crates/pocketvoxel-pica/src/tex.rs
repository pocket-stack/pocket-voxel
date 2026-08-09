//! Atlas pages → PICA200 textures.
//!
//! The pak stores CLUT8 pages **pre-swizzled for the PSP GE** (16-byte × 8-row
//! blocks) and the day tint is applied by rewriting palette entries. The
//! PICA200 has **no paletted texture format at all**, wants **8×8 tiles in
//! row-major order with the 64 texels of a tile in Morton order**, and accepts
//! only **power-of-two dimensions in [8, 1024]**. Three transforms therefore
//! stand between a page and a bindable texture, and this module owns all
//! three:
//!
//! 1. **Palette expansion.** One texture per `(page, frame, resolved VPAL,
//!    tinted)` — [`TexKey`]. The target format is **RGBA5551**: 16 bpp, and
//!    its single alpha bit is exactly the 1-bit cutout the alpha test needs
//!    (`pocketvoxel-sim`'s rasterizer discards a texel whose palette alpha is
//!    `< 0x80`, writing neither colour nor depth; the same threshold becomes
//!    alpha 0 here and `GPU_GREATER`/`0x7f` on the GPU).
//! 2. **Retile.** PSP 16×8 blocks in, PICA 8×8 Morton tiles out, with the
//!    source **flipped vertically** on the way — tiled row 0 is sampled at
//!    `v = 1`, so the source's top row must land in the LAST tiled row the
//!    rescaled V reaches. Getting only the flip wrong leaves every channel
//!    histogram intact and every pixel misplaced.
//! 3. **POT pad.** Most cooked pages are not power-of-two (terrain 128×184,
//!    pics 40×40 / 48×48 / 56×56), so the texture declares a POT envelope and
//!    reports `u_scale`/`v_scale` for the vertex path to fold into the sampled
//!    coordinate — the same trick `pocketvoxel-gu` plays with `sceGuTexScale`,
//!    which the PICA has no fixed-function equivalent for (see
//!    [`TexPlan::u_scale`]).
//!
//! ## Where the three PICA facts come from
//!
//! The packing, the Morton permutation and the tile order were read out of
//! **devkitPro's own `tex3ds` encoder** rather than from memory: a set of
//! probe images encoded with `tex3ds --raw -z none -f rgba5551` and decoded
//! byte by byte. They are:
//!
//! - a texel is a little-endian `u16`, **`R<<11 | G<<6 | B<<1 | A`**;
//! - within an 8×8 tile, texel `(x, y)` sits at
//!   `(x&1) | ((y&1)<<1) | ((x&2)<<1) | ((y&2)<<2) | ((x&4)<<2) | ((y&4)<<3)`;
//! - tiles run **row-major**, left to right then top to bottom.
//!
//! `tex3ds` performs no vertical flip of its own (it records a sub-rectangle
//! for the non-POT case and leaves V to the app). The flip here is forced by
//! the sampler instead, and [`TexPlan`] derives its placement from that one
//! fact — see [`source_row_of_tiled_row`].
//!
//! ## The one modelled fact
//!
//! How the GPU expands a 5-bit channel back to 8 bits is **modelled**, not
//! measured: [`expand5`] assumes bit replication (`c<<3 | c>>2`), which is
//! what makes `31` read back as pure white. [`TO5`] is derived from
//! [`expand5`] by exhaustive nearest-match, so changing the model is a
//! one-function edit and the table follows. `tex3ds` itself truncates
//! (`c >> 3`, verified 256/256 over a ramp); this module rounds instead,
//! because truncation costs up to **7/255 = 2.7%** per channel and the
//! acceptance run compares against the 8-bit CPU oracle at `-fuzz 2%`.
//! Nearest-under-replication costs at most **4/255 = 1.6%**, which fits.
//!
//! ## The sampler these textures are built for
//!
//! The host sets it once: **nearest** magnification and minification (pixel
//! art, and the pak cooks no mips), **clamp** on both axes, and the alpha
//! test at [`ALPHA_CUTOFF`] — `GPU_GREATER` against `0x7f`, since RGBA5551's
//! one alpha bit expands to 0 or 255. Linear filtering would blend content
//! with [`PAD_TEXEL`] along the content's edges; a repeat wrap would pull the
//! padding in from the opposite side.

use alloc::vec::Vec;

use pocketvoxel_core::draw::{modulate_rgb, resolve_pal};
use pocketvoxel_core::pak::{Pak, swizzle_stride};

/// Read errors carry a message, the `pocketvoxel-core` convention.
pub type TexError = &'static str;

/// PICA texture dimensions are power-of-two and bounded on both ends.
pub const MIN_DIM: usize = 8;
pub const MAX_DIM: usize = 1024;

/// PICA tile edge, in texels. A tile is 64 texels in Morton order.
pub const TILE: usize = 8;

/// Palette alpha at or above this is opaque; below it the texel writes
/// neither colour nor depth (`raster.rs` `TexCtx::sample`, `sceGuAlphaFunc`
/// `Greater 0x7f`). RGBA5551 carries exactly this one bit.
pub const ALPHA_CUTOFF: u32 = 0x80;

/// The texel a padded region holds: transparent black, so a UV that spills
/// out of the content rectangle is alpha-tested away instead of painting.
/// The envelope is bigger than the content on both axes, and `CLAMP_TO_EDGE`
/// clamps to the ENVELOPE's edge, not the content's — the padding is
/// reachable, so it has to be harmless.
pub const PAD_TEXEL: u16 = 0x0000;

// ---------------------------------------------------------------------------
// Channel conversion
// ---------------------------------------------------------------------------

/// The 5-bit → 8-bit expansion the GPU is modelled as performing: bit
/// replication, so `0` reads back `0` and `31` reads back `255`.
#[inline]
pub const fn expand5(c5: u8) -> u8 {
    let c = (c5 & 31) as u16;
    ((c << 3) | (c >> 2)) as u8
}

/// The 5-bit code whose [`expand5`] value is nearest `c` — exhaustive, so
/// the table cannot drift from the model above.
const fn nearest5(c: u8) -> u8 {
    let mut best = 0u8;
    let mut best_d = 256i32;
    let mut k = 0u8;
    while k < 32 {
        let e = expand5(k) as i32;
        let t = c as i32;
        let d = if e > t { e - t } else { t - e };
        if d < best_d {
            best_d = d;
            best = k;
        }
        k += 1;
    }
    best
}

/// 8-bit channel → 5-bit code, rounded under [`expand5`].
pub const TO5: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut i = 0usize;
    while i < 256 {
        t[i] = nearest5(i as u8);
        i += 1;
    }
    t
};

/// One ABGR palette entry → one RGBA5551 texel. Alpha thresholds at
/// [`ALPHA_CUTOFF`], which is what turns the pak's 8-bit palette alpha into
/// the GPU's 1-bit cutout without changing which texels survive.
#[inline]
pub const fn abgr_to_rgba5551(c: u32) -> u16 {
    let r = TO5[(c & 0xff) as usize] as u16;
    let g = TO5[((c >> 8) & 0xff) as usize] as u16;
    let b = TO5[((c >> 16) & 0xff) as usize] as u16;
    let a = (((c >> 24) & 0xff) >= ALPHA_CUTOFF) as u16;
    (r << 11) | (g << 6) | (b << 1) | a
}

/// One RGBA5551 texel back to an ABGR u32 through [`expand5`] — the inverse
/// of [`abgr_to_rgba5551`] up to the 5-bit quantisation. Host-side probes and
/// tests read textures back through this.
#[inline]
pub const fn rgba5551_to_abgr(t: u16) -> u32 {
    let r = expand5(((t >> 11) & 31) as u8) as u32;
    let g = expand5(((t >> 6) & 31) as u8) as u32;
    let b = expand5(((t >> 1) & 31) as u8) as u32;
    let a = if t & 1 != 0 { 0xffu32 } else { 0 };
    (a << 24) | (b << 16) | (g << 8) | r
}

// ---------------------------------------------------------------------------
// The PICA tiling
// ---------------------------------------------------------------------------

/// The x half of the Morton index, tabulated: `(x&1) | ((x&2)<<1) | ((x&4)<<2)`.
const XPART: [usize; TILE] = [0, 1, 4, 5, 16, 17, 20, 21];
/// The y half: `((y&1)<<1) | ((y&2)<<2) | ((y&4)<<3)`.
const YPART: [usize; TILE] = [0, 2, 8, 10, 32, 34, 40, 42];

/// Texel index inside one 8×8 tile.
#[inline]
pub const fn morton8(x: usize, y: usize) -> usize {
    XPART[x & 7] | YPART[y & 7]
}

/// Texel index of `(x, y)` in a `pw`-wide tiled texture: tiles row-major,
/// Morton inside the tile. `pw` must be a multiple of [`TILE`].
#[inline]
pub const fn tile_index(pw: usize, x: usize, y: usize) -> usize {
    (((y / TILE) * (pw / TILE)) + (x / TILE)) * (TILE * TILE) + morton8(x, y)
}

/// The source row that must be written to tiled row `ty`, given a `ph`-tall
/// envelope: **`ph - 1 - ty`**.
///
/// The derivation, from the one sampler fact — tiled row 0 is sampled at
/// `v = 1`, so tiled row `ty` is sampled at `v_tex` with
/// `ty = ph - 1 - floor(v_tex * ph)`. The vertex path multiplies the page's
/// own V by `v_scale = h / ph`, so a source `v` arrives as
/// `v_tex = v * h / ph` and `floor(v_tex * ph) = floor(v * h)`, which is the
/// source row the CPU oracle samples. Substituting gives
/// `ty = ph - 1 - source_row`. Content therefore occupies the LAST `h` tiled
/// rows, flipped, and the padding sits at tiled rows `[0, ph - h)`, which the
/// rescaled V never reaches except by precision spill.
#[inline]
pub const fn source_row_of_tiled_row(ph: usize, ty: usize) -> usize {
    ph - 1 - ty
}

/// Next power of two, clamped up to [`MIN_DIM`].
pub const fn pot(v: usize) -> usize {
    let mut p = MIN_DIM;
    while p < v {
        p <<= 1;
    }
    p
}

// ---------------------------------------------------------------------------
// Reading the PSP-swizzled source
// ---------------------------------------------------------------------------

/// A PSP swizzle block: 16 bytes wide, 8 rows tall, its rows consecutive.
const PSP_BLOCK_W: usize = 16;
const PSP_BLOCK_H: usize = 8;

/// Byte offset of the LINEAR texel `(x, y)` inside a PSP-swizzled frame.
/// `stride` is `pak::swizzle_stride(w)`; blocks run block-row by block-row.
///
/// This is the one place the swizzle is expressed. `pak::unswizzle` states
/// the same layout the other way round, by walking blocks in order, and the
/// round-trip test holds the two against each other.
#[inline]
pub const fn psp_offset(stride: usize, x: usize, y: usize) -> usize {
    let blocks_x = stride / PSP_BLOCK_W;
    (((y / PSP_BLOCK_H) * blocks_x + (x / PSP_BLOCK_W)) * PSP_BLOCK_H + (y % PSP_BLOCK_H))
        * PSP_BLOCK_W
        + (x % PSP_BLOCK_W)
}

/// One CLUT8 index out of a PSP-swizzled frame, addressed in LINEAR
/// coordinates — no intermediate buffer, where `pak::unswizzle` would cost a
/// 32 KiB scratch allocation per 128×256 page expanded.
#[inline]
pub fn psp_texel(swizzled: &[u8], stride: usize, x: usize, y: usize) -> u8 {
    swizzled[psp_offset(stride, x, y)]
}

/// Linear CLUT8 → PSP-swizzled, the transform the cooker performs. It exists
/// so the round-trip test can start from a linear page without the core's
/// `std`-gated builder.
pub fn psp_swizzle(w: usize, h: usize, linear: &[u8]) -> Result<Vec<u8>, TexError> {
    if linear.len() != w * h {
        return Err("linear texel size mismatch");
    }
    let stride = swizzle_stride(w);
    let rows = pocketvoxel_core::pak::swizzle_rows(h);
    let mut out = alloc::vec![0u8; stride * rows];
    for y in 0..h {
        for x in 0..w {
            out[psp_offset(stride, x, y)] = linear[y * w + x];
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/// Everything the host needs to allocate and address one texture, and the
/// only thing that crosses to C before the texels do. `repr(C)`: 4 × u16 then
/// 2 × f32, 16 bytes, no padding.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TexPlan {
    /// The cooked page's real size.
    pub src_w: u16,
    pub src_h: u16,
    /// The POT envelope actually uploaded.
    pub width: u16,
    pub height: u16,
    /// `src_w / width`, `src_h / height` — the factor the vertex path folds
    /// into the sampled coordinate, standing in for `sceGuTexScale` (the
    /// PICA has no texture matrix; this is a shader uniform).
    ///
    /// Two uses, and they are not the same arithmetic:
    /// - **page-normalized UVs** (`PakVert::uf`/`vf`, and every `Item::Card`
    ///   UV, which normalizes U by the PAGE width) multiply by this scale;
    /// - **raw texel coordinates** — the GB UI layer, which `pocketvoxel-gu`
    ///   feeds the GE as literal texels through `TRANSFORM_2D` and the PICA
    ///   has no equivalent for — divide by [`TexPlan::width`]/[`height`]
    ///   directly. `texel / src_w * u_scale` is `texel / width`, so applying
    ///   the scale a second time there halves the UI's tile coordinates.
    pub u_scale: f32,
    pub v_scale: f32,
}

impl TexPlan {
    /// The envelope for a `w × h` page, or an error when the page cannot be
    /// represented (zero, or past [`MAX_DIM`] on either axis).
    pub fn for_size(w: u16, h: u16) -> Result<Self, TexError> {
        if w == 0 || h == 0 {
            return Err("atlas page with a zero dimension");
        }
        let (pw, ph) = (pot(w as usize), pot(h as usize));
        if pw > MAX_DIM || ph > MAX_DIM {
            return Err("atlas page exceeds the PICA200 1024 px texture limit");
        }
        Ok(Self {
            src_w: w,
            src_h: h,
            width: pw as u16,
            height: ph as u16,
            u_scale: w as f32 / pw as f32,
            v_scale: h as f32 / ph as f32,
        })
    }

    /// The plan for one of the pak's atlas pages.
    pub fn for_page(pak: &Pak, page: u16) -> Result<Self, TexError> {
        let p = pak.atlases.get(page as usize).ok_or("atlas page out of range")?;
        Self::for_size(p.w, p.h)
    }

    /// Texels in the uploaded envelope.
    #[inline]
    pub const fn texels(&self) -> usize {
        self.width as usize * self.height as usize
    }

    /// Bytes in the uploaded envelope (RGBA5551, 2 bytes a texel).
    #[inline]
    pub const fn bytes(&self) -> usize {
        self.texels() * 2
    }

    /// Texels the padding occupies — the POT tax, reported so a host can log
    /// what the envelope costs over the content.
    #[inline]
    pub const fn padding_texels(&self) -> usize {
        self.texels() - self.src_w as usize * self.src_h as usize
    }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// One VPAL entry expanded to RGBA5551, optionally through the day tint.
///
/// `tint` is `Some(abgr)` for every 3D pass and **`None` for the GB UI
/// layer**, which composites verbatim (`raster.rs` samples
/// `pak.palettes[kind]` untinted for `UiQuad`). The tint is applied by
/// `draw::modulate_rgb` — the core's integer `(c*t + 127)/255` — so this
/// backend and the rasterizer modulate identically, and because
/// `modulate_rgb` keeps the alpha byte the cutout can never move.
pub fn expand_palette(pal: &[u32; 256], tint: Option<u32>) -> [u16; 256] {
    let mut out = [0u16; 256];
    match tint {
        Some(t) => {
            for (i, &c) in pal.iter().enumerate() {
                out[i] = abgr_to_rgba5551(modulate_rgb(c, t));
            }
        }
        None => {
            for (i, &c) in pal.iter().enumerate() {
                out[i] = abgr_to_rgba5551(c);
            }
        }
    }
    out
}

/// Expand + flip + retile + pad one page frame into `out`.
///
/// `swizzled` is the pak's own frame slice (`AtlasPage::frame`), borrowed
/// in place; `out` must be exactly [`TexPlan::texels`] long and is written in
/// tile order, which is also the order the GPU reads it. Nothing else
/// allocates: the palette LUT is a stack array and the source is addressed
/// texel by texel through [`psp_texel`].
pub fn write_page(
    plan: &TexPlan,
    swizzled: &[u8],
    pal: &[u32; 256],
    tint: Option<u32>,
    out: &mut [u16],
) -> Result<(), TexError> {
    let (w, h) = (plan.src_w as usize, plan.src_h as usize);
    let (pw, ph) = (plan.width as usize, plan.height as usize);
    if out.len() != pw * ph {
        return Err("texture destination is not the planned size");
    }
    let stride = swizzle_stride(w);
    if swizzled.len() < stride * pocketvoxel_core::pak::swizzle_rows(h) {
        return Err("swizzled frame shorter than its dimensions");
    }
    let lut = expand_palette(pal, tint);

    for ty in 0..ph {
        // The flip: tiled row `ty` holds source row `ph - 1 - ty`, so the
        // padding lands in the tiled rows the rescaled V never reaches.
        let sy = source_row_of_tiled_row(ph, ty);
        let row_base = (ty / TILE) * (pw / TILE) * (TILE * TILE) + YPART[ty & 7];
        if sy >= h {
            for tx in 0..pw {
                out[row_base + (tx / TILE) * (TILE * TILE) + XPART[tx & 7]] = PAD_TEXEL;
            }
            continue;
        }
        // Source row `sy` lives in one PSP block row, so the row's base
        // offset hoists out and only the block column moves across it:
        // `psp_offset(stride, tx, sy) == src_row + (tx/16)*128 + tx%16`.
        let src_row = psp_offset(stride, 0, sy);
        for tx in 0..pw {
            let slot = row_base + (tx / TILE) * (TILE * TILE) + XPART[tx & 7];
            out[slot] = if tx < w {
                let idx = swizzled
                    [src_row + (tx / PSP_BLOCK_W) * PSP_BLOCK_W * PSP_BLOCK_H + (tx % PSP_BLOCK_W)];
                lut[idx as usize]
            } else {
                PAD_TEXEL
            };
        }
    }
    Ok(())
}

/// Read one texel back in SOURCE coordinates (linear, row 0 = top), undoing
/// the flip and the tiling. The C side uses it to probe a staged texture; the
/// tests use it as one half of the round trip.
#[inline]
pub fn read_source_texel(plan: &TexPlan, tiled: &[u16], sx: usize, sy: usize) -> u16 {
    let ph = plan.height as usize;
    tiled[tile_index(plan.width as usize, sx, ph - 1 - sy)]
}

/// A `u16` texel buffer as bytes, for the `memcpy` into a `C3D_Tex`. The
/// 3DS and every host this crate is tested on are little-endian, so the byte
/// order is the GPU's.
pub fn as_bytes(texels: &[u16]) -> &[u8] {
    // Safety: u16 has no invalid bit patterns and no padding.
    unsafe { core::slice::from_raw_parts(texels.as_ptr() as *const u8, texels.len() * 2) }
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/// The ABI shapes `include/pocketvoxel_pica.h` declares. A mismatch here is
/// a header that reads plausible garbage out of a correct frame.
const _: () = assert!(core::mem::size_of::<TexPlan>() == 16);
const _: () = assert!(core::mem::size_of::<TexKey>() == 8);

/// The four facts that identify one expanded texture. `pal` is the VPAL index
/// the CORE resolved — this backend makes no palette decision of its own.
///
/// `repr(C)`: the key crosses to the C side on every draw command and as this
/// frame's distinct-texture set, so the host can key its own `C3D_Tex` cache
/// off exactly what the core resolved rather than re-deriving any of it.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TexKey {
    pub page: u16,
    /// Animation frame, already reduced modulo the page's frame count.
    pub frame: u16,
    /// VPAL index from `draw::resolve_pal`.
    pub pal: u16,
    /// The day tint is folded into the palette. False only for the GB UI.
    pub tinted: bool,
}

impl TexKey {
    /// Resolve a draw's texture key through `draw::resolve_pal`, the core's
    /// own precedence ladder (the item's VCOL palette, then the page's, then
    /// the `palette` op's SGB selection, then the page kind's GB ramp).
    ///
    /// `item_pal` is `MeshDraw::pal` (`spec::COLOR_PAL_NONE` for a card or a
    /// UI quad), `selection` is `DrawList::palette`, and `tinted` is false
    /// only for the GB UI layer. `None` means the pak has no such page.
    pub fn resolve(
        pak: &Pak,
        page: u16,
        frame: u16,
        item_pal: u16,
        selection: i32,
        tinted: bool,
    ) -> Option<Self> {
        let p = pak.atlases.get(page as usize)?;
        Some(Self {
            page,
            frame: frame % p.frames,
            pal: resolve_pal(pak, page, p.kind, item_pal, selection) as u16,
            tinted,
        })
    }

    #[inline]
    fn packed(&self) -> u64 {
        (self.page as u64) << 48
            | (self.frame as u64) << 32
            | (self.pal as u64) << 16
            | self.tinted as u64
    }
}

/// One cached texture: its key, its envelope, and whether the host still owes
/// it a fill.
#[derive(Clone, Copy, Debug)]
pub struct TexSlot {
    pub key: TexKey,
    pub plan: TexPlan,
    dirty: bool,
}

impl TexSlot {
    #[inline]
    pub fn dirty(&self) -> bool {
        self.dirty
    }
}

/// What the cache has cost so far, for the host's boot log.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TexStats {
    /// Distinct textures minted.
    pub textures: u32,
    /// Bytes those textures occupy in linear memory.
    pub bytes: usize,
    /// Bytes the POT envelopes spend on padding.
    pub padding_bytes: usize,
    /// Expansions performed, mints and tint re-fills together.
    pub fills: u32,
}

/// The measured ceiling for the shipped pak is **12.70 MiB over 541
/// textures** (every reachable `(page, frame, palette, tinted)`: 142 baked
/// ground pages at one world palette each, the terrain page at 3 world
/// palettes × 8 animation frames, 4 OBJ and 10 pic palettes over 374 sprite
/// and battle pages, one GB UI page untinted). The default budget leaves
/// headroom over that inside the Old 3DS's 32 MiB linear arena; a host that
/// wants to fail early can set its own.
pub const DEFAULT_BUDGET_BYTES: usize = 16 * 1024 * 1024;

/// Which textures exist, keyed by [`TexKey`]. **It owns no texel memory** —
/// PICA textures must live in `linearAlloc`/VRAM, which Rust's newlib
/// allocator does not hand out, so the host allocates each slot's buffer and
/// asks [`TexCache::fill`] to write it.
///
/// Slot ids are stable for the life of the cache: nothing is ever evicted, so
/// the C side can index a flat `C3D_Tex` array by slot id. That is a decision
/// the measurement above supports rather than an assumption — the whole
/// expansion fits, so an eviction policy would only add a way to be wrong.
pub struct TexCache {
    /// `(packed key, slot)`, sorted by packed key — binary search per bind
    /// instead of a scan over every minted texture.
    index: Vec<(u64, u16)>,
    slots: Vec<TexSlot>,
    tint: u32,
    budget: usize,
    stats: TexStats,
}

impl TexCache {
    pub fn new() -> Self {
        Self::with_budget(DEFAULT_BUDGET_BYTES)
    }

    pub fn with_budget(budget: usize) -> Self {
        Self {
            index: Vec::new(),
            slots: Vec::new(),
            tint: 0xffff_ffff,
            budget,
            stats: TexStats::default(),
        }
    }

    pub fn stats(&self) -> TexStats {
        self.stats
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    pub fn slots(&self) -> &[TexSlot] {
        &self.slots
    }

    pub fn get(&self, slot: u16) -> Option<&TexSlot> {
        self.slots.get(slot as usize)
    }

    /// Point the cache at this frame's day tint. Returns true when the tint
    /// moved, which marks every TINTED slot for a re-fill: the tint lives
    /// inside the expanded texels, so a changed tint invalidates them.
    /// Untinted slots (the GB UI) are unaffected by construction.
    pub fn set_tint(&mut self, tint: u32) -> bool {
        if self.tint == tint {
            return false;
        }
        self.tint = tint;
        for s in &mut self.slots {
            if s.key.tinted {
                s.dirty = true;
            }
        }
        true
    }

    pub fn tint(&self) -> u32 {
        self.tint
    }

    /// The slot for `key`, minting one if this is the first bind. Returns
    /// `(slot, needs_fill)`; `needs_fill` is true for a fresh slot and for
    /// one the tint dirtied, and stays true until [`TexCache::fill`] runs.
    pub fn slot(&mut self, pak: &Pak, key: TexKey) -> Result<(u16, bool), TexError> {
        let packed = key.packed();
        match self.index.binary_search_by_key(&packed, |&(k, _)| k) {
            Ok(at) => {
                let slot = self.index[at].1;
                Ok((slot, self.slots[slot as usize].dirty))
            }
            Err(at) => {
                if key.pal as usize >= pak.palettes.len() {
                    return Err("texture key names a palette the pak does not have");
                }
                let plan = TexPlan::for_page(pak, key.page)?;
                let bytes = plan.bytes();
                if self.stats.bytes + bytes > self.budget {
                    return Err("texture cache budget exhausted");
                }
                if self.slots.len() >= u16::MAX as usize {
                    return Err("too many textures");
                }
                let slot = self.slots.len() as u16;
                self.slots.push(TexSlot {
                    key,
                    plan,
                    dirty: true,
                });
                self.index.insert(at, (packed, slot));
                self.stats.textures += 1;
                self.stats.bytes += bytes;
                self.stats.padding_bytes += plan.padding_texels() * 2;
                Ok((slot, true))
            }
        }
    }

    /// Expand slot `slot` into `out`, which must be [`TexPlan::texels`] long.
    /// Clears the slot's dirty flag.
    pub fn fill(&mut self, pak: &Pak, slot: u16, out: &mut [u16]) -> Result<(), TexError> {
        let s = *self.slots.get(slot as usize).ok_or("texture slot out of range")?;
        let page = pak
            .atlases
            .get(s.key.page as usize)
            .ok_or("atlas page out of range")?;
        let pal = pak
            .palettes
            .get(s.key.pal as usize)
            .ok_or("palette out of range")?;
        let tint = if s.key.tinted { Some(self.tint) } else { None };
        write_page(&s.plan, page.frame(s.key.frame), pal, tint, out)?;
        self.slots[slot as usize].dirty = false;
        self.stats.fills += 1;
        Ok(())
    }
}

impl Default for TexCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// The Morton permutation exactly as devkitPro's `tex3ds` writes it:
    /// slot index → `(x, y)` inside the tile, read out of the encoder's own
    /// bytes for an 8×8 probe whose R channel carried x and G carried y.
    /// Transcribed rather than computed, so it is independent evidence for
    /// [`morton8`] instead of a restatement of it.
    const TEX3DS_ORDER: [(usize, usize); 64] = [
        (0, 0), (1, 0), (0, 1), (1, 1), (2, 0), (3, 0), (2, 1), (3, 1),
        (0, 2), (1, 2), (0, 3), (1, 3), (2, 2), (3, 2), (2, 3), (3, 3),
        (4, 0), (5, 0), (4, 1), (5, 1), (6, 0), (7, 0), (6, 1), (7, 1),
        (4, 2), (5, 2), (4, 3), (5, 3), (6, 2), (7, 2), (6, 3), (7, 3),
        (0, 4), (1, 4), (0, 5), (1, 5), (2, 4), (3, 4), (2, 5), (3, 5),
        (0, 6), (1, 6), (0, 7), (1, 7), (2, 6), (3, 6), (2, 7), (3, 7),
        (4, 4), (5, 4), (4, 5), (5, 5), (6, 4), (7, 4), (6, 5), (7, 5),
        (4, 6), (5, 6), (4, 7), (5, 7), (6, 6), (7, 6), (6, 7), (7, 7),
    ];

    /// Representative page shapes, every one of them a real cooked size in
    /// `dist/voxelmon/voxelmon.vxpak` plus two edge cases (a 4 px page that
    /// must pad up to the 8 px floor, and a 1×1).
    const SHAPES: [(usize, usize); 12] = [
        (32, 32),
        (40, 40),
        (48, 48),
        (56, 56),
        (64, 16),
        (64, 48),
        (64, 96),
        (128, 128),
        (128, 184),
        (128, 256),
        (4, 4),
        (1, 1),
    ];

    fn ramp(w: usize, h: usize) -> Vec<u8> {
        (0..w * h).map(|i| (i % 251) as u8).collect()
    }

    /// A palette where every index is a distinct, exactly-representable
    /// colour, so a misplaced texel cannot alias onto the right value.
    fn probe_palette() -> [u32; 256] {
        let mut p = [0u32; 256];
        for (i, e) in p.iter_mut().enumerate() {
            let r = expand5((i % 32) as u8) as u32;
            let g = expand5(((i / 32) % 8) as u8) as u32;
            let b = expand5(((i / 8) % 32) as u8) as u32;
            let a: u32 = if i % 7 == 0 { 0x00 } else { 0xff };
            *e = (a << 24) | (b << 16) | (g << 8) | r;
        }
        p
    }

    // -- transform 1: the tiling -------------------------------------------

    #[test]
    fn morton_matches_the_tex3ds_permutation() {
        for (slot, &(x, y)) in TEX3DS_ORDER.iter().enumerate() {
            assert_eq!(morton8(x, y), slot, "texel ({x},{y}) belongs at slot {slot}");
        }
        // And the formula the brief pins agrees with the tabulated halves.
        for y in 0..8 {
            for x in 0..8 {
                let formula = (x & 1) | ((y & 1) << 1) | ((x & 2) << 1)
                    | ((y & 2) << 2) | ((x & 4) << 2) | ((y & 4) << 3);
                assert_eq!(morton8(x, y), formula);
            }
        }
        // A permutation, not a mapping with collisions.
        let mut seen = [false; 64];
        for y in 0..8 {
            for x in 0..8 {
                assert!(!seen[morton8(x, y)], "morton8 collides at ({x},{y})");
                seen[morton8(x, y)] = true;
            }
        }
    }

    #[test]
    fn tiles_are_row_major() {
        // 16x16 = 2x2 tiles: tile (tx, ty) owns texels [t*64, t*64 + 64) with
        // t = ty * 2 + tx.
        for ty in 0..2 {
            for tx in 0..2 {
                let t = ty * 2 + tx;
                for y in 0..8 {
                    for x in 0..8 {
                        let i = tile_index(16, tx * 8 + x, ty * 8 + y);
                        assert!(
                            (t * 64..t * 64 + 64).contains(&i),
                            "tile ({tx},{ty}) texel ({x},{y}) landed at {i}"
                        );
                    }
                }
            }
        }
        // Over a whole non-square envelope the index is still a permutation.
        let (pw, ph) = (128usize, 256usize);
        let mut seen = vec![false; pw * ph];
        for y in 0..ph {
            for x in 0..pw {
                let i = tile_index(pw, x, y);
                assert!(!seen[i], "tile_index collides at ({x},{y})");
                seen[i] = true;
            }
        }
    }

    // -- transform 2: the PSP source ---------------------------------------

    /// Swizzle then unswizzle is the identity, and the direct reader agrees
    /// with both — at every representative page size, POT or not. This is the
    /// test that stands between a plausible frame and a scrambled one: the
    /// pak's bytes are only ever seen through `psp_texel`.
    #[test]
    fn psp_swizzle_round_trips_at_every_page_size() {
        for &(w, h) in &SHAPES {
            let linear = ramp(w, h);
            let sw = psp_swizzle(w, h, &linear).expect("swizzle");
            assert_eq!(
                sw.len(),
                pocketvoxel_core::pak::swizzled_len(w, h),
                "{w}x{h} swizzled size"
            );
            // 1. the core's own reader inverts it exactly
            let back = pocketvoxel_core::pak::unswizzle(w, h, &sw).expect("unswizzle");
            assert_eq!(back, linear, "{w}x{h} round trip");
            // 2. the per-texel reader this module actually uses agrees
            let stride = swizzle_stride(w);
            for y in 0..h {
                for x in 0..w {
                    assert_eq!(
                        psp_texel(&sw, stride, x, y),
                        linear[y * w + x],
                        "{w}x{h} texel ({x},{y})"
                    );
                }
            }
        }
    }

    #[test]
    fn psp_swizzle_rejects_a_mis_sized_source() {
        assert!(psp_swizzle(16, 16, &[0u8; 10]).is_err());
    }

    // -- transform 3: the POT envelope -------------------------------------

    #[test]
    fn pot_envelope_and_uv_scale() {
        let p = TexPlan::for_size(128, 184).unwrap();
        assert_eq!((p.width, p.height), (128, 256), "terrain page envelope");
        assert_eq!(p.u_scale, 1.0);
        assert_eq!(p.v_scale, 184.0 / 256.0);
        assert_eq!(p.bytes(), 128 * 256 * 2);
        assert_eq!(p.padding_texels(), 128 * 256 - 128 * 184);

        for &(w, h) in &SHAPES {
            let p = TexPlan::for_size(w as u16, h as u16).unwrap();
            let (pw, ph) = (p.width as usize, p.height as usize);
            assert!(pw >= MIN_DIM && ph >= MIN_DIM, "{w}x{h} respects the 8 px floor");
            assert!(pw <= MAX_DIM && ph <= MAX_DIM);
            assert!(pw.is_power_of_two() && ph.is_power_of_two());
            assert!(pw >= w && ph >= h, "{w}x{h} envelope must contain the page");
            assert!(pw / 2 < w.max(MIN_DIM) && ph / 2 < h.max(MIN_DIM), "envelope is tight");
            assert_eq!(p.u_scale, w as f32 / pw as f32);
            assert_eq!(p.v_scale, h as f32 / ph as f32);
        }
        assert!(TexPlan::for_size(0, 8).is_err());
        assert!(TexPlan::for_size(2048, 8).is_err(), "past the PICA 1024 limit");
        assert!(TexPlan::for_size(1024, 1024).is_ok());
    }

    // -- palette expansion -------------------------------------------------

    #[test]
    fn rgba5551_packs_r11_g6_b1_a0() {
        // Field masks, read out of tex3ds' own output for solid probes.
        assert_eq!(abgr_to_rgba5551(0xff00_00ff), 0xf801, "red + opaque");
        assert_eq!(abgr_to_rgba5551(0xff00_ff00), 0x07c1, "green + opaque");
        assert_eq!(abgr_to_rgba5551(0xffff_0000), 0x003f, "blue + opaque");
        assert_eq!(abgr_to_rgba5551(0xff00_0000), 0x0001, "black + opaque");
        assert_eq!(abgr_to_rgba5551(0xffff_ffff), 0xffff, "white + opaque");
        assert_eq!(abgr_to_rgba5551(0x00ff_ffff), 0xfffe, "white, alpha-tested out");
    }

    #[test]
    fn alpha_is_the_cutout_bit_at_0x80() {
        for a in 0u32..256 {
            let t = abgr_to_rgba5551((a << 24) | 0x00ff_ffff);
            assert_eq!(
                t & 1 != 0,
                a >= ALPHA_CUTOFF,
                "palette alpha {a} must survive iff the rasterizer keeps it"
            );
        }
    }

    #[test]
    fn five_bit_quantisation_rounds_and_stays_inside_the_fuzz() {
        assert_eq!(TO5[0], 0);
        assert_eq!(TO5[255], 31);
        assert_eq!(expand5(0), 0);
        assert_eq!(expand5(31), 255);
        let mut worst = 0i32;
        for c in 0..256usize {
            let e = expand5(TO5[c]) as i32;
            worst = worst.max((e - c as i32).abs());
            // monotone: a brighter 8-bit value never picks a darker code
            if c > 0 {
                assert!(TO5[c] >= TO5[c - 1], "TO5 must be monotone at {c}");
            }
        }
        // Truncation (`c >> 3`, what tex3ds does) costs 7; rounding costs 4,
        // which is what keeps a flat colour inside the acceptance run's 2%.
        assert!(worst <= 4, "worst 5-bit round trip error was {worst}/255");
        let trunc_worst = (0..256usize)
            .map(|c| (expand5((c >> 3) as u8) as i32 - c as i32).abs())
            .max()
            .unwrap();
        assert_eq!(trunc_worst, 7);
    }

    #[test]
    fn the_tint_is_a_palette_modulation_and_never_touches_the_cutout() {
        let pal = probe_palette();
        let tint = 0xff80_c040u32;
        let tinted = expand_palette(&pal, Some(tint));
        let raw = expand_palette(&pal, None);
        for i in 0..256 {
            assert_eq!(
                tinted[i],
                abgr_to_rgba5551(modulate_rgb(pal[i], tint)),
                "entry {i} must be the core's own modulation"
            );
            assert_eq!(
                tinted[i] & 1,
                raw[i] & 1,
                "entry {i}: the tint moved the alpha cutout"
            );
        }
        // A white tint is the identity, so the GB UI's untinted path and a
        // fully-lit 3D pass agree texel for texel.
        assert_eq!(expand_palette(&pal, Some(0xffff_ffff)), raw);
    }

    // -- the three together, against the CPU oracle ------------------------

    /// The PICA sampler as the one pinned fact describes it: **tiled row 0 is
    /// sampled at v = 1**. Nearest, no filtering. Written out here from first
    /// principles — tile arithmetic included — so it cannot inherit a mistake
    /// from the code it is checking.
    fn sample(plan: &TexPlan, tiled: &[u16], u: f32, v: f32) -> u16 {
        let (pw, ph) = (plan.width as usize, plan.height as usize);
        let uu = u * plan.u_scale;
        let vv = v * plan.v_scale;
        let tx = ((uu * pw as f32).floor() as isize).clamp(0, pw as isize - 1) as usize;
        let from_bottom = ((vv * ph as f32).floor() as isize).clamp(0, ph as isize - 1) as usize;
        let ty = ph - 1 - from_bottom;
        // Tile arithmetic, spelled out rather than borrowed.
        let tile = (ty / 8) * (pw / 8) + (tx / 8);
        let (ix, iy) = (tx % 8, ty % 8);
        let inside = (ix & 1)
            | ((iy & 1) << 1)
            | ((ix & 2) << 1)
            | ((iy & 2) << 2)
            | ((ix & 4) << 2)
            | ((iy & 4) << 3);
        tiled[tile * 64 + inside]
    }

    /// An expanded page, sampled at the UVs the CPU oracle samples, returns
    /// the CPU oracle's own texel — at every page size, including the ones
    /// that pad. This is the test the flip cannot survive being wrong: a page
    /// stored the right way up matches on every channel histogram and lands
    /// every pixel in the wrong row.
    #[test]
    fn the_sampler_sees_exactly_what_the_cpu_oracle_sees() {
        let pal = probe_palette();
        let tint = 0xff90_b0d0u32;
        for &(w, h) in &SHAPES {
            let linear = ramp(w, h);
            let swizzled = psp_swizzle(w, h, &linear).unwrap();
            let plan = TexPlan::for_size(w as u16, h as u16).unwrap();
            let mut out = vec![0u16; plan.texels()];
            write_page(&plan, &swizzled, &pal, Some(tint), &mut out).unwrap();

            for sy in 0..h {
                for sx in 0..w {
                    // The oracle: unswizzle, index the palette, apply the day
                    // tint as a palette modulation (raster.rs `render`).
                    let want = abgr_to_rgba5551(modulate_rgb(pal[linear[sy * w + sx] as usize], tint));
                    // The GPU: the texel centre's UV, rescaled by the plan.
                    let u = (sx as f32 + 0.5) / w as f32;
                    let v = (sy as f32 + 0.5) / h as f32;
                    assert_eq!(
                        sample(&plan, &out, u, v),
                        want,
                        "{w}x{h} source texel ({sx},{sy}) sampled at ({u},{v})"
                    );
                    // And the read-back helper agrees with the sampler.
                    assert_eq!(read_source_texel(&plan, &out, sx, sy), want);
                }
            }
        }
    }

    /// The flip, stated on its own: the source's TOP row is the last tiled
    /// row, not the first. A page whose rows are all distinct proves it
    /// without going through the sampler.
    #[test]
    fn the_source_top_row_lands_at_the_bottom_of_the_envelope() {
        let (w, h) = (64usize, 96usize);
        let linear: Vec<u8> = (0..w * h).map(|i| (i / w) as u8).collect(); // row index
        let swizzled = psp_swizzle(w, h, &linear).unwrap();
        let mut pal = [0u32; 256];
        for (i, e) in pal.iter_mut().enumerate() {
            *e = 0xff00_0000 | (i as u32);
        }
        let plan = TexPlan::for_size(w as u16, h as u16).unwrap();
        let (pw, ph) = (plan.width as usize, plan.height as usize);
        assert_eq!((pw, ph), (64, 128));
        let mut out = vec![0u16; plan.texels()];
        write_page(&plan, &swizzled, &pal, None, &mut out).unwrap();

        // Compare texels, not decoded channels: the probe palette's row index
        // rides an 8-bit channel and comes back 5-bit-quantised.
        let want = |row: usize| abgr_to_rgba5551(pal[row]);
        assert_eq!(
            out[tile_index(pw, 0, ph - 1)],
            want(0),
            "source row 0 sits at the LAST tiled row"
        );
        assert_eq!(
            out[tile_index(pw, 0, ph - h)],
            want(h - 1),
            "source row h-1 sits at tiled row ph-h"
        );
        // The whole first column, so an off-by-one anywhere in the envelope
        // shows up rather than only at the two ends.
        for ty in 0..ph {
            let sy = source_row_of_tiled_row(ph, ty);
            let got = out[tile_index(pw, 0, ty)];
            if sy < h {
                assert_eq!(got, want(sy), "tiled row {ty} must hold source row {sy}");
            } else {
                assert_eq!(got, PAD_TEXEL, "tiled row {ty} is above the content");
            }
        }
    }

    #[test]
    fn padding_is_transparent_everywhere_the_content_is_not() {
        let (w, h) = (40usize, 40usize);
        let linear = vec![1u8; w * h];
        let swizzled = psp_swizzle(w, h, &linear).unwrap();
        let mut pal = [0u32; 256];
        pal[1] = 0xffff_ffff;
        let plan = TexPlan::for_size(w as u16, h as u16).unwrap();
        let (pw, ph) = (plan.width as usize, plan.height as usize);
        assert_eq!((pw, ph), (64, 64));
        let mut out = vec![0u16; plan.texels()];
        write_page(&plan, &swizzled, &pal, None, &mut out).unwrap();
        let mut content = 0usize;
        for ty in 0..ph {
            for tx in 0..pw {
                let t = out[tile_index(pw, tx, ty)];
                let sy = source_row_of_tiled_row(ph, ty);
                if sy < h && tx < w {
                    assert_eq!(t, 0xffff, "content at tiled ({tx},{ty})");
                    content += 1;
                } else {
                    assert_eq!(t, PAD_TEXEL, "padding at tiled ({tx},{ty})");
                    assert_eq!(t & 1, 0, "padding must fail the alpha test");
                }
            }
        }
        assert_eq!(content, w * h);
        assert_eq!(plan.padding_texels(), pw * ph - w * h);
    }

    #[test]
    fn write_page_refuses_a_mis_sized_destination() {
        let plan = TexPlan::for_size(16, 16).unwrap();
        let swizzled = psp_swizzle(16, 16, &vec![0u8; 256]).unwrap();
        let pal = [0u32; 256];
        let mut small = vec![0u16; plan.texels() - 1];
        assert!(write_page(&plan, &swizzled, &pal, None, &mut small).is_err());
        let mut ok = vec![0u16; plan.texels()];
        assert!(write_page(&plan, &swizzled, &pal, None, &mut ok).is_ok());
        // A truncated source is refused, never read past.
        assert!(write_page(&plan, &swizzled[..16], &pal, None, &mut ok).is_err());
    }

    // -- the key and the cache --------------------------------------------

    #[test]
    fn keys_order_and_distinguish_every_field() {
        let base = TexKey { page: 3, frame: 1, pal: 42, tinted: true };
        let variants = [
            TexKey { page: 4, ..base },
            TexKey { frame: 2, ..base },
            TexKey { pal: 41, ..base },
            TexKey { tinted: false, ..base },
        ];
        for v in variants {
            assert_ne!(v.packed(), base.packed(), "{v:?} must not alias {base:?}");
        }
        // The packing is order-preserving, which is what lets the index be a
        // sorted vector with a binary search instead of a hash map.
        let mut ks = [variants[3], variants[2], variants[1], variants[0], base];
        ks.sort();
        let packed: Vec<u64> = ks.iter().map(|k| k.packed()).collect();
        let mut sorted = packed.clone();
        sorted.sort_unstable();
        assert_eq!(packed, sorted);
    }

    /// A pak with RED++ bindings: VPAL 0..3 are the kind ramps, 4 the one SGB
    /// entry, 5 a world CLUT and 6 an OBJ CLUT. Map 7 binds 5 over the
    /// terrain page; the sprite page binds 6. The terrain page carries two
    /// animation frames so the key's frame field has something to separate.
    ///
    /// The builder swizzles with its own block-major loop, so a page read
    /// back here also holds [`psp_offset`] against a second implementation.
    fn colored_pak() -> Vec<u8> {
        use pocketvoxel_core::pak::builder::{ChunkDef, PakBuilder};
        use pocketvoxel_core::pak::{MeshRange, PakVert};
        use pocketvoxel_core::spec::{self, atlas_kind};

        let mut b = PakBuilder::new();
        for p in 0..7 {
            let mut pal = [0xff00_0000u32; 256];
            // Every palette paints a different colour, so a bind that picks
            // the wrong CLUT cannot land on the right texel.
            for (i, e) in pal.iter_mut().enumerate() {
                let a = if i % 5 == 0 { 0x00u32 } else { 0xff };
                *e = (a << 24) | ((p as u32 * 8 + 3) << 8) | (i as u32 & 0xff);
            }
            b.palette(pal);
        }
        // 40x40 terrain: not power-of-two, so the envelope pads.
        let f0: Vec<u8> = (0..40 * 40).map(|i| (i % 256) as u8).collect();
        let f1: Vec<u8> = (0..40 * 40).map(|i| ((i * 3 + 7) % 256) as u8).collect();
        b.atlas_linear(40, 40, atlas_kind::TERRAIN, &[&f0, &f1]);
        b.atlas_linear(64, 96, atlas_kind::SPRITES, &[&vec![9u8; 64 * 96]]);
        b.atlas_linear(128, 128, atlas_kind::UI, &[&vec![5u8; 128 * 128]]);
        let v = |x: i16, z: i16| PakVert { u: 0, v: 0, abgr: 0xffff_ffff, x, y: 0, z, pad: 0 };
        let terrain = b.mesh(&[v(0, 0), v(128, 0), v(128, 128), v(0, 128)], &[0, 1, 2, 0, 2, 3]);
        let mut meshes = [MeshRange::default(); spec::MESH_KINDS];
        meshes[0] = terrain;
        b.map(7, &[ChunkDef {
            cx: 0,
            cy: 0,
            aabb_min: [0, 0, 0],
            aabb_max: [128, 0, 128],
            bake_page: spec::BAKE_PAGE_NONE,
            meshes,
        }]);
        b.stamps(7, &[]);
        b.game(b"{}");
        b.color_flags(spec::VXPK_COLOR_FLAG_WORLD);
        b.map_color(7, 5, 0);
        b.page_color(1, 6);
        b.finish()
    }

    /// The cache resolves through the core's ladder, mints one texture per
    /// distinct key, reuses otherwise, and expands what the CPU oracle reads.
    #[test]
    fn the_cache_binds_what_the_core_resolved() {
        use pocketvoxel_core::pak::{self, AlignedBlob, unswizzle};
        use pocketvoxel_core::spec::{COLOR_PAL_NONE, atlas_kind};

        let blob = AlignedBlob::from_bytes(&colored_pak());
        let pak = pak::read(blob.bytes()).expect("valid pak");
        let tint = 0xffc0_a080u32;

        // The precedence ladder, through TexKey rather than restated: a chunk
        // mesh's own VCOL world palette outranks a live SGB selection, a
        // sprite page takes its own, and the UI takes neither.
        let terrain = TexKey::resolve(&pak, 0, 0, 5, 0, true).unwrap();
        assert_eq!(terrain.pal, 5, "the map's world CLUT wins");
        let sprite = TexKey::resolve(&pak, 1, 0, COLOR_PAL_NONE, 0, true).unwrap();
        assert_eq!(sprite.pal, 6, "the sprite page's OBJ CLUT wins over the SGB pick");
        let ui = TexKey::resolve(&pak, 2, 0, COLOR_PAL_NONE, 0, false).unwrap();
        assert_eq!(ui.pal, atlas_kind::UI, "the UI keeps its own raw ramp");
        assert!(TexKey::resolve(&pak, 99, 0, COLOR_PAL_NONE, -1, true).is_none());
        // The frame index reduces modulo the page's frame count, so two
        // aliasing animation frames share one texture instead of two.
        assert_eq!(TexKey::resolve(&pak, 0, 2, 5, -1, true).unwrap().frame, 0);
        assert_eq!(TexKey::resolve(&pak, 0, 3, 5, -1, true).unwrap().frame, 1);

        let mut cache = TexCache::new();
        cache.set_tint(tint);
        let fill = |cache: &mut TexCache, key: TexKey| -> (u16, Vec<u16>) {
            let (slot, need) = cache.slot(&pak, key).expect("slot");
            let plan = cache.get(slot).unwrap().plan;
            let mut buf = vec![0u16; plan.texels()];
            if need {
                cache.fill(&pak, slot, &mut buf).expect("fill");
            }
            (slot, buf)
        };
        let (s0, buf) = fill(&mut cache, terrain);
        let (s1, _) = fill(&mut cache, sprite);
        let (s2, _) = fill(&mut cache, ui);
        let f1 = TexKey { frame: 1, ..terrain };
        let (s3, _) = fill(&mut cache, f1);
        assert_eq!([s0, s1, s2, s3], [0, 1, 2, 3], "four distinct keys, four slots");
        assert_eq!(cache.stats().textures, 4);
        assert_eq!(cache.stats().fills, 4);
        // Re-binding mints and fills nothing.
        assert_eq!(cache.slot(&pak, terrain).unwrap(), (0, false));
        assert_eq!(cache.stats().textures, 4);

        // The terrain page is 40x40, so the envelope pads to 64x64 and the
        // UV rescale is what keeps the content addressable.
        let plan = cache.get(s0).unwrap().plan;
        assert_eq!((plan.width, plan.height), (64, 64));
        assert_eq!((plan.u_scale, plan.v_scale), (40.0 / 64.0, 40.0 / 64.0));

        // Every texel of frame 0 against the oracle: unswizzle, index VPAL 5,
        // modulate by the day tint.
        let page = &pak.atlases[0];
        let lin = unswizzle(40, 40, page.frame(0)).unwrap();
        for sy in 0..40 {
            for sx in 0..40 {
                let c = pak.palettes[5][lin[sy * 40 + sx] as usize];
                assert_eq!(
                    read_source_texel(&plan, &buf, sx, sy),
                    abgr_to_rgba5551(modulate_rgb(c, tint)),
                    "terrain texel ({sx},{sy})"
                );
            }
        }

        // The budget is a guard, not a suggestion.
        let mut tiny = TexCache::with_budget(1024);
        assert!(tiny.slot(&pak, terrain).is_err(), "an exhausted budget must refuse");
    }

    #[test]
    fn a_changed_tint_dirties_only_the_tinted_slots() {
        // No pak needed: exercise the dirty bookkeeping directly.
        let mut c = TexCache::new();
        assert!(!c.set_tint(0xffff_ffff), "the boot tint is already white");
        c.slots.push(TexSlot {
            key: TexKey { page: 0, frame: 0, pal: 0, tinted: true },
            plan: TexPlan::for_size(16, 16).unwrap(),
            dirty: false,
        });
        c.slots.push(TexSlot {
            key: TexKey { page: 1, frame: 0, pal: 2, tinted: false },
            plan: TexPlan::for_size(16, 16).unwrap(),
            dirty: false,
        });
        assert!(c.set_tint(0xff80_8080));
        assert!(c.slots[0].dirty(), "the tinted 3D page must be re-expanded");
        assert!(!c.slots[1].dirty(), "the GB UI layer never carries the tint");
        assert!(!c.set_tint(0xff80_8080), "an unchanged tint dirties nothing");
    }
}
