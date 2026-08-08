//! The slice of vitaGL / GL ES 1.1 this backend uses, declared by hand.
//!
//! There is no `vitagl-sys` crate, and generating one would pull bindgen and
//! the whole 1300-line header in for the ~40 entry points a fixed-function
//! renderer needs. Every declaration below is transcribed from
//! `$VITASDK/arm-vita-eabi/include/vitaGL.h`; the enum values are the
//! standard GL ones and are pinned by `debug_assert`-free construction —
//! a wrong constant here draws garbage rather than failing to link, so they
//! are grouped by the call that consumes them and named as the header does.

#![allow(non_camel_case_types)]

use core::ffi::{c_int, c_void};

pub type GLenum = u32;
pub type GLboolean = u8;
pub type GLbitfield = u32;
pub type GLint = i32;
pub type GLuint = u32;
pub type GLsizei = i32;
pub type GLfloat = f32;
pub type GLclampf = f32;
/// Attribute and index pointers are either a client address or a byte offset
/// into the bound buffer object, so they are built as integers and cast once.
pub type GLvoid_ptr = *const c_void;

// -- glClear ----------------------------------------------------------------
pub const GL_DEPTH_BUFFER_BIT: GLbitfield = 0x0000_0100;
pub const GL_COLOR_BUFFER_BIT: GLbitfield = 0x0000_4000;

// -- primitives -------------------------------------------------------------
pub const GL_TRIANGLES: GLenum = 0x0004;

// -- glEnable / glDisable ---------------------------------------------------
pub const GL_CULL_FACE: GLenum = 0x0B44;
pub const GL_DEPTH_TEST: GLenum = 0x0B71;
pub const GL_BLEND: GLenum = 0x0BE2;
pub const GL_ALPHA_TEST: GLenum = 0x0BC0;
pub const GL_TEXTURE_2D: GLenum = 0x0DE1;
pub const GL_SCISSOR_TEST: GLenum = 0x0C11;

// -- comparison functions (glDepthFunc, glAlphaFunc) ------------------------
pub const GL_LESS: GLenum = 0x0201;
pub const GL_LEQUAL: GLenum = 0x0203;
pub const GL_GREATER: GLenum = 0x0204;

// -- glBlendFunc ------------------------------------------------------------
pub const GL_SRC_ALPHA: GLenum = 0x0302;
pub const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;

// -- glShadeModel -----------------------------------------------------------
pub const GL_SMOOTH: GLenum = 0x1D01;

// -- attribute component types ----------------------------------------------
pub const GL_UNSIGNED_BYTE: GLenum = 0x1401;
pub const GL_SHORT: GLenum = 0x1402;
pub const GL_UNSIGNED_SHORT: GLenum = 0x1403;
pub const GL_FLOAT: GLenum = 0x1406;

// -- glEnableClientState ----------------------------------------------------
pub const GL_VERTEX_ARRAY: GLenum = 0x8074;
pub const GL_COLOR_ARRAY: GLenum = 0x8076;
pub const GL_TEXTURE_COORD_ARRAY: GLenum = 0x8078;

// -- buffers ----------------------------------------------------------------
pub const GL_ARRAY_BUFFER: GLenum = 0x8892;
pub const GL_ELEMENT_ARRAY_BUFFER: GLenum = 0x8893;
pub const GL_STATIC_DRAW: GLenum = 0x88E4;

// -- glMatrixMode -----------------------------------------------------------
pub const GL_MODELVIEW: GLenum = 0x1700;
pub const GL_PROJECTION: GLenum = 0x1701;
pub const GL_TEXTURE: GLenum = 0x1702;

// -- textures ---------------------------------------------------------------
pub const GL_RGBA: GLenum = 0x1908;
pub const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
pub const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
pub const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
pub const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
pub const GL_NEAREST: GLenum = 0x2600;
pub const GL_CLAMP_TO_EDGE: GLenum = 0x812F;

// -- glTexEnv ---------------------------------------------------------------
pub const GL_TEXTURE_ENV: GLenum = 0x2300;
pub const GL_TEXTURE_ENV_MODE: GLenum = 0x2200;
pub const GL_MODULATE: GLenum = 0x2100;

// -- vglInit* ---------------------------------------------------------------
/// `SceGxmMultisampleMode`: NONE keeps the voxel art's hard pixel edges and
/// spends the fill rate on the 960x544 native raster instead.
pub const SCE_GXM_MULTISAMPLE_NONE: c_int = 0;

extern "C" {
    pub fn glClear(mask: GLbitfield);
    pub fn glClearColor(r: GLclampf, g: GLclampf, b: GLclampf, a: GLclampf);
    pub fn glClearDepthf(depth: GLclampf);
    pub fn glEnable(cap: GLenum);
    pub fn glDisable(cap: GLenum);
    pub fn glDepthFunc(func: GLenum);
    pub fn glDepthMask(flag: GLboolean);
    pub fn glAlphaFunc(func: GLenum, reference: GLfloat);
    pub fn glBlendFunc(sfactor: GLenum, dfactor: GLenum);
    pub fn glShadeModel(mode: GLenum);
    pub fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);

    pub fn glMatrixMode(mode: GLenum);
    pub fn glLoadIdentity();
    pub fn glLoadMatrixf(m: *const GLfloat);

    pub fn glGenTextures(n: GLsizei, textures: *mut GLuint);
    pub fn glDeleteTextures(n: GLsizei, textures: *const GLuint);
    pub fn glBindTexture(target: GLenum, texture: GLuint);
    pub fn glTexParameteri(target: GLenum, pname: GLenum, param: GLint);
    #[allow(clippy::too_many_arguments)]
    pub fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal_format: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        ty: GLenum,
        data: *const c_void,
    );
    pub fn glTexEnvi(target: GLenum, pname: GLenum, param: GLint);

    pub fn glGenBuffers(n: GLsizei, buffers: *mut GLuint);
    pub fn glBindBuffer(target: GLenum, buffer: GLuint);
    pub fn glBufferData(target: GLenum, size: isize, data: *const c_void, usage: GLenum);

    pub fn glEnableClientState(array: GLenum);
    pub fn glDisableClientState(array: GLenum);
    pub fn glVertexPointer(size: GLint, ty: GLenum, stride: GLsizei, pointer: *const c_void);
    pub fn glTexCoordPointer(size: GLint, ty: GLenum, stride: GLsizei, pointer: *const c_void);
    pub fn glColorPointer(size: GLint, ty: GLenum, stride: GLsizei, pointer: *const c_void);
    pub fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    pub fn glDrawElements(mode: GLenum, count: GLsizei, ty: GLenum, indices: *const c_void);

    /// Pool sizes stated outright, rather than `vglInitExtended`'s
    /// "threshold" (RAM to LEAVE for newlib). The threshold form computes
    /// `free_user - threshold` and **clamps at zero**, so one wrong guess
    /// about a console's budget hands vitaGL no RAM pool at all — and it
    /// starts its splashscreen partway through init, so the failure that
    /// follows is a logo spinning forever with no way to ask why.
    ///
    /// **The `GLboolean` is not a success flag.** Every `vglInit*` ends with
    /// `return res_fallback` (`vgl.c`): TRUE means "your requested resolution
    /// did not fit and I substituted the maximum", so the ordinary successful
    /// path returns **FALSE**. vitaGL's own samples ignore the value
    /// entirely. Read [`vglMemFree`] to find out whether init actually
    /// produced a usable context.
    pub fn vglInitWithCustomSizes(
        legacy_pool_size: c_int,
        width: c_int,
        height: c_int,
        ram_pool_size: c_int,
        cdram_pool_size: c_int,
        phycont_pool_size: c_int,
        cdlg_pool_size: c_int,
        msaa: c_int,
    ) -> GLboolean;
    /// Size of the scratch pool every client-array draw stages through. Must
    /// precede `vglInit*`.
    pub fn vglSetCircularPoolSize(size: u32);
    pub fn vglSwapBuffers(has_commondialog: GLboolean);
    pub fn vglWaitVblankStart(enable: GLboolean);
    /// Free bytes in one internal pool (`vglMemType`); 1 = `VGL_MEM_RAM`.
    pub fn vglMemFree(ty: c_int) -> usize;
}

extern "C" {
    /// vitaShaRK's loader, which is what vitaGL itself calls during
    /// `vglInit*` — `NULL` means "use the default location". Reachable
    /// directly so a host can retry the load from somewhere vitaGL does not
    /// probe; returns < 0 on failure.
    pub fn shark_init(path: *const i8) -> c_int;
}

extern "C" {
    /// vitaGL's own runtime-shader-compiler status, set by
    /// `start_shader_compiler()` during `vglInit*`. Not in vitaGL.h — it is a
    /// plain global in `shared.h` — but it is the ONLY authoritative answer to
    /// "can this console build shaders", and the alternative (probing the
    /// filesystem for `libshacccg.suprx`) has to guess vitaGL's own search
    /// list and gets it wrong: vitaGL tries vitaShaRK's default AND
    /// `ur0:data/external/`, so a path check that misses one halts a console
    /// that would have run.
    pub static mut is_shark_online: GLboolean;
}

/// `vglMemType::VGL_MEM_RAM` — the pool the pak's VBOs and the atlas
/// textures come out of.
pub const VGL_MEM_RAM: c_int = 1;

/// What the kernel will still hand out, by partition. `size` is an in-out
/// field: set it to the struct's own size before the call.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct FreeMemorySize {
    pub size: c_int,
    pub size_user: c_int,
    pub size_cdram: c_int,
    pub size_phycont: c_int,
}

extern "C" {
    pub fn sceKernelGetFreeMemorySize(info: *mut FreeMemorySize) -> c_int;
}

/// This application's free memory, by partition.
pub fn free_memory() -> FreeMemorySize {
    let mut info = FreeMemorySize {
        size: core::mem::size_of::<FreeMemorySize>() as c_int,
        ..FreeMemorySize::default()
    };
    unsafe {
        sceKernelGetFreeMemorySize(&mut info);
    }
    info
}
