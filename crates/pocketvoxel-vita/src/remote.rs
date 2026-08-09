//! Video-only PKNT stream for the bedroom's remote computer.
//!
//! The vendored PocketJS Vita transport owns discovery, TCP framing and the
//! in-memory `.pkst` image. This module borrows only that transport and the
//! shared format parser; it never starts PocketJS video audio, because Pocket
//! Voxel's chip synth already owns the application's sound path.

use pocketjs_core::spec::stream as st;
use pocketjs_core::stream::{parse_header_block, parse_slot_header, slot_offset, StreamHeaders};
use pocketjs_vita::net;
use pocketvoxel_gxm::Renderer;

const APP: &str = "voxelmon";
const STREAM_PATH: &str = "media/desktop.pkst";

struct Session {
    geo: StreamHeaders,
    epoch: u32,
    /// 1024-byte ABGR palette followed by w*h CLUT8 indices.
    staging: Vec<u8>,
    presented_seq: u32,
    presented_frame: i32,
    staged_seq: u32,
    staged_frame: i32,
    pending: bool,
}

static mut SESSION: Option<Session> = None;
/// Texture destruction is deferred from the guest turn to the GPU-idle
/// window immediately after `vita2d_start_drawing`.
static mut CLEAR_PENDING: bool = false;

/// Start (or probe) the PocketJS transport and bind its announced desktop
/// ring. False is retryable while discovery/connection is still in flight.
pub unsafe fn open() -> bool {
    if SESSION.is_some() {
        return true;
    }
    if !net::open(APP) {
        return false;
    }
    let Some(geo) = net::with_stream(|path, ram| {
        (path == STREAM_PATH)
            .then(|| parse_header_block(ram.buf()))
            .flatten()
    })
    .flatten() else {
        return false;
    };
    if geo.ended {
        return false;
    }
    let pixels = (geo.video.w as usize).saturating_mul(geo.video.h as usize);
    SESSION = Some(Session {
        geo,
        epoch: geo.epoch,
        staging: vec![0; 1024 + pixels],
        presented_seq: 0,
        presented_frame: -1,
        staged_seq: 0,
        staged_frame: -1,
        pending: false,
    });
    CLEAR_PENDING = true;
    true
}

/// Stage the newest complete TCP slot. The network supervisor has already
/// reconstructed a byte-exact `.pkst` image, so this is one bounded memcpy
/// under its short-held stream lock.
pub unsafe fn tick() -> i32 {
    let Some(session) = SESSION.as_mut() else {
        return -1;
    };
    if !net::connected() {
        return -2;
    }
    let mut terminal = false;
    let staged = net::with_stream(|path, ram| {
        if path != STREAM_PATH {
            terminal = true;
            return false;
        }
        let bytes = ram.buf();
        let Some(now) = parse_header_block(bytes) else {
            terminal = true;
            return false;
        };
        if now.ended
            || now.video_off != session.geo.video_off
            || now.video.w != session.geo.video.w
            || now.video.h != session.geo.video.h
            || now.video.slot_count != session.geo.video.slot_count
            || now.video.slot_size != session.geo.video.slot_size
        {
            terminal = true;
            return false;
        }
        if now.epoch != session.epoch {
            session.epoch = now.epoch;
            session.presented_seq = 0;
            session.presented_frame = -1;
            session.pending = false;
        }
        let video = now.video;
        if session.pending || video.latest_seq == 0 || video.latest_seq <= session.presented_seq {
            return false;
        }
        let seq = video.latest_seq;
        let Some(offset) = slot_offset(&now, seq).map(|offset| offset as usize) else {
            return false;
        };
        let Some(slot) = bytes
            .get(offset..)
            .and_then(|slot| parse_slot_header(slot, &session.geo.video))
        else {
            return false;
        };
        if slot.seq != seq {
            return false;
        }
        let payload_at = offset + st::SLOT_HEADER_SIZE;
        let Some(payload) = bytes.get(payload_at..payload_at + session.staging.len()) else {
            return false;
        };
        session.staging.copy_from_slice(payload);
        session.staged_seq = seq;
        session.staged_frame = slot.frame_index as i32;
        true
    })
    .unwrap_or_else(|| {
        terminal = true;
        false
    });
    if terminal {
        return -2;
    }
    if staged {
        session.pending = true;
    }
    session.presented_frame
}

/// Commit staged pixels after the previous GXM scene is idle.
pub unsafe fn present(renderer: &mut Renderer) {
    if CLEAR_PENDING {
        renderer.clear_remote_video();
        CLEAR_PENDING = false;
    }
    let Some(session) = SESSION.as_mut() else {
        return;
    };
    if !session.pending {
        return;
    }
    let (palette, indices) = session.staging.split_at(1024);
    if renderer.update_remote_video(session.geo.video.w, session.geo.video.h, palette, indices) {
        session.pending = false;
        session.presented_seq = session.staged_seq;
        session.presented_frame = session.staged_frame;
    }
}

/// Stop presenting this session. The transport remains connected and keeps
/// the latest ring warm, so reopening the bedroom PC does not force another
/// Wi-Fi discovery cycle.
pub unsafe fn close() {
    SESSION = None;
    CLEAR_PENDING = true;
}
