//! The C ABI — everything the 3DS host's C side needs to drive one Pocket
//! Voxel process, and nothing else. Mirrored by `include/pocketvoxel_3ds.h`,
//! which also carries the registration and frame sketches.
//!
//! Single-threaded by construction (one QuickJS context on the main thread),
//! so the global below is the established `static mut` style of this family of
//! hosts.
#![allow(static_mut_refs)]

use core::ffi::{c_char, c_void};

use pocketvoxel_core::scene::STATS_LEN;

use crate::host::{Host, Stats};
use crate::voxel::{self, NAME_MAX};

static mut HOST: Option<Host> = None;

/// The process-global host. Created on first touch so a C side that calls a
/// getter before `pv3ds_init` reads an empty runtime rather than a null.
pub fn host() -> &'static mut Host {
    unsafe { HOST.get_or_insert_with(Host::new) }
}

/// One op-table entry, as C sees it. **Pointer-free on purpose**: the name is
/// inline, so the struct has the same size and offsets on the armv6k device
/// and on the host that unit-tests them.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct VoxOp {
    pub name: [u8; NAME_MAX],
    pub code: u32,
    pub argc: u8,
    pub js_len: u8,
    pub kind: u8,
    pub reserved: u8,
}

const _: () = assert!(core::mem::size_of::<VoxOp>() == 24);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/// Adopt the host's `linearAlloc` arena and reset the runtime.
///
/// # Safety
/// `arena` must be `linearAlloc` memory valid for `arena_bytes` and outliving
/// every frame the GPU may still be reading.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_init(arena: *mut c_void, arena_bytes: u32, banks: u32) -> i32 {
    host().init(arena, arena_bytes, banks)
}

/// Parse the pak and hand its sections to the surface.
///
/// # Safety
/// `blob` must be 16-byte aligned, valid for `len`, and must outlive the
/// process: the pak's pools are borrowed in place.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_load_pak(blob: *const c_void, len: u32) -> i32 {
    host().load_pak(blob, len)
}

/// The last error message, NUL-terminated and static. Empty when there is
/// none.
///
/// # Safety
/// Call from the host thread only; the returned pointer is static.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_last_error() -> *const c_char {
    host().last_error()
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/// Entries in the op table.
#[no_mangle]
pub extern "C" fn pv3ds_op_count() -> u32 {
    voxel::OPS.len() as u32
}

/// Copy one entry out. Returns 0, or -1 past the end of the table.
///
/// # Safety
/// `out` must be null or a valid `PvVoxOp`.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_op_at(index: u32, out: *mut VoxOp) -> i32 {
    let Some(def) = voxel::OPS.get(index as usize) else {
        return -1;
    };
    if out.is_null() {
        return -1;
    }
    let mut name = [0u8; NAME_MAX];
    // The table's names are const-asserted shorter than NAME_MAX, so the
    // trailing NUL is always there.
    name[..def.name.len()].copy_from_slice(def.name.as_bytes());
    *out = VoxOp {
        name,
        code: def.code,
        argc: def.argc,
        js_len: def.js_len,
        kind: def.kind,
        reserved: 0,
    };
    0
}

/// Dispatch one numeric op. Missing arguments read as 0 and surplus ones are
/// dropped — the PSP host's marshalling.
///
/// # Safety
/// `args` must be null or valid for `argc` `int32_t`s.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_op(code: u32, args: *const i32, argc: u32) -> i32 {
    let slice = if args.is_null() || argc == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(args, argc as usize)
    };
    host().op(code, slice)
}

/// Dispatch `uiText(x, y, str)`. A null pointer or non-UTF-8 bytes is a no-op.
///
/// # Safety
/// `args` must be null or valid for `argc` `int32_t`s; `text` must be null or
/// valid for `text_len` bytes, borrowed for the call only.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_op_text(
    code: u32,
    args: *const i32,
    argc: u32,
    text: *const c_char,
    text_len: u32,
) -> i32 {
    let slice = if args.is_null() || argc == 0 {
        &[][..]
    } else {
        core::slice::from_raw_parts(args, argc as usize)
    };
    let s = if text.is_null() {
        None
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(text as *const u8, text_len as usize)).ok()
    };
    host().op_text(code, slice, s)
}

/// `gamedata()` — the GAME section, borrowed from the pak.
///
/// # Safety
/// Both pointers must be null or valid for one write.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_gamedata(bytes: *mut *const u8, len: *mut u32) -> i32 {
    match host().gamedata() {
        Some(section) => {
            if !bytes.is_null() {
                *bytes = section.as_ptr();
            }
            if !len.is_null() {
                *len = section.len() as u32;
            }
            0
        }
        None => -1,
    }
}

/// `audiodata()` — the AUDI section, or -1 for a pak with no audio (the guest
/// is then answered undefined).
///
/// # Safety
/// Both pointers must be null or valid for one write.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_audiodata(bytes: *mut *const u8, len: *mut u32) -> i32 {
    match host().audiodata() {
        Some(section) => {
            if !bytes.is_null() {
                *bytes = section.as_ptr();
            }
            if !len.is_null() {
                *len = section.len() as u32;
            }
            0
        }
        None => -1,
    }
}

/// `stats()` — dispatch, and write the core's packed counters (8 bytes).
///
/// # Safety
/// `out` must be null or valid for [`STATS_LEN`] bytes.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_op_stats(out: *mut u8) -> i32 {
    match host().op_stats() {
        Some(packed) => {
            if !out.is_null() {
                core::ptr::copy_nonoverlapping(packed.as_ptr(), out, STATS_LEN);
            }
            0
        }
        None => -1,
    }
}

/// Read-and-clear "this tick's ops re-showed map slot 0".
///
/// # Safety
/// Call from the host thread only.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_take_map_swapped() -> u8 {
    u8::from(host().take_map_swapped())
}

/// True once the guest has emitted any audio op.
///
/// # Safety
/// Call from the host thread only.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_audio_wanted() -> u8 {
    u8::from(host().audio_wanted())
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/// Advance the tick clock. Once per guest tick, after the tick's ops.
///
/// # Safety
/// Call from the host thread only.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_tick() {
    host().tick();
}

/// Build and record this frame. Read the result through `pv_pica_frame()`.
///
/// # Safety
/// Call from the host thread only, and only once the GPU is done with the
/// frame that filled the bank this rewinds.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_present() -> i32 {
    host().present()
}

/// This crate's counters.
///
/// # Safety
/// `out` must be null or a valid `PvVox3dsStats`.
#[no_mangle]
pub unsafe extern "C" fn pv3ds_stats(out: *mut Stats) {
    if !out.is_null() {
        *out = host().stats();
    }
}

/// The circle pad as one VOX_BTN direction. `dy` is screen-down positive.
#[no_mangle]
pub extern "C" fn pv3ds_axis_buttons(dx: i32, dy: i32, deadzone: i32) -> u32 {
    crate::host::axis_buttons(dx, dy, deadzone)
}
