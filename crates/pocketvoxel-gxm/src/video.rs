//! Mutable host-video texture for the remote bedroom computer.
//!
//! The wire format is CLUT8 because that is the PSP's native sampler and
//! keeps each frame small. GXM's palette binding is tied to a texture object,
//! so the Vita expands each committed frame into one persistent RGBA8888
//! texture instead. Updates happen only after `vita2d_start_drawing`, when
//! the previous scene is no longer sampling this storage.

use vita2d_sys as v2d;

use crate::gxm::GpuSlab;

pub struct VideoTexture {
    texture: v2d::SceGxmTexture,
    slab: GpuSlab,
    w: u32,
    h: u32,
}

impl VideoTexture {
    /// Allocate one linear, strided RGBA texture for a validated `.pkst`
    /// geometry.
    ///
    /// # Safety
    /// Render thread, after vita2d init, with the previous frame idle.
    pub unsafe fn new(w: u32, h: u32) -> Result<Self, &'static str> {
        if w == 0 || h == 0 || w > 512 || h > 512 || !w.is_power_of_two() || !h.is_power_of_two() {
            return Err("invalid remote-video geometry");
        }
        let bytes = (w as usize)
            .checked_mul(h as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or("remote-video geometry overflow")?;
        let slab = GpuSlab::alloc(bytes)?;
        core::ptr::write_bytes(slab.as_ptr(), 0, bytes);

        let mut texture: v2d::SceGxmTexture = core::mem::zeroed();
        if v2d::sceGxmTextureInitLinearStrided(
            &mut texture,
            slab.as_ptr().cast(),
            v2d::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_U8U8U8U8_ABGR,
            w,
            h,
            w * 4,
        ) < 0
        {
            slab.free();
            return Err("remote-video texture init failed");
        }
        // The 512x128 source is deliberately anamorphic and displayed at
        // the window's final aspect ratio; linear filtering avoids turning
        // that scale into hard horizontal bands.
        v2d::sceGxmTextureSetMinFilter(
            &mut texture,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        v2d::sceGxmTextureSetMagFilter(
            &mut texture,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        v2d::sceGxmTextureSetUAddrMode(
            &mut texture,
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );
        v2d::sceGxmTextureSetVAddrMode(
            &mut texture,
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP,
        );
        Ok(Self {
            texture,
            slab,
            w,
            h,
        })
    }

    pub fn geometry(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    /// Expand one little-endian ABGR palette and its index plane directly
    /// into GXM-mapped, uncached storage.
    ///
    /// # Safety
    /// Render thread, with the previous frame idle.
    pub unsafe fn update(&mut self, palette: &[u8], indices: &[u8]) -> bool {
        let pixels = (self.w as usize) * (self.h as usize);
        if palette.len() != 1024 || indices.len() != pixels {
            return false;
        }
        let mut colors = [0u32; 256];
        for (i, bytes) in palette.chunks_exact(4).enumerate() {
            colors[i] = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        let out = self.slab.as_ptr().cast::<u32>();
        for (i, &index) in indices.iter().enumerate() {
            out.add(i).write(colors[index as usize]);
        }
        true
    }

    pub fn texture(&self) -> *const v2d::SceGxmTexture {
        &self.texture
    }

    /// # Safety
    /// No submitted scene may still reference the texture.
    pub unsafe fn free(self) {
        self.slab.free();
    }
}
