//! Browser ABI for Pocket Voxel.
//!
//! Gameplay stays in the existing TypeScript guest. This crate owns the same
//! retained Rust [`Scene`], VXPK reader, draw-list builder, software rasterizer,
//! and chip synth used by native hosts. The JS bridge applies the guest's ops,
//! advances one fixed tick, and presents the returned RGBA framebuffer.

use pocketvoxel_core::draw;
use pocketvoxel_core::pak::{self, AlignedBlob, Pak};
use pocketvoxel_core::scene::{OpResult, Scene};
use pocketvoxel_core::spec::{self, op};
use pocketvoxel_sim::raster::{self, AtlasCache, Frame};
use self_cell::self_cell;
use wasm_bindgen::prelude::*;

const MAX_OP_ARGS: usize = 7;
/// Bound one host request to one second of stereo PCM. Normal browser pumps
/// ask for 735 frames; the cap prevents an untrusted caller from trapping the
/// instance with a multi-gigabyte allocation.
const MAX_AUDIO_FRAMES: u32 = 44_100;

self_cell!(
    /// A parsed pak and the aligned bytes every borrowed pool points into.
    /// `self_cell` guarantees the dependent is dropped before its owner.
    struct OwnedPak {
        owner: AlignedBlob,

        #[covariant]
        dependent: Pak,
    }
);

fn js_error(message: &str) -> JsValue {
    #[cfg(target_arch = "wasm32")]
    {
        JsValue::from_str(message)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // wasm-bindgen's string constructors intentionally panic off wasm32.
        // Native tests only need an error sentinel; browser callers receive
        // the full reader message through the branch above.
        let _ = message;
        JsValue::NULL
    }
}

fn parse_owned(bytes: &[u8]) -> Result<OwnedPak, JsValue> {
    OwnedPak::try_new(AlignedBlob::from_bytes(bytes), |blob| {
        pak::read(blob.bytes())
    })
    .map_err(js_error)
}

/// One browser runtime. A page may create more than one; no mutable global
/// state is used. Returned framebuffer and PCM pointers remain valid until the
/// next mutable method call on this object.
#[wasm_bindgen]
pub struct PocketVoxel {
    pak: OwnedPak,
    scene: Scene,
    atlas: AtlasCache,
    frame: Frame,
    pcm: Vec<i16>,
}

/// The WebAssembly.Memory backing every pointer returned by [`PocketVoxel`].
/// wasm-bindgen keeps its raw instance private, so pointer-based framebuffer,
/// pak-section and PCM APIs need this explicit accessor.
#[wasm_bindgen]
pub fn wasm_memory() -> JsValue {
    #[cfg(target_arch = "wasm32")]
    {
        wasm_bindgen::memory()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        JsValue::NULL
    }
}

#[wasm_bindgen]
impl PocketVoxel {
    /// Validate and mount one complete VXPK. wasm-bindgen copies the incoming
    /// Uint8Array into linear memory; `AlignedBlob` makes the retained copy
    /// 16-byte aligned for the zero-copy vertex and index pools.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<PocketVoxel, JsValue> {
        let pak = parse_owned(bytes)?;
        let atlas = pak.with_dependent(|_, parsed| AtlasCache::new(parsed));
        let mut scene = Scene::new();
        // The browser is the desktop host. Quality is host policy and may be
        // changed later through `quality`; the guest never names a rung.
        scene.op(op::QUALITY, &[spec::quality_tier::DESKTOP as i32], None);
        Ok(PocketVoxel {
            pak,
            scene,
            atlas,
            frame: Frame::new(),
            pcm: Vec::new(),
        })
    }

    /// Apply one numeric surface op without allocating an argument array in
    /// JavaScript. `argc` selects the prefix of a0..a6; the current contract's
    /// widest op (`ent`) has seven arguments.
    #[allow(clippy::too_many_arguments)]
    pub fn op(
        &mut self,
        code: u32,
        argc: u32,
        a0: i32,
        a1: i32,
        a2: i32,
        a3: i32,
        a4: i32,
        a5: i32,
        a6: i32,
    ) -> bool {
        let argc = argc as usize;
        if argc > MAX_OP_ARGS {
            return false;
        }
        let args = [a0, a1, a2, a3, a4, a5, a6];
        self.scene.op(code, &args[..argc], None);
        true
    }

    /// Apply the one string-bearing surface op (`uiText`). Unknown codes stay
    /// defensive no-ops through `Scene::op`, just like native hosts.
    pub fn op_text(&mut self, code: u32, x: i32, y: i32, text: &str) {
        self.scene.op(code, &[x, y], Some(text));
    }

    /// Select a runtime quality rung. Returns false instead of silently
    /// clamping an unknown tier.
    pub fn quality(&mut self, tier: u8) -> bool {
        if tier as usize >= spec::QUALITY.len() {
            return false;
        }
        self.scene.op(op::QUALITY, &[tier as i32], None);
        true
    }

    /// Advance the retained presentation clock exactly once. The host calls
    /// this after the TypeScript guest's `frame(buttons)` returned.
    pub fn tick(&mut self) {
        self.scene.tick();
    }

    /// Build and rasterize the current draw list. Returns a byte offset into
    /// exported wasm memory holding 480x272 tightly-packed RGBA8 pixels.
    /// Rebuild the JS typed view after every call because wasm memory may grow.
    pub fn render(&mut self) -> u32 {
        let list = self
            .pak
            .with_dependent(|_, parsed| draw::build(&self.scene, parsed));
        self.frame = self
            .pak
            .with_dependent(|_, parsed| raster::render(&list, parsed, &self.atlas));
        self.framebuffer_ptr()
    }

    pub fn framebuffer_ptr(&self) -> u32 {
        self.frame.color.as_ptr() as usize as u32
    }

    pub fn framebuffer_len(&self) -> u32 {
        (self.frame.color.len() * core::mem::size_of::<u32>()) as u32
    }

    pub fn width(&self) -> u32 {
        raster::W as u32
    }

    pub fn height(&self) -> u32 {
        raster::H as u32
    }

    /// Borrowed GAME JSON in wasm memory. Decode this once at guest boot.
    pub fn gamedata_ptr(&self) -> u32 {
        self.pak
            .with_dependent(|_, parsed| parsed.game.as_ptr() as usize as u32)
    }

    pub fn gamedata_len(&self) -> u32 {
        self.pak
            .with_dependent(|_, parsed| parsed.game.len() as u32)
    }

    /// Borrowed AUDI payload in wasm memory. It is empty when this pak has no
    /// audio; the guest then runs silently, as on native hosts.
    pub fn audiodata_ptr(&self) -> u32 {
        self.pak
            .with_dependent(|_, parsed| parsed.audio.as_ptr() as usize as u32)
    }

    pub fn audiodata_len(&self) -> u32 {
        self.pak
            .with_dependent(|_, parsed| parsed.audio.len() as u32)
    }

    /// The synth accepts rates that divide 44.1 kHz. Browsers can consume the
    /// default 44.1 kHz stream directly and let Web Audio resample to the
    /// AudioContext's device rate.
    pub fn set_audio_rate(&mut self, rate: u32) -> bool {
        self.scene.audio.set_rate(rate)
    }

    pub fn audio_rate(&self) -> u32 {
        self.scene.audio.rate()
    }

    /// Render `frames` interleaved stereo i16 samples and return their byte
    /// offset in wasm memory. `pcm_len` is the sample count (frames * 2).
    pub fn render_audio(&mut self, frames: u32) -> u32 {
        self.pcm.clear();
        if frames > MAX_AUDIO_FRAMES {
            return 0;
        }
        let Some(samples) = (frames as usize).checked_mul(2) else {
            return 0;
        };
        self.pcm.resize(samples, 0);
        self.pak.with_dependent(|_, parsed| {
            self.scene
                .render_audio(parsed, frames as usize, &mut self.pcm)
        });
        self.pcm_ptr()
    }

    pub fn pcm_ptr(&self) -> u32 {
        self.pcm.as_ptr() as usize as u32
    }

    pub fn pcm_len(&self) -> u32 {
        self.pcm.len() as u32
    }

    /// `[tick, ops_applied]`, matching the core's packed debug stats.
    pub fn stats(&mut self) -> Vec<u32> {
        match self.scene.op(op::STATS, &[], None) {
            OpResult::Stats(bytes) => vec![
                u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
                u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            ],
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketvoxel_core::pak::builder::{ChunkDef, PakBuilder};
    use pocketvoxel_core::pak::{MeshRange, PakVert};
    use pocketvoxel_core::spec::{Q4, atlas_kind, mesh_kind};

    fn tiny_pak() -> Vec<u8> {
        let mut builder = PakBuilder::new();
        let mut palette = [0xff00_0000; 256];
        palette[1] = 0xff40_b040;
        for _ in 0..4 {
            builder.palette(palette);
        }
        let texels = vec![1u8; 16 * 16];
        builder.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&texels]);
        builder.atlas_linear(16, 16, atlas_kind::SPRITES, &[&texels]);
        builder.atlas_linear(16, 16, atlas_kind::UI, &[&texels]);
        builder.atlas_linear(16, 16, atlas_kind::PICS, &[&texels]);
        let verts = [
            PakVert {
                u: 0,
                v: 0,
                abgr: u32::MAX,
                x: 0,
                y: 0,
                z: 0,
                pad: 0,
            },
            PakVert {
                u: 32767,
                v: 0,
                abgr: u32::MAX,
                x: 128,
                y: 0,
                z: 0,
                pad: 0,
            },
            PakVert {
                u: 32767,
                v: 32767,
                abgr: u32::MAX,
                x: 128,
                y: 0,
                z: 128,
                pad: 0,
            },
            PakVert {
                u: 0,
                v: 32767,
                abgr: u32::MAX,
                x: 0,
                y: 0,
                z: 128,
                pad: 0,
            },
        ];
        let terrain = builder.mesh(&verts, &[0, 1, 2, 0, 2, 3]);
        let mut meshes = [MeshRange::default(); spec::MESH_KINDS];
        meshes[mesh_kind::TERRAIN as usize] = terrain;
        builder.map(
            7,
            &[ChunkDef {
                cx: 0,
                cy: 0,
                aabb_min: [0, 0, 0],
                aabb_max: [128, 0, 128],
                bake_page: spec::BAKE_PAGE_NONE,
                meshes,
            }],
        );
        builder.stamps(7, &[]);
        builder.game(br#"{"browser":true}"#);
        builder.audio(&[], &[]);
        builder.finish()
    }

    #[test]
    fn validates_ops_ticks_and_renders_non_flat_rgba() {
        let mut runtime = PocketVoxel::new(&tiny_pak()).expect("valid pak");
        assert_eq!(runtime.width(), 480);
        assert_eq!(runtime.height(), 272);
        assert!(runtime.op(op::MAP_SHOW, 4, 0, 7, 0, 0, 0, 0, 0));
        assert!(runtime.op(op::CAM, 2, 64 * Q4, 64 * Q4, 0, 0, 0, 0, 0));
        assert!(!runtime.op(op::CAM, 8, 0, 0, 0, 0, 0, 0, 0));
        runtime.tick();
        runtime.render();
        assert_eq!(runtime.framebuffer_len() as usize, 480 * 272 * 4);
        let first = runtime.frame.color[0];
        assert!(runtime.frame.color.iter().any(|&pixel| pixel != first));
        assert_eq!(runtime.stats()[0], 1);
    }

    #[test]
    fn exposes_sections_quality_text_and_pcm() {
        let mut runtime = PocketVoxel::new(&tiny_pak()).expect("valid pak");
        assert_eq!(runtime.gamedata_len(), br#"{"browser":true}"#.len() as u32);
        assert_eq!(runtime.audiodata_len(), 0);
        assert!(runtime.quality(spec::quality_tier::PSP));
        assert!(!runtime.quality(spec::QUALITY.len() as u8));
        runtime.op_text(op::UI_TEXT, 1, 1, "AB");
        assert_eq!(runtime.scene.ui_text.as_ref().unwrap().text, "AB");
        assert!(runtime.set_audio_rate(11025));
        assert!(!runtime.set_audio_rate(48000));
        runtime.render_audio(184);
        assert_eq!(runtime.pcm_len(), 368);
        assert!(runtime.pcm.iter().all(|&sample| sample == 0));
        assert_eq!(runtime.render_audio(MAX_AUDIO_FRAMES + 1), 0);
        assert_eq!(runtime.pcm_len(), 0);
    }

    #[test]
    fn rejects_invalid_pak() {
        assert!(PocketVoxel::new(b"not a pak").is_err());
    }
}
