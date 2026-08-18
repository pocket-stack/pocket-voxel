#![no_std]
#![feature(alloc_error_handler)]
#![allow(static_mut_refs)]

extern crate alloc;

mod gles1;

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::{c_char, c_void};
use pocketvoxel_core::pak::{self, Pak};
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::{op, quality_tier};

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn realloc(pointer: *mut c_void, size: usize) -> *mut c_void;
    fn free(pointer: *mut c_void);
    fn abort() -> !;
}

struct CAllocator;

unsafe impl GlobalAlloc for CAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.align() > 8 {
            return core::ptr::null_mut();
        }
        malloc(layout.size().max(1)).cast()
    }

    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        free(pointer.cast());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if layout.align() > 8 {
            return core::ptr::null_mut();
        }
        realloc(pointer.cast(), size.max(1)).cast()
    }
}

#[global_allocator]
static ALLOCATOR: CAllocator = CAllocator;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { abort() }
}

#[alloc_error_handler]
fn allocation_error(_layout: Layout) -> ! {
    unsafe { abort() }
}

struct App {
    pak: Pak<'static>,
    scene: Scene,
    renderer: gles1::Renderer,
}

static mut APP: Option<App> = None;
static mut ERROR: &[u8] = b"not booted\0";

fn app() -> Option<&'static mut App> {
    unsafe { APP.as_mut() }
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_boot(bytes: *const u8, length: usize) -> i32 {
    if bytes.is_null() || length == 0 {
        ERROR = b"embedded VXPK is missing\0";
        return 0;
    }
    let blob = core::slice::from_raw_parts(bytes, length);
    let pak = match pak::read(blob) {
        Ok(pak) => pak,
        Err(message) => {
            ERROR = match message {
                "bad VXPK magic" => b"bad VXPK magic\0",
                "unsupported VXPK version" => b"unsupported VXPK version\0",
                _ => b"VXPK validation failed\0",
            };
            return 0;
        }
    };
    let mut scene = Scene::new();
    scene.op(op::QUALITY, &[quality_tier::PSP as i32], None);
    let _ = scene.audio.set_rate(11_025);
    APP = Some(App {
        pak,
        scene,
        renderer: gles1::Renderer::new(),
    });
    ERROR = b"\0";
    1
}

#[no_mangle]
pub extern "C" fn pocketvoxel_error() -> *const c_char {
    unsafe { ERROR.as_ptr().cast() }
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_game(length: *mut usize) -> *const u8 {
    let Some(app) = app() else {
        if !length.is_null() {
            *length = 0;
        }
        return core::ptr::null();
    };
    if !length.is_null() {
        *length = app.pak.game.len();
    }
    app.pak.game.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_audio(length: *mut usize) -> *const u8 {
    let Some(app) = app() else {
        if !length.is_null() {
            *length = 0;
        }
        return core::ptr::null();
    };
    if !length.is_null() {
        *length = app.pak.audio.len();
    }
    app.pak.audio.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_op(
    code: u32,
    arguments: *const i32,
    argument_count: usize,
    string: *const u8,
    string_length: usize,
) {
    let Some(app) = app() else { return };
    let args = if arguments.is_null() || argument_count == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(arguments, argument_count)
    };
    let text = if string.is_null() || string_length == 0 {
        None
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(string, string_length)).ok()
    };
    app.scene.op(code, args, text);
}

#[no_mangle]
pub extern "C" fn pocketvoxel_tick() {
    if let Some(app) = app() {
        app.scene.tick();
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_render(width: i32, height: i32, buttons: u32) -> i32 {
    let Some(app) = app() else { return 0 };
    let list = pocketvoxel_core::draw::build(&app.scene, &app.pak);
    app.renderer.render(&list, &app.pak, width, height, buttons)
}

#[no_mangle]
pub unsafe extern "C" fn pocketvoxel_audio_render(output: *mut i16, frames: usize) -> usize {
    let Some(app) = app() else { return 0 };
    if output.is_null() || frames == 0 {
        return 0;
    }
    let samples = core::slice::from_raw_parts_mut(output, frames.saturating_mul(2));
    app.scene.render_audio(&app.pak, frames, samples);
    frames
}

#[no_mangle]
pub extern "C" fn pocketvoxel_gl_initialize(width: i32, height: i32) -> i32 {
    let Some(app) = app() else { return 0 };
    unsafe { app.renderer.initialize(width, height) }
}

#[no_mangle]
pub extern "C" fn pocketvoxel_gl_shutdown() {
    if let Some(app) = app() {
        unsafe { app.renderer.shutdown() }
    }
}

#[no_mangle]
pub extern "C" fn pocketvoxel_shutdown() {
    unsafe {
        if let Some(mut app) = APP.take() {
            app.renderer.shutdown();
        }
    }
}
