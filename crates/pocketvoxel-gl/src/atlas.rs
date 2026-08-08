//! CLUT8 → RGBA texture cache.
//!
//! The pak carries every atlas page once, as swizzled 8-bit palette indices,
//! and the PSP backend samples exactly that: the GE has a hardware CLUT, so
//! `pocketvoxel-gu` binds one 256-entry palette per draw and the day tint is
//! a CLUT rewrite that costs a kilobyte. GXM has no palette sampler that
//! vitaGL exposes, so this backend resolves the palette on the CPU and keeps
//! the RESULT: one RGBA8888 texture per (page, frame, palette, tinted).
//!
//! Three facts make that affordable where it would not have been on a PSP:
//!
//! - the whole ATLS section is ~5.5 MB of indices across ~500 page frames,
//!   and a map draws a few dozen of them, so the working set is small;
//! - the Vita's user partition is measured in hundreds of megabytes, not the
//!   PSP's 24;
//! - the key includes the palette, so RED++'s "one terrain page, different
//!   roofs per map" stays one upload per (page, palette) pair instead of a
//!   rebind per draw.
//!
//! The day tint is the one thing that can invalidate in bulk: it multiplies
//! into the palette exactly as `pocketvoxel-gu::clut_for` does, so a `tint`
//! op drops every tinted texture. That is correct rather than clever — the
//! guest emits `tint` on map transitions, not per frame — and
//! [`AtlasCache::retint`] is where a future runtime that animates the tint
//! would pay for it.

use std::collections::HashMap;

use pocketvoxel_core::draw::modulate_rgb;
use pocketvoxel_core::pak::{Pak, unswizzle};

use crate::gl::{self, GLuint};

/// One resident texture's identity: the page, its animation frame, the VPAL
/// index the core resolved for the draw, and whether the day tint was folded
/// in (the GB UI layer samples the raw ramp, everything else the tinted one).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Key {
    pub page: u16,
    pub frame: u16,
    pub pal: u16,
    pub tinted: bool,
}

struct Entry {
    texture: GLuint,
    bytes: usize,
    /// Frame counter at the last bind — the eviction order.
    used: u32,
}

/// Resident-texture budget. Comfortably above any single map's working set
/// (a busy outdoor map binds well under 4 MB of pages), and far enough below
/// the Vita's free RAM that vitaGL's pools are never the reason a map fails
/// to draw. Exceeding it evicts least-recently-bound first.
const BUDGET_BYTES: usize = 24 * 1024 * 1024;

pub struct AtlasCache {
    resident: HashMap<Key, Entry>,
    /// Linear index buffer reused by every expansion (pages are at most a
    /// few hundred pixels a side; this never reallocates after the first
    /// large page).
    indices: Vec<u8>,
    /// RGBA staging buffer, reused for the same reason.
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
            indices: Vec::new(),
            texels: Vec::new(),
            tint: 0xffff_ffff,
            bytes: 0,
            clock: 0,
        }
    }

    /// Advance the eviction clock. Call once per frame.
    pub fn tick(&mut self) {
        self.clock = self.clock.wrapping_add(1);
    }

    /// Adopt this frame's day tint, dropping every texture baked with the
    /// previous one. Untinted (UI) textures survive.
    ///
    /// # Safety
    /// A GL context must be current and no scene may be mid-draw with one of
    /// the dropped textures still bound.
    pub unsafe fn retint(&mut self, tint: u32) {
        if tint == self.tint {
            return;
        }
        self.tint = tint;
        let stale: Vec<Key> = self
            .resident
            .keys()
            .copied()
            .filter(|key| key.tinted)
            .collect();
        for key in stale {
            self.release(key);
        }
    }

    /// The GL texture for `key`, uploading it on a miss. `None` when the pak
    /// has no such page (a hostile or truncated pak must not draw garbage).
    ///
    /// # Safety
    /// A GL context must be current on the calling thread.
    pub unsafe fn texture(&mut self, pak: &Pak, key: Key) -> Option<GLuint> {
        if let Some(entry) = self.resident.get_mut(&key) {
            entry.used = self.clock;
            return Some(entry.texture);
        }
        let page = pak.atlases.get(key.page as usize)?;
        let palette = pak.palettes.get(key.pal as usize)?;
        let (w, h) = (page.w as usize, page.h as usize);
        if w == 0 || h == 0 {
            return None;
        }

        // The GE consumes swizzled texels in place; a sampler wants them
        // linear, so this is the same one-time linearization the software
        // rasterizer does at load (pocketvoxel-sim/src/raster.rs).
        self.indices = unswizzle(w, h, page.frame(key.frame)).ok()?;
        self.texels.clear();
        self.texels.reserve(w * h);
        // A VPAL entry is ABGR (0xAABBGGRR), which on this little-endian
        // machine is already the R,G,B,A byte order GL_RGBA/GL_UNSIGNED_BYTE
        // reads — so the palette lookup writes the texel verbatim and no
        // channel shuffle exists to get backwards.
        if key.tinted {
            let tint = self.tint;
            for &index in &self.indices {
                self.texels.push(modulate_rgb(palette[index as usize], tint));
            }
        } else {
            for &index in &self.indices {
                self.texels.push(palette[index as usize]);
            }
        }

        let mut texture: GLuint = 0;
        gl::glGenTextures(1, &mut texture);
        if texture == 0 {
            return None;
        }
        gl::glBindTexture(gl::GL_TEXTURE_2D, texture);
        gl::glTexImage2D(
            gl::GL_TEXTURE_2D,
            0,
            gl::GL_RGBA as i32,
            w as i32,
            h as i32,
            0,
            gl::GL_RGBA,
            gl::GL_UNSIGNED_BYTE,
            self.texels.as_ptr().cast(),
        );
        // Pixel art: nearest everywhere, no mips cooked — the same choice
        // pocketvoxel-gu makes, and the reason a 2x native raster still
        // reads as the same picture rather than a blurred one.
        gl::glTexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_MIN_FILTER, gl::GL_NEAREST as i32);
        gl::glTexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_MAG_FILTER, gl::GL_NEAREST as i32);
        // Clamp: cooked UVs stay inside the page, and clamping means a
        // precision spill lands on the edge texel instead of wrapping to the
        // opposite side of an atlas.
        gl::glTexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_WRAP_S, gl::GL_CLAMP_TO_EDGE as i32);
        gl::glTexParameteri(gl::GL_TEXTURE_2D, gl::GL_TEXTURE_WRAP_T, gl::GL_CLAMP_TO_EDGE as i32);

        let bytes = w * h * 4;
        self.bytes += bytes;
        self.resident.insert(
            key,
            Entry {
                texture,
                bytes,
                used: self.clock,
            },
        );
        self.evict_to_budget(key);
        Some(texture)
    }

    /// Drop least-recently-bound textures until the budget holds. `keep` is
    /// the key just uploaded — evicting the texture the caller is about to
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

    unsafe fn release(&mut self, key: Key) {
        if let Some(entry) = self.resident.remove(&key) {
            gl::glDeleteTextures(1, &entry.texture);
            self.bytes -= entry.bytes;
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
