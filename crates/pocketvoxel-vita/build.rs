//! Bakes the QuickJS game bundle into the VPK and declares the vitaGL link.
//!
//! `VOXELMON_JS` (set by tools/voxel.ts vita) is the path to the built
//! `dist/voxelmon/game.js`; the bundle is copied to OUT_DIR with a trailing
//! NUL so `JS_Eval` sees `input[len] == '\0'` (main.rs evals with `len - 1`).
//! An empty env writes an empty (NUL-only) bundle so the crate still links;
//! booting it halts at the frame lookup.
//!
//! `VOXELMON_TIER` names the quality rung this build asks the core for
//! (contracts/spec/voxel-spec.ts §quality ladder). It is a build input rather
//! than a constant so a device session can A/B two rungs of the same tree
//! without editing the spec — which is exactly how the PSP rung's numbers
//! were found.

use std::path::Path;
use std::{env, fs};

/// The graphics link. GNU ld reads each archive once, so the order matters.
///
/// This is the whole benefit of the GXM backend stated as a list: no
/// `vitashark`, no `SceShaccCgExt`, no `SceShaccCg` stub, no `taihen_stub`,
/// no `stdc++`. Those were vitaGL's, and they were there because vitaGL
/// builds even its fixed-function shaders on the console — which made
/// `libshacccg.suprx` a prerequisite for launching at all. This backend
/// brings shaders that are already compiled, so nothing here reaches for a
/// compiler and the VPK installs as one self-contained file.
///
/// vita2d's image loaders and font backends reference libpng, libjpeg and
/// SceP(v)f, but they live in their own archive members and this crate calls
/// none of them, so the linker never pulls those objects in.
const GRAPHICS_LIBS: &[&str] = &[
    "vita2d",
    "SceCommonDialog_stub",
    "SceGxm_stub",
    "SceDisplay_stub",
    "SceAppMgr_stub",
    "SceSysmodule_stub",
    "SceKernelDmacMgr_stub",
];

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

    let tier = env::var("VOXELMON_TIER").unwrap_or_else(|_| "vita".into());
    println!("cargo:rustc-env=VOXELMON_TIER={tier}");
    println!("cargo:rerun-if-env-changed=VOXELMON_TIER");

    let vitasdk = env::var("VITASDK").unwrap_or_else(|_| {
        panic!("VITASDK is not set — run through `bun tools/voxel.ts vita`")
    });
    println!("cargo:rustc-link-search=native={vitasdk}/arm-vita-eabi/lib");
    for lib in GRAPHICS_LIBS {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    println!("cargo:rerun-if-env-changed=VITASDK");
}
