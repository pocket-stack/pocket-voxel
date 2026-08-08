//! The `voxel` surface: the op table the guest's `globalThis.voxel` is built
//! from, and the argument marshalling every op goes through.
//!
//! This is `crates/pocketvoxel-psp/src/voxel.rs` transcribed. That file is
//! authoritative for **op numbers, arities and semantics**, and the two hosts
//! must present the same surface or the same guest bundle stops meaning the
//! same thing on the two consoles. What differs here is only where the JSValue
//! unwrapping happens: the PSP registers QuickJS C functions from Rust, while
//! the 3DS host follows `hosts/3ds/src/qjs.c` and does it in C, so this module
//! publishes the table as **data** and the C side walks it.
//!
//! Two consequences of that transcription worth stating, because both look
//! like bugs and neither is:
//!
//! - **A missing argument reads as 0.** The PSP host collects exactly the op's
//!   declared arity through `arg_i32`, which answers 0 past the guest's own
//!   `argc`, and hands `scene.op` a full argument list every time. So
//!   `voxel.cam(4)` moves the camera to (4, 0) instead of throwing. Native
//!   hosts are the non-strict kind (`framework/src/host.ts`), and the core's
//!   dispatch is defensive by contract because the op stream crosses a trust
//!   boundary.
//! - **`mapShow` reads argument 0 before dispatch.** Slot 0 re-showing is a
//!   warp landing, which is the one moment a long garbage collection is an
//!   invisible held cut; the flag is set from the same defaulted argument, so
//!   `voxel.mapShow()` with no arguments trips it exactly as the PSP host
//!   does.
//!
//! There is deliberately **no `quality` op**: the PSP EBOOT registers none and
//! so runs tier 0, the `psp` rung, and this host does the same. See
//! [`crate::host::Host::new`].

use pocketvoxel_core::spec::op;

/// What the C side does with an op's return value. Mirrored by the
/// `PV3DS_OP_*` defines in `include/pocketvoxel_3ds.h`.
pub mod op_kind {
    /// Plain numeric op; returns undefined.
    pub const NUMERIC: u8 = 0;
    /// `uiText(x, y, str)` — the one string-bearing op.
    pub const TEXT: u8 = 1;
    /// `gamedata()` — the pak's GAME section as a JS string.
    pub const GAMEDATA: u8 = 2;
    /// `audiodata()` — the pak's AUDI section as an ArrayBuffer, or undefined.
    pub const AUDIODATA: u8 = 3;
    /// `stats()` — dispatch only; the guest is answered undefined.
    pub const STATS: u8 = 4;
}

/// The widest numeric arity in the table (`ent`, 7). The dispatch buffer is
/// this size, so it never allocates.
pub const MAX_ARGS: usize = 8;

/// Bytes a name occupies in [`crate::cabi::VoxOp`], NUL included. Mirrored by
/// `PV3DS_OP_NAME_MAX`.
pub const NAME_MAX: usize = 16;

/// One entry of the surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpDef {
    /// The property name on `globalThis.voxel`.
    pub name: &'static str,
    /// The VOX_OP code (`spec::op`).
    pub code: u32,
    /// Numeric arguments the Scene is given — the PSP host's `dispatch::<N>`.
    pub argc: u8,
    /// The length declared to `JS_NewCFunction`, which is the PSP host's
    /// `add_fn` length: `argc`, plus one for the trailing string of a
    /// [`op_kind::TEXT`] op.
    pub js_len: u8,
    pub kind: u8,
    /// Emitting this op means the run intends to sound
    /// ([`crate::host::Host::audio_wanted`]).
    pub audio: bool,
}

const fn n(name: &'static str, code: u32, argc: u8) -> OpDef {
    OpDef { name, code, argc, js_len: argc, kind: op_kind::NUMERIC, audio: false }
}

const fn a(name: &'static str, code: u32, argc: u8) -> OpDef {
    OpDef { name, code, argc, js_len: argc, kind: op_kind::NUMERIC, audio: true }
}

/// The whole surface, in the order the PSP host registers it. Order is what
/// the C side's magic number indexes, so appending is safe and reordering is
/// not observable to the guest but is to a debugger reading magics.
pub const OPS: &[OpDef] = &[
    OpDef { name: "gamedata", code: op::GAMEDATA, argc: 0, js_len: 0, kind: op_kind::GAMEDATA, audio: false },
    OpDef { name: "audiodata", code: op::AUDIODATA, argc: 0, js_len: 0, kind: op_kind::AUDIODATA, audio: false },
    OpDef { name: "stats", code: op::STATS, argc: 0, js_len: 0, kind: op_kind::STATS, audio: false },
    n("reset", op::RESET, 0),
    n("mapShow", op::MAP_SHOW, 4),
    n("mapHide", op::MAP_HIDE, 1),
    n("cam", op::CAM, 2),
    n("pitch", op::PITCH, 1),
    n("tint", op::TINT, 1),
    n("stamp", op::STAMP, 4),
    n("palette", op::PALETTE, 1),
    n("ent", op::ENT, 7),
    n("entHide", op::ENT_HIDE, 1),
    n("emote", op::EMOTE, 2),
    n("uiTile", op::UI_TILE, 3),
    n("uiFill", op::UI_FILL, 5),
    // Two numeric args and the string: `add_fn(.., b"uiText\0", .., 3)`.
    OpDef { name: "uiText", code: op::UI_TEXT, argc: 2, js_len: 3, kind: op_kind::TEXT, audio: false },
    n("uiReveal", op::UI_REVEAL, 1),
    n("uiClear", op::UI_CLEAR, 0),
    n("arena", op::ARENA, 5),
    n("card", op::CARD, 4),
    n("cardHide", op::CARD_HIDE, 1),
    n("battleCam", op::BATTLE_CAM, 3),
    n("arenaEnd", op::ARENA_END, 0),
    a("music", op::MUSIC, 4),
    a("musicStop", op::MUSIC_STOP, 0),
    a("musicFade", op::MUSIC_FADE, 1),
    a("sfx", op::SFX, 6),
    a("cry", op::CRY, 5),
    a("audioWaves", op::AUDIO_WAVES, 3),
    a("audioDrum", op::AUDIO_DRUM, 4),
];

// The table is walked by index from C and copied into a fixed-size name
// field; both properties are structural, so they are checked at compile time.
const _: () = {
    let mut i = 0;
    while i < OPS.len() {
        assert!(OPS[i].argc as usize <= MAX_ARGS);
        assert!(OPS[i].name.len() < NAME_MAX);
        let mut j = i + 1;
        while j < OPS.len() {
            assert!(OPS[i].code != OPS[j].code, "duplicate op code in the table");
            j += 1;
        }
        i += 1;
    }
};

/// The entry for `code`, or `None` — the table is 31 entries, so a linear
/// scan costs less than the branch that would pick a smarter structure.
pub fn find(code: u32) -> Option<&'static OpDef> {
    OPS.iter().find(|d| d.code == code)
}

/// The entry the guest reaches by name, for tests and for anyone reading a
/// trace.
pub fn find_by_name(name: &str) -> Option<&'static OpDef> {
    OPS.iter().find(|d| d.name == name)
}

/// The PSP host's `dispatch::<N>` argument collection: exactly `def.argc`
/// values, missing ones 0, surplus ones dropped.
pub fn marshal(def: &OpDef, args: &[i32]) -> ([i32; MAX_ARGS], usize) {
    let want = def.argc as usize;
    let mut out = [0i32; MAX_ARGS];
    for (i, slot) in out.iter_mut().enumerate().take(want) {
        *slot = args.get(i).copied().unwrap_or(0);
    }
    (out, want)
}
