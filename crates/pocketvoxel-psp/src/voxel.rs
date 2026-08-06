//! The `voxel` surface on PSP: one QuickJS C function per VOX_OP
//! (contracts/spec/voxel-spec.ts §Ops), expressed through the raw QuickJS
//! API — the openstrike-psp `strike` surface pattern. Every numeric op
//! applies synchronously into the shared retained [`Scene`] (the core's
//! dispatch is defensive by contract, so a hostile guest can at worst
//! no-op); `gamedata()` returns the pak's GAME JSON as a JS string;
//! `uiText` carries the one string argument.
//!
//! Single-threaded host (the QuickJS worker) — `static mut` matches the
//! established hosts/psp style.

use core::ffi::c_void;

use libquickjs_sys::*;
use pocketjs_psp::ffi::{add_fn, arg_i32};
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::op;

// Symbols the vendored libquickjs-sys omits (provided by the linked QuickJS
// C library — the established local-extern pattern, strike.rs / hosts/psp
// main.rs's JS_NewArrayBuffer). size_t stays usize (MIPS o32).
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
/// Set by the first audio op of the run. The guest emits its engine-table
/// pins at boot when — and only when — its audio director has a manifest, so
/// this flag is exactly "the guest intends to sound", and the frame loop
/// waits for it before opening a hardware stream (main.rs `audio_pump`).
static mut AUDIO_WANTED: bool = false;
/// Set when THIS tick's ops re-showed map slot 0 — a warp landing (the guest
/// holds the world frozen through the fade, so the frame is a held cut).
/// The frame loop reads-and-clears it every tick: it is the one moment a
/// long collection is invisible (main.rs's arena-pressure GC).
static mut MAP_SWAPPED: bool = false;

/// # Safety
/// Call once on the worker thread before `register`/`scene`.
pub unsafe fn init(game: &'static [u8]) {
    SCENE = Some(Scene::new());
    GAME = game;
}

/// Hand the pak's AUDI section to the `audiodata` op. Call next to [`init`],
/// with `pak.audio`; skipping it leaves the game silent but otherwise intact.
///
/// # Safety
/// Same as [`init`]: once, on the worker thread, before `register`.
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
/// it to decide whether to reserve a hardware channel at all: a guest that
/// keeps audio off (psp-main.ts `setAudio(null)`) never trips it, and the
/// EBOOT stays exactly as silent — and as cheap — as it was before the ops
/// existed.
///
/// # Safety
/// Worker thread only, same as the ops that set it.
pub unsafe fn audio_wanted() -> bool {
    AUDIO_WANTED
}

/// One numeric op: collect up to `N` i32 args, dispatch. Missing args read
/// as 0 (the same defaulting scene.op applies to short arg lists).
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
/// frame loop's GC policy needs: slot 0 re-showing is a warp landing, and
/// the guest holds the world frozen through it (game.ts WarpFadeState) — the
/// held cut is where a long collection hides.
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

/// Read-and-clear the warp-landing flag. Call EVERY tick — a stale flag from
/// a cheap early map show must not license a collection mid-walk later.
///
/// # Safety
/// Worker thread only.
pub unsafe fn take_map_swapped() -> bool {
    let v = MAP_SWAPPED;
    MAP_SWAPPED = false;
    v
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
/// One cold read at boot, exactly like `gamedata()`; undefined when the pak
/// carries no audio (the guest treats any falsy answer as "run silent").
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

/// `stats()`: dispatch for the counter, no return payload on this host
/// (debug-only; the guest's QuickJsHost returns null regardless).
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

/// Autopilot-only guest profiling channel (never in a shipped build; the
/// bindings simply do not exist elsewhere, and the guest checks before
/// installing its hook). `now()` — the kernel µs clock as a float.
#[cfg(feature = "autopilot")]
unsafe extern "C" fn js_now(
    ctx: *mut JSContext,
    _this: JSValue,
    _argc: i32,
    _argv: *mut JSValue,
) -> JSValue {
    JS_NewFloat64(ctx, psp::sys::sceKernelGetSystemTimeLow() as f64)
}

/// `perf(line)` — one guest line into the frame loop's pilot log, flushed
/// with the phase log when the tape ends.
#[cfg(feature = "autopilot")]
unsafe extern "C" fn js_perf(
    ctx: *mut JSContext,
    _this: JSValue,
    argc: i32,
    argv: *mut JSValue,
) -> JSValue {
    if argc < 1 {
        return JS_UNDEFINED;
    }
    let mut len: size_t = 0;
    let s = JS_ToCStringLen2(ctx, &mut len, *argv, 0);
    if !s.is_null() {
        if let Ok(text) = core::str::from_utf8(core::slice::from_raw_parts(s as *const u8, len)) {
            crate::pilot_guest_line(text);
        }
        JS_FreeCString(ctx, s);
    }
    JS_UNDEFINED
}

/// Install `globalThis.voxel` — the full VOX_OP surface.
///
/// # Safety
/// QuickJS context alive, worker thread, after [`init`].
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
    #[cfg(feature = "autopilot")]
    {
        add_fn(ctx, obj, b"now\0", js_now, 0);
        add_fn(ctx, obj, b"perf\0", js_perf, 1);
    }
    JS_SetPropertyStr(ctx, global, b"voxel\0".as_ptr() as *const _, obj);
}
