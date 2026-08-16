//! Video-only Pocket service stream for the bedroom's remote computer.
//!
//! This is deliberately narrower than PocketJS's general `vid` module. It
//! reuses the proven `pocket-svc` root discovery and the shared, hardened
//! `.pkst` parsers, but never opens an audio channel: VOXELMON's chip synth
//! already owns its sound path. The companion writes one fixed stream,
//! `pocket-svc/voxelmon/media/desktop.pkst`, under either the PSPLINK
//! `host0:` share or PPSSPP's `ms0:` directory.
//!
//! `tick` performs bounded file IO while the previous GE list may still be
//! running. A complete, revalidated slot waits in cached main RAM until
//! `present`, which the frame loop calls only after `sceGuSync`; only there
//! are the renderer's persistent CLUT8 bytes replaced. This is the same
//! no-tearing boundary as PocketJS video, without its PCM half.

use alloc::vec::Vec;
use core::ffi::c_void;

use pocketjs_core::spec::stream as st;
use pocketjs_core::stream::{parse_header_block, parse_slot_header, slot_offset, StreamHeaders};
use pocketjs_psp::svc;
use pocketvoxel_gu::Renderer;
use psp::sys::{self, IoOpenFlags, IoWhence, SceUid};

const APP: &str = "voxelmon";
const STREAM_PATH: &str = "media/desktop.pkst";

/// No PCM crosses this stream, so the whole budget is available to pixels.
/// 26 KiB per 60 Hz tick is PocketJS's hardware-tuned usbhostfs ceiling: a
/// 512x128 CLUT8 frame drains in three ticks and a stalled host cannot turn
/// one guest turn into an unbounded file read.
const IO_BUDGET: usize = 26 * 1024;

struct Session {
    fd: SceUid,
    /// Geometry pinned at open. Per-tick reads refresh cursors and epoch.
    geo: StreamHeaders,
    epoch: u32,
    /// Slot header + 1024-byte ABGR CLUT + w*h index bytes.
    slot_bytes: usize,
    staging: Vec<u8>,
    staged: usize,
    /// Slot being read; zero means idle.
    target_seq: u32,
    presented_seq: u32,
    presented_frame: i32,
    /// Complete slot waiting for the GE-idle commit.
    staged_seq: u32,
    staged_frame: i32,
    pending: bool,
}

static mut SESSION: Option<Session> = None;
/// Renderer memory can only be freed with the GE idle. `close` runs inside
/// the guest turn, so it requests a deferred clear instead of dropping it.
static mut CLEAR_PENDING: bool = false;

/// Positional read: seek then fill exactly `buf`. A `.pkst` ring is
/// preallocated, so a short read is a transport failure rather than EOF.
unsafe fn pread(fd: SceUid, off: u32, buf: &mut [u8]) -> bool {
    if sys::sceIoLseek(fd, off as i64, IoWhence::Set) != off as i64 {
        return false;
    }
    let mut got = 0usize;
    while got < buf.len() {
        let n = sys::sceIoRead(
            fd,
            buf.as_mut_ptr().add(got) as *mut c_void,
            (buf.len() - got) as u32,
        );
        if n <= 0 {
            return false;
        }
        got += n as usize;
    }
    true
}

/// Bind the fixed desktop stream. Returns true only after both the service
/// root and a valid stream header exist; callers may retry while the daemon
/// is starting.
pub unsafe fn open() -> bool {
    close_session(false);
    CLEAR_PENDING = true;

    if !svc::active() && !svc::open(APP) {
        return false;
    }
    let Some(path) = svc::side_path(STREAM_PATH) else {
        return false;
    };
    let fd = sys::sceIoOpen(path.as_ptr(), IoOpenFlags::RD_ONLY, 0o777);
    if fd.0 < 0 {
        return false;
    }
    let mut header = [0u8; st::HEADER_BLOCK_SIZE];
    if !pread(fd, 0, &mut header) {
        sys::sceIoClose(fd);
        return false;
    }
    let Some(geo) = parse_header_block(&header) else {
        sys::sceIoClose(fd);
        return false;
    };
    if geo.ended {
        sys::sceIoClose(fd);
        return false;
    }
    let pixel_bytes = (geo.video.w as usize).saturating_mul(geo.video.h as usize);
    let slot_bytes = st::SLOT_HEADER_SIZE + 1024 + pixel_bytes;
    SESSION = Some(Session {
        fd,
        epoch: geo.epoch,
        geo,
        slot_bytes,
        staging: alloc::vec![0u8; slot_bytes],
        staged: 0,
        target_seq: 0,
        presented_seq: 0,
        presented_frame: -1,
        staged_seq: 0,
        staged_frame: -1,
        pending: false,
    });
    true
}

/// Continue the newest slot read within one tick's IO budget. The returned
/// index changes only after [`present`] commits a complete frame; `-1` means
/// unopened or waiting for the first picture, and `-2` asks the guest to
/// close an ended/broken file and retry the service path.
pub unsafe fn tick() -> i32 {
    let Some(s) = SESSION.as_mut() else {
        return -1;
    };
    let mut budget = IO_BUDGET;

    let mut header = [0u8; st::HEADER_BLOCK_SIZE];
    if !pread(s.fd, 0, &mut header) {
        return -2;
    }
    budget = budget.saturating_sub(st::HEADER_BLOCK_SIZE);
    let Some(now) = parse_header_block(&header) else {
        return -2;
    };
    if now.ended {
        return -2;
    }

    // A daemon restart/source change invalidates both an in-flight read and
    // the old seq watermark. The last committed texture may remain visible
    // until a new complete frame replaces it.
    if now.epoch != s.epoch {
        s.epoch = now.epoch;
        s.target_seq = 0;
        s.staged = 0;
        s.presented_seq = 0;
        s.pending = false;
    }

    let v = &now.video;
    if s.target_seq != 0 && v.latest_seq >= s.target_seq.saturating_add(v.slot_count) {
        // Writer lapped the slot while it was arriving; discard the torn
        // partial and chase the newest frame on the next branch below.
        s.target_seq = 0;
        s.staged = 0;
    }
    if !s.pending && s.target_seq == 0 && v.latest_seq > s.presented_seq {
        s.target_seq = v.latest_seq;
        s.staged = 0;
    }
    if !s.pending && s.target_seq != 0 {
        if let Some(base) = slot_offset(&now, s.target_seq) {
            let want = (s.slot_bytes - s.staged).min(budget);
            if want > 0 {
                let at = s.staged;
                if pread(s.fd, base + at as u32, &mut s.staging[at..at + want]) {
                    s.staged += want;
                }
            }
            if s.staged == s.slot_bytes {
                // Validate the header captured with the payload, then read
                // the live seq again. A writer that wrapped onto this slot
                // during the chunked read is rejected instead of flickering.
                let parsed = parse_slot_header(&s.staging, &s.geo.video)
                    .filter(|slot| slot.seq == s.target_seq);
                let mut live_seq = [0u8; 4];
                let fresh = parsed.is_some()
                    && pread(s.fd, base, &mut live_seq)
                    && u32::from_le_bytes(live_seq) == s.target_seq;
                if fresh {
                    let slot = parsed.expect("checked by fresh");
                    s.staged_seq = s.target_seq;
                    s.staged_frame = slot.frame_index as i32;
                    s.pending = true;
                }
                s.target_seq = 0;
                s.staged = 0;
            }
        } else {
            s.target_seq = 0;
            s.staged = 0;
        }
    }

    s.presented_frame
}

/// Commit the staged CLUT8 frame while the GE is idle. The frame loop calls
/// this after `sceGuSync` and before the next `sceGuStart`.
pub unsafe fn present(renderer: &mut Renderer) {
    if CLEAR_PENDING {
        renderer.clear_remote_video();
        CLEAR_PENDING = false;
    }

    let Some(s) = SESSION.as_mut() else {
        return;
    };
    if !s.pending {
        return;
    }
    let pal_start = st::SLOT_HEADER_SIZE;
    let pixels_start = pal_start + 1024;
    let palette = &s.staging[pal_start..pixels_start];
    let pixels = &s.staging[pixels_start..s.slot_bytes];
    if renderer.update_remote_video(s.geo.video.w, s.geo.video.h, palette, pixels) {
        s.pending = false;
        s.presented_seq = s.staged_seq;
        s.presented_frame = s.staged_frame;
    }
}

/// Stop file IO immediately; renderer storage is released later in the
/// frame loop's GE-idle window.
pub unsafe fn close() {
    close_session(true);
}

unsafe fn close_session(reset_service: bool) {
    if let Some(s) = SESSION.take() {
        sys::sceIoClose(s.fd);
    }
    CLEAR_PENDING = true;
    if reset_service {
        svc::reset();
    }
}
