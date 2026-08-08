// Single-threaded guest state behind `static mut`, the established style on
// the sibling hosts (crates/pocketvoxel-psp/src/main.rs).
#![allow(static_mut_refs)]

//! VOXELMON on the PS Vita: the full Pocket Voxel composition on the second
//! machine (docs/VOXEL.md §2, §8).
//!
//! Per frame (one guest turn per tick, §3/§7):
//!   pad -> `frame(buttons)` in QuickJS (the TypeScript gameplay port; its
//!   ops apply synchronously into the shared Scene through `voxel.*`) ->
//!   microtasks -> `scene.tick()` -> `draw::build` -> the vitaGL backend ->
//!   `vglSwapBuffers` -> `audio_pump`.
//!
//! Same guest bundle, same pak, same core as the PSP EBOOT — what changes is
//! the rung and the raster. The host names its quality rung
//! (`op::QUALITY`, contracts/spec/voxel-spec.ts §quality ladder) rather than
//! the guest, which is why one bundle serves both machines; and the logical
//! viewport stays 480x272 while the physical one is 960x544, so the picture
//! is the PSP's layout at four times the pixels.
//!
//! Buttons: CIRCLE confirms (A), CROSS cancels (B) — the same choice the
//! EBOOT makes, so a player with the rest of the family on their stick does
//! not find A dead here.
//!
//! Memory: the 32 MB pak is a FILE next to the executable inside the VPK
//! (never include_bytes! — a 32 MB `.rodata` array is a self-inflicted link
//! and load cost), staged into one 16-byte-aligned heap block whose vertex
//! and index pools then become GL buffer objects. Unlike the PSP there is no
//! partition to husband: the Vita's user RAM is measured in hundreds of
//! megabytes.

mod audio;
mod voxel;

use std::io::Read;

use libquickjs_sys::*;
use pocketvoxel_core::pak;
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::{self, op};
use pocketvoxel_gl as vgl;
use vitasdk_sys::{
    SCE_CTRL_CIRCLE, SCE_CTRL_CROSS, SCE_CTRL_DOWN, SCE_CTRL_LEFT, SCE_CTRL_MODE_ANALOG,
    SCE_CTRL_RIGHT, SCE_CTRL_SELECT, SCE_CTRL_START, SCE_CTRL_UP, SceCtrlData,
    sceCtrlPeekBufferPositive, sceCtrlSetSamplingMode, sceKernelDelayThread,
    sceKernelGetProcessTimeLow,
};

/// QuickJS parses a 1.1 MB gamedata graph at boot and then runs the whole
/// game on this thread; Vita's 4 KiB default would not survive the parse.
#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 2 * 1024 * 1024;

/// The bundled gameplay guest (voxelmon/game/psp-main.ts via `bun build`),
/// NUL-terminated by build.rs; evaled with `len - 1`.
static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));

/// The quality rung this build asks the core for (build.rs `VOXELMON_TIER`).
static TIER: &str = env!("VOXELMON_TIER");

/// Pak search order: a writable copy first, so a device session can drop in a
/// re-cooked pak without reinstalling the 32 MB VPK, then the VPK's own copy.
/// Both `app0:` spellings are tried, and the installed path is spelled out
/// after them, because which of the three a given firmware accepts is not
/// worth a device round trip to find out.
const PAK_PATHS: [&str; 4] = [
    "ux0:data/voxelmon/voxelmon.vxpak",
    "app0:voxelmon.vxpak",
    "app0:/voxelmon.vxpak",
    "ux0:app/PVOX00001/voxelmon.vxpak",
];

/// The analog stick reads 0..255 with 128 at rest; this much off-centre
/// counts as a direction.
const NUB_DEADZONE: i32 = 48;

/// The rate the core interprets channel programs at, and the rate the pump
/// feeds the ring at. 11025 divides 44100 exactly, so the mixer upsamples it
/// with integer steps (audio.rs) and no resampler runs. Same rate as the
/// EBOOT, so both machines play the same render.
const AUDIO_RATE: u32 = 11025;
/// Frames the audio clock eats per tick, rounded up (11025/60 = 183.75).
const AUDIO_FRAMES_PER_TICK: usize = (AUDIO_RATE as usize).div_ceil(60);
/// How far ahead of the audio clock the ring is kept: 100 ms absorbs a slow
/// tick (a map load, a collection) without synthesising music a map change
/// would discard.
const AUDIO_LEAD_FRAMES: usize = AUDIO_RATE as usize / 10;
/// The deeper lead pumped right before a garbage collection.
const GC_LEAD_FRAMES: usize = AUDIO_RATE as usize / 4;
/// Ceiling on frames rendered in ONE tick — four ticks' worth. Reaching the
/// lead then takes a few ticks instead of one, which is what bounds the
/// worst tick.
const AUDIO_MAX_FRAMES: usize = AUDIO_FRAMES_PER_TICK * 4;

/// The render buffer, sized for the worst tick. The frame loop must not
/// allocate, so it lives in bss.
static mut AUDIO_PCM: [i16; AUDIO_MAX_FRAMES * 2] = [0; AUDIO_MAX_FRAMES * 2];
/// Whether the hardware port is open. A refusal is final for the run.
static mut AUDIO_OPEN: bool = false;
static mut AUDIO_REFUSED: bool = false;
/// Ticks the port has been fed — the `audioFramesForTick` index.
static mut AUDIO_CLOCK: u32 = 0;

extern "C" {
    /// The linked QuickJS C library provides this; libquickjs-sys omits it.
    fn JS_RunGC(rt: *mut JSRuntime);
}

fn log(args: std::fmt::Arguments<'_>) {
    // sceClibPrintf lands in the PSVita's kernel log, which is what a
    // `psp2shell`/Vita3K session reads; a retail boot simply drops it.
    use std::fmt::Write as _;
    let mut line = String::new();
    let _ = line.write_fmt(args);
    line.push('\0');
    unsafe {
        sce_clib_printf(c"%s\n".as_ptr(), line.as_ptr());
    }
}

extern "C" {
    #[link_name = "sceClibPrintf"]
    fn sce_clib_printf(fmt: *const i8, ...) -> i32;
}

/// Park visibly rather than exiting: a VPK that returns from `main` drops
/// the player back to LiveArea with no explanation, and the one thing worth
/// knowing is in the log line above the park.
fn halt(message: &str) -> ! {
    log(format_args!("[voxelmon] FATAL: {message}"));
    loop {
        unsafe { sceKernelDelayThread(100_000) };
    }
}

/// Read the pak into one 16-byte-aligned block and leak it: the pak's
/// borrowed pools (vertices, indices, atlas texels, the GAME JSON the guest
/// parses) live for the whole process, and `pak::read` rejects a misaligned
/// vertex pool by contract (`Vec<u8>` carries no alignment guarantee).
///
/// Read straight into the aligned store rather than through
/// `AlignedBlob::from_bytes`, which would hold two 32 MB copies at once.
fn load_pak_blob() -> Option<&'static [u8]> {
    for path in PAK_PATHS {
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let Ok(meta) = file.metadata() else { continue };
        let len = meta.len() as usize;
        if len == 0 {
            continue;
        }
        let mut store: Vec<u128> = vec![0; len.div_ceil(16)];
        // Safety: the u128 store holds at least `len` bytes and u128 is
        // 16-byte aligned, which is what the reader requires.
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(store.as_mut_ptr() as *mut u8, len) };
        if file.read_exact(bytes).is_err() {
            continue;
        }
        log(format_args!("[voxelmon] pak: {path} ({} MB)", len / 1048576));
        let leaked: &'static mut [u128] = Vec::leak(store);
        return Some(unsafe { std::slice::from_raw_parts(leaked.as_ptr() as *const u8, len) });
    }
    None
}

/// Where a HENkaku console keeps the runtime shader compiler. vitaGL builds
/// its fixed-function shaders at runtime (build.rs `VITAGL_LIBS`), so this
/// module is a prerequisite of drawing anything at all — and without the
/// check, its absence looks exactly like a renderer bug: the VPK launches,
/// the log is clean, and the screen stays black.
///
/// Written as an error file as well as a log line, because the one player
/// who hits this is looking at a black screen with no way to read a log.
const SHACCCG_PATHS: [&str; 3] = [
    "ur0:data/libshacccg.suprx",
    "ux0:data/libshacccg.suprx",
    "vs0:sys/external/libshacccg.suprx",
];

fn require_shader_compiler() {
    if SHACCCG_PATHS.iter().any(|p| std::fs::metadata(p).is_ok()) {
        return;
    }
    let message = "libshacccg.suprx is not installed.\n\n\
        Pocket Voxel renders through vitaGL, which builds its shaders on the \
        console at runtime, so the PS Vita's own shader compiler module has \
        to be present. Install it once with VitaDeploy or ShaccCgSetup (it \
        extracts the module from a firmware update file); every vitaGL \
        homebrew on the system needs the same module.\n";
    let _ = std::fs::create_dir_all("ux0:data/voxelmon");
    let _ = std::fs::write("ux0:data/voxelmon/error.txt", message);
    halt(message);
}

/// The rung named by the build, or the weakest one if the name is not a rung
/// (a typo must not silently ask for a picture this machine cannot hold).
fn tier_code(name: &str) -> u8 {
    match name {
        "psp" => spec::quality_tier::PSP,
        "vita" => spec::quality_tier::VITA,
        "desktop" => spec::quality_tier::DESKTOP,
        _ => {
            log(format_args!("[voxelmon] unknown tier {name:?}, using psp"));
            spec::quality_tier::PSP
        }
    }
}

fn main() {
    unsafe { run() }
}

unsafe fn run() {
    let Some(blob) = load_pak_blob() else {
        halt("voxelmon.vxpak not found (app0: or ux0:data/voxelmon/)");
    };
    let pak = match pak::read(blob) {
        Ok(p) => p,
        Err(e) => halt(e),
    };
    log(format_args!(
        "[voxelmon] pak: {} maps, {} chunks, {} verts, {} atlases, {} KB game",
        pak.maps.len(),
        pak.chunks.len(),
        pak.verts.len(),
        pak.atlases.len(),
        pak.game.len() / 1024,
    ));

    // ---- graphics ----
    require_shader_compiler();
    // The legacy (immediate-mode) pool stays small: this backend never uses
    // glBegin/glEnd. The RAM threshold is what vitaGL LEAVES to newlib, and
    // newlib is where the pak, the QuickJS heap and the CLUT expansion
    // scratch live — 96 MB is comfortably more than all three.
    if vgl::gl::vglInitExtended(
        0x100000,
        vgl::PHYSICAL_W,
        vgl::PHYSICAL_H,
        96 * 1024 * 1024,
        vgl::gl::SCE_GXM_MULTISAMPLE_NONE,
    ) == 0
    {
        halt("vglInit failed");
    }
    vgl::gl::vglWaitVblankStart(1);
    sceCtrlSetSamplingMode(SCE_CTRL_MODE_ANALOG);

    let mut renderer = vgl::Renderer::new(&pak);
    log(format_args!(
        "[voxelmon] gl: {}x{}, {} KB free in the RAM pool",
        vgl::PHYSICAL_W,
        vgl::PHYSICAL_H,
        vgl::gl::vglMemFree(vgl::gl::VGL_MEM_RAM) / 1024,
    ));

    // ---- scene ----
    // The GAME/AUDI sections borrow from the leaked blob, so the 'static
    // they carry is honest.
    voxel::init(pak.game);
    voxel::set_audio(pak.audio);
    let scene = voxel::scene();
    // The rung, before any op can reach the core. The guest never names it —
    // one bundle, many machines (voxel-spec.ts §quality ladder).
    scene.op(op::QUALITY, &[tier_code(TIER) as i32], None);
    log(format_args!("[voxelmon] quality rung: {TIER}"));
    // The synth's output rate for the whole run, set before any audio op can
    // reach the core (changing it later drops what is playing, because every
    // event's span is measured in samples).
    let _ = scene.audio.set_rate(AUDIO_RATE);

    // ---- QuickJS ----
    let rt = JS_NewRuntime();
    if rt.is_null() {
        halt("JS_NewRuntime returned null");
    }
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        halt("JS_NewContext returned null");
    }
    let global = JS_GetGlobalObject(ctx);
    voxel::register(ctx, global);

    let res = JS_Eval(
        ctx,
        APP_JS.as_ptr() as *const _,
        APP_JS.len() - 1, // exclude the trailing NUL
        c"voxelmon.js".as_ptr(),
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        log_exception(ctx);
        halt("JS_Eval threw");
    }
    JS_FreeValue(ctx, res);

    let frame_fn = JS_GetPropertyStr(ctx, global, c"frame".as_ptr());
    if JS_IsUndefined(frame_fn) {
        halt("globalThis.frame is undefined");
    }
    log(format_args!("[voxelmon] guest booted, entering the frame loop"));

    let mut pad: SceCtrlData = core::mem::zeroed();
    let mut frame: u32 = 0;
    #[cfg(feature = "telemetry")]
    let (mut perf_work, mut perf_frame, mut perf_max) = (0u64, 0u64, 0u32);

    loop {
        let t_start = sceKernelGetProcessTimeLow();
        sceCtrlPeekBufferPositive(0, &mut pad, 1);
        let mask = map_buttons(&pad);

        // One guest turn per host tick: frame(buttons), exactly once.
        let mut args = [JS_NewInt32(ctx, mask as i32)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            log_exception(ctx);
        }
        JS_FreeValue(ctx, r);
        drain_jobs(rt, ctx);

        // Collect on a warp landing, where the guest holds the world frozen
        // through the fade and the stall is an invisible held cut — and map
        // loads are exactly what balloon the heap in the first place. The
        // ring is pre-fed past the stall first, so the mixer cannot starve
        // where the design put continuity.
        let swapped = voxel::take_map_swapped();
        let scene = voxel::scene();
        if swapped {
            for _ in 0..8 {
                audio_pump_with_lead(scene, &pak, GC_LEAD_FRAMES);
            }
            JS_RunGC(rt);
        }

        scene.tick();

        let list = pocketvoxel_core::draw::build(scene, &pak);
        #[cfg(feature = "telemetry")]
        let t_work = sceKernelGetProcessTimeLow();
        renderer.render(&list, &pak);
        // vglSwapBuffers ends the GXM scene, queues the flip and — with
        // vsync on — paces the loop. The audio pump then runs while the GPU
        // is still consuming this frame.
        vgl::gl::vglSwapBuffers(0);
        audio_pump(scene, &pak);

        #[cfg(feature = "telemetry")]
        {
            let work = t_work.wrapping_sub(t_start);
            let whole = sceKernelGetProcessTimeLow().wrapping_sub(t_start);
            perf_work += work as u64;
            perf_frame += whole as u64;
            perf_max = perf_max.max(work);
            if frame > 0 && frame % 300 == 0 {
                perf_write(&format!(
                    "f{frame} work {}us frame {}us max {}us tris {} draws {}\n",
                    perf_work / 300,
                    perf_frame / 300,
                    perf_max,
                    triangles(&list),
                    renderer.draw_count,
                ));
                perf_work = 0;
                perf_frame = 0;
                perf_max = 0;
            }
        }
        #[cfg(not(feature = "telemetry"))]
        let _ = t_start;

        frame = frame.wrapping_add(1);
    }
}

/// Run QuickJS's pending promise jobs to completion.
unsafe fn drain_jobs(rt: *mut JSRuntime, ctx: *mut JSContext) {
    extern "C" {
        fn JS_ExecutePendingJob(rt: *mut JSRuntime, pctx: *mut *mut JSContext) -> i32;
    }
    loop {
        let mut pending: *mut JSContext = core::ptr::null_mut();
        let r = JS_ExecutePendingJob(rt, &mut pending);
        if r > 0 {
            continue;
        }
        if r < 0 {
            log_exception(if pending.is_null() { ctx } else { pending });
        }
        return;
    }
}

unsafe fn log_exception(ctx: *mut JSContext) {
    let value = JS_GetException(ctx);
    let mut len: size_t = 0;
    let ptr = JS_ToCStringLen2(ctx, &mut len, value, 0);
    if !ptr.is_null() {
        let bytes = core::slice::from_raw_parts(ptr as *const u8, len);
        log(format_args!(
            "[voxelmon] js: {}",
            String::from_utf8_lossy(bytes)
        ));
        JS_FreeCString(ctx, ptr);
    }
    JS_FreeValue(ctx, value);
}

// ---------------------------------------------------------------------------
// The PCM pump — one call per tick, after the frame is handed to the GPU
// ---------------------------------------------------------------------------

/// contracts/spec/audio.ts `audioFramesForTick` — the frames the audio clock
/// consumes during tick `tick`. The floor difference distributes 11025/60 =
/// 183.75 as 183/184/184/184… with zero drift: any 60 consecutive ticks sum
/// to exactly the rate. u64 throughout, because `tick * rate` overflows u32
/// after under two hours of play.
fn audio_frames_for_tick(tick: u32) -> usize {
    let rate = AUDIO_RATE as u64;
    let tick = tick as u64;
    (((tick + 1) * rate) / 60 - (tick * rate) / 60) as usize
}

unsafe fn audio_pump(scene: &mut Scene, pak: &pak::Pak<'_>) {
    audio_pump_with_lead(scene, pak, AUDIO_LEAD_FRAMES);
}

/// Feed this tick's chip-synth PCM to the ring.
///
/// The host is the synth's client here, not the guest: psp-main.ts emits
/// audio INTENT as `voxel.*` ops and never touches PCM, so what crosses per
/// tick is a render straight from the core into a bss buffer and one push.
/// The port opens on the first tick after the guest emits any audio op — no
/// op, no hardware port and no mixer thread.
unsafe fn audio_pump_with_lead(scene: &mut Scene, pak: &pak::Pak<'_>, lead: usize) {
    if AUDIO_REFUSED || !voxel::audio_wanted() {
        return;
    }
    if !AUDIO_OPEN {
        if !audio::start(AUDIO_RATE) {
            AUDIO_REFUSED = true;
            log(format_args!("[voxelmon] audio: port refused, running silent"));
            return;
        }
        AUDIO_OPEN = true;
        log(format_args!("[voxelmon] audio: {AUDIO_RATE} Hz stereo open"));
    }

    let free = audio::free_frames();
    let queued = audio::RING_FRAMES - free;
    let per_tick = audio_frames_for_tick(AUDIO_CLOCK);
    AUDIO_CLOCK = AUDIO_CLOCK.wrapping_add(1);
    let want = (per_tick + lead.saturating_sub(queued))
        .min(AUDIO_MAX_FRAMES)
        .min(free);
    if want == 0 {
        return; // the ring is full: this tick's frames are already in it
    }
    scene.render_audio(pak, want, &mut AUDIO_PCM[..want * 2]);
    audio::push(&AUDIO_PCM[..want * 2]);
}

/// Map the console's pad onto VOX_BTN. CIRCLE = A (confirm), CROSS = B — see
/// the module docs. The left stick walks too, one axis at a time (the world
/// is a grid; a diagonal push picks a lane).
fn map_buttons(pad: &SceCtrlData) -> u32 {
    let b = pad.buttons;
    let mut mask = 0;
    let held = |bit: u32| b & bit != 0;
    if held(SCE_CTRL_UP) {
        mask |= spec::btn::UP;
    }
    if held(SCE_CTRL_DOWN) {
        mask |= spec::btn::DOWN;
    }
    if held(SCE_CTRL_LEFT) {
        mask |= spec::btn::LEFT;
    }
    if held(SCE_CTRL_RIGHT) {
        mask |= spec::btn::RIGHT;
    }
    if held(SCE_CTRL_CIRCLE) {
        mask |= spec::btn::A;
    }
    if held(SCE_CTRL_CROSS) {
        mask |= spec::btn::B;
    }
    if held(SCE_CTRL_START) {
        mask |= spec::btn::START;
    }
    if held(SCE_CTRL_SELECT) {
        mask |= spec::btn::SELECT;
    }
    let dx = pad.lx as i32 - 128;
    let dy = pad.ly as i32 - 128;
    if dx.abs() > NUB_DEADZONE || dy.abs() > NUB_DEADZONE {
        if dx.abs() > dy.abs() {
            mask |= if dx < 0 { spec::btn::LEFT } else { spec::btn::RIGHT };
        } else {
            mask |= if dy < 0 { spec::btn::UP } else { spec::btn::DOWN };
        }
    }
    mask
}

#[cfg(feature = "telemetry")]
fn triangles(list: &pocketvoxel_core::draw::DrawList) -> u32 {
    list.items
        .iter()
        .filter_map(|item| match item {
            pocketvoxel_core::draw::Item::ChunkMesh { mesh, .. }
            | pocketvoxel_core::draw::Item::StampMesh { mesh, .. } => Some(mesh.index_count as u32 / 3),
            _ => None,
        })
        .sum::<u32>()
}

/// Frame-time telemetry, appended to ux0:data/voxelmon/voxperf.txt.
///
/// work = JS + tick + list build (everything before the backend records);
/// frame = work + the backend + the vsync-paced swap.
#[cfg(feature = "telemetry")]
fn perf_write(text: &str) {
    use std::io::Write as _;
    let _ = std::fs::create_dir_all("ux0:data/voxelmon");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("ux0:data/voxelmon/voxperf.txt")
    {
        let _ = file.write_all(text.as_bytes());
    }
}
