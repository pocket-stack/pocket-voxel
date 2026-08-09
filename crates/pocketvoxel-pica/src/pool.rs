//! Per-frame bump arena over LINEAR memory the host owns.
//!
//! This is `pocketvoxel-gu`'s [`FramePool`] with one structural difference,
//! and it is the difference that defines this backend: the PSP points the GE
//! straight at the pak, but `BufInfo_Add` rejects any pointer below physical
//! `0x18000000`, so **every vertex and every index the PICA200 reads has to
//! be copied into `linearAlloc` memory first**. `linearAlloc` is libctru, so
//! the host allocates the region once at boot and hands it here; this arena
//! only sub-allocates inside it.
//!
//! Two more consequences of that ownership split:
//!
//! - **The arena cannot grow.** The GE pool pushes another 1 MB `Box` when it
//!   runs out; there is no equivalent here, so an allocation that does not fit
//!   returns `None`, the caller DROPS that draw, and [`FrameArena::overflow`]
//!   counts it. A dropped mesh is a hole in one frame; a panic on a handheld
//!   is the whole run.
//! - **Rewind is banked.** The GPU reads this memory asynchronously, so a bank
//!   may only be rewound once the GPU is done with the frame that filled it.
//!   [`FrameArena::rotate`] moves to the next bank each frame; with `banks >=
//!   2` and a host loop whose `C3D_FrameBegin` waits for the GPU command queue
//!   to drain, the bank being rewound is two frames old and provably idle.
//!   `banks == 1` is legal and means the host syncs the GPU before recording.
//!
//! Sizing (the brief's "well above the GE pool's 1 MB"): the worst sampled
//! story frame at the shipped `psp` rung is ~70k triangles (docs/VOXEL.md
//! §4a) and the pre-ground-bake worst was 110k. At 6 indices and 4 vertices
//! per quad that is ~4.7 MB of vertices plus ~0.9 MB of indices for a 140k
//! triangle frame — call it **6 MiB per bank**, 12 MiB for the default two,
//! against the Old 3DS's 32 MiB linear heap. [`FrameArena::high_water`]
//! reports what a run actually used, so the number is measurable rather than
//! assumed.

use core::ptr::NonNull;

/// Every block is 16-byte aligned, the alignment the pak's own pools carry
/// and the one the PICA's attribute fetch is happiest with.
pub const ALIGN: usize = 16;

/// A banked bump arena over host-provided linear memory.
pub struct FrameArena {
    base: Option<NonNull<u8>>,
    /// Usable bytes per bank (16-aligned, floor).
    bank_len: usize,
    banks: usize,
    bank: usize,
    used: usize,
    high_water: usize,
    overflow: u32,
}

// The host is single-threaded (one QuickJS worker); the arena is never shared.
unsafe impl Send for FrameArena {}

impl FrameArena {
    pub const fn new() -> Self {
        Self {
            base: None,
            bank_len: 0,
            banks: 0,
            bank: 0,
            used: 0,
            high_water: 0,
            overflow: 0,
        }
    }

    /// Adopt `len` bytes at `base` as `banks` equal banks. The region must be
    /// `linearAlloc`/`vramAlloc` memory that outlives every frame recorded
    /// against it; a misaligned base is aligned up (and the region shortened)
    /// rather than rejected.
    ///
    /// Passing a null base or zero banks leaves the arena empty, which makes
    /// every allocation fail and every draw drop — the frame renders as a
    /// clear. That is the intended failure mode for a host whose
    /// `linearAlloc` came back NULL.
    ///
    /// # Safety
    /// `base .. base + len` must be valid, writable, and live for as long as
    /// the GPU may read frames recorded into it.
    pub unsafe fn adopt(&mut self, base: *mut u8, len: usize, banks: usize) {
        self.base = None;
        self.bank_len = 0;
        self.banks = 0;
        self.bank = 0;
        self.used = 0;
        self.high_water = 0;
        self.overflow = 0;
        if base.is_null() || banks == 0 {
            return;
        }
        let addr = base as usize;
        let aligned = addr.div_ceil(ALIGN) * ALIGN;
        let skew = aligned - addr;
        if skew >= len {
            return;
        }
        let usable = len - skew;
        let bank_len = (usable / banks) / ALIGN * ALIGN;
        if bank_len == 0 {
            return;
        }
        self.base = NonNull::new(base.add(skew));
        self.bank_len = bank_len;
        self.banks = banks;
    }

    /// Move to the next bank and rewind it. Call once per recorded frame,
    /// BEFORE staging anything — never mid-frame.
    pub fn rotate(&mut self) {
        if self.banks == 0 {
            return;
        }
        self.bank = (self.bank + 1) % self.banks;
        self.used = 0;
    }

    /// Bump-allocate `bytes`, 16-aligned, inside the current bank. `None`
    /// when the bank cannot hold it: the caller drops the draw.
    pub fn alloc(&mut self, bytes: usize) -> Option<*mut u8> {
        let base = self.base?;
        let aligned = bytes.div_ceil(ALIGN) * ALIGN;
        let end = self.used.checked_add(aligned)?;
        if end > self.bank_len {
            self.overflow = self.overflow.saturating_add(1);
            return None;
        }
        // Safety: `bank < banks` and `end <= bank_len` by the checks above,
        // and `adopt` proved `banks * bank_len` fits the adopted region.
        let p = unsafe { base.as_ptr().add(self.bank * self.bank_len + self.used) };
        self.used = end;
        if end > self.high_water {
            self.high_water = end;
        }
        Some(p)
    }

    /// Copy `data` into the arena. `None` on overflow (nothing is written).
    pub fn upload(&mut self, data: &[u8]) -> Option<*mut u8> {
        let dst = self.alloc(data.len())?;
        // Safety: `alloc` returned a block of at least `data.len()` bytes
        // inside the adopted region, and the arena never aliases the source.
        unsafe { core::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len()) };
        Some(dst)
    }

    /// Byte offset of `ptr` from the adopted base — what a command carries,
    /// so the C side indexes one known pointer instead of trusting an
    /// absolute address across the ABI.
    ///
    /// Address arithmetic only: nothing is dereferenced, and a pointer that
    /// did not come from [`alloc`](Self::alloc) reads back as 0 rather than
    /// as a wild offset.
    pub fn offset_of(&self, ptr: *mut u8) -> u32 {
        match self.base {
            Some(base) => (ptr as usize).saturating_sub(base.as_ptr() as usize) as u32,
            None => 0,
        }
    }

    /// The adopted (aligned) base — the pointer every command offset is
    /// relative to.
    pub fn base(&self) -> *mut u8 {
        match self.base {
            Some(b) => b.as_ptr(),
            None => core::ptr::null_mut(),
        }
    }

    pub fn used(&self) -> usize {
        self.used
    }
    pub fn high_water(&self) -> usize {
        self.high_water
    }
    pub fn bank_len(&self) -> usize {
        self.bank_len
    }
    pub fn banks(&self) -> usize {
        self.banks
    }
    /// Allocations refused since [`adopt`](Self::adopt) — draws this backend
    /// dropped because the arena is too small for the content.
    pub fn overflow(&self) -> u32 {
        self.overflow
    }
}

impl Default for FrameArena {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn banks_rotate_and_never_overlap() {
        let mut mem = vec![0u8; 4096];
        let mut a = FrameArena::new();
        unsafe { a.adopt(mem.as_mut_ptr(), mem.len(), 2) };
        assert_eq!(a.banks(), 2);
        assert_eq!(a.bank_len(), 2048);

        a.rotate();
        let p0 = a.alloc(64).unwrap();
        let o0 = a.offset_of(p0);
        a.rotate();
        let p1 = a.alloc(64).unwrap();
        let o1 = a.offset_of(p1);
        assert_ne!(o0, o1, "consecutive frames land in different banks");
        assert!(o1.abs_diff(o0) >= 2048, "banks are bank_len apart");

        // Two rotations later the first bank comes back around.
        a.rotate();
        let p2 = a.alloc(64).unwrap();
        assert_eq!(a.offset_of(p2), o0, "bank 0 rewound, not grown");
    }

    #[test]
    fn allocations_are_16_aligned_and_bump() {
        let mut mem = vec![0u8; 1024];
        let mut a = FrameArena::new();
        unsafe { a.adopt(mem.as_mut_ptr(), mem.len(), 1) };
        let p0 = a.alloc(1).unwrap();
        let p1 = a.alloc(1).unwrap();
        assert_eq!(a.offset_of(p0) % 16, 0);
        assert_eq!(a.offset_of(p1), a.offset_of(p0) + 16, "1 byte still burns 16");
    }

    /// The failure mode the brief asks for: refuse, count, keep going.
    #[test]
    fn overflow_refuses_instead_of_panicking() {
        let mut mem = vec![0u8; 256];
        let mut a = FrameArena::new();
        unsafe { a.adopt(mem.as_mut_ptr(), mem.len(), 1) };
        assert!(a.alloc(256).is_some());
        assert!(a.alloc(16).is_none(), "a full bank refuses");
        assert!(a.alloc(1 << 30).is_none(), "an absurd request refuses");
        assert_eq!(a.overflow(), 2);
        assert_eq!(a.high_water(), 256);
        // And it recovers: the next frame's bank is rewound and usable.
        a.rotate();
        assert!(a.alloc(16).is_some());
    }

    #[test]
    fn an_unadopted_arena_refuses_everything() {
        let mut a = FrameArena::new();
        assert!(a.alloc(16).is_none());
        assert!(a.base().is_null());
        a.rotate(); // must not divide by zero
        let mut mem = vec![0u8; 32];
        unsafe { a.adopt(core::ptr::null_mut(), 4096, 2) };
        assert!(a.alloc(16).is_none(), "a NULL linearAlloc drops every draw");
        unsafe { a.adopt(mem.as_mut_ptr(), mem.len(), 64) };
        assert!(a.alloc(1).is_none(), "banks smaller than the alignment");
    }

    #[test]
    fn upload_copies_bytes() {
        let mut mem = vec![0u8; 256];
        let mut a = FrameArena::new();
        unsafe { a.adopt(mem.as_mut_ptr(), mem.len(), 1) };
        let src = [1u8, 2, 3, 4, 5];
        let p = a.upload(&src).unwrap();
        let back = unsafe { core::slice::from_raw_parts(p, src.len()) };
        assert_eq!(back, &src);
    }
}
