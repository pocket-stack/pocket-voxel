//! Bakes the QuickJS game bundle into the EBOOT.
//!
//! `VOXELMON_JS` (set by tools/voxel.ts psp) is the path to the built
//! `dist/voxelmon/game.js`; the bundle is copied to OUT_DIR with a trailing
//! NUL so `JS_Eval` sees `input[len] == '\0'` (the openstrike-psp pattern —
//! main.rs evals with `len - 1`). An empty env writes an empty (NUL-only)
//! bundle so the crate still links; booting it halts at the frame lookup.
//!
//! Capture inputs (VOXEL_CAP_INPUT / VOXEL_CAP_MARKS) pass through as
//! rustc-env so a stale value can never linger in cargo's fingerprint —
//! tools always set them, capture builds read them via `env!`.

use std::path::Path;
use std::{env, fs};

fn main() {
    let out_dir = env::var("OUT_DIR").unwrap();
    let js_path = env::var("VOXELMON_JS").unwrap_or_default();
    let mut js = if js_path.is_empty() {
        String::new()
    } else {
        println!("cargo:rerun-if-changed={js_path}");
        fs::read_to_string(&js_path)
            .unwrap_or_else(|e| panic!("could not read VOXELMON_JS={js_path}: {e}"))
    };
    js.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), js).unwrap();
    println!("cargo:rerun-if-env-changed=VOXELMON_JS");

    for var in ["VOXEL_CAP_INPUT", "VOXEL_CAP_MARKS", "VOXEL_CAP_DUMP"] {
        println!("cargo:rustc-env={var}={}", env::var(var).unwrap_or_default());
        println!("cargo:rerun-if-env-changed={var}");
    }
}
