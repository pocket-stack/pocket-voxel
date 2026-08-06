#![no_std]
#![no_main]
#![allow(static_mut_refs)]

//! VOXELMON on the PSP: the full Pocket Voxel composition (docs/VOXEL.md).
//!
//! Per frame (one guest turn per tick, §3/§7):
//!   pad → `frame(buttons)` in QuickJS (the TypeScript gameplay port; its
//!   ops apply synchronously into the shared Scene through `voxel.*`) →
//!   microtasks → `audio_pump` → `scene.tick()` → `draw::build` →
//!   [pipelined present] → sceGuStart → gu renderer → sceGuFinish.
//!
//! Sound leaves through the audio MODULE (contracts/spec/audio.ts), not the
//! `voxel` surface: the guest emits audio intent as ops, the core's chip
//! synth interprets the pak's channel programs, and `audio_pump` renders the
//! ring's frames on this side of the JS boundary.
//!
//! Boot skeleton follows openstrike-psp/main.rs (1 MB VFPU worker thread,
//! arena allocator installed by linking pocketjs-psp, full 333 MHz clocks —
//! PSPLINK inherits 222 MHz and a QuickJS guest feels every missing cycle).
//!
//! Buttons: CIRCLE confirms (A), CROSS cancels (B) — the pocketmon lesson
//! (98f035d): every other PocketJS host presses on CIRCLE, and a player
//! with the rest of the family on their stick must not find A dead here.
//!
//! Memory: the 21 MB pak is loaded from a FILE next to the EBOOT into one
//! reused 16-aligned buffer (the OpenStrike maps.rs pattern) — NEVER
//! include_bytes!. A PSP-1000's 24 MB user partition cannot hold the pak
//! plus the QuickJS heap, so the current pak is slim/PPSSPP-only:
//! tools/voxel.ts stamps MEMSIZE=1 into the PARAM.SFO (full PSP-2000 64 MB
//! under PPSSPP and CFW slims). Streaming chunks from the pak file is the
//! flagged follow-up for fat hardware.

extern crate alloc;

mod voxel;

// The autopilot build borrows only the scripted-button half of capture.rs;
// its dump/exit half stays dead there (real GE present, no VRAM dumps).
#[cfg(any(feature = "capture", feature = "autopilot"))]
#[cfg_attr(not(feature = "capture"), allow(dead_code))]
mod capture;

use core::ffi::c_void;

use libquickjs_sys::*;
use pocketjs_core::spec::audio as audio_spec;
use pocketjs_psp::{arena, audio_mod, host};
use pocketvoxel_core::draw;
use pocketvoxel_core::pak;
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec;
use pocketvoxel_gu as gu;
use psp::sys::{
    self, CtrlButtons, CtrlMode, GuContextType, GuSyncBehavior, GuSyncMode, IoOpenFlags,
    IoWhence, SceCtrlData,
};

psp::module!("voxelmon", 1, 0);

/// The bundled gameplay guest (voxelmon/game/psp-main.ts via
/// `bun build`), NUL-terminated by build.rs; evaled with `len - 1`.
static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));

/// Pak search order: PSPLINK/PPSSPP (host0: is the EBOOT's own directory),
/// then a Memory Stick install.
const PAK_PATHS: [&[u8]; 2] = [
    b"host0:/voxelmon.vxpak\0",
    b"ms0:/PSP/GAME/VOXELMON/voxelmon.vxpak\0",
];

/// The analog stick reads 0..255 with 128 at rest; this much off-centre
/// counts as a direction (a well-used nub does not sit exactly at centre).
const NUB_DEADZONE: i32 = 48;

// ---------------------------------------------------------------------------
// Audio: the chip synth's output rate and the ring pump's budget
// ---------------------------------------------------------------------------

/// The rate the core interprets channel programs at, and the rate this EBOOT
/// pumps the audio module's ring at.
///
/// 11025 divides 44100 exactly, so the module's mixer upsamples it x4 with
/// integer steps and the PSP's own resampler (which sizzles — hosts/psp/src/
/// audio.rs) never runs. Of the three AUDIO_RATES it is also the cheapest by
/// a factor of four: the synth's cost is per SAMPLE, 184 frames a tick
/// against 44.1 kHz's 735. A tick's worth measures ~6.5 us on desktop, which
/// extrapolates to 0.2-0.4 ms on the 333 MHz part — 1-2.5% of the 16.7 ms
/// frame, and not yet timed on hardware. What it costs is bandwidth above
/// 5.5 kHz;
/// tests/voxel-audio.test.ts pins that the same song at 11.025 kHz holds its
/// RMS within 10% of the 44.1 kHz reference render, so the trade is measured
/// rather than assumed. (Sample-exactness against gen1recomp is a 44.1 kHz
/// claim — the reference hardcodes that rate — and the sim's `--wav` captures
/// there; this is the device rate, not the oracle's.)
const AUDIO_RATE: u32 = 11025;

/// Frames the audio clock eats per tick, rounded up (11025/60 = 183.75).
const AUDIO_FRAMES_PER_TICK: usize = (AUDIO_RATE as usize).div_ceil(60);

/// How far ahead of the audio clock the ring is kept: 100 ms absorbs a slow
/// tick (a map load, a GC) without wasting synthesis on music the next map
/// change discards. The ring holds 16384 frames — 1.5 s at this rate — so
/// this is a lead, not a limit.
const AUDIO_LEAD_FRAMES: usize = AUDIO_RATE as usize / 10;

/// The deep lead pumped just before a garbage collection: the collection is
/// ~175 ms, so 250 ms keeps the mixer fed through it. The cost is that ops
/// landing during the covered ticks mix that much later — once, on a warp.
const GC_LEAD_FRAMES: usize = AUDIO_RATE as usize / 4;

/// Ceiling on frames rendered in ONE tick: three ticks' worth, 552 frames.
/// Reaching the lead then takes a few ticks instead of one, which is what
/// bounds the worst tick — at the extrapolated 1.1-2.2 us per frame that is
/// 0.6-1.2 ms, where an uncapped catch-up after a long stall could ask for
/// the ring's whole 16384.
const AUDIO_CATCHUP_TICKS: usize = 4;
const AUDIO_MAX_FRAMES: usize = AUDIO_FRAMES_PER_TICK * AUDIO_CATCHUP_TICKS;

/// The render buffer, sized for the worst tick and living in bss — the frame
/// loop must not allocate, and the arena's bump is what the GC heuristic
/// watches. 552 stereo frames = 2208 bytes.
static mut AUDIO_PCM: [i16; AUDIO_MAX_FRAMES * 2] = [0; AUDIO_MAX_FRAMES * 2];
/// The module stream, or -1 before it is opened.
static mut AUDIO_HANDLE: i32 = -1;
/// A refused stream is refused for the run (no channel to reserve): asking
/// again every tick would reserve-and-fail 60 times a second.
static mut AUDIO_REFUSED: bool = false;
/// This side's mirror of the ring's free frames (contracts/spec/audio.ts
/// §frame contract): reset by every `credit` event, decremented by what each
/// write accepts, so the hot path never queries the module.
static mut AUDIO_FREE: usize = audio_spec::RING_FRAMES;
/// Ticks the stream has been fed — the `audioFramesForTick` index.
static mut AUDIO_CLOCK: u32 = 0;
/// The tap opens only once the ring has something in it (the
/// play-deferred-until-fed rule, framework/src/audio-api.ts).
static mut AUDIO_STARTED: bool = false;
/// Starved episodes, edge-counted. Reported once, the first time.
static mut AUDIO_UNDERRUNS: u32 = 0;

// The linked QuickJS C library provides these; libquickjs-sys omits them
// (the established local-extern pattern, hosts/psp/src/main.rs).
extern "C" {
    fn JS_RunGC(rt: *mut JSRuntime);
}

/// Arena bump high-water at the last host-forced collection (the hosts/psp
/// arena-pressure GC — QuickJS's own lazy threshold otherwise lets slab
/// chunks pin the fixed arena). Single-threaded QuickJS worker.
static mut LAST_GC_BUMP: usize = 0;

fn psp_main() {
    unsafe {
        host::reset_fpu_status();
        host::run_on_worker(worker_main, run);
    }
}

unsafe extern "C" fn worker_main(_argc: usize, _argv: *mut c_void) -> i32 {
    host::reset_fpu_status();
    run();
    0
}

unsafe fn log_exception(ctx: *mut JSContext) {
    #[cfg(feature = "capture")]
    host::log_exception_with(ctx, |msg| capture::log_line(msg));
    #[cfg(not(feature = "capture"))]
    host::log_exception_with(ctx, |_| {});
}

/// Load the pak file into ONE dedicated kernel block (16-aligned for the
/// zero-copy reader), write it back for the GE, and hand out the 'static
/// slice. The block is never freed — the pak's borrowed pools live for the
/// whole process.
///
/// A kernel block, NOT the Rust heap: the arena global allocator is a
/// power-of-two-class sub-allocator, so a 21 MB pak allocated through it
/// would burn a 32 MB class — most of the partition — and the first
/// grass-heavy frame's pool growth would OOM-park the EBOOT (measured;
/// the alloc_error_handler waits on vblank forever, invisibly, under
/// PPSSPPHeadless). MUST run before the arena's lazy init so the arena
/// sizes itself over what remains.
unsafe fn load_pak_blob() -> Option<&'static [u8]> {
    for path in PAK_PATHS {
        let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
        if fd.0 < 0 {
            continue;
        }
        let size = sys::sceIoLseek(fd, 0, IoWhence::End);
        sys::sceIoLseek(fd, 0, IoWhence::Set);
        if size <= 0 {
            sys::sceIoClose(fd);
            continue;
        }
        let size = size as usize;
        let id = sys::sceKernelAllocPartitionMemory(
            sys::SceSysMemPartitionId::SceKernelPrimaryUserPartition,
            b"voxelmon-pak\0".as_ptr(),
            sys::SceSysMemBlockTypes::Low,
            (size + 16) as u32,
            core::ptr::null_mut(),
        );
        if id.0 < 0 {
            sys::sceIoClose(fd);
            continue;
        }
        let base = sys::sceKernelGetBlockHeadAddr(id) as usize;
        let ptr = ((base + 15) & !15) as *mut u8;
        let mut off = 0usize;
        loop {
            if off >= size {
                break;
            }
            let n = sys::sceIoRead(fd, ptr.add(off) as *mut c_void, (size - off) as u32);
            if n <= 0 {
                break;
            }
            off += n as usize;
        }
        sys::sceIoClose(fd);
        if off != size {
            continue; // truncated read; try the next root
        }
        let blob = core::slice::from_raw_parts(ptr, size);
        // The GE bypasses the dcache: write the whole pak back once so
        // vertex/index pools and swizzled texels are visible in place.
        gu::writeback(blob);
        return Some(blob);
    }
    None
}

unsafe fn run() {
    // Partition size BEFORE anything allocates: PSPLINK's ldstart path does
    // not apply the PBP's MEMSIZE, so a dev session can get the 24 MB user
    // partition where an XMB launch gets ~56 MB. Knowing which is which is
    // the difference between "the guest is too fat" and "this session is".
    psp::dprintln!(
        "[voxelmon] boot: max free {} KB",
        sys::sceKernelMaxFreeMemSize() / 1024
    );
    // ---- Pak FIRST: its dedicated kernel block must exist before the
    // arena's lazy init (first Rust allocation) sizes the arena over the
    // remaining partition — see load_pak_blob.
    let Some(blob) = load_pak_blob() else {
        host::halt("voxelmon.vxpak not found (host0:/ or ms0:/PSP/GAME/VOXELMON/)");
    };

    psp::enable_home_button();
    // Full clocks. PSPLINK launches modules at its own 222 MHz default, and
    // a QuickJS guest feels every missing cycle (the perf-wall lesson).
    sys::scePowerSetClockFrequency(333, 333, 166);
    host::init_graphics(host::GfxConfig { depth: true });

    sys::sceCtrlSetSamplingCycle(0);
    sys::sceCtrlSetSamplingMode(CtrlMode::Analog);
    let pak = match pak::read(blob) {
        Ok(p) => p,
        Err(e) => host::halt(e),
    };
    psp::dprintln!(
        "[voxelmon] pak: {} maps, {} chunks, {} verts, {} atlases, {} KB game",
        pak.maps.len(),
        pak.chunks.len(),
        pak.verts.len(),
        pak.atlases.len(),
        pak.game.len() / 1024,
    );
    psp::dprintln!(
        "[voxelmon] arena {} KB free, kernel free {} KB",
        arena::stats().tail_free_bytes / 1024,
        sys::sceKernelMaxFreeMemSize() / 1024,
    );

    // The GAME section borrows from the leaked (never-freed) blob, so the
    // 'static it carries is honest.
    voxel::init(pak.game);
    // The chip synth's banks (pak AUDI section) reach the guest through the
    // `audiodata` op: the manifest half tells the guest which bank and address
    // a song lives at, and the program half stays in the pak, where the core
    // reads it. Mounting the data is a host capability, not a host policy —
    // the guest decides whether to decode it.
    voxel::set_audio(pak.audio);
    // The synth's output rate for the whole run, set before any audio op can
    // reach the core (changing it later drops what is playing, because every
    // event's span is measured in samples). Cannot fail for a rate that
    // divides 44100, which AUDIO_RATE does by construction.
    let _ = voxel::scene().audio.set_rate(AUDIO_RATE);

    // ---- QuickJS ----
    let rt = pocketjs_psp::qjs_alloc::new_runtime();
    if rt.is_null() {
        host::halt("JS_NewRuntime returned null");
    }
    let ctx = JS_NewContext(rt);
    if ctx.is_null() {
        host::halt("JS_NewContext returned null");
    }
    let global = JS_GetGlobalObject(ctx);
    voxel::register(ctx, global);
    // globalThis.audio — the PocketJS audio module (credit-based PCM). This
    // surface is mounted on its own, not through ffi::register (that mounts
    // the `ui` surface this EBOOT does not use).
    pocketjs_psp::ffi::register_audio(ctx, global);

    let res = JS_Eval(
        ctx,
        APP_JS.as_ptr() as *const _,
        APP_JS.len() - 1, // exclude the trailing NUL
        b"voxelmon.js\0".as_ptr() as *const _,
        JS_EVAL_TYPE_GLOBAL as i32,
    );
    if JS_ValueGetTag(res) == JS_TAG_EXCEPTION {
        log_exception(ctx);
        host::halt("JS_Eval threw");
    }
    JS_FreeValue(ctx, res);

    let frame_fn = JS_GetPropertyStr(ctx, global, b"frame\0".as_ptr() as *const _);
    if JS_IsUndefined(frame_fn) {
        host::halt("globalThis.frame is undefined");
    }

    let mut renderer = gu::Renderer::new();
    let mut pad = SceCtrlData::default();
    let mut frame: u32 = 0;

    // Logic stays 60 Hz; presentation locks to every 2nd vblank (30 fps).
    // Two guest ticks run per presented frame, so game speed is unchanged
    // and the GE renders half as often — and, as important as the mean,
    // the CADENCE is even: 27-34 ms frames on a 60 Hz grid alternate
    // between 2- and 3-vblank presents (judder); paced by vcount they land
    // every 33.3 ms exactly. Capture builds keep 1:1 (they present marks).
    const TICKS_PER_PRESENT: u32 = 2;
    let mut last_vcount = sys::sceDisplayGetVcount();
    let mut t_frame_start = sys::sceKernelGetSystemTimeLow();
    #[allow(unused_assignments)]
    let mut t_js_done = t_frame_start;
    #[allow(unused_assignments)]
    let mut t_gc_done = t_frame_start;
    let mut gc_frame_us: u32 = 0;

    // ---- Frame loop (pipelined present, the openstrike-psp pattern) ----
    loop {
        t_frame_start = sys::sceKernelGetSystemTimeLow();
        gc_frame_us = 0;
        for _tick_step in 0..TICKS_PER_PRESENT {
        sys::sceCtrlPeekBufferPositive(&mut pad, 1);
        #[cfg(not(any(feature = "capture", feature = "autopilot")))]
        let mask = map_buttons(&pad);
        // A capture/autopilot build ignores the pad entirely: the run must
        // be a pure function of the tick index — for capture so the marks
        // mean anything, for autopilot so two builds' numbers compare.
        #[cfg(any(feature = "capture", feature = "autopilot"))]
        let mask = capture::scripted_buttons(frame);

        // One guest turn per host tick: frame(buttons), exactly once.
        let mut args = [JS_NewInt32(ctx, mask as i32)];
        let r = JS_Call(ctx, frame_fn, global, 1, args.as_mut_ptr());
        if JS_ValueGetTag(r) == JS_TAG_EXCEPTION {
            log_exception(ctx);
        }
        JS_FreeValue(ctx, r);
        host::drain_jobs(rt);
        t_js_done = sys::sceKernelGetSystemTimeLow();

        // Arena-pressure GC (hosts/psp main.rs): collect when a frame leaves
        // the bump past the last collection — but WHEN matters as much as
        // whether. A collection is ~175 ms on this part (measured over the
        // story tape), which mid-walk is a visible hitch; on a warp landing
        // (voxel::take_map_swapped — the guest holds the world frozen
        // through the fade) it is an invisible held cut, and map loads are
        // exactly what balloon the bump in the first place. So: collect on
        // the landing tick once pressure exists, with a 4x emergency
        // threshold so a long fade-less stretch still cannot grow the arena
        // unboundedly (that one may hitch; it fires when a run allocates
        // ~1 MB without entering a single door, which the story tape never
        // does). The ring is pre-fed to cover the stall either way.
        let swapped = voxel::take_map_swapped();
        let scene = voxel::scene();
        let gc_us = {
            const GC_BUMP_STEP: usize = 256 * 1024;
            let bump = arena::stats().bump_bytes;
            let pressure = bump > LAST_GC_BUMP.saturating_add(GC_BUMP_STEP);
            let emergency = bump > LAST_GC_BUMP.saturating_add(4 * GC_BUMP_STEP);
            if pressure && (swapped || emergency) {
                // Top the audio ring up past the stall first: the pump's
                // steady lead is 100 ms, a collection is longer, and the
                // mixer starving mid-cut would put a pop where the design
                // put silence-free continuity. Each call renders at most
                // AUDIO_MAX_FRAMES, so reaching the deep lead takes a few.
                for _ in 0..8 {
                    audio_pump_with_lead(scene, &pak, GC_LEAD_FRAMES);
                }
                let t_gc = sys::sceKernelGetSystemTimeLow();
                JS_RunGC(rt);
                LAST_GC_BUMP = arena::stats().bump_bytes;
                sys::sceKernelGetSystemTimeLow().wrapping_sub(t_gc)
            } else {
                0
            }
        };
        gc_frame_us = gc_frame_us.wrapping_add(gc_us);
        #[cfg(feature = "capture")]
        let _ = gc_us; // a capture build keeps no telemetry

        // Core frame: the ops applied during frame() already sit in the
        // scene. This tick's PCM first — the audio ops of the tick that just
        // ran are applied by the render, and the fade walks on the clock —
        // then advance the tick clock once. Same order as the sim's replay
        // (pocketvoxel-sim/src/trace.rs `close!`), so what a .vtrace records
        // and what the console plays come from the same sequence.
        // The PCM pump for this tick's ops runs AFTER the GE kick (below):
        // rendering 3 ticks' worth of catch-up PCM measured 6-8 ms on the
        // slow outdoor frames, and after the kick that work runs inside the
        // GE's execution window — time the CPU otherwise spends blocked in
        // next frame's sceGuSync. The ring sequence is unchanged (tick N's
        // ops are still applied before tick N+1's), at the price of the
        // fade stepper (`audio.tick`, inside scene.tick) sitting one tick
        // ahead of the render — a deterministic 1-3% level offset during a
        // fade, and only there. render_audio itself reads no clock.
        t_gc_done = sys::sceKernelGetSystemTimeLow();
        scene.tick();

        // ---- CAPTURE PRESENT: only the mark frames render (capture.rs
        // module docs — the state is pure CPU; drawing the in-between
        // frames under the software renderer would take an hour). Each
        // mark draws synchronously (start → render → kick → sync → swap)
        // and dumps immediately; no pipeline, no off-by-one.
        #[cfg(feature = "capture")]
        {
            capture::heartbeat(frame);
            if capture::is_mark(frame) {
                capture::log_line("mark: build");
                let list = draw::build(scene, &pak);
                renderer.reset_pool(); // GE idle: fully synced below, every mark
                capture::log_line("mark: record");
                sys::sceGuStart(GuContextType::Direct, host::list_ptr());
                renderer.render(&list, &pak);
                sys::sceGuFinish();
                capture::log_line("mark: sync");
                sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
                sys::sceDisplayWaitVblankStart();
                sys::sceGuSwapBuffers();
                capture::log_line("mark: dump");
                capture::dump_frame(frame);
                // Hold each mark ~3 s on screen so a live PSPLINK session
                // can scrshot it (headless runs just get slightly longer).
                for _ in 0..180 {
                    sys::sceDisplayWaitVblankStart();
                }
            }
            capture::tick_exit(frame);
        }
        frame = frame.wrapping_add(1);
        } // ---- end of the ticks-per-present inner loop
        let scene = voxel::scene();

        // ---- PIPELINED PRESENT: the GE has been executing frame N-1's
        // list while the JS/tick above ran. Wait for it, present it, then
        // record frame N and loop into N+1's CPU work. The pool and
        // display list are reused only after the sync.
        #[cfg(not(feature = "capture"))]
        {
            let t_guest_done = sys::sceKernelGetSystemTimeLow();
            let list = draw::build(scene, &pak);
            let t_work_done = sys::sceKernelGetSystemTimeLow();
            sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
            let t_synced = sys::sceKernelGetSystemTimeLow();
            // Present on an even TICKS_PER_PRESENT-vblank cadence: wait
            // until that many vblanks have passed since the last present
            // and not a tick longer — the even beat IS the smoothness.
            while sys::sceDisplayGetVcount() < last_vcount.wrapping_add(TICKS_PER_PRESENT) {
                sys::sceDisplayWaitVblankStart();
            }
            last_vcount = sys::sceDisplayGetVcount();
            sys::sceGuSwapBuffers();
            let t_present = sys::sceKernelGetSystemTimeLow();
            renderer.reset_pool(); // GE idle: safe to rewind (pool contract)
            sys::sceGuStart(GuContextType::Direct, host::list_ptr());
            renderer.render(&list, &pak);
            let t_recorded = sys::sceKernelGetSystemTimeLow();
            // Belt-and-braces coherence: ~0.1 ms flushes every dirty line
            // before the kick, so no per-write WritebackRange call can be
            // missed as staging paths evolve. (The one garble actually
            // observed on hardware was the narrow-atlas-page sampling, not
            // proven cache incoherence — this stays because it is cheap.)
            sys::sceKernelDcacheWritebackAll();
            sys::sceGuFinish(); // kick list N — the GE draws during N+1's CPU
            let t_kicked = sys::sceKernelGetSystemTimeLow();
            // This tick's PCM, inside the GE's execution window (see the
            // comment at scene.tick above).
            audio_pump(scene, &pak);
            let t_pump_done = sys::sceKernelGetSystemTimeLow();
            #[cfg(not(feature = "telemetry"))]
            let _ = (
                t_guest_done,
                t_synced,
                t_present,
                t_recorded,
                t_kicked,
                t_js_done,
                t_gc_done,
                t_pump_done,
            );
            #[cfg(feature = "telemetry")]
            {
                let (mut tris, mut draws) = (0u32, 0u32);
                for it in &list.items {
                    if let pocketvoxel_core::draw::Item::ChunkMesh { mesh, .. }
                        | pocketvoxel_core::draw::Item::StampMesh { mesh, .. } = it
                    {
                        tris += mesh.index_count as u32 / 3;
                        draws += 1;
                    }
                }
                GEO_TRIS = tris;
                GEO_DRAWS = draws;
            }
            // The rolling mean answers "how is it generally"; the autopilot's
            // per-frame phase log answers "where does THIS frame go". One
            // build keeps one voice.
            #[cfg(all(feature = "telemetry", not(feature = "autopilot")))]
            perf_sample(
                frame,
                t_work_done.wrapping_sub(t_frame_start),
                t_kicked.wrapping_sub(t_frame_start),
                gc_frame_us,
            );
            #[cfg(feature = "autopilot")]
            autopilot_sample(
                frame,
                t_guest_done.wrapping_sub(t_frame_start),
                t_work_done.wrapping_sub(t_guest_done),
                t_synced.wrapping_sub(t_work_done),
                t_present.wrapping_sub(t_synced),
                t_recorded.wrapping_sub(t_present),
                t_kicked.wrapping_sub(t_recorded),
                gc_frame_us,
                t_js_done.wrapping_sub(t_frame_start),
                t_pump_done.wrapping_sub(t_kicked),
                t_guest_done.wrapping_sub(t_gc_done),
            );
        }


    }
}

// ---------------------------------------------------------------------------
// The PCM pump — one call per tick, between the guest's turn and the clock
// ---------------------------------------------------------------------------

/// contracts/spec/audio.ts:149 `audioFramesForTick` — the frames the audio
/// clock consumes during tick `tick`. The floor difference distributes
/// 11025/60 = 183.75 as 183/184/184/184… with zero drift: any 60 consecutive
/// ticks sum to exactly the rate. u64 throughout, because `tick * rate`
/// overflows u32 after under two hours of play.
fn audio_frames_for_tick(tick: u32) -> usize {
    let rate = AUDIO_RATE as u64;
    let tick = tick as u64;
    (((tick + 1) * rate) / 60 - (tick * rate) / 60) as usize
}

/// Read a numeric field out of one audio-module event. The module publishes
/// its facts as the spec's JSON (`{"t":"credit","h":8,"free":16384}`) because
/// its usual reader is a guest; this pump is native and needs two numbers out
/// of one shape, so it probes the key rather than linking a parser.
fn audio_event_number(line: &str, key: &str) -> Option<usize> {
    let at = line.find(key)? + key.len();
    let mut value = 0usize;
    let mut any = false;
    for &b in &line.as_bytes()[at..] {
        if !b.is_ascii_digit() {
            break;
        }
        value = value * 10 + (b - b'0') as usize;
        any = true;
    }
    any.then_some(value)
}

/// Feed this tick's chip-synth PCM to the audio module (hosts/psp/src/
/// audio_mod.rs), obeying the credit contract in contracts/spec/audio.ts.
///
/// The EBOOT is the module's client here, not the guest: psp-main.ts emits
/// audio INTENT as `voxel.*` ops and never touches `globalThis.audio`, so
/// there is no PCM on the JS boundary at all. What crosses per tick is a
/// render straight from the core into a bss buffer and one `write_pcm`.
///
/// Shape of a tick:
///   1. drain the event batch — `credit` resets the free-frame mirror,
///      `underrun` says the ring starved (the mixer emitted silence for the
///      gap and resumes on its own when data lands);
///   2. want = this tick's frames + whatever it takes to reach the 100 ms
///      lead, capped at three ticks and at the mirror;
///   3. render exactly `want` frames and write them; the tap opens after the
///      first accepted write, never before (an empty playing ring is an
///      underrun by construction).
///
/// The stream is opened on the first tick after the guest emits any audio op
/// — no op, no hardware channel and no mixer thread, so a run with audio off
/// costs one predictable branch per tick.
unsafe fn audio_pump(scene: &mut Scene, pak: &pak::Pak<'_>) {
    audio_pump_with_lead(scene, pak, AUDIO_LEAD_FRAMES);
}

/// [`audio_pump`] with the ring lead as a parameter — the GC path asks for a
/// deeper one right before stalling the world (see the frame loop).
unsafe fn audio_pump_with_lead(scene: &mut Scene, pak: &pak::Pak<'_>, lead: usize) {
    // A capture build stays silent: its marks are pixels, its run has to be a
    // pure function of the tick index, and PPSSPPHeadless has no speaker to
    // pace a mixer thread against. `cfg!` rather than `#[cfg]` so the pump
    // still compiles in that build and cannot rot behind the feature.
    if cfg!(feature = "capture") || AUDIO_REFUSED || !voxel::audio_wanted() {
        return;
    }
    if AUDIO_HANDLE < 0 {
        AUDIO_HANDLE = audio_mod::create_stream(AUDIO_RATE, 2);
        if AUDIO_HANDLE < 0 {
            // No free channel or a rate the module rejects: run silent for
            // the rest of the session rather than retry 60 times a second.
            AUDIO_REFUSED = true;
            psp::dprintln!("[voxelmon] audio: stream refused, running silent");
            return;
        }
        AUDIO_FREE = audio_spec::RING_FRAMES;
        psp::dprintln!("[voxelmon] audio: {} Hz stereo stream open", AUDIO_RATE);
    }

    while let Some(event) = audio_mod::poll() {
        // Every event names its stream, and `globalThis.audio` is mounted for
        // this realm too: a future guest that opens its own stream must not
        // reset this pump's mirror with its credit.
        if audio_event_number(&event, "\"h\":") != Some(AUDIO_HANDLE as usize) {
            continue;
        }
        if let Some(free) = audio_event_number(&event, "\"free\":") {
            AUDIO_FREE = free;
        } else if event.contains(audio_spec::EVENT_UNDERRUN) {
            AUDIO_UNDERRUNS += 1;
            if AUDIO_UNDERRUNS == 1 {
                // Once per boot: the first starve is the diagnosis (the pump
                // fell behind the audio clock), the rest are its echo.
                psp::dprintln!("[voxelmon] audio: ring starved, refilling");
            }
        }
    }

    let per_tick = audio_frames_for_tick(AUDIO_CLOCK);
    AUDIO_CLOCK = AUDIO_CLOCK.wrapping_add(1);
    let queued = audio_spec::RING_FRAMES - AUDIO_FREE.min(audio_spec::RING_FRAMES);
    let want = (per_tick + lead.saturating_sub(queued))
        .min(AUDIO_MAX_FRAMES)
        .min(AUDIO_FREE);
    if want == 0 {
        return; // the ring is full: this tick's frames are already in it
    }

    scene.render_audio(pak, want, &mut AUDIO_PCM[..want * 2]);
    // write_pcm BORROWS the buffer for the call (contracts/spec/audio.ts): it
    // copies into the ring before returning, so the bss buffer is reused next
    // tick with no ownership question.
    let accepted = audio_mod::write_pcm(AUDIO_HANDLE, &AUDIO_PCM[..want * 2]).max(0) as usize;
    AUDIO_FREE = AUDIO_FREE.saturating_sub(accepted);
    if !AUDIO_STARTED && accepted > 0 {
        AUDIO_STARTED = true;
        audio_mod::play(AUDIO_HANDLE);
    }
}

/// Frame-time telemetry, appended to host0:/voxperf.txt (PSPLINK serves it;
/// an absent host0: fails silently). Two records, because a mean answers a
/// different question than a frame does:
///
///   `b<frame> work <n>us frame <n>us gc <n>us` — ONE LINE PER FRAME for the
///   first BOOT_FRAMES frames, buffered in bss and flushed in a single write
///   (writing per frame would cost more than the frame being measured). This
///   is what separates "one gigantic first frame collecting over the
///   freshly-parsed 1.15 MB gamedata graph" from "every early frame is slow"
///   — the 300-frame mean cannot, and that ambiguity is exactly what the
///   110 ms boot figure left open.
///
///   `f<frame> work <n>us frame <n>us max <n>us` — the rolling 300-frame
///   MEAN, plus the window's worst work sample so one spike can no longer
///   hide inside an average.
///
/// work = JS + tick + list build (pre-sync CPU), frame = work + GE sync +
/// vblank + record, gc = the arena-pressure JS_RunGC inside that work.
///
/// Runbook: launch the release EBOOT under PSPLINK, play through the opening,
/// then read host0:/voxperf.txt.
#[cfg_attr(feature = "capture", allow(dead_code))]
const BOOT_FRAMES: usize = 120;
#[cfg_attr(feature = "capture", allow(dead_code))]
#[cfg(feature = "telemetry")]
static mut GEO_TRIS: u32 = 0;
#[cfg(feature = "telemetry")]
static mut GEO_DRAWS: u32 = 0;
static mut PERF_WORK: u64 = 0;
#[cfg_attr(feature = "capture", allow(dead_code))]
static mut PERF_FRAME: u64 = 0;
#[cfg_attr(feature = "capture", allow(dead_code))]
static mut PERF_MAX_WORK: u32 = 0;
#[cfg_attr(feature = "capture", allow(dead_code))]
static mut BOOT_WORK: [u32; BOOT_FRAMES] = [0; BOOT_FRAMES];
#[cfg_attr(feature = "capture", allow(dead_code))]
static mut BOOT_FRAME: [u32; BOOT_FRAMES] = [0; BOOT_FRAMES];
#[cfg_attr(feature = "capture", allow(dead_code))]
static mut BOOT_GC: [u32; BOOT_FRAMES] = [0; BOOT_FRAMES];

#[cfg_attr(feature = "capture", allow(dead_code))]
unsafe fn perf_write(text: &str) {
    let fd = sys::sceIoOpen(
        b"host0:/voxperf.txt\0".as_ptr(),
        IoOpenFlags::WR_ONLY | IoOpenFlags::CREAT | IoOpenFlags::APPEND,
        0o644,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, text.as_ptr() as *const c_void, text.len());
        sys::sceIoClose(fd);
    }
}

#[cfg_attr(any(feature = "capture", feature = "autopilot"), allow(dead_code))]
#[cfg(feature = "telemetry")]
unsafe fn perf_sample(frame: u32, work_us: u32, frame_us: u32, gc_us: u32) {
    PERF_WORK += work_us as u64;
    PERF_FRAME += frame_us as u64;
    if work_us > PERF_MAX_WORK {
        PERF_MAX_WORK = work_us;
    }

    // ---- the boot window: record every frame, flush once at the end
    let i = frame as usize;
    if i < BOOT_FRAMES {
        BOOT_WORK[i] = work_us;
        BOOT_FRAME[i] = frame_us;
        BOOT_GC[i] = gc_us;
        if i + 1 == BOOT_FRAMES {
            // One write for the whole window, and it lands AFTER this frame's
            // samples were taken, so the flush cannot appear in its own data.
            let mut text = alloc::string::String::new();
            for f in 0..BOOT_FRAMES {
                let (w, fr, gc) = (BOOT_WORK[f], BOOT_FRAME[f], BOOT_GC[f]);
                let _ = core::fmt::write(
                    &mut text,
                    format_args!("b{} work {}us frame {}us gc {}us\n", f, w, fr, gc),
                );
            }
            perf_write(&text);
        }
    }

    if frame == 0 || frame % 300 != 0 {
        return;
    }
    let (work_mean, frame_mean, worst) = (PERF_WORK / 300, PERF_FRAME / 300, PERF_MAX_WORK);
    let mut line = alloc::string::String::new();
    let _ = core::fmt::write(
        &mut line,
        format_args!(
            "f{} work {}us frame {}us max {}us tris {} draws {}\n",
            frame, work_mean, frame_mean, worst, GEO_TRIS, GEO_DRAWS,
        ),
    );
    PERF_WORK = 0;
    PERF_FRAME = 0;
    PERF_MAX_WORK = 0;
    perf_write(&line);
}

/// The autopilot's per-frame phase log: one line per frame into a
/// pre-reserved buffer (an appending write per frame would cost more than
/// most of the phases being measured), flushed to host0:/voxperf.txt in one
/// write when the tape ends, then the run exits itself.
///
///   a<frame> g <guest> b <build> s <sync> v <vb> r <rec> k <kick>
///     gc <gc> tris <n> draws <n>
///
/// guest = JS frame() + jobs + GC + audio pump + scene.tick; build =
/// draw::build; sync = waiting on frame N-1's GE; vb = vblank + swap; rec =
/// the CPU record pass (pool staging, pull restage); kick = the coherence
/// writeback + list kick. All µs.
#[cfg(feature = "autopilot")]
static mut PILOT_LOG: Option<alloc::string::String> = None;
/// One reservation up front: growing the log mid-run would both disturb the
/// arena the guest is playing in and put its own realloc into the numbers.
#[cfg(feature = "autopilot")]
const PILOT_CAP: usize = 512 * 1024;

/// Append one guest-side profiling line (voxel.rs's autopilot-only `perf`
/// binding lands here, interleaved with the host's phase lines).
#[cfg(feature = "autopilot")]
pub(crate) unsafe fn pilot_guest_line(line: &str) {
    use core::fmt::Write as _;
    if let Some(log) = PILOT_LOG.as_mut() {
        if log.len() + line.len() + 1 <= PILOT_CAP {
            let _ = writeln!(log, "{}", line);
        }
    }
}

#[cfg(feature = "autopilot")]
#[allow(clippy::too_many_arguments)]
unsafe fn autopilot_sample(
    frame: u32,
    guest_us: u32,
    build_us: u32,
    sync_us: u32,
    vb_us: u32,
    rec_us: u32,
    kick_us: u32,
    gc_us: u32,
    js_us: u32,
    pump_us: u32,
    tick_us: u32,
) {
    use core::fmt::Write as _;
    let log = PILOT_LOG.get_or_insert_with(|| {
        let mut s = alloc::string::String::new();
        s.reserve(PILOT_CAP);
        s
    });
    if log.len() + 160 <= PILOT_CAP {
        let _ = write!(
            log,
            "a{} g {} b {} s {} v {} r {} k {} gc {} tris {} draws {} pv {} pus {} js {} ap {} tk {}\n",
            frame,
            guest_us,
            build_us,
            sync_us,
            vb_us,
            rec_us,
            kick_us,
            gc_us,
            GEO_TRIS,
            GEO_DRAWS,
            gu::PULL_VERTS,
            gu::PULL_US,
            js_us,
            pump_us,
            tick_us,
        );
    }
    if frame % 300 == 0 {
        psp::dprintln!("[voxelmon] autopilot: tick {}", frame);
    }
    // The tape is over one grace-second after its last mark: flush, exit.
    let last = capture::last_mark_tick();
    if frame >= last.saturating_add(60) {
        perf_write(log);
        psp::dprintln!("[voxelmon] autopilot: {} frames logged, exiting", frame + 1);
        sys::sceKernelExitGame();
    }
}

/// Map the console's pad onto VOX_BTN. CIRCLE = A (confirm), CROSS = B —
/// see the module docs. The analog stick walks too, one axis at a time
/// (the world is a grid; a diagonal push picks a lane).
#[cfg_attr(any(feature = "capture", feature = "autopilot"), allow(dead_code))]
fn map_buttons(pad: &SceCtrlData) -> u32 {
    let b = pad.buttons;
    let mut mask = 0;
    if b.contains(CtrlButtons::UP) {
        mask |= spec::btn::UP;
    }
    if b.contains(CtrlButtons::DOWN) {
        mask |= spec::btn::DOWN;
    }
    if b.contains(CtrlButtons::LEFT) {
        mask |= spec::btn::LEFT;
    }
    if b.contains(CtrlButtons::RIGHT) {
        mask |= spec::btn::RIGHT;
    }
    if b.contains(CtrlButtons::CIRCLE) {
        mask |= spec::btn::A;
    }
    if b.contains(CtrlButtons::CROSS) {
        mask |= spec::btn::B;
    }
    if b.contains(CtrlButtons::START) {
        mask |= spec::btn::START;
    }
    if b.contains(CtrlButtons::SELECT) {
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
