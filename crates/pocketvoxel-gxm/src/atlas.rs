//! CLUT8 → RGBA texture cache, on GXM.
//!
//! The pak carries every atlas page once, as swizzled 8-bit palette indices,
//! and the PSP samples exactly that: the GE has a hardware CLUT, so
//! `pocketvoxel-gu` binds a 256-entry palette per draw and the day tint is a
//! CLUT rewrite that costs a kilobyte. GXM has a palette sampler too, but
//! only ONE palette can be bound per texture object, and RED++ makes the same
//! page sample through different palettes within a frame (two towns share the
//! terrain page and differ only in their roofs). So the palette is resolved on
//! the CPU and the RESULT is cached: one RGBA8888 texture per
//! (page, frame, palette, tinted).
//!
//! Affordable here for the reasons it would not have been on a PSP: the whole
//! ATLS section is ~5.5 MB of indices, a map binds a few dozen page frames,
//! and this machine measures its user partition in hundreds of megabytes.
//!
//! Two GXM-specific disciplines, neither of which the GL backend needed:
//!
//! - **Texels live in GXM-mapped memory**, one [`GpuSlab`] per texture, and
//!   the texture is `LinearStrided` with an explicit `width * 4` byte stride.
//!   Strided linear textures take any width, which is what lets the cooked
//!   pages upload at their real size with no power-of-two envelope and no UV
//!   rescale.
//! - **Eviction is deferred by three frames.** Freeing a slab the moment the
//!   cache overflows would hand memory back while the GPU is still reading the
//!   frame that referenced it. Retired slabs go into a ring and are released
//!   only once three presents have gone by, which is past the deepest
//!   buffering vita2d uses.

use std::collections::HashMap;

use pocketvoxel_core::draw::modulate_rgb;
use pocketvoxel_core::pak::{Pak, unswizzle};
use vita2d_sys as v2d;

use crate::gxm::GpuSlab;

/// One resident texture's identity: the page, its animation frame, the VPAL
/// index the core resolved for the draw, whether the day tint was folded in
/// (the GB UI layer samples the raw ramp, everything else the tinted one),
/// and an optional flat silhouette color. `solid` keeps source alpha only;
/// it is how the shader-limited Vita backend masks the occluded player ghost.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Key {
    pub page: u16,
    pub frame: u16,
    pub pal: u16,
    pub tinted: bool,
    pub solid: Option<u32>,
}

struct Entry {
    texture: v2d::SceGxmTexture,
    slab: GpuSlab,
    bytes: usize,
    /// Frame counter at the last bind — the eviction order.
    used: u32,
}

/// Resident-texture budget. Comfortably above any single map's working set and
/// far below what this console has spare.
const BUDGET_BYTES: usize = 24 * 1024 * 1024;

/// How many presents a retired slab waits before its memory is released.
const RETIRE_FRAMES: usize = 3;

pub struct AtlasCache {
    resident: HashMap<Key, Entry>,
    /// Slabs whose textures are no longer bound, held until the GPU can no
    /// longer be reading them.
    retiring: [Vec<GpuSlab>; RETIRE_FRAMES],
    /// Linear index buffer reused by every expansion.
    indices: Vec<u8>,
    /// RGBA staging, reused for the same reason.
    texels: Vec<u32>,
    /// The tint every `tinted` entry was baked with.
    tint: u32,
    bytes: usize,
    clock: u32,
}

impl AtlasCache {
    pub fn new() -> Self {
        Self {
            resident: HashMap::new(),
            retiring: Default::default(),
            indices: Vec::new(),
            texels: Vec::new(),
            tint: 0xffff_ffff,
            bytes: 0,
            clock: 0,
        }
    }

    /// Advance the frame clock and release the slabs retired three frames ago.
    ///
    /// # Safety
    /// Call once per frame, before any draw, on the render thread.
    pub unsafe fn tick(&mut self) {
        self.clock = self.clock.wrapping_add(1);
        let slot = self.clock as usize % RETIRE_FRAMES;
        for slab in self.retiring[slot].drain(..) {
            slab.free();
        }
    }

    /// Adopt this frame's day tint, dropping every texture baked with the
    /// previous one. Untinted (UI) textures survive.
    ///
    /// # Safety
    /// Render thread, no draw in flight referencing a dropped texture this
    /// frame (the retire ring covers earlier frames).
    pub unsafe fn retint(&mut self, tint: u32) {
        if tint == self.tint {
            return;
        }
        self.tint = tint;
        let stale: Vec<Key> = self.resident.keys().copied().filter(|k| k.tinted).collect();
        for key in stale {
            self.release(key);
        }
    }

    /// The GXM texture for `key`, uploading it on a miss. `None` when the pak
    /// has no such page or palette — a truncated pak must not draw garbage.
    ///
    /// # Safety
    /// Render thread, after vita2d init.
    pub unsafe fn texture(&mut self, pak: &Pak, key: Key) -> Option<*const v2d::SceGxmTexture> {
        if let Some(entry) = self.resident.get_mut(&key) {
            entry.used = self.clock;
            return Some(&entry.texture);
        }
        let page = pak.atlases.get(key.page as usize)?;
        let palette = pak.palettes.get(key.pal as usize)?;
        let (w, h) = (page.w as usize, page.h as usize);
        if w == 0 || h == 0 {
            return None;
        }

        // The GE consumes swizzled texels in place; a sampler wants them
        // linear, so this is the one-time linearization the software
        // rasterizer also does at load.
        self.indices = unswizzle(w, h, page.frame(key.frame)).ok()?;
        self.texels.clear();
        self.texels.reserve(w * h);
        // A VPAL entry is ABGR (0xAABBGGRR), which is exactly what
        // `U8U8U8U8_ABGR` reads, so the palette lookup writes the texel
        // verbatim and no channel shuffle exists to get backwards.
        if let Some(solid) = key.solid {
            for &index in &self.indices {
                let source = palette[index as usize];
                self.texels.push(if (source >> 24) & 0xff >= 0x80 {
                    solid
                } else {
                    0
                });
            }
        } else if key.tinted {
            let tint = self.tint;
            for &index in &self.indices {
                self.texels.push(modulate_rgb(palette[index as usize], tint));
            }
        } else {
            for &index in &self.indices {
                self.texels.push(palette[index as usize]);
            }
        }

        let bytes = w * h * 4;
        let slab = GpuSlab::alloc(bytes).ok()?;
        core::ptr::copy_nonoverlapping(
            self.texels.as_ptr(),
            slab.as_ptr().cast::<u32>(),
            w * h,
        );

        let mut texture: v2d::SceGxmTexture = core::mem::zeroed();
        // Strided rather than plain linear: a strided texture states its row
        // pitch outright, so a cooked page uploads at its real width with no
        // power-of-two envelope and no UV rescale — the `sceGuTexScale` the
        // GE backend needs has no counterpart here.
        if v2d::sceGxmTextureInitLinearStrided(
            &mut texture,
            slab.as_ptr().cast(),
            v2d::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
            w as u32,
            h as u32,
            (w * 4) as u32,
        ) < 0
        {
            slab.free();
            return None;
        }
        // Pixel art: point sampling, no mips cooked — the same choice
        // pocketvoxel-gu makes, and the reason a 2x native raster still reads
        // as the same picture rather than a blurred one.
        v2d::sceGxmTextureSetMinFilter(
            &mut texture,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT,
        );
        v2d::sceGxmTextureSetMagFilter(
            &mut texture,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_POINT,
        );
        // Clamp: cooked UVs stay inside the page, and clamping means a
        // precision spill lands on the edge texel instead of wrapping to the
        // opposite side of an atlas.
        v2d::sceGxmTextureSetUAddrMode(
            &mut texture,
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );
        v2d::sceGxmTextureSetVAddrMode(
            &mut texture,
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );

        self.bytes += bytes;
        self.resident.insert(
            key,
            Entry {
                texture,
                slab,
                bytes,
                used: self.clock,
            },
        );
        self.evict_to_budget(key);
        self.resident.get(&key).map(|entry| &entry.texture as *const _)
    }

    /// Retire least-recently-bound textures until the budget holds. `keep` is
    /// the key just uploaded — retiring the texture the caller is about to
    /// bind would be a use-after-free with extra steps.
    unsafe fn evict_to_budget(&mut self, keep: Key) {
        while self.bytes > BUDGET_BYTES {
            let Some(victim) = self
                .resident
                .iter()
                .filter(|(key, _)| **key != keep)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| *key)
            else {
                return;
            };
            self.release(victim);
        }
    }

    /// Drop a texture and hand its memory to the retire ring. The GPU may
    /// still be reading the frames that referenced it, so the slab is not
    /// freed here.
    unsafe fn release(&mut self, key: Key) {
        if let Some(entry) = self.resident.remove(&key) {
            self.bytes -= entry.bytes;
            let slot = (self.clock as usize + RETIRE_FRAMES - 1) % RETIRE_FRAMES;
            self.retiring[slot].push(entry.slab);
        }
    }

    /// Resident texture bytes — the frame loop's boot log reads it.
    pub fn resident_bytes(&self) -> usize {
        self.bytes
    }
}

impl Default for AtlasCache {
    fn default() -> Self {
        Self::new()
    }
}
