//! The C ABI — everything the 3DS host's C side needs to execute a frame this
//! crate recorded, and nothing else.
//!
//! Mirrored by `include/pocketvoxel_pica.h`. The division of labour, which is
//! the same one `hosts/iphone2g` uses (a pure-C host over a Rust staticlib):
//!
//! - **Rust** owns the pak, the DrawList, the frame lowering and the texel
//!   layout. Recording is driven from the host's own Rust glue, which owns the
//!   QuickJS guest and the retained `Scene`:
//!   `pocketvoxel_pica::global().record(&draw::build(&scene, pak), pak)`.
//! - **C** owns citro3d, `linearAlloc`, the `C3D_Tex` array, the frame
//!   lifecycle and present. It reads the recorded frame through
//!   [`pv_pica_frame`] and the textures through [`pv_pica_tex_slot`] /
//!   [`pv_pica_tex_fill`].
//!
//! Single-threaded by construction (one QuickJS worker), so the globals below
//! are the established `static mut` style of this family of hosts.
#![allow(static_mut_refs)]

use core::ffi::{c_char, c_void};

use pocketvoxel_core::pak::{self, Pak};

use crate::tex::{TexKey, TexPlan};
use crate::{Cmd, Renderer, Stats};

static mut RENDERER: Option<Renderer> = None;
static mut PAK: Option<Pak<'static>> = None;
static mut ERROR: *const c_char = c"".as_ptr();
static mut FRAME: Frame = Frame {
    cmds: core::ptr::null(),
    cmd_count: 0,
    matrices: core::ptr::null(),
    matrix_count: 0,
    keys: core::ptr::null(),
    key_count: 0,
    arena: core::ptr::null_mut(),
};

/// The process-global renderer. The host's Rust glue records into it; the C
/// side reads what it recorded.
pub fn global() -> &'static mut Renderer {
    unsafe { RENDERER.get_or_insert_with(Renderer::new) }
}

/// The pak [`pv_pica_init`] parsed, so the host's Rust glue can build its
/// DrawList against the same parse instead of a second one.
pub fn global_pak() -> Option<&'static Pak<'static>> {
    unsafe { PAK.as_ref() }
}

fn fail(msg: &'static core::ffi::CStr) -> i32 {
    unsafe { ERROR = msg.as_ptr() };
    -1
}

/// The recorded frame, as C sees it. Every `*_offset` in a [`Cmd`] is a byte
/// offset from `arena`.
#[repr(C)]
pub struct Frame {
    pub cmds: *const Cmd,
    pub cmd_count: u32,
    /// `matrix_count * 16` floats, each 16 already in `C3D_Mtx.m[]` order.
    pub matrices: *const f32,
    pub matrix_count: u32,
    /// The frame's distinct textures — what the expansion set actually costs.
    pub keys: *const TexKey,
    pub key_count: u32,
    pub arena: *mut u8,
}

/// Parse the pak and adopt the host's linear arena. `pak_blob` must stay alive
/// and 16-byte aligned for the whole run (the host leaks it, the PSP pattern);
/// `arena` must be `linearAlloc` memory, since `BufInfo_Add` rejects anything
/// below physical 0x18000000.
///
/// Returns 0, or -1 with [`pv_pica_last_error`] set. Safe to call again to
/// re-adopt a different arena.
///
/// # Safety
/// Both pointers must be valid for their stated lengths and outlive every
/// frame the GPU may still be reading.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_init(
    pak_blob: *const c_void,
    pak_len: u32,
    arena: *mut c_void,
    arena_bytes: u32,
    banks: u32,
) -> i32 {
    if pak_blob.is_null() || pak_len == 0 {
        return fail(c"pv_pica_init: null pak blob");
    }
    let blob: &'static [u8] = core::slice::from_raw_parts(pak_blob as *const u8, pak_len as usize);
    match pak::read(blob) {
        Ok(p) => PAK = Some(p),
        Err(_) => return fail(c"pv_pica_init: the pak failed validation"),
    }
    let r = global();
    r.adopt_arena(arena as *mut u8, arena_bytes as usize, banks as usize);
    if r.arena_base().is_null() {
        return fail(c"pv_pica_init: the arena is null or too small to bank");
    }
    ERROR = c"".as_ptr();
    0
}

/// The last error message, NUL-terminated and static. Empty when there is
/// none.
///
/// # Safety
/// Call from the host thread only; the returned pointer is static.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_last_error() -> *const c_char {
    ERROR
}

/// The frame most recently recorded. The pointers stay valid until the next
/// `record`, which is also when the arena bank they index is rewound.
///
/// # Safety
/// Call from the host thread only. The returned pointers stay valid until
/// the next `record`, which rewinds the arena bank they index.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_frame() -> *const Frame {
    let r = global();
    FRAME = Frame {
        cmds: r.commands().as_ptr(),
        cmd_count: r.commands().len() as u32,
        matrices: r.matrices().as_ptr() as *const f32,
        matrix_count: r.matrices().len() as u32,
        keys: r.keys().as_ptr(),
        key_count: r.keys().len() as u32,
        arena: r.arena_base(),
    };
    &raw const FRAME
}

/// The last frame's counters, including the graceful-degradation ones.
///
/// # Safety
/// `out` must be null or a valid `PvPicaStats`.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_stats(out: *mut Stats) {
    if !out.is_null() {
        *out = global().stats();
    }
}

/// The letterboxed viewport, in landscape top-screen pixels. Apply it with
/// `C3D_SetViewport` AFTER `C3D_FrameDrawOn`, which resets it.
///
/// # Safety
/// Each pointer must be null or a valid `int32_t`.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_viewport(
    x: *mut i32,
    y: *mut i32,
    w: *mut i32,
    h: *mut i32,
) {
    for (p, v) in [
        (x, crate::VIEWPORT_X),
        (y, crate::VIEWPORT_Y),
        (w, crate::VIEWPORT_W),
        (h, crate::VIEWPORT_H),
    ] {
        if !p.is_null() {
            *p = v;
        }
    }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/// The slot for one texture key, minting it on first bind. Writes 1 to
/// `needs_fill` when the host still owes this slot a [`pv_pica_tex_fill`] —
/// on a fresh slot, and again whenever the day tint moved, because the tint
/// lives inside the expanded texels.
///
/// Returns the slot id, or -1 with [`pv_pica_last_error`] set. Slot ids are
/// stable for the life of the process, so a flat `C3D_Tex` array indexed by
/// slot is the intended host structure.
///
/// # Safety
/// `needs_fill` must be null or a valid `uint8_t`, and `pv_pica_init` must
/// have succeeded.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_tex_slot(
    page: u16,
    frame: u16,
    pal: u16,
    tinted: u8,
    needs_fill: *mut u8,
) -> i32 {
    let Some(pak) = PAK.as_ref() else {
        return fail(c"pv_pica_tex_slot: pv_pica_init has not run");
    };
    let key = TexKey {
        page,
        frame,
        pal,
        tinted: tinted != 0,
    };
    match global().cache_mut().slot(pak, key) {
        Ok((slot, fill)) => {
            if !needs_fill.is_null() {
                *needs_fill = u8::from(fill);
            }
            slot as i32
        }
        Err(_) => fail(c"pv_pica_tex_slot: the pak has no such page or palette"),
    }
}

/// The envelope one slot uploads: source size, the POT dimensions to pass to
/// `C3D_TexInit`, and the UV rescale the POT envelope costs. Returns 0 or -1.
///
/// # Safety
/// `out` must be null or a valid `PvPicaTexPlan`.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_tex_plan(slot: u16, out: *mut TexPlan) -> i32 {
    let Some(s) = global().cache().get(slot) else {
        return fail(c"pv_pica_tex_plan: slot out of range");
    };
    if !out.is_null() {
        *out = s.plan;
    }
    0
}

/// Expand slot `slot` into `out`, which must be at least
/// `plan.width * plan.height * 2` bytes and should be the `C3D_Tex`'s own
/// buffer. Clears the slot's fill debt. Returns 0 or -1.
///
/// # Safety
/// `out` must be valid for `out_bytes`.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_tex_fill(slot: u16, out: *mut c_void, out_bytes: u32) -> i32 {
    let Some(pak) = PAK.as_ref() else {
        return fail(c"pv_pica_tex_fill: pv_pica_init has not run");
    };
    let Some(s) = global().cache().get(slot) else {
        return fail(c"pv_pica_tex_fill: slot out of range");
    };
    let texels = s.plan.texels();
    if out.is_null() || (out_bytes as usize) < texels * 2 {
        return fail(c"pv_pica_tex_fill: destination smaller than the planned texture");
    }
    let dst = core::slice::from_raw_parts_mut(out as *mut u16, texels);
    match global().cache_mut().fill(pak, slot, dst) {
        Ok(()) => 0,
        Err(_) => fail(c"pv_pica_tex_fill: expansion failed"),
    }
}

/// Textures minted so far, and what they cost in linear memory.
///
/// # Safety
/// Each pointer must be null or a valid `uint32_t`.
#[no_mangle]
pub unsafe extern "C" fn pv_pica_tex_cost(textures: *mut u32, bytes: *mut u32) {
    let s = global().cache().stats();
    if !textures.is_null() {
        *textures = s.textures;
    }
    if !bytes.is_null() {
        *bytes = s.bytes as u32;
    }
}
