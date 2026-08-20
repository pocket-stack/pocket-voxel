//! Hardware GLES2 renderer for the Cardputer Zero's VC4/V3D.
//!
//! The SPI LCD is not connected to VC4 scanout, so GLES rasterizes into a
//! small off-screen pbuffer. We read that 300x170 RGBA result back and let the
//! framebuffer device perform the final RGB565 panel write. Geometry,
//! texturing, depth and blending still run on V3D; only presentation crosses
//! back to the CPU.

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::mem::{size_of, size_of_val};
use std::ptr;
use std::time::Instant;

use anyhow::{Context as _, Result, bail};
use glow::HasContext;
use pocketvoxel_core::draw::{
    DrawList, Item, MeshDraw, SKY_BANDS, biased_vp, modulate_rgb, resolve_pal,
};
use pocketvoxel_core::math::{Mat4, Vec3, vec3};
use pocketvoxel_core::pak::{Pak, unswizzle};
use pocketvoxel_core::spec::{COLOR_PAL_NONE, TILE_PX, VIEW_H, VIEW_W, mesh_kind};

type EglDisplay = *mut c_void;
type EglConfig = *mut c_void;
type EglSurface = *mut c_void;
type EglContext = *mut c_void;
type EglBoolean = u32;
type EglEnum = u32;
type EglInt = i32;

const EGL_PLATFORM_SURFACELESS_MESA: EglEnum = 0x31dd;
const EGL_OPENGL_ES_API: EglEnum = 0x30a0;
const EGL_SURFACE_TYPE: EglInt = 0x3033;
const EGL_PBUFFER_BIT: EglInt = 0x0001;
const EGL_RENDERABLE_TYPE: EglInt = 0x3040;
const EGL_OPENGL_ES2_BIT: EglInt = 0x0004;
const EGL_RED_SIZE: EglInt = 0x3024;
const EGL_GREEN_SIZE: EglInt = 0x3023;
const EGL_BLUE_SIZE: EglInt = 0x3022;
const EGL_ALPHA_SIZE: EglInt = 0x3021;
const EGL_DEPTH_SIZE: EglInt = 0x3025;
const EGL_WIDTH: EglInt = 0x3057;
const EGL_HEIGHT: EglInt = 0x3056;
const EGL_CONTEXT_CLIENT_VERSION: EglInt = 0x3098;
const EGL_NONE: EglInt = 0x3038;
const EGL_VENDOR: EglInt = 0x3053;
const EGL_VERSION: EglInt = 0x3054;

type GetPlatformDisplay = unsafe extern "C" fn(EglEnum, *mut c_void, *const EglInt) -> EglDisplay;
type Initialize = unsafe extern "C" fn(EglDisplay, *mut EglInt, *mut EglInt) -> EglBoolean;
type BindApi = unsafe extern "C" fn(EglEnum) -> EglBoolean;
type ChooseConfig = unsafe extern "C" fn(
    EglDisplay,
    *const EglInt,
    *mut EglConfig,
    EglInt,
    *mut EglInt,
) -> EglBoolean;
type CreatePbufferSurface =
    unsafe extern "C" fn(EglDisplay, EglConfig, *const EglInt) -> EglSurface;
type CreateContext =
    unsafe extern "C" fn(EglDisplay, EglConfig, EglContext, *const EglInt) -> EglContext;
type MakeCurrent =
    unsafe extern "C" fn(EglDisplay, EglSurface, EglSurface, EglContext) -> EglBoolean;
type GetProcAddress = unsafe extern "C" fn(*const c_char) -> *const c_void;
type QueryString = unsafe extern "C" fn(EglDisplay, EglInt) -> *const c_char;
type DestroySurface = unsafe extern "C" fn(EglDisplay, EglSurface) -> EglBoolean;
type DestroyContext = unsafe extern "C" fn(EglDisplay, EglContext) -> EglBoolean;
type Terminate = unsafe extern "C" fn(EglDisplay) -> EglBoolean;

macro_rules! egl_symbol {
    ($library:expr, $name:literal, $ty:ty) => {{
        let symbol = CString::new($name).expect("literal EGL symbol");
        let address = unsafe { libc::dlsym($library, symbol.as_ptr()) };
        if address.is_null() {
            bail!("libEGL is missing {}", $name);
        }
        unsafe { std::mem::transmute::<*mut c_void, $ty>(address) }
    }};
}

struct Egl {
    library: *mut c_void,
    gles: *mut c_void,
    display: EglDisplay,
    surface: EglSurface,
    context: EglContext,
    get_proc_address: GetProcAddress,
    destroy_surface: DestroySurface,
    destroy_context: DestroyContext,
    terminate: Terminate,
}

impl Egl {
    fn new(width: usize, height: usize) -> Result<Self> {
        let egl_name = CString::new("libEGL.so.1")?;
        let gles_name = CString::new("libGLESv2.so.2")?;
        let library = unsafe { libc::dlopen(egl_name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if library.is_null() {
            bail!("loading libEGL.so.1: {}", dl_error());
        }
        let gles = unsafe { libc::dlopen(gles_name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if gles.is_null() {
            unsafe { libc::dlclose(library) };
            bail!("loading libGLESv2.so.2: {}", dl_error());
        }

        let result = (|| {
            let get_platform_display =
                egl_symbol!(library, "eglGetPlatformDisplay", GetPlatformDisplay);
            let initialize = egl_symbol!(library, "eglInitialize", Initialize);
            let bind_api = egl_symbol!(library, "eglBindAPI", BindApi);
            let choose_config = egl_symbol!(library, "eglChooseConfig", ChooseConfig);
            let create_pbuffer_surface =
                egl_symbol!(library, "eglCreatePbufferSurface", CreatePbufferSurface);
            let create_context = egl_symbol!(library, "eglCreateContext", CreateContext);
            let make_current = egl_symbol!(library, "eglMakeCurrent", MakeCurrent);
            let get_proc_address = egl_symbol!(library, "eglGetProcAddress", GetProcAddress);
            let query_string = egl_symbol!(library, "eglQueryString", QueryString);
            let destroy_surface = egl_symbol!(library, "eglDestroySurface", DestroySurface);
            let destroy_context = egl_symbol!(library, "eglDestroyContext", DestroyContext);
            let terminate = egl_symbol!(library, "eglTerminate", Terminate);

            let display = unsafe {
                get_platform_display(EGL_PLATFORM_SURFACELESS_MESA, ptr::null_mut(), ptr::null())
            };
            if display.is_null() {
                bail!("EGL did not expose the surfaceless Mesa platform");
            }
            let (mut major, mut minor) = (0, 0);
            if unsafe { initialize(display, &mut major, &mut minor) } == 0 {
                bail!("eglInitialize failed");
            }
            if unsafe { bind_api(EGL_OPENGL_ES_API) } == 0 {
                bail!("eglBindAPI(OpenGL ES) failed");
            }
            let attributes = [
                EGL_SURFACE_TYPE,
                EGL_PBUFFER_BIT,
                EGL_RENDERABLE_TYPE,
                EGL_OPENGL_ES2_BIT,
                EGL_RED_SIZE,
                8,
                EGL_GREEN_SIZE,
                8,
                EGL_BLUE_SIZE,
                8,
                EGL_ALPHA_SIZE,
                8,
                EGL_DEPTH_SIZE,
                16,
                EGL_NONE,
            ];
            let mut config = ptr::null_mut();
            let mut count = 0;
            if unsafe { choose_config(display, attributes.as_ptr(), &mut config, 1, &mut count) }
                == 0
                || count == 0
            {
                unsafe { terminate(display) };
                bail!("no EGL pbuffer GLES2 configuration with a depth buffer");
            }
            let pbuffer_attributes = [
                EGL_WIDTH,
                width.try_into().context("render width exceeds EGL range")?,
                EGL_HEIGHT,
                height
                    .try_into()
                    .context("render height exceeds EGL range")?,
                EGL_NONE,
            ];
            let surface =
                unsafe { create_pbuffer_surface(display, config, pbuffer_attributes.as_ptr()) };
            if surface.is_null() {
                unsafe { terminate(display) };
                bail!("eglCreatePbufferSurface failed");
            }
            let context_attributes = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];
            let context = unsafe {
                create_context(
                    display,
                    config,
                    ptr::null_mut(),
                    context_attributes.as_ptr(),
                )
            };
            if context.is_null() {
                unsafe {
                    destroy_surface(display, surface);
                    terminate(display);
                }
                bail!("eglCreateContext(GLES2) failed");
            }
            if unsafe { make_current(display, surface, surface, context) } == 0 {
                unsafe {
                    destroy_context(display, context);
                    destroy_surface(display, surface);
                    terminate(display);
                }
                bail!("eglMakeCurrent failed");
            }
            let vendor = egl_string(unsafe { query_string(display, EGL_VENDOR) });
            let version = egl_string(unsafe { query_string(display, EGL_VERSION) });
            log::info!("cardputer: EGL {version}, vendor {vendor}");
            Ok(Self {
                library,
                gles,
                display,
                surface,
                context,
                get_proc_address,
                destroy_surface,
                destroy_context,
                terminate,
            })
        })();
        if result.is_err() {
            unsafe {
                libc::dlclose(gles);
                libc::dlclose(library);
            }
        }
        result
    }

    fn load(&self, name: &CStr) -> *const c_void {
        let direct = unsafe { libc::dlsym(self.gles, name.as_ptr()) };
        if direct.is_null() {
            unsafe { (self.get_proc_address)(name.as_ptr()) }
        } else {
            direct.cast_const()
        }
    }
}

impl Drop for Egl {
    fn drop(&mut self) {
        unsafe {
            (self.destroy_context)(self.display, self.context);
            (self.destroy_surface)(self.display, self.surface);
            (self.terminate)(self.display);
            libc::dlclose(self.gles);
            libc::dlclose(self.library);
        }
    }
}

fn dl_error() -> String {
    let error = unsafe { libc::dlerror() };
    if error.is_null() {
        "unknown dynamic-loader error".into()
    } else {
        unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned()
    }
}

fn egl_string(value: *const c_char) -> String {
    if value.is_null() {
        "unknown".into()
    } else {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct TextureKey {
    page: u16,
    frame: u16,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PaletteKey {
    pal: u16,
    tinted: bool,
    solid: Option<u32>,
}

struct TextureEntry {
    texture: glow::NativeTexture,
    bytes: usize,
    used: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct DynVert {
    u: f32,
    v: f32,
    abgr: u32,
    x: f32,
    y: f32,
    z: f32,
}
const _: () = assert!(size_of::<DynVert>() == 24);

#[derive(Clone, Copy)]
enum DepthMode {
    None,
    LessWrite,
    LessNoWrite,
    GreaterNoWrite,
}

struct Program {
    handle: glow::NativeProgram,
    matrix: Option<glow::NativeUniformLocation>,
    offset: Option<glow::NativeUniformLocation>,
    eye: Option<glow::NativeUniformLocation>,
    pull: Option<glow::NativeUniformLocation>,
    cutout: Option<glow::NativeUniformLocation>,
}

pub struct Renderer {
    // Keep EGL alive until after all GL resources have been destroyed.
    egl: Egl,
    gl: glow::Context,
    width: usize,
    height: usize,
    pak_program: Program,
    dyn_program: Program,
    world_vertices: glow::NativeBuffer,
    world_indices: glow::NativeBuffer,
    dynamic_vertices: glow::NativeBuffer,
    white_indices: glow::NativeTexture,
    white_palette: glow::NativeTexture,
    textures: HashMap<TextureKey, TextureEntry>,
    palettes: HashMap<PaletteKey, TextureEntry>,
    texture_bytes: usize,
    tint: u32,
    clock: u32,
    staging_indices: Vec<u8>,
    staging_texels: Vec<u32>,
    dynamic: Vec<DynVert>,
    readback: Vec<u8>,
    frame: Vec<u32>,
}

impl Renderer {
    pub fn new(pak: &Pak<'_>, width: usize, height: usize) -> Result<Self> {
        let egl = Egl::new(width, height)?;
        let gl = unsafe { glow::Context::from_loader_function_cstr(|name| egl.load(name)) };
        let renderer = unsafe { gl.get_parameter_string(glow::RENDERER) };
        let version = unsafe { gl.get_parameter_string(glow::VERSION) };
        let lower = renderer.to_ascii_lowercase();
        if ["llvmpipe", "softpipe", "swrast"]
            .iter()
            .any(|needle| lower.contains(needle))
        {
            bail!("refusing software OpenGL renderer {renderer:?}");
        }
        if !lower.contains("vc4") && !lower.contains("v3d") {
            bail!("expected the Cardputer VC4/V3D renderer, got {renderer:?}");
        }
        log::info!("cardputer: hardware GLES renderer {renderer}, {version}");

        let pak_program = create_program(&gl, PAK_VERTEX_SHADER, FRAGMENT_SHADER, true)?;
        let dyn_program = create_program(&gl, DYN_VERTEX_SHADER, FRAGMENT_SHADER, false)?;
        let world_vertices = unsafe { gl.create_buffer().map_err(anyhow::Error::msg)? };
        let world_indices = unsafe { gl.create_buffer().map_err(anyhow::Error::msg)? };
        let dynamic_vertices = unsafe { gl.create_buffer().map_err(anyhow::Error::msg)? };
        unsafe {
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(world_vertices));
            gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, as_bytes(pak.verts), glow::STATIC_DRAW);
            gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(world_indices));
            gl.buffer_data_u8_slice(
                glow::ELEMENT_ARRAY_BUFFER,
                as_bytes(pak.indices),
                glow::STATIC_DRAW,
            );
            gl.pixel_store_i32(glow::PACK_ALIGNMENT, 1);
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            gl.viewport(0, 0, width as i32, height as i32);
            gl.disable(glow::CULL_FACE);
        }
        let white_indices = unsafe { gl.create_texture().map_err(anyhow::Error::msg)? };
        unsafe {
            gl.bind_texture(glow::TEXTURE_2D, Some(white_indices));
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::LUMINANCE as i32,
                1,
                1,
                0,
                glow::LUMINANCE,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(&[0])),
            );
        }
        let white_palette = unsafe { gl.create_texture().map_err(anyhow::Error::msg)? };
        unsafe {
            gl.bind_texture(glow::TEXTURE_2D, Some(white_palette));
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::NEAREST as i32,
            );
            gl.tex_image_2d(
                glow::TEXTURE_2D,
                0,
                glow::RGBA as i32,
                1,
                1,
                0,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelUnpackData::Slice(Some(&[255, 255, 255, 255])),
            );
        }

        let mut renderer = Self {
            egl,
            gl,
            width,
            height,
            pak_program,
            dyn_program,
            world_vertices,
            world_indices,
            dynamic_vertices,
            white_indices,
            white_palette,
            textures: HashMap::new(),
            palettes: HashMap::new(),
            texture_bytes: 0,
            tint: 0xffff_ffff,
            clock: 0,
            staging_indices: Vec::new(),
            staging_texels: Vec::new(),
            dynamic: Vec::new(),
            readback: vec![0; width * height * 4],
            frame: vec![0; width * height],
        };
        let preload_started = Instant::now();
        for (page_index, page) in pak.atlases.iter().enumerate() {
            for frame in 0..page.frames {
                let _ = renderer.texture(
                    pak,
                    page_index as u16,
                    frame,
                    COLOR_PAL_NONE,
                    -1,
                    false,
                    None,
                )?;
            }
        }
        unsafe { renderer.gl.finish() };
        log::info!(
            "cardputer: preloaded {} KiB of CLUT8 atlas textures in {:.1} ms",
            renderer.texture_bytes / 1024,
            preload_started.elapsed().as_secs_f64() * 1000.0,
        );
        Ok(renderer)
    }

    pub fn render(&mut self, list: &DrawList, pak: &Pak<'_>) -> Result<Vec<u32>> {
        self.clock = self.clock.wrapping_add(1);
        self.retint(list.tint);
        let backdrop = list
            .items
            .iter()
            .find_map(|item| match item {
                Item::SkyBands { colors, .. } => Some(colors[SKY_BANDS - 1]),
                _ => None,
            })
            .unwrap_or(0xff00_0000);
        let [r, g, b, a] = rgba(backdrop);
        unsafe {
            self.gl.clear_color(r, g, b, a);
            self.gl.clear_depth_f32(1.0);
            self.gl
                .clear(glow::COLOR_BUFFER_BIT | glow::DEPTH_BUFFER_BIT);
        }

        for item in &list.items {
            match item {
                Item::SkyBands {
                    colors,
                    horizon_row,
                } => self.sky(colors, *horizon_row),
                Item::ChunkMesh { kind, mesh, .. } => {
                    self.mesh(pak, list, mesh, *kind)?;
                }
                Item::StampMesh { mesh, .. } => {
                    self.mesh(pak, list, mesh, mesh_kind::TERRAIN)?;
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.shadow(&list.cam.vp, corners, *abgr);
                }
                Item::Ghost {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                    abgr,
                } => {
                    self.card(
                        pak,
                        list,
                        verts,
                        *page,
                        uv,
                        *mirror,
                        *pull,
                        Some(*abgr),
                        true,
                    )?;
                }
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => {
                    self.card(pak, list, verts, *page, uv, *mirror, *pull, None, false)?;
                }
                Item::UiQuad { .. } | Item::VideoQuad { .. } | Item::OverlayRect { .. } => {}
            }
        }
        self.ui(pak, list)?;
        self.video(list);
        self.overlays(list);

        unsafe {
            self.gl.read_pixels(
                0,
                0,
                self.width as i32,
                self.height as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut self.readback)),
            );
        }
        // OpenGL's first readback row is the bottom row; fbdev expects top-down.
        for y in 0..self.height {
            let source_y = self.height - 1 - y;
            for x in 0..self.width {
                let offset = (source_y * self.width + x) * 4;
                self.frame[y * self.width + x] =
                    u32::from_le_bytes(self.readback[offset..offset + 4].try_into().unwrap());
            }
        }
        Ok(self.frame.clone())
    }

    fn retint(&mut self, tint: u32) {
        if tint == self.tint {
            return;
        }
        self.tint = tint;
        let stale: Vec<_> = self
            .palettes
            .keys()
            .copied()
            .filter(|key| key.tinted)
            .collect();
        for key in stale {
            if let Some(entry) = self.palettes.remove(&key) {
                self.texture_bytes -= entry.bytes;
                unsafe { self.gl.delete_texture(entry.texture) };
            }
        }
    }

    fn texture(
        &mut self,
        pak: &Pak<'_>,
        page_idx: u16,
        frame: u16,
        pal: u16,
        selection: i32,
        tinted: bool,
        solid: Option<u32>,
    ) -> Result<Option<(glow::NativeTexture, glow::NativeTexture)>> {
        let Some(page) = pak.atlases.get(page_idx as usize) else {
            return Ok(None);
        };
        let resolved = resolve_pal(pak, page_idx, page.kind, pal, selection);
        let Some(palette) = pak.palettes.get(resolved) else {
            return Ok(None);
        };
        let key = TextureKey {
            page: page_idx,
            frame: frame % page.frames.max(1),
        };
        let indices = if let Some(entry) = self.textures.get_mut(&key) {
            entry.used = self.clock;
            entry.texture
        } else {
            let (w, h) = (page.w as usize, page.h as usize);
            self.staging_indices =
                unswizzle(w, h, page.frame(key.frame)).map_err(anyhow::Error::msg)?;
            let texture = unsafe { self.gl.create_texture().map_err(anyhow::Error::msg)? };
            unsafe {
                self.gl.bind_texture(glow::TEXTURE_2D, Some(texture));
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MIN_FILTER,
                    glow::NEAREST as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MAG_FILTER,
                    glow::NEAREST as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_S,
                    glow::CLAMP_TO_EDGE as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_T,
                    glow::CLAMP_TO_EDGE as i32,
                );
                self.gl.tex_image_2d(
                    glow::TEXTURE_2D,
                    0,
                    glow::LUMINANCE as i32,
                    w as i32,
                    h as i32,
                    0,
                    glow::LUMINANCE,
                    glow::UNSIGNED_BYTE,
                    glow::PixelUnpackData::Slice(Some(&self.staging_indices)),
                );
            }
            let bytes = w * h;
            self.texture_bytes += bytes;
            self.textures.insert(
                key,
                TextureEntry {
                    texture,
                    bytes,
                    used: self.clock,
                },
            );
            self.evict_textures(key);
            texture
        };

        let palette_key = PaletteKey {
            pal: resolved as u16,
            tinted,
            solid,
        };
        let palette_texture = if let Some(entry) = self.palettes.get_mut(&palette_key) {
            entry.used = self.clock;
            entry.texture
        } else {
            self.staging_texels.clear();
            self.staging_texels.reserve(256);
            for &source in palette {
                let color = if let Some(solid) = solid {
                    if source >> 24 >= 0x80 { solid } else { 0 }
                } else if tinted {
                    modulate_rgb(source, self.tint)
                } else {
                    source
                };
                self.staging_texels.push(color);
            }
            let texture = unsafe { self.gl.create_texture().map_err(anyhow::Error::msg)? };
            unsafe {
                self.gl.bind_texture(glow::TEXTURE_2D, Some(texture));
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MIN_FILTER,
                    glow::NEAREST as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_MAG_FILTER,
                    glow::NEAREST as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_S,
                    glow::CLAMP_TO_EDGE as i32,
                );
                self.gl.tex_parameter_i32(
                    glow::TEXTURE_2D,
                    glow::TEXTURE_WRAP_T,
                    glow::CLAMP_TO_EDGE as i32,
                );
                self.gl.tex_image_2d(
                    glow::TEXTURE_2D,
                    0,
                    glow::RGBA as i32,
                    256,
                    1,
                    0,
                    glow::RGBA,
                    glow::UNSIGNED_BYTE,
                    glow::PixelUnpackData::Slice(Some(as_bytes(&self.staging_texels))),
                );
            }
            self.texture_bytes += 1024;
            self.palettes.insert(
                palette_key,
                TextureEntry {
                    texture,
                    bytes: 1024,
                    used: self.clock,
                },
            );
            texture
        };
        Ok(Some((indices, palette_texture)))
    }

    fn evict_textures(&mut self, keep: TextureKey) {
        const BUDGET: usize = 8 * 1024 * 1024;
        while self.texture_bytes > BUDGET {
            let victim = self
                .textures
                .iter()
                .filter(|(key, _)| **key != keep)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| *key);
            let Some(victim) = victim else { break };
            if let Some(entry) = self.textures.remove(&victim) {
                self.texture_bytes -= entry.bytes;
                // Every frame ends in synchronous glReadPixels, so no earlier
                // command can still reference an evicted texture here.
                unsafe { self.gl.delete_texture(entry.texture) };
            }
        }
    }

    fn mesh(&mut self, pak: &Pak<'_>, list: &DrawList, mesh: &MeshDraw, _kind: u16) -> Result<()> {
        if mesh.index_count == 0 {
            return Ok(());
        }
        let Some((texture, palette)) = self.texture(
            pak,
            mesh.page,
            mesh.frame,
            mesh.pal,
            list.palette,
            true,
            None,
        )?
        else {
            return Ok(());
        };
        let matrix = if mesh.pull_bias != 0.0 {
            biased_vp(&list.cam.vp, mesh.pull_bias)
        } else {
            list.cam.vp
        };
        unsafe {
            self.set_state(DepthMode::LessWrite, false);
            self.gl.use_program(Some(self.pak_program.handle));
            self.gl
                .uniform_matrix_4_f32_slice(self.pak_program.matrix.as_ref(), false, &matrix.m);
            self.gl.uniform_3_f32(
                self.pak_program.offset.as_ref(),
                mesh.off_x as f32,
                0.0,
                mesh.off_y as f32,
            );
            self.gl.uniform_3_f32(
                self.pak_program.eye.as_ref(),
                list.cam.eye.x,
                list.cam.eye.y,
                list.cam.eye.z,
            );
            self.gl
                .uniform_1_f32(self.pak_program.pull.as_ref(), mesh.pull);
            self.gl.uniform_1_f32(self.pak_program.cutout.as_ref(), 1.0);
            self.gl.active_texture(glow::TEXTURE0);
            self.gl.bind_texture(glow::TEXTURE_2D, Some(texture));
            self.gl.active_texture(glow::TEXTURE1);
            self.gl.bind_texture(glow::TEXTURE_2D, Some(palette));
            self.gl
                .bind_buffer(glow::ARRAY_BUFFER, Some(self.world_vertices));
            self.gl
                .bind_buffer(glow::ELEMENT_ARRAY_BUFFER, Some(self.world_indices));
            let base = mesh.vert_base as i32 * 16;
            self.gl.enable_vertex_attrib_array(0);
            self.gl
                .vertex_attrib_pointer_f32(0, 2, glow::UNSIGNED_SHORT, false, 16, base);
            self.gl.enable_vertex_attrib_array(1);
            self.gl
                .vertex_attrib_pointer_f32(1, 4, glow::UNSIGNED_BYTE, true, 16, base + 4);
            self.gl.enable_vertex_attrib_array(2);
            self.gl
                .vertex_attrib_pointer_f32(2, 3, glow::SHORT, false, 16, base + 8);
            self.gl.draw_elements(
                glow::TRIANGLES,
                mesh.index_count as i32,
                glow::UNSIGNED_SHORT,
                mesh.index_base as i32 * 2,
            );
        }
        Ok(())
    }

    fn sky(&mut self, colors: &[u32; SKY_BANDS], horizon_row: i32) {
        let horizon = horizon_row.clamp(0, VIEW_H);
        self.dynamic.clear();
        for (i, color) in colors.iter().copied().enumerate() {
            let y0 = (horizon * i as i32 / SKY_BANDS as i32) as f32;
            let y1 = (horizon * (i as i32 + 1) / SKY_BANDS as i32) as f32;
            push_rect(&mut self.dynamic, 0.0, y0, VIEW_W as f32, y1, color);
        }
        self.draw_dynamic(
            logical_ortho(),
            (self.white_indices, self.white_palette),
            false,
            DepthMode::None,
            false,
        );
    }

    fn shadow(&mut self, vp: &Mat4, corners: &[[f32; 3]; 4], abgr: u32) {
        self.dynamic.clear();
        for index in [0usize, 1, 2, 0, 2, 3] {
            let p = corners[index];
            self.dynamic.push(DynVert {
                u: 0.0,
                v: 0.0,
                abgr,
                x: p[0],
                y: p[1],
                z: p[2],
            });
        }
        self.draw_dynamic(
            *vp,
            (self.white_indices, self.white_palette),
            false,
            DepthMode::LessNoWrite,
            true,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn card(
        &mut self,
        pak: &Pak<'_>,
        list: &DrawList,
        verts: &[[f32; 3]; 4],
        page: u16,
        uv: &[f32; 4],
        mirror: bool,
        pull: f32,
        solid: Option<u32>,
        occluded: bool,
    ) -> Result<()> {
        let Some(texture) =
            self.texture(pak, page, 0, COLOR_PAL_NONE, list.palette, true, solid)?
        else {
            return Ok(());
        };
        let (u0, u1) = if mirror {
            (uv[2], uv[0])
        } else {
            (uv[0], uv[2])
        };
        let (v0, v1) = (uv[1], uv[3]);
        let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
        self.dynamic.clear();
        for index in [0usize, 1, 2, 0, 2, 3] {
            let source = verts[index];
            let p = pulled_i16(list.cam.eye, vec3(source[0], source[1], source[2]), pull);
            self.dynamic.push(DynVert {
                u: uvs[index].0,
                v: uvs[index].1,
                abgr: 0xffff_ffff,
                x: p.x,
                y: p.y,
                z: p.z,
            });
        }
        self.draw_dynamic(
            list.cam.vp,
            texture,
            true,
            if occluded {
                DepthMode::GreaterNoWrite
            } else {
                DepthMode::LessWrite
            },
            occluded,
        );
        Ok(())
    }

    fn ui(&mut self, pak: &Pak<'_>, list: &DrawList) -> Result<()> {
        let Some(page_idx) = list.items.iter().find_map(|item| match item {
            Item::UiQuad { page, .. } => Some(*page),
            _ => None,
        }) else {
            return Ok(());
        };
        let Some(page) = pak.atlases.get(page_idx as usize) else {
            return Ok(());
        };
        let Some(texture) =
            self.texture(pak, page_idx, 0, COLOR_PAL_NONE, list.palette, false, None)?
        else {
            return Ok(());
        };
        let cols = (page.w as i32 / TILE_PX).max(1) as u16;
        let (pw, ph) = (page.w as f32, page.h as f32);
        self.dynamic.clear();
        for item in &list.items {
            let Item::UiQuad {
                x, y, w, h, tile, ..
            } = item
            else {
                continue;
            };
            let tx = (tile % cols) as f32 * TILE_PX as f32;
            let ty = (tile / cols) as f32 * TILE_PX as f32;
            push_tex_rect(
                &mut self.dynamic,
                *x,
                *y,
                *x + *w,
                *y + *h,
                tx / pw,
                ty / ph,
                (tx + TILE_PX as f32) / pw,
                (ty + TILE_PX as f32) / ph,
                0xffff_ffff,
            );
        }
        self.draw_dynamic(logical_ortho(), texture, true, DepthMode::None, false);
        Ok(())
    }

    fn video(&mut self, list: &DrawList) {
        self.dynamic.clear();
        for item in &list.items {
            let Item::VideoQuad { x, y, w, h } = item else {
                continue;
            };
            let y_end = y.saturating_add(*h);
            let x_end = x.saturating_add(*w);
            let mut py = *y;
            while py < y_end {
                let mut px = *x;
                while px < x_end {
                    let color = if ((px - x) / 8 + (py - y) / 8) & 1 == 0 {
                        0xff30_3030
                    } else {
                        0xff18_1818
                    };
                    push_rect(
                        &mut self.dynamic,
                        px as f32,
                        py as f32,
                        (px + 8).min(x_end) as f32,
                        (py + 8).min(y_end) as f32,
                        color,
                    );
                    px += 8;
                }
                py += 8;
            }
        }
        self.draw_dynamic(
            logical_ortho(),
            (self.white_indices, self.white_palette),
            false,
            DepthMode::None,
            false,
        );
    }

    fn overlays(&mut self, list: &DrawList) {
        self.dynamic.clear();
        for item in &list.items {
            let Item::OverlayRect { x, y, w, h, abgr } = item else {
                continue;
            };
            push_rect(
                &mut self.dynamic,
                *x as f32,
                *y as f32,
                x.saturating_add(*w) as f32,
                y.saturating_add(*h) as f32,
                *abgr,
            );
        }
        self.draw_dynamic(
            logical_ortho(),
            (self.white_indices, self.white_palette),
            false,
            DepthMode::None,
            true,
        );
    }

    fn draw_dynamic(
        &self,
        matrix: Mat4,
        textures: (glow::NativeTexture, glow::NativeTexture),
        cutout: bool,
        depth: DepthMode,
        blend: bool,
    ) {
        if self.dynamic.is_empty() {
            return;
        }
        unsafe {
            self.set_state(depth, blend);
            self.gl.use_program(Some(self.dyn_program.handle));
            self.gl
                .uniform_matrix_4_f32_slice(self.dyn_program.matrix.as_ref(), false, &matrix.m);
            self.gl
                .uniform_1_f32(self.dyn_program.cutout.as_ref(), cutout as u8 as f32);
            self.gl.active_texture(glow::TEXTURE0);
            self.gl.bind_texture(glow::TEXTURE_2D, Some(textures.0));
            self.gl.active_texture(glow::TEXTURE1);
            self.gl.bind_texture(glow::TEXTURE_2D, Some(textures.1));
            self.gl
                .bind_buffer(glow::ARRAY_BUFFER, Some(self.dynamic_vertices));
            self.gl.buffer_data_u8_slice(
                glow::ARRAY_BUFFER,
                as_bytes(&self.dynamic),
                glow::STREAM_DRAW,
            );
            self.gl.bind_buffer(glow::ELEMENT_ARRAY_BUFFER, None);
            self.gl.enable_vertex_attrib_array(0);
            self.gl
                .vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 24, 0);
            self.gl.enable_vertex_attrib_array(1);
            self.gl
                .vertex_attrib_pointer_f32(1, 4, glow::UNSIGNED_BYTE, true, 24, 8);
            self.gl.enable_vertex_attrib_array(2);
            self.gl
                .vertex_attrib_pointer_f32(2, 3, glow::FLOAT, false, 24, 12);
            self.gl
                .draw_arrays(glow::TRIANGLES, 0, self.dynamic.len() as i32);
        }
    }

    unsafe fn set_state(&self, depth: DepthMode, blend: bool) {
        unsafe {
            match depth {
                DepthMode::None => {
                    self.gl.disable(glow::DEPTH_TEST);
                    self.gl.depth_mask(false);
                }
                DepthMode::LessWrite => {
                    self.gl.enable(glow::DEPTH_TEST);
                    self.gl.depth_func(glow::LESS);
                    self.gl.depth_mask(true);
                }
                DepthMode::LessNoWrite => {
                    self.gl.enable(glow::DEPTH_TEST);
                    self.gl.depth_func(glow::LESS);
                    self.gl.depth_mask(false);
                }
                DepthMode::GreaterNoWrite => {
                    self.gl.enable(glow::DEPTH_TEST);
                    self.gl.depth_func(glow::GREATER);
                    self.gl.depth_mask(false);
                }
            }
            if blend {
                self.gl.enable(glow::BLEND);
                self.gl
                    .blend_func(glow::SRC_ALPHA, glow::ONE_MINUS_SRC_ALPHA);
            } else {
                self.gl.disable(glow::BLEND);
            }
        }
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe {
            for entry in self.textures.drain().map(|(_, entry)| entry) {
                self.gl.delete_texture(entry.texture);
            }
            for entry in self.palettes.drain().map(|(_, entry)| entry) {
                self.gl.delete_texture(entry.texture);
            }
            self.gl.delete_texture(self.white_palette);
            self.gl.delete_texture(self.white_indices);
            self.gl.delete_buffer(self.dynamic_vertices);
            self.gl.delete_buffer(self.world_indices);
            self.gl.delete_buffer(self.world_vertices);
            self.gl.delete_program(self.dyn_program.handle);
            self.gl.delete_program(self.pak_program.handle);
        }
        // Touch the field so its lifetime requirement remains explicit.
        let _ = &self.egl;
    }
}

fn create_program(gl: &glow::Context, vertex: &str, fragment: &str, pak: bool) -> Result<Program> {
    unsafe {
        let vs = compile_shader(gl, glow::VERTEX_SHADER, vertex)?;
        let fs = compile_shader(gl, glow::FRAGMENT_SHADER, fragment)?;
        let handle = gl.create_program().map_err(anyhow::Error::msg)?;
        gl.attach_shader(handle, vs);
        gl.attach_shader(handle, fs);
        gl.bind_attrib_location(handle, 0, "a_uv");
        gl.bind_attrib_location(handle, 1, "a_color");
        gl.bind_attrib_location(handle, 2, "a_position");
        gl.link_program(handle);
        gl.detach_shader(handle, vs);
        gl.detach_shader(handle, fs);
        gl.delete_shader(vs);
        gl.delete_shader(fs);
        if !gl.get_program_link_status(handle) {
            let log = gl.get_program_info_log(handle);
            gl.delete_program(handle);
            bail!("linking GLES program: {log}");
        }
        gl.use_program(Some(handle));
        gl.uniform_1_i32(gl.get_uniform_location(handle, "u_texture").as_ref(), 0);
        gl.uniform_1_i32(gl.get_uniform_location(handle, "u_palette").as_ref(), 1);
        Ok(Program {
            handle,
            matrix: gl.get_uniform_location(handle, "u_matrix"),
            offset: pak
                .then(|| gl.get_uniform_location(handle, "u_offset"))
                .flatten(),
            eye: pak
                .then(|| gl.get_uniform_location(handle, "u_eye"))
                .flatten(),
            pull: pak
                .then(|| gl.get_uniform_location(handle, "u_pull"))
                .flatten(),
            cutout: gl.get_uniform_location(handle, "u_cutout"),
        })
    }
}

unsafe fn compile_shader(
    gl: &glow::Context,
    kind: u32,
    source: &str,
) -> Result<glow::NativeShader> {
    unsafe {
        let shader = gl.create_shader(kind).map_err(anyhow::Error::msg)?;
        gl.shader_source(shader, source);
        gl.compile_shader(shader);
        if !gl.get_shader_compile_status(shader) {
            let log = gl.get_shader_info_log(shader);
            gl.delete_shader(shader);
            bail!("compiling GLES shader: {log}");
        }
        Ok(shader)
    }
}

fn logical_ortho() -> Mat4 {
    let mut matrix = Mat4::IDENTITY;
    matrix.m[0] = 2.0 / VIEW_W as f32;
    matrix.m[5] = -2.0 / VIEW_H as f32;
    matrix.m[10] = 0.0;
    matrix.m[12] = -1.0;
    matrix.m[13] = 1.0;
    matrix
}

fn pulled_i16(eye: Vec3, position: Vec3, pull: f32) -> Vec3 {
    if pull == 0.0 {
        return position;
    }
    let p = position.add(eye.sub(position).normalize().scale(pull));
    vec3(p.x.trunc(), p.y.trunc(), p.z.trunc())
}

fn push_rect(vertices: &mut Vec<DynVert>, x0: f32, y0: f32, x1: f32, y1: f32, abgr: u32) {
    push_tex_rect(vertices, x0, y0, x1, y1, 0.0, 0.0, 0.0, 0.0, abgr);
}

#[allow(clippy::too_many_arguments)]
fn push_tex_rect(
    vertices: &mut Vec<DynVert>,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
    abgr: u32,
) {
    let corner = |x, y, u, v| DynVert {
        u,
        v,
        abgr,
        x,
        y,
        z: 0.0,
    };
    vertices.extend_from_slice(&[
        corner(x0, y0, u0, v0),
        corner(x1, y0, u1, v0),
        corner(x1, y1, u1, v1),
        corner(x0, y0, u0, v0),
        corner(x1, y1, u1, v1),
        corner(x0, y1, u0, v1),
    ]);
}

fn rgba(abgr: u32) -> [f32; 4] {
    [
        (abgr & 0xff) as f32 / 255.0,
        ((abgr >> 8) & 0xff) as f32 / 255.0,
        ((abgr >> 16) & 0xff) as f32 / 255.0,
        ((abgr >> 24) & 0xff) as f32 / 255.0,
    ]
}

fn as_bytes<T>(values: &[T]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast(), size_of_val(values)) }
}

const PAK_VERTEX_SHADER: &str = r#"
attribute vec2 a_uv;
attribute vec4 a_color;
attribute vec3 a_position;
uniform mat4 u_matrix;
uniform vec3 u_offset;
uniform vec3 u_eye;
uniform float u_pull;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    vec3 p = a_position + u_offset;
    if (u_pull != 0.0) {
        vec3 ray = u_eye - p;
        float len = length(ray);
        if (len > 0.000000000001) p += ray / len * u_pull;
        p = vec3(p.x < 0.0 ? ceil(p.x) : floor(p.x),
                 p.y < 0.0 ? ceil(p.y) : floor(p.y),
                 p.z < 0.0 ? ceil(p.z) : floor(p.z));
    }
    gl_Position = u_matrix * vec4(p, 1.0);
    v_uv = a_uv / 32768.0;
    v_color = a_color;
}
"#;

const DYN_VERTEX_SHADER: &str = r#"
attribute vec2 a_uv;
attribute vec4 a_color;
attribute vec3 a_position;
uniform mat4 u_matrix;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    gl_Position = u_matrix * vec4(a_position, 1.0);
    v_uv = a_uv;
    v_color = a_color;
}
"#;

const FRAGMENT_SHADER: &str = r#"
precision mediump float;
uniform sampler2D u_texture;
uniform sampler2D u_palette;
uniform float u_cutout;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
    float index = texture2D(u_texture, v_uv).r;
    vec4 color = texture2D(u_palette, vec2((index * 255.0 + 0.5) / 256.0, 0.5)) * v_color;
    if (u_cutout > 0.5 && color.a < 0.5) discard;
    gl_FragColor = color;
}
"#;
