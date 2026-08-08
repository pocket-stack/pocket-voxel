//! The runtime state one Pocket Voxel process holds on the 3DS: the retained
//! [`Scene`] the guest drives, the pak's borrowed sections, and the counters.
//!
//! This is the ownership split of `crates/pocketvoxel-psp/src/main.rs` with
//! the QuickJS half handed to C (see [`crate::voxel`]). What stayed here is
//! everything that decides what the frame contains:
//!
//! ```text
//! pak -> Scene <- guest ops        (crate::voxel, dispatched below)
//!         |
//!         +-- tick()               the only clock in the runtime
//!         +-- draw::build()        the DrawList both other backends consume
//!               |
//!               +-- pocketvoxel_pica::Renderer::record()
//! ```
//!
//! Nothing here touches the GPU, allocates linear memory or owns the frame
//! lifecycle; the C side does, through `pocketvoxel_pica.h`.

use core::ffi::{CStr, c_char, c_void};

use pocketvoxel_core::draw;
use pocketvoxel_core::pak::Pak;
use pocketvoxel_core::scene::{OpResult, STATS_LEN, Scene};
use pocketvoxel_core::spec::{QUALITY_TIER_DEFAULT, op};

use crate::voxel::{self, OpDef, op_kind};

/// The pak blob's required alignment. The reader rejects a blob whose u16 and
/// vertex pools are 2/4-byte misaligned; this is the stricter number every
/// VXPK section offset is already a multiple of (`VXPK_ALIGN`), so a
/// 16-aligned base makes every borrowed pool aligned by construction.
pub const PAK_ALIGN: usize = 16;

/// The counters, as C sees them. Mirrored by `PvVox3dsStats`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub ticks: u32,
    pub presents: u32,
    pub ops: u32,
    pub ops_rejected: u32,
    pub scene_tick: u32,
    pub draw_items: u32,
    pub map_swaps: u32,
    pub quality_tier: u32,
}

const _: () = assert!(core::mem::size_of::<Stats>() == 32);

pub struct Host {
    scene: Scene,
    /// The parse `pv3ds_load_pak` retained. pocketvoxel-pica owns the storage
    /// (one parse feeds both the DrawList and the texture expansion); this is
    /// the handle, and it is what makes "no pak loaded" a state of THIS host
    /// rather than of the process.
    pak: Option<&'static Pak<'static>>,
    /// The pak's GAME section (gameplay JSON), borrowed from the leaked blob.
    game: &'static [u8],
    /// The pak's AUDI section, borrowed from the same blob. Empty is a pak
    /// without audio, which `audiodata()` answers as undefined.
    audio: &'static [u8],
    audio_wanted: bool,
    map_swapped: bool,
    ticks: u32,
    presents: u32,
    ops: u32,
    ops_rejected: u32,
    draw_items: u32,
    map_swaps: u32,
    arena: *mut u8,
    arena_bytes: usize,
    banks: usize,
    error: *const c_char,
}

impl Host {
    /// A host with a fresh Scene and no pak.
    ///
    /// The Scene boots on quality tier 0 — the `psp` rung — and **nothing in
    /// this crate ever calls `quality`**: there is no such entry in the op
    /// table, so the guest cannot climb, and no host code sets one. That is
    /// deliberate and it is the PSP EBOOT's behaviour, which is what the
    /// shipped goldens were recorded at. A weaker 3DS rung cannot be appended
    /// either: the ladder's tier ids are dense and in declaration order,
    /// climbing is non-decreasing, and the last rung is the identity that
    /// `tests/goldens/voxel/*-max.hashes` anchor, so inserting one would
    /// renumber `desktop`.
    pub fn new() -> Self {
        Self {
            scene: Scene::new(),
            pak: None,
            game: &[],
            audio: &[],
            audio_wanted: false,
            map_swapped: false,
            ticks: 0,
            presents: 0,
            ops: 0,
            ops_rejected: 0,
            draw_items: 0,
            map_swaps: 0,
            arena: core::ptr::null_mut(),
            arena_bytes: 0,
            banks: 0,
            error: c"".as_ptr(),
        }
    }

    fn fail(&mut self, msg: &'static CStr) -> i32 {
        self.error = msg.as_ptr();
        -1
    }

    fn reject(&mut self, msg: &'static CStr) -> i32 {
        self.ops_rejected = self.ops_rejected.wrapping_add(1);
        self.fail(msg)
    }

    pub fn last_error(&self) -> *const c_char {
        self.error
    }

    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Adopt the host's `linearAlloc` region and reset everything else.
    ///
    /// # Safety
    /// `arena .. arena + arena_bytes` must be writable linear memory that
    /// outlives every frame the GPU may still be reading.
    pub unsafe fn init(&mut self, arena: *mut c_void, arena_bytes: u32, banks: u32) -> i32 {
        *self = Host::new();
        self.arena = arena as *mut u8;
        self.arena_bytes = arena_bytes as usize;
        self.banks = banks as usize;
        pocketvoxel_pica::global().adopt_arena(self.arena, self.arena_bytes, self.banks);
        if pocketvoxel_pica::global().arena_base().is_null() {
            return self.fail(c"pv3ds_init: the arena is null or too small to bank");
        }
        0
    }

    /// Parse the pak and hand its sections to the surface. The blob is
    /// borrowed for the life of the process, never copied.
    ///
    /// # Safety
    /// `blob .. blob + len` must stay valid and unmoved for the whole run.
    pub unsafe fn load_pak(&mut self, blob: *const c_void, len: u32) -> i32 {
        if blob.is_null() || len == 0 {
            return self.fail(c"pv3ds_load_pak: null or empty pak blob");
        }
        if !(blob as usize).is_multiple_of(PAK_ALIGN) {
            return self.fail(c"pv3ds_load_pak: the pak blob must be 16-byte aligned");
        }
        if self.arena.is_null() {
            return self.fail(c"pv3ds_load_pak: no arena — pv3ds_init has not run, or was refused");
        }
        // One parse for both halves: pocketvoxel-pica keeps the `Pak` and the
        // DrawList is built against that same parse rather than a second one.
        if pocketvoxel_pica::cabi::pv_pica_init(
            blob,
            len,
            self.arena as *mut c_void,
            self.arena_bytes as u32,
            self.banks as u32,
        ) != 0
        {
            self.error = pocketvoxel_pica::cabi::pv_pica_last_error();
            return -1;
        }
        let Some(pak) = pocketvoxel_pica::global_pak() else {
            return self.fail(c"pv3ds_load_pak: the pak parsed but was not retained");
        };
        // A fresh Scene per pak, exactly as the EBOOT's `voxel::init` builds
        // one; the GAME and AUDI sections borrow the leaked blob, so the
        // 'static they carry is honest.
        self.scene = Scene::new();
        self.pak = Some(pak);
        self.game = pak.game;
        self.audio = pak.audio;
        self.audio_wanted = false;
        self.map_swapped = false;
        self.error = c"".as_ptr();
        0
    }

    pub fn pak(&self) -> Option<&'static Pak<'static>> {
        self.pak
    }

    // -- the surface --------------------------------------------------------

    /// Dispatch one op, after the PSP host's argument marshalling. Returns
    /// what the core answered, so the data ops can pick their payload out.
    fn apply(&mut self, def: &OpDef, args: &[i32], text: Option<&str>) -> OpResult {
        let (buf, n) = voxel::marshal(def, args);
        // Both flags are set BEFORE dispatch, as the PSP host sets them: the
        // audio one from the op's identity, the warp one from the same
        // defaulted argument 0 the Scene is about to read.
        if def.audio {
            self.audio_wanted = true;
        }
        if def.code == op::MAP_SHOW && buf[0] == 0 {
            self.map_swapped = true;
            self.map_swaps = self.map_swaps.wrapping_add(1);
        }
        self.ops = self.ops.wrapping_add(1);
        self.scene.op(def.code, &buf[..n], text)
    }

    /// One numeric op.
    pub fn op(&mut self, code: u32, args: &[i32]) -> i32 {
        let Some(def) = voxel::find(code) else {
            return self.reject(c"pv3ds_op: no such op code");
        };
        if def.kind != op_kind::NUMERIC {
            return self.reject(c"pv3ds_op: that op is not a numeric op");
        }
        self.apply(def, args, None);
        0
    }

    /// The one string-bearing op. A missing or non-UTF-8 string is a no-op
    /// that never reaches the Scene — the PSP host's failed
    /// `core::str::from_utf8` does the same.
    pub fn op_text(&mut self, code: u32, args: &[i32], text: Option<&str>) -> i32 {
        let Some(def) = voxel::find(code) else {
            return self.reject(c"pv3ds_op_text: no such op code");
        };
        if def.kind != op_kind::TEXT {
            return self.reject(c"pv3ds_op_text: that op takes no string");
        }
        let Some(text) = text else {
            return self.reject(c"pv3ds_op_text: the string argument is missing or not UTF-8");
        };
        self.apply(def, args, Some(text));
        0
    }

    /// `gamedata()`: the GAME section, after dispatching the op. `None` when
    /// no pak is loaded — the guest is then answered undefined and boots into
    /// nothing, which is louder than an empty string.
    pub fn gamedata(&mut self) -> Option<&'static [u8]> {
        let def = voxel::find(op::GAMEDATA)?;
        if self.pak().is_none() {
            self.reject(c"pv3ds_gamedata: no pak loaded");
            return None;
        }
        self.apply(def, &[], None);
        Some(self.game)
    }

    /// `audiodata()`: the AUDI section, after dispatching the op. `None` for a
    /// pak that carries no audio, which the guest reads as "run silent".
    pub fn audiodata(&mut self) -> Option<&'static [u8]> {
        let def = voxel::find(op::AUDIODATA)?;
        if self.pak().is_none() {
            self.reject(c"pv3ds_audiodata: no pak loaded");
            return None;
        }
        self.apply(def, &[], None);
        if self.audio.is_empty() { None } else { Some(self.audio) }
    }

    /// `stats()`: dispatch, and hand back the core's packed counters. The
    /// guest is answered undefined regardless (the PSP host's behaviour, and
    /// what the guest's `QuickJsHost` expects).
    pub fn op_stats(&mut self) -> Option<[u8; STATS_LEN]> {
        let def = voxel::find(op::STATS)?;
        match self.apply(def, &[], None) {
            OpResult::Stats(s) => Some(s),
            _ => None,
        }
    }

    /// Read-and-clear the warp-landing flag.
    pub fn take_map_swapped(&mut self) -> bool {
        core::mem::take(&mut self.map_swapped)
    }

    /// True once the guest has emitted any audio op.
    pub fn audio_wanted(&self) -> bool {
        self.audio_wanted
    }

    // -- the frame ----------------------------------------------------------

    /// Advance the tick clock — the whole host half of one guest tick, since
    /// the guest's own turn happens in C. Exactly once per tick, after the
    /// tick's ops: tile animation, cursors and the camera tween all read it,
    /// and the sim's replay closes a tick in the same order.
    pub fn tick(&mut self) {
        self.scene.tick();
        self.ticks = self.ticks.wrapping_add(1);
    }

    /// Build this frame's DrawList and record it into pocketvoxel-pica.
    ///
    /// The list is built from the Scene as the ops left it, in the core's own
    /// order, and handed over untouched: this crate makes no drawing decision
    /// of its own, which is what keeps the 3DS, the PSP GE and the software
    /// rasterizer three implementations of one list.
    pub fn present(&mut self) -> i32 {
        let Some(pak) = self.pak() else {
            return self.fail(c"pv3ds_present: no pak loaded");
        };
        let list = draw::build(&self.scene, pak);
        self.draw_items = list.items.len() as u32;
        // `record` rewinds one arena bank, so the caller owes it the GPU sync
        // documented in pocketvoxel_3ds.h.
        pocketvoxel_pica::global().record(&list, pak);
        self.presents = self.presents.wrapping_add(1);
        0
    }

    pub fn stats(&self) -> Stats {
        Stats {
            ticks: self.ticks,
            presents: self.presents,
            ops: self.ops,
            ops_rejected: self.ops_rejected,
            scene_tick: self.scene.tick,
            draw_items: self.draw_items,
            map_swaps: self.map_swaps,
            quality_tier: self.scene.quality as u32,
        }
    }
}

impl Default for Host {
    fn default() -> Self {
        Self::new()
    }
}

// The rung claim the header makes, checked where it is cheapest to check.
const _: () = assert!(QUALITY_TIER_DEFAULT == 0);

/// The circle pad as one direction: past `deadzone` on either axis, the
/// DOMINANT axis wins and the other is discarded, because the world is a walk
/// grid and a diagonal push has to pick a lane.
///
/// `crates/pocketvoxel-psp/src/main.rs`'s `map_buttons` expression, with the
/// deadzone lifted out of it: the PSP's nub reads 0..255 around a centre of
/// 128 and uses 48, while the circle pad reports a signed deflection of about
/// ±154, so the same 37.5% fraction is about 58. `dy` is screen-down positive
/// (the nub's convention); libctru reports it positive up.
///
/// `saturating_abs` rather than `abs` so a pathological `i32::MIN` cannot
/// overflow on a handheld; no real axis reaches it.
pub fn axis_buttons(dx: i32, dy: i32, deadzone: i32) -> u32 {
    use pocketvoxel_core::spec::btn;
    let (ax, ay) = (dx.saturating_abs(), dy.saturating_abs());
    if ax <= deadzone && ay <= deadzone {
        return 0;
    }
    if ax > ay {
        if dx < 0 { btn::LEFT } else { btn::RIGHT }
    } else if dy < 0 {
        btn::UP
    } else {
        btn::DOWN
    }
}
