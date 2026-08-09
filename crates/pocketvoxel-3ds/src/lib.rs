// `no_std` and the handlers below are gated on the DEVICE, not on `not(test)`:
// this crate is a staticlib, so a host build would also demand a
// `#[panic_handler]` it must not define next to std. Gating on the target
// keeps `cargo check`, `cargo clippy --all-targets` and `cargo test` all
// working on the host while the 3DS build stays no_std.
#![cfg_attr(target_os = "horizon", no_std)]
#![cfg_attr(target_os = "horizon", feature(alloc_error_handler))]

//! pocketvoxel-3ds — the Rust half of the Pocket Voxel runtime on the Nintendo
//! 3DS, and the sibling of [`pocketvoxel-psp`], the EBOOT.
//!
//! It owns exactly what decides the picture: the pak, the retained
//! [`Scene`](pocketvoxel_core::scene::Scene) the guest drives through the
//! `voxel` op surface, the per-present [`draw::build`](pocketvoxel_core::draw)
//! call, and the handover to [`pocketvoxel_pica`]. It owns nothing about the
//! machine: QuickJS, citro3d, `linearAlloc`, the frame lifecycle, input and
//! present are the C side's, through `include/pocketvoxel_3ds.h`.
//!
//! # Why QuickJS is on the other side of the boundary here
//!
//! The PSP EBOOT registers its QuickJS C functions from Rust, because
//! `libquickjs-sys` builds the library as a cargo dependency. On the 3DS
//! QuickJS is compiled with devkitARM inside the container (the brief's §0
//! toolchain), so the host follows `hosts/3ds/src/qjs.c` and unwraps JSValues
//! in C. The surface stays authoritative here — op codes, arities, argument
//! defaulting, the warp-landing and audio-intent flags are all in
//! [`voxel`]/[`host`] — but it crosses as **data plus plain C entry points**,
//! so the 16-byte `JS_NO_NAN_BOXING` JSValue ABI is expressed in exactly one
//! place.
//!
//! # A frame
//!
//! ```text
//! // once, at boot
//! pv3ds_init(linearAlloc(PV3DS_ARENA_BYTES), PV3DS_ARENA_BYTES, PV3DS_ARENA_BANKS)
//! pv3ds_load_pak(blob16, len)          // 16-byte aligned, never freed
//! // C: build the QuickJS runtime, register globalThis.voxel from the op
//! //    table, eval the guest bundle, find globalThis.frame
//!
//! // per tick (60 Hz)
//! JS_Call(frame, buttons)              // ops land through pv3ds_op*
//! drain the job queue
//! pv3ds_tick()
//!
//! // per present
//! pv3ds_present()                      // draw::build + pica record
//! // C: C3D_FrameBegin -> walk pv_pica_frame() -> C3D_FrameEnd
//! ```
//!
//! # The rung
//!
//! The Scene stays on quality tier 0, the `psp` rung: no `quality` op is
//! registered and none is dispatched, which is what the EBOOT does and what
//! the shipped goldens were recorded at. [`host::Host::new`] says why the
//! ladder must not gain a 3DS rung instead.
//!
//! [`pocketvoxel-psp`]: https://docs.rs/pocketvoxel-psp

extern crate alloc;

pub mod cabi;
pub mod host;
pub mod voxel;

// `extern crate alloc` owns the `alloc` name at the crate root, so the
// allocator module is mounted under a name of its own. Off the device, std
// brings its own allocator and panic handler.
#[cfg(target_os = "horizon")]
#[path = "heap.rs"]
mod heap;

pub use host::{Host, Stats, axis_buttons};
pub use voxel::{OPS, OpDef, op_kind};

#[cfg(test)]
mod tests;
