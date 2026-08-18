use alloc::vec::Vec;
use core::ffi::c_void;

use pocketvoxel_core::draw::{self, modulate_rgb, resolve_pal, DrawList, Item, MeshDraw};
use pocketvoxel_core::math::{vec3, Mat4};
use pocketvoxel_core::pak::{unswizzle, Pak};
use pocketvoxel_core::spec::{btn, COLOR_PAL_NONE, TILE_PX, VIEW_H, VIEW_W};

type GLenum = u32;
type GLuint = u32;
type GLint = i32;
type GLsizei = i32;
type GLfloat = f32;
type GLboolean = u8;

const GL_FALSE: GLboolean = 0;
const GL_TRUE: GLboolean = 1;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
const GL_DEPTH_BUFFER_BIT: u32 = 0x0100;
const GL_TRIANGLES: GLenum = 0x0004;
const GL_TRIANGLE_FAN: GLenum = 0x0006;
const GL_FLOAT: GLenum = 0x1406;
const GL_UNSIGNED_BYTE: GLenum = 0x1401;
const GL_UNSIGNED_SHORT: GLenum = 0x1403;
const GL_TEXTURE_2D: GLenum = 0x0de1;
const GL_RGBA: GLenum = 0x1908;
const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;
const GL_TEXTURE_WRAP_S: GLenum = 0x2802;
const GL_TEXTURE_WRAP_T: GLenum = 0x2803;
const GL_NEAREST: GLint = 0x2600;
const GL_LINEAR: GLint = 0x2601;
const GL_CLAMP_TO_EDGE: GLint = 0x812f;
const GL_UNPACK_ALIGNMENT: GLenum = 0x0cf5;
const GL_VERTEX_ARRAY: GLenum = 0x8074;
const GL_COLOR_ARRAY: GLenum = 0x8076;
const GL_TEXTURE_COORD_ARRAY: GLenum = 0x8078;
const GL_PROJECTION: GLenum = 0x1701;
const GL_MODELVIEW: GLenum = 0x1700;
const GL_DEPTH_TEST: GLenum = 0x0b71;
const GL_ALPHA_TEST: GLenum = 0x0bc0;
const GL_BLEND: GLenum = 0x0be2;
const GL_SCISSOR_TEST: GLenum = 0x0c11;
const GL_CULL_FACE: GLenum = 0x0b44;
const GL_LESS: GLenum = 0x0201;
const GL_GREATER: GLenum = 0x0204;
const GL_SRC_ALPHA: GLenum = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA: GLenum = 0x0303;
const GL_FRAMEBUFFER_OES: GLenum = 0x8d40;
const GL_RENDERBUFFER_OES: GLenum = 0x8d41;
const GL_DEPTH_ATTACHMENT_OES: GLenum = 0x8d00;
const GL_DEPTH_COMPONENT16_OES: GLenum = 0x81a5;
const GL_FRAMEBUFFER_COMPLETE_OES: GLenum = 0x8cd5;

const LETTER_A: &[u8; 64 * 64 * 4] = include_bytes!(env!("POCKETVOXEL_LETTER_A"));
const LETTER_B: &[u8; 64 * 64 * 4] = include_bytes!(env!("POCKETVOXEL_LETTER_B"));
const SELECT_LABEL: &[u8; 80 * 24 * 4] = include_bytes!(env!("POCKETVOXEL_SELECT_LABEL"));
const START_LABEL: &[u8; 80 * 24 * 4] = include_bytes!(env!("POCKETVOXEL_START_LABEL"));
const MOTION_CREDIT: &[u8; 96 * 18 * 4] = include_bytes!(env!("POCKETVOXEL_MOTION_CREDIT"));
const DPAD_IDLE: &[u8; 256 * 256 * 4] = include_bytes!(env!("POCKETVOXEL_DPAD_IDLE"));
const DPAD_UP: &[u8; 256 * 256 * 4] = include_bytes!(env!("POCKETVOXEL_DPAD_UP"));
const DPAD_RIGHT: &[u8; 256 * 256 * 4] = include_bytes!(env!("POCKETVOXEL_DPAD_RIGHT"));
const DPAD_DOWN: &[u8; 256 * 256 * 4] = include_bytes!(env!("POCKETVOXEL_DPAD_DOWN"));
const DPAD_LEFT: &[u8; 256 * 256 * 4] = include_bytes!(env!("POCKETVOXEL_DPAD_LEFT"));

unsafe extern "C" {
    fn glAlphaFunc(function: GLenum, reference: GLfloat);
    fn glBindTexture(target: GLenum, texture: GLuint);
    fn glBlendFunc(source: GLenum, destination: GLenum);
    fn glClear(mask: u32);
    fn glClearColor(red: GLfloat, green: GLfloat, blue: GLfloat, alpha: GLfloat);
    fn glClearDepthf(depth: GLfloat);
    fn glColorPointer(size: GLint, kind: GLenum, stride: GLsizei, pointer: *const c_void);
    fn glDeleteTextures(count: GLsizei, textures: *const GLuint);
    fn glDepthFunc(function: GLenum);
    fn glDepthMask(flag: GLboolean);
    fn glDisable(capability: GLenum);
    fn glDisableClientState(array: GLenum);
    fn glDrawArrays(mode: GLenum, first: GLint, count: GLsizei);
    fn glDrawElements(mode: GLenum, count: GLsizei, kind: GLenum, indices: *const c_void);
    fn glEnable(capability: GLenum);
    fn glEnableClientState(array: GLenum);
    fn glGenTextures(count: GLsizei, textures: *mut GLuint);
    fn glLoadIdentity();
    fn glLoadMatrixf(matrix: *const GLfloat);
    fn glMatrixMode(mode: GLenum);
    fn glOrthof(
        left: GLfloat,
        right: GLfloat,
        bottom: GLfloat,
        top: GLfloat,
        near: GLfloat,
        far: GLfloat,
    );
    fn glPixelStorei(parameter: GLenum, value: GLint);
    fn glScissor(x: GLint, y: GLint, width: GLsizei, height: GLsizei);
    fn glTexCoordPointer(size: GLint, kind: GLenum, stride: GLsizei, pointer: *const c_void);
    fn glTexImage2D(
        target: GLenum,
        level: GLint,
        internal: GLint,
        width: GLsizei,
        height: GLsizei,
        border: GLint,
        format: GLenum,
        kind: GLenum,
        pixels: *const c_void,
    );
    fn glTexParameteri(target: GLenum, parameter: GLenum, value: GLint);
    fn glVertexPointer(size: GLint, kind: GLenum, stride: GLsizei, pointer: *const c_void);
    fn glViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei);

    fn glGenRenderbuffersOES(count: GLsizei, names: *mut GLuint);
    fn glBindRenderbufferOES(target: GLenum, name: GLuint);
    fn glRenderbufferStorageOES(target: GLenum, format: GLenum, width: GLsizei, height: GLsizei);
    fn glFramebufferRenderbufferOES(
        target: GLenum,
        attachment: GLenum,
        renderbuffer_target: GLenum,
        renderbuffer: GLuint,
    );
    fn glCheckFramebufferStatusOES(target: GLenum) -> GLenum;
    fn glDeleteRenderbuffersOES(count: GLsizei, names: *const GLuint);
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Vertex {
    u: f32,
    v: f32,
    rgba: [u8; 4],
    x: f32,
    y: f32,
    z: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct FlatVertex {
    rgba: [u8; 4],
    x: f32,
    y: f32,
    z: f32,
}

struct Texture {
    page: u16,
    frame: u16,
    palette: u16,
    tint: u32,
    raw: bool,
    name: GLuint,
    u_scale: f32,
    v_scale: f32,
}

pub struct Renderer {
    textures: Vec<Texture>,
    vertices: Vec<Vertex>,
    indices: Vec<u16>,
    flat: Vec<FlatVertex>,
    last_tint: u32,
    depth: GLuint,
    controls: [GLuint; 10],
}

impl Renderer {
    pub fn new() -> Self {
        Self {
            textures: Vec::new(),
            vertices: Vec::new(),
            indices: Vec::new(),
            flat: Vec::new(),
            last_tint: 0xffff_ffff,
            depth: 0,
            controls: [0; 10],
        }
    }

    pub unsafe fn initialize(&mut self, width: i32, height: i32) -> i32 {
        if width != 640 || height != 960 {
            return 0;
        }
        glGenRenderbuffersOES(1, &mut self.depth);
        if self.depth == 0 {
            return 0;
        }
        glBindRenderbufferOES(GL_RENDERBUFFER_OES, self.depth);
        glRenderbufferStorageOES(GL_RENDERBUFFER_OES, GL_DEPTH_COMPONENT16_OES, width, height);
        glFramebufferRenderbufferOES(
            GL_FRAMEBUFFER_OES,
            GL_DEPTH_ATTACHMENT_OES,
            GL_RENDERBUFFER_OES,
            self.depth,
        );
        if glCheckFramebufferStatusOES(GL_FRAMEBUFFER_OES) != GL_FRAMEBUFFER_COMPLETE_OES {
            glDeleteRenderbuffersOES(1, &self.depth);
            self.depth = 0;
            return 0;
        }
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        for (index, (pixels, texture_width, texture_height)) in [
            (LETTER_A.as_slice(), 64, 64),
            (LETTER_B.as_slice(), 64, 64),
            (SELECT_LABEL.as_slice(), 80, 24),
            (START_LABEL.as_slice(), 80, 24),
            (MOTION_CREDIT.as_slice(), 96, 18),
            (DPAD_IDLE.as_slice(), 256, 256),
            (DPAD_UP.as_slice(), 256, 256),
            (DPAD_RIGHT.as_slice(), 256, 256),
            (DPAD_DOWN.as_slice(), 256, 256),
            (DPAD_LEFT.as_slice(), 256, 256),
        ]
        .into_iter()
        .enumerate()
        {
            self.controls[index] = Self::upload_control(pixels, texture_width, texture_height);
            if self.controls[index] == 0 {
                self.shutdown();
                return 0;
            }
        }
        1
    }

    pub unsafe fn shutdown(&mut self) {
        for texture in self.textures.drain(..) {
            glDeleteTextures(1, &texture.name);
        }
        for texture in &mut self.controls {
            if *texture != 0 {
                glDeleteTextures(1, texture);
                *texture = 0;
            }
        }
        if self.depth != 0 {
            glDeleteRenderbuffersOES(1, &self.depth);
            self.depth = 0;
        }
    }

    pub unsafe fn render(
        &mut self,
        list: &DrawList,
        pak: &Pak<'_>,
        width: i32,
        height: i32,
        buttons: u32,
    ) -> i32 {
        if self.depth == 0 || width != 640 || height != 960 {
            return 0;
        }
        if self.last_tint != list.tint {
            let mut retained = Vec::with_capacity(self.textures.len());
            for texture in self.textures.drain(..) {
                if texture.raw {
                    retained.push(texture);
                } else {
                    glDeleteTextures(1, &texture.name);
                }
            }
            self.textures = retained;
            self.last_tint = list.tint;
        }

        glViewport(0, 0, width, height);
        glDisable(GL_SCISSOR_TEST);
        glDisable(GL_TEXTURE_2D);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_ALPHA_TEST);
        glDisable(GL_BLEND);
        glDisable(GL_CULL_FACE);
        glDepthMask(GL_TRUE);
        glClearColor(0.025, 0.035, 0.055, 1.0);
        glClearDepthf(1.0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        let game_h = 362;
        let game_y = 539;
        glViewport(0, game_y, width, game_h);
        glScissor(0, game_y, width, game_h);
        glEnable(GL_SCISSOR_TEST);
        glClearColor(0.0, 0.0, 0.0, 1.0);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        for item in &list.items {
            match item {
                Item::SkyBands {
                    colors,
                    horizon_row,
                } => self.sky(*colors, *horizon_row),
                Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                    self.mesh(list, pak, mesh);
                }
                Item::ShadowDecal { corners, abgr } => {
                    self.flat_quad(list, *corners, *abgr, GL_LESS, true)
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
                        list,
                        pak,
                        *verts,
                        *page,
                        *uv,
                        *mirror,
                        *pull,
                        Some(*abgr),
                        GL_GREATER,
                        true,
                    );
                }
                Item::Card {
                    verts,
                    page,
                    uv,
                    mirror,
                    pull,
                } => {
                    self.card(
                        list, pak, *verts, *page, *uv, *mirror, *pull, None, GL_LESS, false,
                    );
                }
                _ => {}
            }
        }
        self.ui(list, pak);
        self.overlay(list);

        glDisable(GL_SCISSOR_TEST);
        self.controls(width, height, buttons);
        glDisableClientState(GL_TEXTURE_COORD_ARRAY);
        glDisableClientState(GL_COLOR_ARRAY);
        glDisableClientState(GL_VERTEX_ARRAY);
        glDisable(GL_TEXTURE_2D);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_ALPHA_TEST);
        glDisable(GL_BLEND);
        1
    }

    unsafe fn set_projection(matrix: &Mat4) {
        glMatrixMode(GL_PROJECTION);
        glLoadMatrixf(matrix.m.as_ptr());
        glMatrixMode(GL_MODELVIEW);
        glLoadIdentity();
    }

    unsafe fn ortho(width: f32, height: f32) {
        glMatrixMode(GL_PROJECTION);
        glLoadIdentity();
        glOrthof(0.0, width, height, 0.0, -1.0, 1.0);
        glMatrixMode(GL_MODELVIEW);
        glLoadIdentity();
    }

    unsafe fn sky(&mut self, colors: [u32; 4], horizon: i32) {
        Self::ortho(VIEW_W as f32, VIEW_H as f32);
        glDisable(GL_TEXTURE_2D);
        glDisable(GL_DEPTH_TEST);
        glDepthMask(GL_FALSE);
        let horizon = horizon.clamp(0, VIEW_H) as f32;
        for (index, color) in colors.into_iter().enumerate() {
            let y0 = horizon * index as f32 / 4.0;
            let y1 = if index == 3 {
                VIEW_H as f32
            } else {
                horizon * (index + 1) as f32 / 4.0
            };
            self.color_rect(0.0, y0, VIEW_W as f32, y1 - y0, color);
        }
        glDepthMask(GL_TRUE);
    }

    unsafe fn mesh(&mut self, list: &DrawList, pak: &Pak<'_>, mesh: &MeshDraw) {
        let Some(page) = pak.atlases.get(mesh.page as usize) else {
            return;
        };
        let palette = resolve_pal(pak, mesh.page, page.kind, mesh.pal, list.palette) as u16;
        let (texture, us, vs) = self.texture(pak, mesh.page, mesh.frame, palette, list.tint, false);
        if texture == 0 {
            return;
        }
        self.vertices.clear();
        self.indices.clear();
        let eye = list.cam.eye;
        let base = mesh.vert_base as usize;
        for source in &pak.verts[base..base + mesh.vert_count as usize] {
            let mut position = vec3(
                source.x as f32 + mesh.off_x as f32,
                source.y as f32,
                source.z as f32 + mesh.off_y as f32,
            );
            if mesh.pull != 0.0 {
                position = position.add(eye.sub(position).normalize().scale(mesh.pull));
            }
            self.vertices.push(Vertex {
                u: source.uf() * us,
                v: source.vf() * vs,
                rgba: source.abgr.to_le_bytes(),
                x: position.x,
                y: position.y,
                z: position.z,
            });
        }
        let first = mesh.index_base as usize;
        self.indices
            .extend_from_slice(&pak.indices[first..first + mesh.index_count as usize]);
        let projection = if mesh.pull_bias != 0.0 {
            draw::biased_vp(&list.cam.vp, mesh.pull_bias)
        } else {
            list.cam.vp
        };
        Self::set_projection(&projection);
        self.draw_textured(texture, GL_LESS, true, false);
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn card(
        &mut self,
        list: &DrawList,
        pak: &Pak<'_>,
        corners: [[f32; 3]; 4],
        page_index: u16,
        uv: [f32; 4],
        mirror: bool,
        pull: f32,
        solid: Option<u32>,
        depth: GLenum,
        blend: bool,
    ) {
        let Some(page) = pak.atlases.get(page_index as usize) else {
            return;
        };
        let palette = resolve_pal(pak, page_index, page.kind, COLOR_PAL_NONE, list.palette) as u16;
        let (texture, us, vs) = self.texture(pak, page_index, 0, palette, list.tint, false);
        if texture == 0 {
            return;
        }
        let (u0, u1) = if mirror {
            (uv[2], uv[0])
        } else {
            (uv[0], uv[2])
        };
        let texcoords = [(u0, uv[3]), (u1, uv[3]), (u1, uv[1]), (u0, uv[1])];
        self.vertices.clear();
        self.indices.clear();
        for index in 0..4 {
            let mut position = vec3(corners[index][0], corners[index][1], corners[index][2]);
            if pull != 0.0 {
                position = position.add(list.cam.eye.sub(position).normalize().scale(pull));
            }
            self.vertices.push(Vertex {
                u: texcoords[index].0 * us,
                v: texcoords[index].1 * vs,
                rgba: solid.unwrap_or(0xffff_ffff).to_le_bytes(),
                x: position.x,
                y: position.y,
                z: position.z,
            });
        }
        self.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        Self::set_projection(&list.cam.vp);
        self.draw_textured(texture, depth, solid.is_none(), blend);
    }

    unsafe fn flat_quad(
        &mut self,
        list: &DrawList,
        corners: [[f32; 3]; 4],
        color: u32,
        depth: GLenum,
        blend: bool,
    ) {
        self.flat.clear();
        let rgba = color.to_le_bytes();
        for corner in corners {
            self.flat.push(FlatVertex {
                rgba,
                x: corner[0],
                y: corner[1],
                z: corner[2],
            });
        }
        Self::set_projection(&list.cam.vp);
        glDisable(GL_TEXTURE_2D);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(depth);
        glDepthMask(GL_FALSE);
        if blend {
            glEnable(GL_BLEND);
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        }
        self.bind_flat();
        let indices = [0u16, 1, 2, 0, 2, 3];
        glDrawElements(GL_TRIANGLES, 6, GL_UNSIGNED_SHORT, indices.as_ptr().cast());
        glDisable(GL_BLEND);
        glDepthMask(GL_TRUE);
    }

    unsafe fn ui(&mut self, list: &DrawList, pak: &Pak<'_>) {
        Self::ortho(VIEW_W as f32, VIEW_H as f32);
        glDisable(GL_DEPTH_TEST);
        glDepthMask(GL_FALSE);
        for item in &list.items {
            let Item::UiQuad {
                x,
                y,
                w,
                h,
                page: page_index,
                tile,
            } = item
            else {
                continue;
            };
            let Some(page) = pak.atlases.get(*page_index as usize) else {
                continue;
            };
            let palette = page.kind;
            let (texture, us, vs) = self.texture(pak, *page_index, 0, palette, 0xffff_ffff, true);
            let columns = (page.w as i32 / TILE_PX).max(1);
            let tx = *tile as i32 % columns;
            let ty = *tile as i32 / columns;
            let u0 = tx as f32 * TILE_PX as f32 / page.w as f32 * us;
            let v0 = ty as f32 * TILE_PX as f32 / page.h as f32 * vs;
            let u1 = (tx + 1) as f32 * TILE_PX as f32 / page.w as f32 * us;
            let v1 = (ty + 1) as f32 * TILE_PX as f32 / page.h as f32 * vs;
            self.screen_quad(*x, *y, *w, *h, texture, [u0, v0, u1, v1], 0xffff_ffff);
        }
        glDepthMask(GL_TRUE);
    }

    unsafe fn overlay(&mut self, list: &DrawList) {
        Self::ortho(VIEW_W as f32, VIEW_H as f32);
        glDisable(GL_TEXTURE_2D);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        for item in &list.items {
            match item {
                Item::OverlayRect { x, y, w, h, abgr } => {
                    self.color_rect(*x as f32, *y as f32, *w as f32, *h as f32, *abgr)
                }
                Item::VideoQuad { x, y, w, h } => {
                    self.color_rect(*x as f32, *y as f32, *w as f32, *h as f32, 0xff18_161c)
                }
                _ => {}
            }
        }
        glDisable(GL_BLEND);
    }

    unsafe fn draw_textured(
        &mut self,
        texture: GLuint,
        depth: GLenum,
        write_depth: bool,
        blend: bool,
    ) {
        glEnable(GL_TEXTURE_2D);
        glBindTexture(GL_TEXTURE_2D, texture);
        glEnable(GL_ALPHA_TEST);
        glAlphaFunc(GL_GREATER, 0.5);
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(depth);
        glDepthMask(if write_depth { GL_TRUE } else { GL_FALSE });
        if blend {
            glEnable(GL_BLEND);
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        }
        self.bind_textured();
        glDrawElements(
            GL_TRIANGLES,
            self.indices.len() as i32,
            GL_UNSIGNED_SHORT,
            self.indices.as_ptr().cast(),
        );
        glDisable(GL_BLEND);
        glDisable(GL_ALPHA_TEST);
        glDepthMask(GL_TRUE);
    }

    unsafe fn bind_textured(&self) {
        let stride = core::mem::size_of::<Vertex>() as i32;
        let base = self.vertices.as_ptr() as *const u8;
        glEnableClientState(GL_TEXTURE_COORD_ARRAY);
        glEnableClientState(GL_COLOR_ARRAY);
        glEnableClientState(GL_VERTEX_ARRAY);
        glTexCoordPointer(2, GL_FLOAT, stride, base.cast());
        glColorPointer(4, GL_UNSIGNED_BYTE, stride, base.add(8).cast());
        glVertexPointer(3, GL_FLOAT, stride, base.add(12).cast());
    }

    unsafe fn bind_flat(&self) {
        let stride = core::mem::size_of::<FlatVertex>() as i32;
        let base = self.flat.as_ptr() as *const u8;
        glDisableClientState(GL_TEXTURE_COORD_ARRAY);
        glEnableClientState(GL_COLOR_ARRAY);
        glEnableClientState(GL_VERTEX_ARRAY);
        glColorPointer(4, GL_UNSIGNED_BYTE, stride, base.cast());
        glVertexPointer(3, GL_FLOAT, stride, base.add(4).cast());
    }

    unsafe fn screen_quad(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        texture: GLuint,
        uv: [f32; 4],
        color: u32,
    ) {
        self.vertices.clear();
        self.indices.clear();
        let rgba = color.to_le_bytes();
        for (px, py, u, v) in [
            (x, y + h, uv[0], uv[3]),
            (x + w, y + h, uv[2], uv[3]),
            (x + w, y, uv[2], uv[1]),
            (x, y, uv[0], uv[1]),
        ] {
            self.vertices.push(Vertex {
                u,
                v,
                rgba,
                x: px,
                y: py,
                z: 0.0,
            });
        }
        self.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        glEnable(GL_TEXTURE_2D);
        glBindTexture(GL_TEXTURE_2D, texture);
        glEnable(GL_ALPHA_TEST);
        glAlphaFunc(GL_GREATER, 0.5);
        self.bind_textured();
        glDrawElements(
            GL_TRIANGLES,
            6,
            GL_UNSIGNED_SHORT,
            self.indices.as_ptr().cast(),
        );
        glDisable(GL_ALPHA_TEST);
    }

    unsafe fn color_rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: u32) {
        self.flat.clear();
        let rgba = color.to_le_bytes();
        for (px, py) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
            self.flat.push(FlatVertex {
                rgba,
                x: px,
                y: py,
                z: 0.0,
            });
        }
        self.bind_flat();
        glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
    }

    unsafe fn texture(
        &mut self,
        pak: &Pak<'_>,
        page: u16,
        frame: u16,
        palette: u16,
        tint: u32,
        raw: bool,
    ) -> (GLuint, f32, f32) {
        if let Some(found) = self.textures.iter().find(|entry| {
            entry.page == page
                && entry.frame == frame
                && entry.palette == palette
                && entry.tint == tint
                && entry.raw == raw
        }) {
            return (found.name, found.u_scale, found.v_scale);
        }
        let Some(source) = pak.atlases.get(page as usize) else {
            return (0, 1.0, 1.0);
        };
        let Some(colors) = pak.palettes.get(palette as usize) else {
            return (0, 1.0, 1.0);
        };
        let width = source.w as usize;
        let height = source.h as usize;
        let texture_width = width.next_power_of_two();
        let texture_height = height.next_power_of_two();
        let Ok(indices) = unswizzle(width, height, source.frame(frame)) else {
            return (0, 1.0, 1.0);
        };
        let mut rgba = alloc::vec![0u32; texture_width * texture_height];
        for y in 0..height {
            for x in 0..width {
                let color = colors[indices[y * width + x] as usize];
                rgba[y * texture_width + x] = if raw {
                    color
                } else {
                    modulate_rgb(color, tint)
                };
            }
        }
        let mut name = 0;
        glGenTextures(1, &mut name);
        if name == 0 {
            return (0, 1.0, 1.0);
        }
        glBindTexture(GL_TEXTURE_2D, name);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA as i32,
            texture_width as i32,
            texture_height as i32,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            rgba.as_ptr().cast(),
        );
        let entry = Texture {
            page,
            frame,
            palette,
            tint,
            raw,
            name,
            u_scale: width as f32 / texture_width as f32,
            v_scale: height as f32 / texture_height as f32,
        };
        let result = (entry.name, entry.u_scale, entry.v_scale);
        self.textures.push(entry);
        result
    }

    unsafe fn controls(&mut self, width: i32, height: i32, buttons: u32) {
        glViewport(0, 0, width, height);
        Self::ortho(width as f32, height as f32);
        glDisable(GL_TEXTURE_2D);
        glDisable(GL_DEPTH_TEST);
        glDepthMask(GL_FALSE);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

        self.color_rect(0.0, 480.0, width as f32, 480.0, 0xff18_1217);
        self.color_rect(0.0, 478.0, width as f32, 2.0, 0xff42_263c);

        self.dpad(buttons);

        self.face_button(
            0,
            520.0,
            660.0,
            66.0,
            buttons & btn::A != 0,
            0xffd8_55dc,
            0xfff0_78ee,
        );
        self.face_button(
            1,
            405.0,
            770.0,
            62.0,
            buttons & btn::B != 0,
            0xff70_50df,
            0xff90_70ff,
        );

        let active = 0xff86_73ff;
        self.color_rect(
            196.0,
            896.0,
            92.0,
            36.0,
            if buttons & btn::SELECT != 0 {
                active
            } else {
                0xff50_4651
            },
        );
        self.control_quad(202.0, 902.0, 80.0, 24.0, self.controls[2]);
        self.color_rect(
            338.0,
            896.0,
            92.0,
            36.0,
            if buttons & btn::START != 0 {
                active
            } else {
                0xff50_4651
            },
        );
        self.control_quad(344.0, 902.0, 80.0, 24.0, self.controls[3]);
        self.control_quad(536.0, 940.0, 96.0, 18.0, self.controls[4]);
        glDisable(GL_BLEND);
        glDepthMask(GL_TRUE);
    }

    unsafe fn upload_control(pixels: &[u8], width: i32, height: i32) -> GLuint {
        let mut name = 0;
        glGenTextures(1, &mut name);
        if name == 0 {
            return 0;
        }
        glBindTexture(GL_TEXTURE_2D, name);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA as i32,
            width,
            height,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            pixels.as_ptr().cast(),
        );
        name
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn face_button(
        &mut self,
        texture_index: usize,
        cx: f32,
        cy: f32,
        radius: f32,
        pressed: bool,
        cap: u32,
        active: u32,
    ) {
        let offset = if pressed { 9.0 } else { 0.0 };
        self.disc(cx, cy + 13.0, radius + 4.0, 0xff24_1729);
        self.disc(cx, cy + 8.0, radius + 2.0, 0xff65_3c72);
        self.disc(cx, cy + offset, radius, if pressed { active } else { cap });
        self.disc(cx - 8.0, cy - 8.0 + offset, radius - 10.0, 0x20ff_ffff);
        self.control_quad(
            cx - 32.0,
            cy - 32.0 + offset,
            64.0,
            64.0,
            self.controls[texture_index],
        );
    }

    unsafe fn dpad(&mut self, buttons: u32) {
        let texture = if buttons & btn::UP != 0 {
            self.controls[6]
        } else if buttons & btn::RIGHT != 0 {
            self.controls[7]
        } else if buttons & btn::DOWN != 0 {
            self.controls[8]
        } else if buttons & btn::LEFT != 0 {
            self.controls[9]
        } else {
            self.controls[5]
        };
        self.control_quad(12.0, 582.0, 276.0, 276.0, texture);
    }

    unsafe fn control_quad(&mut self, x: f32, y: f32, width: f32, height: f32, texture: GLuint) {
        self.vertices.clear();
        self.indices.clear();
        for (px, py, u, v) in [
            (x, y + height, 0.0, 1.0),
            (x + width, y + height, 1.0, 1.0),
            (x + width, y, 1.0, 0.0),
            (x, y, 0.0, 0.0),
        ] {
            self.vertices.push(Vertex {
                u,
                v,
                rgba: [255; 4],
                x: px,
                y: py,
                z: 0.0,
            });
        }
        self.indices.extend_from_slice(&[0, 1, 2, 0, 2, 3]);
        glEnable(GL_TEXTURE_2D);
        glBindTexture(GL_TEXTURE_2D, texture);
        self.bind_textured();
        glDrawElements(
            GL_TRIANGLES,
            6,
            GL_UNSIGNED_SHORT,
            self.indices.as_ptr().cast(),
        );
        glDisable(GL_TEXTURE_2D);
    }

    unsafe fn disc(&mut self, cx: f32, cy: f32, radius: f32, color: u32) {
        self.flat.clear();
        let rgba = color.to_le_bytes();
        self.flat.push(FlatVertex {
            rgba,
            x: cx,
            y: cy,
            z: 0.0,
        });
        for index in 0..=32 {
            let angle = index as f32 * core::f32::consts::TAU / 32.0;
            self.flat.push(FlatVertex {
                rgba,
                x: cx + libm::cosf(angle) * radius,
                y: cy + libm::sinf(angle) * radius,
                z: 0.0,
            });
        }
        self.bind_flat();
        glDrawArrays(GL_TRIANGLE_FAN, 0, self.flat.len() as i32);
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe { self.shutdown() }
    }
}
