//! Shared host-side pieces of the Pocket Voxel simulator.
//!
//! The deterministic software rasterizer is also the browser renderer. Keeping
//! it in this library means the browser, native golden harness, and PNG capture
//! all execute the same pixels rather than maintaining parallel render paths.

pub mod raster;
