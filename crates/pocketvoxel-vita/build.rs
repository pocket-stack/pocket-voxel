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

/// The vitaGL link, in the order VitaSDK's own samples use — GNU ld reads
/// each archive once, so this order is load-bearing.
///
/// `SceShaccCg_stub_weak` rather than `SceShaccCg_stub` is the one deliberate
/// difference, and it is worth stating why the compiler is in the link at
/// all: vitaGL builds even its FIXED-FUNCTION shaders at runtime. `ffp.c`'s
/// `reload_ffp_shaders` sprintf's a Cg source for the exact state mask a
/// draw needs and hands it to `shark_compile_shader_extended`, so the
/// runtime compiler (`libshacccg.suprx`) is a hard prerequisite of this
/// backend, not an optional extra for GLSL programs. The weak stub means a
/// console without that module still LAUNCHES the VPK, so main.rs can check
/// for it and say so, instead of the system refusing the app with a code.
const VITAGL_LIBS: &[&str] = &[
    "vitaGL",
    "stdc++",
    "SceCommonDialog_stub",
    "SceGxm_stub",
    "SceDisplay_stub",
    "SceAppMgr_stub",
    "mathneon",
    "vitashark",
    "SceShaccCgExt",
    "taihen_stub",
    "SceShaccCg_stub_weak",
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
    for lib in VITAGL_LIBS {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    println!("cargo:rerun-if-env-changed=VITASDK");
}
