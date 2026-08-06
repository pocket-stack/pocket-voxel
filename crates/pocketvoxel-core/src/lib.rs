#![cfg_attr(not(feature = "std"), no_std)]

//! pocketvoxel-core — the presentation core of the Pocket Voxel runtime
//! (docs/VOXEL.md). The guest (TypeScript gameplay) drives a retained scene
//! through the `voxel` surface ops; this crate owns everything that renders:
//! the VXPK cooked-content reader, the scene state, the orbit and battle
//! cameras, and the per-frame [`draw::DrawList`] that both the software
//! rasterizer (`pocketvoxel-sim`) and the future sceGu backend consume.
//!
//! Zero gameplay lives here, and zero dependencies besides `libm` on no_std
//! targets. All contract constants come from [`spec`], generated from
//! `contracts/spec/voxel-spec.ts` — never edited by hand.

extern crate alloc;

pub mod audio;
pub mod cam;
pub mod draw;
pub mod math;
pub mod pak;
pub mod scene;
pub mod spec;
pub mod ui;

#[cfg(all(not(feature = "std"), not(feature = "libm")))]
compile_error!("pocketvoxel-core needs either the `std` or the `libm` feature for f32 math");

#[cfg(target_endian = "big")]
compile_error!("the VXPK reader assumes a little-endian target");
