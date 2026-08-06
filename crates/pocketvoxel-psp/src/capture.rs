//! The frame-dump build (`--features capture`) — tests/e2e/voxel-ppsspp.ts.
//!
//! Exactly the pocketmon-psp capture mechanism: bake the run into the EBOOT
//! (the emulator's filesystem is one more thing between "the run" and "the
//! verdict"), replay it under PPSSPPHeadless's software renderer, dump the
//! presented framebuffer at each checkpoint.
//!
//! - `VOXEL_CAP_INPUT`  — `"tick:mask,tick:mask,…"`; the active mask is the
//!   last threshold at or before the current tick. tools/voxel.ts extracts
//!   it from the story `.vtrace`'s `t <tick> <buttons>` lines (every button
//!   transition is an entry, so the threshold form replays the per-tick
//!   stream exactly).
//! - `VOXEL_CAP_MARKS`  — `"tick,tick,…"`, ascending: the checkpoint ticks
//!   (one per `m` line). Frame N of the run renders the state after tick
//!   N's ops + scene.tick — the same state the sim hashes at a mark in tick
//!   block N — so dumping frame N at each mark tick reproduces the sim's
//!   checkpoint frames. Files: `ms0:/vox_cap/fNNNN.raw` in mark order
//!   (512-stride RGBA, top-down, straight from VRAM).
//!
//! Capture runs render ONLY the mark frames ([`is_mark`] gates the whole
//! GE pass in main.rs): the diorama's Route 1 seam is ~400k triangles a
//! frame, which PPSSPP's byte-stable software renderer draws at seconds
//! per frame — rendering the ~3000 in-between frames would burn an hour
//! proving nothing, since the scene state is a pure function of (tick,
//! buttons) on the CPU side and the DrawList build is pure. The presented
//! picture at each mark is identical either way.
//!
//! The run exits itself after the last mark (plus a small grace window in
//! case a mark never lands, so a broken build fails fast instead of eating
//! the harness timeout). Never compiled into a normal build.

use core::ffi::c_void;

use psp::sys::{self, DisplayPixelFormat, DisplaySetBufSync, IoOpenFlags};

const INPUT: &str = env!("VOXEL_CAP_INPUT");
const MARKS: &str = env!("VOXEL_CAP_MARKS");

/// Frames past the last mark before a hard exit (a mark can only be missed
/// if the pipeline is broken; presenting is 60 Hz so this is one second).
const GRACE: u32 = 60;

fn parse_u32(s: &str) -> Option<u32> {
    let s = s.trim();
    let (radix, digits) = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex) => (16, hex),
        None => (10, s),
    };
    if digits.is_empty() {
        return None;
    }
    let mut v: u32 = 0;
    for b in digits.bytes() {
        let d = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' if radix == 16 => b - b'a' + 10,
            b'A'..=b'F' if radix == 16 => b - b'A' + 10,
            _ => return None,
        };
        v = v.wrapping_mul(radix).wrapping_add(d as u32);
    }
    Some(v)
}

/// The scripted button mask for a tick: the last threshold at or before it.
pub fn scripted_buttons(tick: u32) -> u32 {
    let mut best_tick = 0u32;
    let mut best = 0u32;
    let mut seen = false;
    for pair in INPUT.split(',') {
        let Some((at, mask)) = pair.split_once(':') else {
            continue;
        };
        let (Some(at), Some(mask)) = (parse_u32(at), parse_u32(mask)) else {
            continue;
        };
        if at <= tick && (!seen || at >= best_tick) {
            best_tick = at;
            best = mask;
            seen = true;
        }
    }
    best
}

/// Mark index for a presented tick, plus the total and the last mark tick.
fn mark_info(tick: u32) -> (Option<u32>, u32, u32) {
    let mut idx = None;
    let mut count = 0u32;
    let mut last = 0u32;
    for entry in MARKS.split(',') {
        let Some(t) = parse_u32(entry) else { continue };
        if t == tick {
            idx = Some(count);
        }
        if t > last {
            last = t;
        }
        count += 1;
    }
    (idx, count, last)
}

/// True when `tick` is a checkpoint — main.rs renders and presents only
/// these frames in a capture build (see the module docs).
pub fn is_mark(tick: u32) -> bool {
    mark_info(tick).0.is_some()
}

/// The last checkpoint tick (0 with no marks) — the autopilot build's
/// "tape is over" signal.
pub fn last_mark_tick() -> u32 {
    mark_info(0).2
}

/// Dump the just-presented framebuffer if `presented_tick` is a checkpoint;
/// exit the run once the last checkpoint (or the grace window) passes.
///
/// # Safety
/// Call between `sceGuSwapBuffers` and the next list kick (the display
/// buffer must be settled).
pub unsafe fn dump_frame(presented_tick: u32) {
    // Device runs (PSPLINK) screenshot externally; the VRAM->ms0 frame
    // write hangs on real hardware IO. VOXEL_CAP_DUMP=0 skips it.
    if matches!(option_env!("VOXEL_CAP_DUMP"), Some("0")) {
        return;
    }
    let (idx, count, last) = mark_info(presented_tick);
    if count == 0 {
        return;
    }
    if let Some(idx) = idx {
        if idx == 0 {
            sys::sceIoMkdir(b"ms0:/vox_cap\0".as_ptr(), 0o777);
        }
        // "ms0:/vox_cap/fNNNN.raw\0", digits at offsets 14..=17.
        let mut name: [u8; 23] = *b"ms0:/vox_cap/f0000.raw\0";
        let mut v = idx;
        let mut i = 17usize;
        loop {
            name[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if i == 14 {
                break;
            }
            i -= 1;
        }
        // Read straight from VRAM through the uncached mirror: the GE's
        // output is not in the CPU's dcache; the cached view is stale.
        let mut top: *mut c_void = core::ptr::null_mut();
        let mut bw: usize = 0;
        let mut fmt = DisplayPixelFormat::Psm8888;
        sys::sceDisplayGetFrameBuf(&mut top, &mut bw, &mut fmt, DisplaySetBufSync::Immediate);
        let mut addr = top as u32;
        if addr < 0x0400_0000 {
            addr += 0x0400_0000;
        }
        addr |= 0x4000_0000;
        let fd = sys::sceIoOpen(
            name.as_ptr(),
            IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
            0o777,
        );
        if fd.0 >= 0 {
            sys::sceIoWrite(fd, addr as *const c_void, 512 * 272 * 4);
            sys::sceIoClose(fd);
        }
    }
    if presented_tick >= last && idx.is_some() {
        sys::sceKernelExitGame();
    }
}

/// Per-frame watchdog: end the run once the grace window past the last
/// mark expires, so a build that somehow skips a mark still terminates.
///
/// # Safety
/// PSP kernel call; any thread.
pub unsafe fn tick_exit(tick: u32) {
    let (_, count, last) = mark_info(tick);
    if count > 0 && tick >= last.saturating_add(GRACE) {
        sys::sceKernelExitGame();
    }
}

/// Debug heartbeat: every 30 ticks, truncate-write the current tick to
/// `ms0:/vox_cap/hb.txt` — when a run wedges, the file names the tick.
///
/// # Safety
/// PSP io calls; worker thread.
pub unsafe fn heartbeat(tick: u32) {
    if tick % 30 != 0 {
        return;
    }
    if tick == 0 {
        sys::sceIoMkdir(b"ms0:/vox_cap\0".as_ptr(), 0o777);
    }
    let mut buf = [b' '; 12];
    let mut v = tick;
    let mut i = 9usize;
    loop {
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 || i == 0 {
            break;
        }
        i -= 1;
    }
    buf[10] = b'\n';
    buf[11] = 0;
    let fd = sys::sceIoOpen(
        b"ms0:/vox_cap/hb.txt\0".as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::TRUNC,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, buf.as_ptr() as *const c_void, 11);
        sys::sceIoClose(fd);
    }
}

/// Append one guest-exception line to `ms0:/vox_cap/log.txt` (the debug
/// screen is invisible under PPSSPPHeadless).
///
/// # Safety
/// PSP io calls; worker thread.
pub unsafe fn log_line(msg: &str) {
    let fd = sys::sceIoOpen(
        b"ms0:/vox_cap/log.txt\0".as_ptr(),
        IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | IoOpenFlags::APPEND,
        0o777,
    );
    if fd.0 >= 0 {
        sys::sceIoWrite(fd, msg.as_ptr() as *const c_void, msg.len());
        sys::sceIoWrite(fd, b"\n".as_ptr() as *const c_void, 1);
        sys::sceIoClose(fd);
    }
}
