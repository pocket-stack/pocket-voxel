//! PCM output for the chip synth: one BGM port at 44.1 kHz fed by a
//! dedicated thread from an in-RAM SPSC ring.
//!
//! The design is `vendor/pocketjs/hosts/vita/src/audio.rs`, which is where
//! these disciplines were earned (and, before that, the PSP's own audio.rs):
//!
//!   - single writer (the frame loop) + single reader (the audio thread)
//!     over absolute frame counters with release/acquire publication;
//!   - starvation SLEEPS rather than queueing silence, so resume latency is
//!     one block and not a queue of hush;
//!   - the PORT is opened and released on the MAIN thread — releasing it
//!     from the audio thread is the channel-leak class of bug.
//!
//! What differs is the client. The PSP EBOOT talks to PocketJS's audio
//! MODULE (`globalThis.audio`, a credit-based ring the guest could also
//! open); here the guest still never touches PCM — `psp-main.ts` emits audio
//! INTENT as `voxel.*` ops — but there is no second client to arbitrate
//! with, so the free-frame count is read directly instead of mirrored from
//! credit events.
//!
//! The synth runs at 11 025 Hz (main.rs `AUDIO_RATE`), which divides 44 100
//! exactly, so the upsample is an integer x4 step and the Vita's own
//! resampler never runs.

use core::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};

use vitasdk_sys::{
    SCE_AUDIO_OUT_MODE_STEREO, SCE_AUDIO_OUT_PORT_TYPE_BGM, sceAudioOutOpenPort,
    sceAudioOutOutput, sceAudioOutReleasePort, sceKernelDelayThread,
};

/// Output frames per port submit at 44.1 kHz (~23 ms per block).
const BLOCK_OUT: usize = 1024;
/// In-RAM ring capacity in SOURCE sample frames — 1.5 s at 11 025 Hz, which
/// is deep enough to ride out a map load without the pump ever needing to
/// think about it.
pub const RING_FRAMES: usize = 16 * 1024;

static mut RING: [i16; RING_FRAMES * 2] = [0; RING_FRAMES * 2];
static mut OUT: [i16; BLOCK_OUT * 2] = [0; BLOCK_OUT * 2];

static WRITE_POS: AtomicUsize = AtomicUsize::new(0);
static READ_POS: AtomicUsize = AtomicUsize::new(0);
static RUN: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicBool = AtomicBool::new(false);
/// Open BGM port id (-1 = none). Owned by the main thread.
static PORT: AtomicI32 = AtomicI32::new(-1);
/// Integer upsample factor to 44.1 kHz.
static UPSAMPLE: AtomicUsize = AtomicUsize::new(1);
/// Starved episodes, edge-counted by the audio thread.
pub static UNDERRUNS: AtomicUsize = AtomicUsize::new(0);

fn upsample_factor(sample_rate: u32) -> Option<usize> {
    match sample_rate {
        44100 => Some(1),
        22050 => Some(2),
        11025 => Some(4),
        _ => None,
    }
}

#[allow(static_mut_refs)]
fn audio_thread() {
    // Linear interpolation across the upsample step: the synth's own output
    // is band-limited to 5.5 kHz at this rate, so holding samples would add
    // an image the interpolation removes for two adds per output frame.
    let mut prev_l: i32 = 0;
    let mut prev_r: i32 = 0;
    while RUN.load(Ordering::Acquire) {
        let k = UPSAMPLE.load(Ordering::Relaxed).max(1);
        let need = BLOCK_OUT / k;
        let read = READ_POS.load(Ordering::Relaxed);
        let avail = WRITE_POS.load(Ordering::Acquire).wrapping_sub(read);
        if avail < need {
            UNDERRUNS.fetch_add(1, Ordering::Relaxed);
            unsafe { sceKernelDelayThread(4_000) };
            continue;
        }
        unsafe {
            for i in 0..need {
                let src = ((read + i) % RING_FRAMES) * 2;
                let l = RING[src] as i32;
                let r = RING[src + 1] as i32;
                for step in 0..k {
                    let t = (step + 1) as i32;
                    let dst = (i * k + step) * 2;
                    OUT[dst] = (prev_l + (l - prev_l) * t / k as i32) as i16;
                    OUT[dst + 1] = (prev_r + (r - prev_r) * t / k as i32) as i16;
                }
                prev_l = l;
                prev_r = r;
            }
            READ_POS.store(read.wrapping_add(need), Ordering::Release);
            let port = PORT.load(Ordering::Relaxed);
            if port >= 0 {
                sceAudioOutOutput(port, OUT.as_ptr().cast());
            }
        }
    }
    LIVE.store(false, Ordering::Release);
}

/// Open the BGM port and start the output thread. Rates without an integer
/// path to 44.1 kHz are refused (the game still runs, silently).
///
/// # Safety
/// Call once, from the main thread.
pub unsafe fn start(sample_rate: u32) -> bool {
    let Some(k) = upsample_factor(sample_rate) else {
        return false;
    };
    if LIVE.load(Ordering::Acquire) {
        return true;
    }
    WRITE_POS.store(0, Ordering::Relaxed);
    READ_POS.store(0, Ordering::Relaxed);
    UPSAMPLE.store(k, Ordering::Relaxed);
    let port = sceAudioOutOpenPort(
        SCE_AUDIO_OUT_PORT_TYPE_BGM as _,
        BLOCK_OUT as i32,
        44100,
        SCE_AUDIO_OUT_MODE_STEREO as _,
    );
    if port < 0 {
        return false;
    }
    PORT.store(port, Ordering::Relaxed);
    RUN.store(true, Ordering::Release);
    match std::thread::Builder::new()
        .name("voxel-audio".into())
        .stack_size(32 * 1024)
        .spawn(audio_thread)
    {
        Ok(_) => {
            LIVE.store(true, Ordering::Release);
            true
        }
        Err(_) => {
            RUN.store(false, Ordering::Release);
            sceAudioOutReleasePort(port);
            PORT.store(-1, Ordering::Relaxed);
            false
        }
    }
}

/// SOURCE sample frames the ring can still accept.
pub fn free_frames() -> usize {
    let queued = WRITE_POS
        .load(Ordering::Relaxed)
        .wrapping_sub(READ_POS.load(Ordering::Acquire));
    RING_FRAMES - queued.min(RING_FRAMES)
}

/// Queue interleaved stereo s16 PCM at the SOURCE rate. Returns the frames
/// accepted — the caller never has to ask twice, because it sized its render
/// against [`free_frames`] first.
///
/// # Safety
/// Single writer: call only from the frame loop's thread.
#[allow(static_mut_refs)]
pub unsafe fn push(pcm: &[i16]) -> usize {
    let n = (pcm.len() / 2).min(free_frames());
    let write = WRITE_POS.load(Ordering::Relaxed);
    for i in 0..n {
        let dst = ((write + i) % RING_FRAMES) * 2;
        RING[dst] = pcm[i * 2];
        RING[dst + 1] = pcm[i * 2 + 1];
    }
    WRITE_POS.store(write.wrapping_add(n), Ordering::Release);
    n
}
