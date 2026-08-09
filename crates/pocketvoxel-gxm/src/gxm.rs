//! The GXM pipeline: libvita2d's precompiled shaders, bound to Pocket Voxel's
//! own vertex layouts.
//!
//! GXM is shader-only — there is no fixed-function pipe in the hardware — so
//! every draw needs a compiled vertex/fragment program pair. Compiling on the
//! console means Sony's `libshacccg.suprx`; bringing programs that are
//! already compiled means no prerequisite at all. The five `.gxp` binaries
//! come from xerpi's MIT-licensed libvita2d and are reused from
//! `pocket3d-vita/shaders/`, which records their extraction (see that
//! directory's `README.md` and `LICENSE.libvita2d`). One copy in the tree,
//! one provenance record.
//!
//! What those five shaders are:
//!
//! ```text
//! color_v    aPosition, aColor  + uniform wvp -> per-vertex colour
//! color_f    that colour
//! texture_v  aPosition, aTexcoord + uniform wvp -> a sampled texel
//! texture_f  that texel
//! texture_tint_f  texel * uniform uTintColor
//! ```
//!
//! Two consequences shape this whole backend, and neither is a shader we can
//! edit our way out of:
//!
//! 1. **The textured program has no per-vertex colour.** The pak's per-vertex
//!    AO cannot modulate the texel in one pass, so a mesh draws TWICE — the
//!    texel, then the AO through `color_v` with a multiply blend
//!    (`dst * src`). Same vertex buffer, same indices, different attribute
//!    offsets; the result is `texel * ao`, which is what the GE gets from one
//!    `TextureEffect::Modulate`.
//! 2. **GXM has no alpha test.** The GE's `AlphaFunc::Greater 0x7f` cutout
//!    has no equivalent, so alpha is resolved by blending and draw order
//!    instead of by discard (see `lib.rs`, which owns that policy).
//!
//! The vertex attribute FORMAT is where the pak's cooked layout survives
//! unchanged: `S16` takes its i16 world positions as the integers they are
//! (no ×32768 counter-scale, unlike the GE), `S16N` reads its fixed-point
//! UVs as 0..1, and `U8N` reads its ABGR straight.

#![cfg(target_os = "vita")]

use core::cell::UnsafeCell;
use core::ffi::c_void;
use core::ptr;

use vita2d_sys as v2d;

use pocketvoxel_core::spec::VERTEX_STRIDE;

/// GXM consumes these blobs as `SceGxmProgram` structures. `include_bytes!`
/// alone has byte alignment, which is insufficient on ARM and can be rejected
/// by the shader patcher even when the payload itself is valid.
#[repr(C, align(16))]
struct AlignedShader<const N: usize>([u8; N]);

const SHADERS: &str = "../../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-vita/shaders";
static COLOR_V: AlignedShader<344> = AlignedShader(*include_bytes!(concat!(
    "../../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-vita/shaders/color_v.gxp"
)));
static COLOR_F: AlignedShader<216> = AlignedShader(*include_bytes!(concat!(
    "../../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-vita/shaders/color_f.gxp"
)));
static TEXTURE_V: AlignedShader<344> = AlignedShader(*include_bytes!(concat!(
    "../../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-vita/shaders/texture_v.gxp"
)));
static TEXTURE_F: AlignedShader<228> = AlignedShader(*include_bytes!(concat!(
    "../../../vendor/pocketjs/engine/pocket3d/crates/pocket3d-vita/shaders/texture_f.gxp"
)));

// ---------------------------------------------------------------------------
// Vertex layouts
// ---------------------------------------------------------------------------

/// The pak's own 16-byte `PakVert`, drawn from GPU memory in place.
const PAK_UV_OFFSET: u16 = 0;
const PAK_COLOR_OFFSET: u16 = 4;
const PAK_POSITION_OFFSET: u16 = 8;
const _: () = assert!(VERTEX_STRIDE == 16);

/// CPU-built untextured vertex (sky bands, shadow decals, the ghost):
/// `u32 ABGR` then `f32 xyz`.
pub const FLAT_STRIDE: u16 = 16;
const FLAT_COLOR_OFFSET: u16 = 0;
const FLAT_POSITION_OFFSET: u16 = 4;

/// CPU-built textured vertex (billboard cards, the GB UI layer):
/// `f32 uv` then `f32 xyz`. Floats rather than the pak's fixed point because
/// these are built per frame anyway, and a card's UV is a sub-texel crop.
pub const TEX_STRIDE: u16 = 20;
const TEX_UV_OFFSET: u16 = 0;
const TEX_POSITION_OFFSET: u16 = 8;

pub struct Pipeline {
    patcher: *mut v2d::SceGxmShaderPatcher,
    ids: [v2d::SceGxmShaderPatcherId; 4],
    /// The pak stream, textured (`texture_v`: position + uv).
    pak_tex_vp: *mut v2d::SceGxmVertexProgram,
    /// The pak stream again, as colour only (`color_v`: position + ao).
    pak_col_vp: *mut v2d::SceGxmVertexProgram,
    flat_vp: *mut v2d::SceGxmVertexProgram,
    tex_vp: *mut v2d::SceGxmVertexProgram,
    /// Opaque texel, no blending.
    tex_opaque_fp: *mut v2d::SceGxmFragmentProgram,
    /// Texel with straight alpha blending — the cutout stand-in.
    tex_alpha_fp: *mut v2d::SceGxmFragmentProgram,
    /// `dst * src`: the AO modulate pass.
    col_multiply_fp: *mut v2d::SceGxmFragmentProgram,
    col_opaque_fp: *mut v2d::SceGxmFragmentProgram,
    col_alpha_fp: *mut v2d::SceGxmFragmentProgram,
    tex_wvp: *const v2d::SceGxmProgramParameter,
    col_wvp: *const v2d::SceGxmProgramParameter,
}

struct PipelineCell(UnsafeCell<Option<Result<Pipeline, &'static str>>>);
// Access is confined to the Vita render thread by the unsafe public API.
unsafe impl Sync for PipelineCell {}
static PIPELINE: PipelineCell = PipelineCell(UnsafeCell::new(None));

/// One GPU-mapped uncached allocation (the `pocket3d-vita` GpuSlab pattern).
/// Freeing is manual: the caller guarantees no in-flight GPU work references
/// the range.
pub struct GpuSlab {
    uid: v2d::SceUID,
    base: *mut c_void,
    len: usize,
}

impl GpuSlab {
    /// Allocate `len` bytes of uncached, GXM-mapped memory.
    ///
    /// # Safety
    /// Render-thread only, after vita2d init.
    pub unsafe fn alloc(len: usize) -> Result<Self, &'static str> {
        let size = len.max(4096).next_multiple_of(4096);
        let uid = v2d::sceKernelAllocMemBlock(
            c"pocketvoxel".as_ptr(),
            v2d::SCE_KERNEL_MEMBLOCK_TYPE_USER_RW_UNCACHE,
            size as v2d::SceSize,
            ptr::null_mut(),
        );
        if uid < 0 {
            return Err("sceKernelAllocMemBlock failed");
        }
        let mut base: *mut c_void = ptr::null_mut();
        if v2d::sceKernelGetMemBlockBase(uid, &mut base) < 0 || base.is_null() {
            v2d::sceKernelFreeMemBlock(uid);
            return Err("sceKernelGetMemBlockBase failed");
        }
        if v2d::sceGxmMapMemory(
            base,
            size as v2d::SceSize,
            v2d::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_READ,
        ) < 0
        {
            v2d::sceKernelFreeMemBlock(uid);
            return Err("sceGxmMapMemory failed");
        }
        Ok(Self { uid, base, len: size })
    }

    pub fn as_ptr(&self) -> *mut u8 {
        self.base.cast()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// # Safety
    /// No in-flight GPU work may reference this range.
    pub unsafe fn free(self) {
        v2d::sceGxmUnmapMemory(self.base);
        v2d::sceKernelFreeMemBlock(self.uid);
    }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

fn blend_info(
    color_src: v2d::SceGxmBlendFactor,
    color_dst: v2d::SceGxmBlendFactor,
    alpha_src: v2d::SceGxmBlendFactor,
    alpha_dst: v2d::SceGxmBlendFactor,
) -> v2d::SceGxmBlendInfo {
    // `colorMask` is a plain byte; everything else is a packed bitfield with
    // generated setters.
    let mut info = v2d::SceGxmBlendInfo {
        colorMask: v2d::SceGxmColorMask_SCE_GXM_COLOR_MASK_ALL as u8,
        _bitfield_align_1: [],
        _bitfield_1: Default::default(),
    };
    info.set_colorFunc(v2d::SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_alphaFunc(v2d::SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_colorSrc(color_src as u8);
    info.set_colorDst(color_dst as u8);
    info.set_alphaSrc(alpha_src as u8);
    info.set_alphaDst(alpha_dst as u8);
    info
}

unsafe fn register(
    patcher: *mut v2d::SceGxmShaderPatcher,
    blob: &'static [u8],
) -> Result<(v2d::SceGxmShaderPatcherId, *const v2d::SceGxmProgram), &'static str> {
    let program = blob.as_ptr().cast::<v2d::SceGxmProgram>();
    if v2d::sceGxmProgramCheck(program) < 0 {
        return Err("sceGxmProgramCheck failed");
    }
    if v2d::sceGxmProgramGetSize(program) as usize > blob.len() {
        return Err("truncated GXM shader program");
    }
    let mut id: v2d::SceGxmShaderPatcherId = ptr::null_mut();
    if v2d::sceGxmShaderPatcherRegisterProgram(patcher, program, &mut id) < 0 {
        return Err("sceGxmShaderPatcherRegisterProgram failed");
    }
    Ok((id, program))
}

unsafe fn parameter(
    program: *const v2d::SceGxmProgram,
    name: &'static core::ffi::CStr,
) -> Result<*const v2d::SceGxmProgramParameter, &'static str> {
    let parameter = v2d::sceGxmProgramFindParameterByName(program, name.as_ptr());
    if parameter.is_null() {
        return Err("shader parameter not found");
    }
    Ok(parameter)
}

unsafe fn resource_index(
    program: *const v2d::SceGxmProgram,
    name: &'static core::ffi::CStr,
) -> Result<u16, &'static str> {
    Ok(v2d::sceGxmProgramParameterGetResourceIndex(parameter(program, name)?) as u16)
}

unsafe fn vertex_program(
    patcher: *mut v2d::SceGxmShaderPatcher,
    id: v2d::SceGxmShaderPatcherId,
    attributes: &[v2d::SceGxmVertexAttribute],
    stride: u16,
) -> Result<*mut v2d::SceGxmVertexProgram, &'static str> {
    let stream = v2d::SceGxmVertexStream {
        stride,
        indexSource: v2d::SceGxmIndexSource_SCE_GXM_INDEX_SOURCE_INDEX_16BIT as u16,
    };
    let mut program: *mut v2d::SceGxmVertexProgram = ptr::null_mut();
    if v2d::sceGxmShaderPatcherCreateVertexProgram(
        patcher,
        id,
        attributes.as_ptr(),
        attributes.len() as u32,
        &stream,
        1,
        &mut program,
    ) < 0
    {
        return Err("sceGxmShaderPatcherCreateVertexProgram failed");
    }
    Ok(program)
}

unsafe fn fragment_program(
    patcher: *mut v2d::SceGxmShaderPatcher,
    id: v2d::SceGxmShaderPatcherId,
    blend: Option<&v2d::SceGxmBlendInfo>,
    linked_vertex: *const v2d::SceGxmProgram,
) -> Result<*mut v2d::SceGxmFragmentProgram, &'static str> {
    let mut program: *mut v2d::SceGxmFragmentProgram = ptr::null_mut();
    if v2d::sceGxmShaderPatcherCreateFragmentProgram(
        patcher,
        id,
        v2d::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_UCHAR4,
        v2d::SceGxmMultisampleMode_SCE_GXM_MULTISAMPLE_NONE,
        blend.map_or(ptr::null(), |blend| blend as *const _),
        linked_vertex,
        &mut program,
    ) < 0
    {
        return Err("sceGxmShaderPatcherCreateFragmentProgram failed");
    }
    Ok(program)
}

unsafe fn build() -> Result<Pipeline, &'static str> {
    let patcher = v2d::vita2d_get_shader_patcher();
    if patcher.is_null() {
        return Err("vita2d is not initialized (no shader patcher)");
    }
    let _ = SHADERS;

    let (color_v_id, color_v) = register(patcher, &COLOR_V.0)?;
    let (color_f_id, _) = register(patcher, &COLOR_F.0)?;
    let (texture_v_id, texture_v) = register(patcher, &TEXTURE_V.0)?;
    let (texture_f_id, _) = register(patcher, &TEXTURE_F.0)?;

    let col_position = resource_index(color_v, c"aPosition")?;
    let col_color = resource_index(color_v, c"aColor")?;
    let tex_position = resource_index(texture_v, c"aPosition")?;
    let tex_texcoord = resource_index(texture_v, c"aTexcoord")?;
    let col_wvp = parameter(color_v, c"wvp")?;
    let tex_wvp = parameter(texture_v, c"wvp")?;

    let attribute = |offset: u16, format: v2d::SceGxmAttributeFormat, count: u8, reg: u16| {
        v2d::SceGxmVertexAttribute {
            streamIndex: 0,
            offset,
            format: format as u8,
            componentCount: count,
            regIndex: reg,
        }
    };
    let s16 = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S16;
    let s16n = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S16N;
    let u8n = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_U8N;
    let f32a = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_F32;

    // The pak stream, read twice with different attributes. `S16` keeps the
    // cooked i16 world positions as integers — the GE needed a x32768 model
    // scale to undo its own normalization, and nothing here does. `S16N`
    // divides the cooked fixed-point UVs by 32767 where the GE divides by
    // 32768: a 0.003% difference, well under a texel on the largest page,
    // and the cook clamps to 32767 so the sign bit is never set.
    let pak_tex_vp = vertex_program(
        patcher,
        texture_v_id,
        &[
            attribute(PAK_POSITION_OFFSET, s16, 3, tex_position),
            attribute(PAK_UV_OFFSET, s16n, 2, tex_texcoord),
        ],
        VERTEX_STRIDE as u16,
    )?;
    let pak_col_vp = vertex_program(
        patcher,
        color_v_id,
        &[
            attribute(PAK_POSITION_OFFSET, s16, 3, col_position),
            attribute(PAK_COLOR_OFFSET, u8n, 4, col_color),
        ],
        VERTEX_STRIDE as u16,
    )?;
    let flat_vp = vertex_program(
        patcher,
        color_v_id,
        &[
            attribute(FLAT_POSITION_OFFSET, f32a, 3, col_position),
            attribute(FLAT_COLOR_OFFSET, u8n, 4, col_color),
        ],
        FLAT_STRIDE,
    )?;
    let tex_vp = vertex_program(
        patcher,
        texture_v_id,
        &[
            attribute(TEX_POSITION_OFFSET, f32a, 3, tex_position),
            attribute(TEX_UV_OFFSET, f32a, 2, tex_texcoord),
        ],
        TEX_STRIDE,
    )?;

    let src_alpha = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_SRC_ALPHA;
    let inv_src_alpha = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
    let one = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE;
    let zero = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO;
    let dst_color = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_DST_COLOR;
    let alpha = blend_info(src_alpha, inv_src_alpha, one, inv_src_alpha);
    // `dst * src` with alpha left alone: the AO pass multiplies the texel
    // already in the framebuffer, which is the GE's Modulate in two steps.
    let multiply = blend_info(dst_color, zero, zero, one);

    let tex_opaque_fp = fragment_program(patcher, texture_f_id, None, texture_v)?;
    let tex_alpha_fp = fragment_program(patcher, texture_f_id, Some(&alpha), texture_v)?;
    let col_multiply_fp = fragment_program(patcher, color_f_id, Some(&multiply), color_v)?;
    let col_opaque_fp = fragment_program(patcher, color_f_id, None, color_v)?;
    let col_alpha_fp = fragment_program(patcher, color_f_id, Some(&alpha), color_v)?;

    Ok(Pipeline {
        patcher,
        ids: [color_v_id, color_f_id, texture_v_id, texture_f_id],
        pak_tex_vp,
        pak_col_vp,
        flat_vp,
        tex_vp,
        tex_opaque_fp,
        tex_alpha_fp,
        col_multiply_fp,
        col_opaque_fp,
        col_alpha_fp,
        tex_wvp,
        col_wvp,
    })
}

/// Initialize (once) and fetch the pipeline. vita2d must be initialized.
///
/// # Safety
/// Render-thread only, after vita2d init.
pub unsafe fn pipeline() -> Result<&'static Pipeline, &'static str> {
    let slot = &mut *PIPELINE.0.get();
    if slot.is_none() {
        *slot = Some(build());
    }
    match slot.as_ref().unwrap() {
        Ok(pipeline) => Ok(pipeline),
        Err(error) => Err(error),
    }
}

// ---------------------------------------------------------------------------
// Per-draw state
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DepthMode {
    /// Depth-tested and depth-written: the GE's default world pass.
    Opaque,
    /// Depth-tested, depth-preserving: shadow decals, and every pass that
    /// resolves alpha by blending rather than by a discard the hardware does
    /// not have.
    TestOnly,
    /// Draws only where something nearer already wrote depth — the GE's
    /// inverted `Less` test, which is how the player ghost shows through
    /// what occludes it.
    Occluded,
    /// Unconditional: the screen-space passes (sky bands, the GB UI layer).
    Overlay,
}

/// Apply one depth configuration.
///
/// # Safety
/// Render-thread only, inside an open vita2d scene.
pub unsafe fn set_depth(mode: DepthMode) {
    let context = v2d::vita2d_get_context();
    let (function, write) = match mode {
        DepthMode::Opaque => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_LESS_EQUAL,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED,
        ),
        DepthMode::TestOnly => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_LESS_EQUAL,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED,
        ),
        DepthMode::Occluded => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_GREATER,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED,
        ),
        DepthMode::Overlay => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED,
        ),
    };
    v2d::sceGxmSetFrontDepthFunc(context, function);
    v2d::sceGxmSetBackDepthFunc(context, function);
    v2d::sceGxmSetFrontDepthWriteEnable(context, write);
    v2d::sceGxmSetBackDepthWriteEnable(context, write);
}

/// Which fragment program a textured draw uses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TexMode {
    /// No blending — the texel lands whatever its alpha says.
    Opaque,
    /// Straight alpha blending: this backend's stand-in for the GE's alpha
    /// test, for the passes whose art is cut out.
    Alpha,
}

impl Pipeline {
    unsafe fn set_wvp(&self, parameter: *const v2d::SceGxmProgramParameter, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        let mut buffer: *mut c_void = ptr::null_mut();
        if v2d::sceGxmReserveVertexDefaultUniformBuffer(context, &mut buffer) < 0 {
            return false;
        }
        v2d::sceGxmSetUniformDataF(buffer, parameter, 0, 16, wvp.as_ptr()) >= 0
    }

    /// Bind the pak stream's textured pass.
    ///
    /// # Safety
    /// Render-thread only, inside an open vita2d scene.
    pub unsafe fn bind_pak_textured(&self, wvp: &[f32; 16], mode: TexMode) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.pak_tex_vp);
        v2d::sceGxmSetFragmentProgram(
            context,
            match mode {
                TexMode::Opaque => self.tex_opaque_fp,
                TexMode::Alpha => self.tex_alpha_fp,
            },
        );
        self.set_wvp(self.tex_wvp, wvp)
    }

    /// Bind the pak stream's AO modulate pass over the same geometry.
    ///
    /// # Safety
    /// Render-thread only, inside an open vita2d scene, after the textured
    /// pass wrote the texels this multiplies.
    pub unsafe fn bind_pak_light(&self, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.pak_col_vp);
        v2d::sceGxmSetFragmentProgram(context, self.col_multiply_fp);
        self.set_wvp(self.col_wvp, wvp)
    }

    /// Bind the CPU-built flat-colour stream.
    ///
    /// # Safety
    /// Render-thread only, inside an open vita2d scene.
    pub unsafe fn bind_flat(&self, wvp: &[f32; 16], blended: bool) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.flat_vp);
        v2d::sceGxmSetFragmentProgram(
            context,
            if blended { self.col_alpha_fp } else { self.col_opaque_fp },
        );
        self.set_wvp(self.col_wvp, wvp)
    }

    /// Bind the CPU-built textured stream (cards, the GB UI layer).
    ///
    /// # Safety
    /// Render-thread only, inside an open vita2d scene.
    pub unsafe fn bind_tex(&self, wvp: &[f32; 16], mode: TexMode) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.tex_vp);
        v2d::sceGxmSetFragmentProgram(
            context,
            match mode {
                TexMode::Opaque => self.tex_opaque_fp,
                TexMode::Alpha => self.tex_alpha_fp,
            },
        );
        self.set_wvp(self.tex_wvp, wvp)
    }

    /// Submit one indexed triangle list.
    ///
    /// # Safety
    /// A program pair must be bound, and both pointers must reference
    /// GXM-mapped memory that stays live until the GPU has consumed the
    /// frame.
    pub unsafe fn draw(&self, vertices: *const c_void, indices: *const u16, count: u32) {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexStream(context, 0, vertices);
        v2d::sceGxmDraw(
            context,
            v2d::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
            v2d::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16,
            indices.cast(),
            count,
        );
    }

    /// # Safety
    /// Render-thread only, with no in-flight work referencing these objects.
    pub unsafe fn destroy(self) {
        for program in [
            self.col_alpha_fp,
            self.col_opaque_fp,
            self.col_multiply_fp,
            self.tex_alpha_fp,
            self.tex_opaque_fp,
        ] {
            v2d::sceGxmShaderPatcherReleaseFragmentProgram(self.patcher, program);
        }
        for program in [self.tex_vp, self.flat_vp, self.pak_col_vp, self.pak_tex_vp] {
            v2d::sceGxmShaderPatcherReleaseVertexProgram(self.patcher, program);
        }
        for id in self.ids.into_iter().rev() {
            v2d::sceGxmShaderPatcherUnregisterProgram(self.patcher, id);
        }
    }
}
