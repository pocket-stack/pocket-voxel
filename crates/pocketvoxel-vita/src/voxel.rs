//! The `voxel` surface on Vita: one QuickJS C function per VOX_OP
//! (contracts/spec/voxel-spec.ts §Ops), expressed through the raw QuickJS
//! API. Every numeric op applies synchronously into the shared retained
//! [`Scene`] (the core's dispatch is defensive by contract, so a hostile
//! guest can at worst no-op); `gamedata()` returns the pak's GAME JSON as a
//! JS string; `uiText` carries the one string argument.
//!
//! This is `crates/pocketvoxel-psp/src/voxel.rs` with its two host imports
//! (`add_fn`, `arg_i32`) inlined: there is no PocketJS host library under
//! this VPK to borrow them from, and the surface itself is the contract —
//! the guest bundle is byte-identical on both machines, so any divergence
//! between the two files is a bug in one of them.
//!
//! Single-threaded host (the Vita main thread) — `static mut` matches the
//! established style on the sibling hosts.

use core::ffi::c_void;

use libquickjs_sys::*;
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::op;

// Symbols the vendored libquickjs-sys omits (provided by the linked QuickJS
// C library — the established local-extern pattern).
extern "C" {
    fn JS_NewStringLen(ctx: *mut JSContext, s: *const u8, len: usize) -> JSValue;
    fn JS_NewArrayBuffer(
        ctx: *mut JSContext,
        buf: *mut u8,
        len: usize,
        free_func: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void, *mut c_void)>,
        opaque: *mut c_void,
        is_shared: i32,
    ) -> JSValue;
}

/// The retained scene every op mutates and the frame loop draws.
static mut SCENE: Option<Scene> = None;
/// The pak's GAME section (JSON, zero-copy over the leaked pak buffer).
static mut GAME: &[u8] = &[];
/// The pak's AUDI section (zero-copy, same buffer). Empty until [`set_audio`]
/// runs, and an empty section is a pak without audio: `audiodata()` then
/// answers undefined and the guest's audio director runs silent.
static mut AUDIO: &[u8] = &[];
/// Set by the first audio op of the run — exactly "the guest intends to
/// sound", which the frame loop waits for before opening a hardware port.
static mut AUDIO_WANTED: bool = false;
/// Set when THIS tick's ops re-showed map slot 0 — a warp landing, where the
/// guest holds the world frozen through the fade and a collection is an
/// invisible held cut. Read-and-cleared every tick by the frame loop.
static mut MAP_SWAPPED: bool = false;

/// # Safety
/// Call once on the main thread before `register`/`scene`.
pub unsafe fn init(game: &'static [u8]) {
    SCENE = Some(Scene::new());
    GAME = game;
}

/// Hand the pak's AUDI section to the `audiodata` op. Call next to [`init`],
/// with `pak.audio`; skipping it leaves the game silent but otherwise intact.
///
/// # Safety
/// Same as [`init`]: once, on the main thread, before `register`.
pub unsafe fn set_audio(audio: &'static [u8]) {
    AUDIO = audio;
}

/// # Safety
/// `init` must have run. Single-threaded access only.
#[allow(static_mut_refs)]
pub unsafe fn scene() -> &'static mut Scene {
    SCENE.as_mut().expect("voxel::init not called")
}

/// True once the guest has emitted any audio op. The frame loop's pump reads
/// it to decide whether to reserve a hardware port at all.
///
/// # Safety
/// Main thread only, same as the ops that set it.
pub unsafe fn audio_wanted() -> bool {
    AUDIO_WANTED
}

/// Read-and-clear the warp-landing flag. Call EVERY tick — a stale flag from
/// a cheap early map show must not license a collection mid-walk later.
///
/// # Safety
/// Main thread only.
pub unsafe fn take_map_swapped() -> bool {
    let v = MAP_SWAPPED;
    MAP_SWAPPED = false;
    v
}

/// Argument `i` as an i32; missing arguments read as 0 (the same defaulting
/// `Scene::op` applies to short arg lists).
#[inline]
unsafe fn arg_i32(ctx: *mut JSContext, argc: i32, argv: *mut JSValue, i: isize) -> i32 {
    if (i as i32) >= argc {
        return 0;
    }
    let mut out: i32 = 0;
    JS_ToInt32(ctx, &mut out, *argv.offset(i));
    out
}

unsafe fn add_fn(
    ctx: *mut JSContext,
    obj: JSValue,
    name: &'static [u8], // NUL-terminated
    f: unsafe extern "C" fn(*mut JSContext, JSValue, i32, *mut JSValue) -> JSValue,
    nargs: i32,
) {
    let v = JS_NewCFunction2(
        ctx,
        Some(f),
        name.as_ptr() as *const _,
        nargs,
        JS_CFUNC_generic,
        0,
    );
    JS_SetPropertyStr(ctx, obj, name.as_ptr() as *const _, v);
}

/// One numeric op: collect up to `N` i32 args, dispatch.
unsafe fn dispatch<const N: usize>(
    ctx: *mut JSContext,
    argc: i32,
    argv: *mut JSValue,
    code: u32,
) -> JSValue {
    let mut args = [0i32; N];
    for (i, a) in args.iter_mut().enumerate() {
        *a = arg_i32(ctx, argc, argv, i as isize);
    }
    scene().op(code, &args, None);
    JS_UNDEFINED
}

macro_rules! op_fn {
    ($name:ident, $code:expr, $n:literal) => {
        unsafe extern "C" fn $name(
            ctx: *mut JSContext,
            _this: JSValue,
            argc: i32,
            argv: *mut JSValue,
        ) -> JSValue {
            dispatch::<$n>(ctx, argc, argv, $code)
        }
    };
}

/// The same numeric dispatch, plus the one bit the host side needs: this run
/// wants sound. Every audio op sets it, including the boot-time table pins,
/// so the flag is up before the first `frame()` of a run that has audio.
macro_rules! audio_op_fn {
    ($name:ident, $code:expr, $n:literal) => {
        unsafe extern "C" fn $name(
            ctx: *mut JSContext,
            _this: JSValue,
            argc: i32,
            argv: *mut JSValue,
        ) -> JSValue {
            AUDIO_WANTED = true;
            dispatch::<$n>(ctx, argc, argv, $code)
        }
    };
}

op_fn!(js_reset, op::RESET, 0);
op_fn!(js_map_hide, op::MAP_HIDE, 1);

/// `mapShow` dispatches like every numeric op, plus the one observation the
/// frame loop's GC policy needs: slot 0 re-showing is a warp landing.
unsafe extern "C" fn js_map_show(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if arg_i32(ctx, argc, argv, 0) == 0 {
        MAP_SWAPPED = true;
    }
    dispatch::<4>(ctx, argc, argv, op::MAP_SHOW)
}

op_fn!(js_cam, op::CAM, 2);
op_fn!(js_pitch, op::PITCH, 1);
op_fn!(js_tint, op::TINT, 1);
op_fn!(js_stamp, op::STAMP, 4);
op_fn!(js_palette, op::PALETTE, 1);
op_fn!(js_ent, op::ENT, 7);
op_fn!(js_ent_hide, op::ENT_HIDE, 1);
op_fn!(js_emote, op::EMOTE, 2);
op_fn!(js_ui_tile, op::UI_TILE, 3);
op_fn!(js_ui_fill, op::UI_FILL, 5);
op_fn!(js_ui_reveal, op::UI_REVEAL, 1);
op_fn!(js_ui_clear, op::UI_CLEAR, 0);
op_fn!(js_arena, op::ARENA, 5);
op_fn!(js_card, op::CARD, 4);
op_fn!(js_card_hide, op::CARD_HIDE, 1);
op_fn!(js_battle_cam, op::BATTLE_CAM, 3);
op_fn!(js_arena_end, op::ARENA_END, 0);

// The chip synth's ops (voxel-spec.ts §audio). Plain numeric ops like every
// other: the core queues the intent and interprets the ROM's channel programs
// when the frame loop pumps `Scene::render_audio` for frames.
audio_op_fn!(js_music, op::MUSIC, 4);
audio_op_fn!(js_music_stop, op::MUSIC_STOP, 0);
audio_op_fn!(js_music_fade, op::MUSIC_FADE, 1);
audio_op_fn!(js_sfx, op::SFX, 6);
audio_op_fn!(js_cry, op::CRY, 5);
audio_op_fn!(js_audio_waves, op::AUDIO_WAVES, 3);
audio_op_fn!(js_audio_drum, op::AUDIO_DRUM, 4);

/// `gamedata()`: the pak's GAME JSON as a string — one cold parse at boot,
/// then the guest never crosses for data again (docs/VOXEL.md §4).
unsafe extern "C" fn js_gamedata(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    scene().op(op::GAMEDATA, &[], None);
    JS_NewStringLen(ctx, GAME.as_ptr(), GAME.len())
}

/// `audiodata()`: the pak's AUDI section as an ArrayBuffer, zero-copy over
/// the leaked pak buffer (free_func = None — the pak outlives the realm).
unsafe extern "C" fn js_audiodata(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    scene().op(op::AUDIODATA, &[], None);
    if AUDIO.is_empty() {
        return JS_UNDEFINED;
    }
    JS_NewArrayBuffer(
        ctx,
        AUDIO.as_ptr() as *mut u8,
        AUDIO.len(),
        None,
        core::ptr::null_mut(),
        0,
    )
}

/// `stats()`: dispatch for the counter, no return payload on this host.
unsafe extern "C" fn js_stats(
    _ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    scene().op(op::STATS, &[], None);
    JS_UNDEFINED
}

/// `uiText(x, y, str)` — the one string-bearing op.
unsafe extern "C" fn js_ui_text(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 3 {
        return JS_UNDEFINED;
    }
    let x = arg_i32(ctx, argc, argv, 0);
    let y = arg_i32(ctx, argc, argv, 1);
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv.offset(2), 0);
    if !s.is_null() {
        if let Ok(text) = core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
            scene().op(op::UI_TEXT, &[x, y], Some(text));
        }
        JS_FreeCString(ctx, s);
    }
    JS_UNDEFINED
}

/// Install `globalThis.voxel` — the full VOX_OP surface.
///
/// # Safety
/// QuickJS context alive, main thread, after [`init`].
pub unsafe fn register(ctx: *mut JSContext, global: JSValue) {
    let obj = JS_NewObject(ctx);
    add_fn(ctx, obj, b"gamedata\0", js_gamedata, 0);
    add_fn(ctx, obj, b"audiodata\0", js_audiodata, 0);
    add_fn(ctx, obj, b"stats\0", js_stats, 0);
    add_fn(ctx, obj, b"reset\0", js_reset, 0);
    add_fn(ctx, obj, b"mapShow\0", js_map_show, 4);
    add_fn(ctx, obj, b"mapHide\0", js_map_hide, 1);
    add_fn(ctx, obj, b"cam\0", js_cam, 2);
    add_fn(ctx, obj, b"pitch\0", js_pitch, 1);
    add_fn(ctx, obj, b"tint\0", js_tint, 1);
    add_fn(ctx, obj, b"stamp\0", js_stamp, 4);
    add_fn(ctx, obj, b"palette\0", js_palette, 1);
    add_fn(ctx, obj, b"ent\0", js_ent, 7);
    add_fn(ctx, obj, b"entHide\0", js_ent_hide, 1);
    add_fn(ctx, obj, b"emote\0", js_emote, 2);
    add_fn(ctx, obj, b"uiTile\0", js_ui_tile, 3);
    add_fn(ctx, obj, b"uiFill\0", js_ui_fill, 5);
    add_fn(ctx, obj, b"uiText\0", js_ui_text, 3);
    add_fn(ctx, obj, b"uiReveal\0", js_ui_reveal, 1);
    add_fn(ctx, obj, b"uiClear\0", js_ui_clear, 0);
    add_fn(ctx, obj, b"arena\0", js_arena, 5);
    add_fn(ctx, obj, b"card\0", js_card, 4);
    add_fn(ctx, obj, b"cardHide\0", js_card_hide, 1);
    add_fn(ctx, obj, b"battleCam\0", js_battle_cam, 3);
    add_fn(ctx, obj, b"arenaEnd\0", js_arena_end, 0);
    add_fn(ctx, obj, b"music\0", js_music, 4);
    add_fn(ctx, obj, b"musicStop\0", js_music_stop, 0);
    add_fn(ctx, obj, b"musicFade\0", js_music_fade, 1);
    add_fn(ctx, obj, b"sfx\0", js_sfx, 6);
    add_fn(ctx, obj, b"cry\0", js_cry, 5);
    add_fn(ctx, obj, b"audioWaves\0", js_audio_waves, 3);
    add_fn(ctx, obj, b"audioDrum\0", js_audio_drum, 4);
    JS_SetPropertyStr(ctx, global, b"voxel\0".as_ptr() as *const _, obj);
}
