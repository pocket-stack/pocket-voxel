//! The software rasterizer: consumes the core's [`DrawList`] exactly as the
//! GE backend will — same draw order, same pull displacement, same alpha
//! test, same depth conventions — into a 480x272 RGBA frame whose bytes are
//! the committed golden hashes. Correctness over speed, but O(pixels):
//! perspective-correct texturing, f32 depth, integer color math so every
//! host rounds identically.
//!
//! Depth convention: NDC z (GL -1..1), **less** wins, cleared to +inf. The
//! ghost pass inverts the test (greater, no write) so the silhouette draws
//! only where the card is occluded — the sceGu backend expresses the same
//! two passes with its inverted 16-bit depth range; the *visible result* is
//! the contract, not the depth encoding.

use pocketvoxel_core::draw::{DrawList, Item, MeshDraw, biased_vp, modulate_rgb, resolve_pal};
use pocketvoxel_core::math::{Mat4, Vec3, vec3};
use pocketvoxel_core::pak::{AtlasPage, Pak, unswizzle};
use pocketvoxel_core::spec::{COLOR_PAL_NONE, TILE_PX, VIEW_H, VIEW_W};

pub const W: usize = VIEW_W as usize;
pub const H: usize = VIEW_H as usize;

/// One rendered frame. `color` is ABGR u32 — its little-endian bytes are
/// exactly the RGBA stream that gets hashed and written to PNG.
pub struct Frame {
    pub color: Vec<u32>,
    pub depth: Vec<f32>,
}

impl Frame {
    pub fn new() -> Self {
        Self {
            color: vec![0xff00_0000; W * H],
            depth: vec![f32::INFINITY; W * H],
        }
    }

    pub fn rgba_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(W * H * 4);
        for c in &self.color {
            out.extend_from_slice(&c.to_le_bytes());
        }
        out
    }
}

impl Default for Frame {
    fn default() -> Self {
        Self::new()
    }
}

/// Atlas pages linearized once at load (the pak stores them pre-swizzled
/// for the GE; the sim samples linear).
pub struct CachedPage {
    pub w: usize,
    pub h: usize,
    pub kind: u16,
    pub frames: Vec<Vec<u8>>,
}

pub struct AtlasCache {
    pub pages: Vec<CachedPage>,
}

impl AtlasCache {
    pub fn new(pak: &Pak) -> Self {
        let linearize = |p: &AtlasPage| CachedPage {
            w: p.w as usize,
            h: p.h as usize,
            kind: p.kind,
            frames: (0..p.frames)
                .map(|f| {
                    unswizzle(p.w as usize, p.h as usize, p.frame(f))
                        .expect("pak-validated frame length")
                })
                .collect(),
        };
        Self {
            pages: pak.atlases.iter().map(linearize).collect(),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum DepthMode {
    /// Normal 3D: draw nearer, write depth.
    LessWrite,
    /// Decals: test but never write (cards drawn later must win).
    LessNoWrite,
    /// The ghost pass: draw only where occluded, never write.
    /// (UI quads bypass the triangle path entirely — no depth at all.)
    GreaterNoWrite,
}

/// Clip-space vertex with its interpolants (rgba in 0..255).
#[derive(Clone, Copy)]
struct PV {
    clip: [f32; 4],
    u: f32,
    v: f32,
    rgba: [f32; 4],
}

fn lerp_pv(a: &PV, b: &PV, t: f32) -> PV {
    let l = |x: f32, y: f32| x + (y - x) * t;
    PV {
        clip: [
            l(a.clip[0], b.clip[0]),
            l(a.clip[1], b.clip[1]),
            l(a.clip[2], b.clip[2]),
            l(a.clip[3], b.clip[3]),
        ],
        u: l(a.u, b.u),
        v: l(a.v, b.v),
        rgba: [
            l(a.rgba[0], b.rgba[0]),
            l(a.rgba[1], b.rgba[1]),
            l(a.rgba[2], b.rgba[2]),
            l(a.rgba[3], b.rgba[3]),
        ],
    }
}

/// Clip a polygon against the near plane (`z + w > 0`) in homogeneous space.
fn clip_near(poly: &[PV]) -> Vec<PV> {
    const EPS: f32 = 1e-5;
    let mut out = Vec::with_capacity(poly.len() + 1);
    for i in 0..poly.len() {
        let a = &poly[i];
        let b = &poly[(i + 1) % poly.len()];
        let da = a.clip[2] + a.clip[3];
        let db = b.clip[2] + b.clip[3];
        if da > EPS {
            out.push(*a);
        }
        if (da > EPS) != (db > EPS) {
            let t = (da - EPS) / (da - db);
            out.push(lerp_pv(a, b, t));
        }
    }
    out
}

/// Screen-space vertex: position, NDC z, and 1/w-premultiplied attributes.
#[derive(Clone, Copy)]
struct SV {
    x: f32,
    y: f32,
    z: f32,
    iw: f32,
    u: f32,
    v: f32,
    rgba: [f32; 4],
}

fn project(p: &PV) -> Option<SV> {
    let w = p.clip[3];
    if w <= 0.0 {
        return None; // defensive: near clip leaves w > 0 for real cameras
    }
    let iw = 1.0 / w;
    Some(SV {
        x: (p.clip[0] * iw * 0.5 + 0.5) * W as f32,
        y: (1.0 - (p.clip[1] * iw * 0.5 + 0.5)) * H as f32,
        z: p.clip[2] * iw,
        iw,
        u: p.u * iw,
        v: p.v * iw,
        rgba: [
            p.rgba[0] * iw,
            p.rgba[1] * iw,
            p.rgba[2] * iw,
            p.rgba[3] * iw,
        ],
    })
}

struct TexCtx<'a> {
    texels: &'a [u8],
    w: usize,
    h: usize,
    pal: &'a [u32; 256],
}

impl TexCtx<'_> {
    /// Nearest-neighbour sample with repeat wrap; `None` = alpha-tested out
    /// (palette alpha < 0x80, the GE `sceGuAlphaFunc` cutoff).
    fn sample(&self, u: f32, v: f32) -> Option<u32> {
        let tx = (u * self.w as f32).floor() as i64;
        let ty = (v * self.h as f32).floor() as i64;
        let tx = tx.rem_euclid(self.w as i64) as usize;
        let ty = ty.rem_euclid(self.h as i64) as usize;
        let c = self.pal[self.texels[ty * self.w + tx] as usize];
        if (c >> 24) & 0xff < 0x80 {
            None
        } else {
            Some(c)
        }
    }
}

/// GE-style modulate: (texel * vertex + 127) / 255 per channel.
fn modulate(t: u32, v: [u32; 4]) -> [u32; 4] {
    [
        ((t & 0xff) * v[0] + 127) / 255,
        (((t >> 8) & 0xff) * v[1] + 127) / 255,
        (((t >> 16) & 0xff) * v[2] + 127) / 255,
        (((t >> 24) & 0xff) * v[3] + 127) / 255,
    ]
}

fn blend_over(dst: u32, rgb: [u32; 3], a: u32) -> u32 {
    let ch = |d: u32, s: u32| (s * a + d * (255 - a) + 127) / 255;
    let r = ch(dst & 0xff, rgb[0]);
    let g = ch((dst >> 8) & 0xff, rgb[1]);
    let b = ch((dst >> 16) & 0xff, rgb[2]);
    0xff00_0000 | (b << 16) | (g << 8) | r
}

fn draw_clip_tri(
    frame: &mut Frame,
    tri: [PV; 3],
    tex: Option<&TexCtx>,
    depth: DepthMode,
    blend: bool,
) {
    let poly = clip_near(&tri);
    if poly.len() < 3 {
        return;
    }
    let Some(first) = project(&poly[0]) else {
        return;
    };
    for i in 1..poly.len() - 1 {
        let (Some(b), Some(c)) = (project(&poly[i]), project(&poly[i + 1])) else {
            continue;
        };
        raster_tri(frame, [first, b, c], tex, depth, blend);
    }
}

fn raster_tri(frame: &mut Frame, v: [SV; 3], tex: Option<&TexCtx>, depth: DepthMode, blend: bool) {
    let edge =
        |a: &SV, b: &SV, px: f32, py: f32| (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    let area = edge(&v[0], &v[1], v[2].x, v[2].y);
    if area.abs() < 1e-9 {
        return;
    }
    let inv_area = 1.0 / area;

    let min_x = v
        .iter()
        .map(|p| p.x)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as usize;
    let max_x = (v
        .iter()
        .map(|p| p.x)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil() as usize)
        .min(W);
    let min_y = v
        .iter()
        .map(|p| p.y)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as usize;
    let max_y = (v
        .iter()
        .map(|p| p.y)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil() as usize)
        .min(H);

    for py in min_y..max_y {
        let cy = py as f32 + 0.5;
        for px in min_x..max_x {
            let cx = px as f32 + 0.5;
            // Barycentric weights toward v0, v1, v2 (double-sided: divide by
            // the signed area, then require all weights >= 0).
            let w0 = edge(&v[1], &v[2], cx, cy) * inv_area;
            let w1 = edge(&v[2], &v[0], cx, cy) * inv_area;
            let w2 = edge(&v[0], &v[1], cx, cy) * inv_area;
            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                continue;
            }
            let idx = py * W + px;
            let z = w0 * v[0].z + w1 * v[1].z + w2 * v[2].z;
            let pass = match depth {
                DepthMode::LessWrite | DepthMode::LessNoWrite => z < frame.depth[idx],
                DepthMode::GreaterNoWrite => z > frame.depth[idx],
            };
            if !pass {
                continue;
            }
            let iw = w0 * v[0].iw + w1 * v[1].iw + w2 * v[2].iw;
            if iw <= 0.0 {
                continue;
            }
            let pc = 1.0 / iw;
            let at = |f: fn(&SV) -> f32| (w0 * f(&v[0]) + w1 * f(&v[1]) + w2 * f(&v[2])) * pc;
            let vr = |i: usize| {
                let c = (w0 * v[0].rgba[i] + w1 * v[1].rgba[i] + w2 * v[2].rgba[i]) * pc;
                (c + 0.5).clamp(0.0, 255.0) as u32
            };
            let vert = [vr(0), vr(1), vr(2), vr(3)];
            let (rgb, alpha) = match tex {
                Some(t) => {
                    let Some(texel) = t.sample(at(|s| s.u), at(|s| s.v)) else {
                        continue; // alpha-tested: no color, no depth
                    };
                    let m = modulate(texel, vert);
                    ([m[0], m[1], m[2]], m[3])
                }
                None => ([vert[0], vert[1], vert[2]], vert[3]),
            };
            frame.color[idx] = if blend {
                blend_over(frame.color[idx], rgb, alpha)
            } else {
                0xff00_0000 | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]
            };
            if depth == DepthMode::LessWrite {
                frame.depth[idx] = z;
            }
        }
    }
}

fn abgr_to_rgba_f(c: u32) -> [f32; 4] {
    [
        (c & 0xff) as f32,
        ((c >> 8) & 0xff) as f32,
        ((c >> 16) & 0xff) as f32,
        ((c >> 24) & 0xff) as f32,
    ]
}

/// World-space vertex → clip-space [`PV`], applying the camera-ward pull
/// along the vertex's own eye ray first (the mod's depth bias).
fn to_clip(vp: &Mat4, eye: Vec3, pos: Vec3, pull: f32, u: f32, v: f32, rgba: [f32; 4]) -> PV {
    to_clip_opts(vp, eye, pos, pull, u, v, rgba, false)
}

/// `i16_trunc` models the GE backend's re-staging of textured displaced
/// vertices through the pak's i16 vertex format (textured f32 vertices draw
/// garbage on real hardware): positions truncate toward zero exactly like
/// Rust's `as i16`, so both backends shade identical pixels. Untextured
/// passes (ghost, shadows) stay f32 on the GE and here.
#[allow(clippy::too_many_arguments)]
fn to_clip_opts(
    vp: &Mat4,
    eye: Vec3,
    pos: Vec3,
    pull: f32,
    u: f32,
    v: f32,
    rgba: [f32; 4],
    i16_trunc: bool,
) -> PV {
    let pos = if pull != 0.0 {
        let p = pos.add(eye.sub(pos).normalize().scale(pull));
        if i16_trunc {
            vec3(p.x.trunc(), p.y.trunc(), p.z.trunc())
        } else {
            p
        }
    } else {
        pos
    };
    let clip = vp.transform(pos, 1.0);
    PV {
        clip: [clip.x, clip.y, clip.z, clip.w],
        u,
        v,
        rgba,
    }
}

fn quad_tris<F: FnMut([PV; 3])>(quad: [PV; 4], mut emit: F) {
    emit([quad[0], quad[1], quad[2]]);
    emit([quad[0], quad[2], quad[3]]);
}

/// Rasterize one draw list against the pak's palettes and cached atlases.
pub fn render(list: &DrawList, pak: &Pak, cache: &AtlasCache) -> Frame {
    let mut frame = Frame::new();
    // Day tint = CLUT rewrite: 3D passes sample tinted palettes; the GB UI
    // layer composites verbatim.
    let tinted: Vec<[u32; 256]> = pak
        .palettes
        .iter()
        .map(|p| {
            let mut out = *p;
            for c in &mut out {
                *c = modulate_rgb(*c, list.tint);
            }
            out
        })
        .collect();
    let vp = &list.cam.vp;
    let eye = list.cam.eye;

    // Which VPAL entry a draw samples: the core's own precedence ladder
    // (draw::resolve_pal — the VCOL binding, then page_pal, then the
    // `palette` op's SGB selection, then the kind ramp), shared verbatim
    // with the GE backend so both bind the same CLUT. The day tint is
    // already folded into every entry above.
    let pal_index = |page: u16, kind: u16, pal: u16| -> usize {
        resolve_pal(pak, page, kind, pal, list.palette)
    };
    let mesh_tex = |m: &MeshDraw| -> Option<TexCtx<'_>> {
        let page = cache.pages.get(m.page as usize)?;
        let texels = page.frames.get(m.frame as usize % page.frames.len())?;
        Some(TexCtx {
            texels,
            w: page.w,
            h: page.h,
            pal: tinted.get(pal_index(m.page, page.kind, m.pal))?,
        })
    };

    for item in &list.items {
        match item {
            Item::SkyBands {
                colors,
                horizon_row,
            } => {
                let hr = (*horizon_row).clamp(0, H as i32) as usize;
                for (i, &c) in colors.iter().enumerate() {
                    let y0 = hr * i / colors.len();
                    let y1 = hr * (i + 1) / colors.len();
                    frame.color[y0 * W..y1 * W].fill(c);
                }
                frame.color[hr * W..].fill(colors[colors.len() - 1]);
            }

            Item::ChunkMesh { mesh, .. } | Item::StampMesh { mesh, .. } => {
                let Some(tex) = mesh_tex(mesh) else {
                    continue;
                };
                // A depth-biased mesh (§quality ladder `pullDepthBias`)
                // draws its vertices in place through the SAME biased VP the
                // GE backend folds in — one formulation, `draw::biased_vp`.
                let mvp = if mesh.pull_bias != 0.0 {
                    biased_vp(vp, mesh.pull_bias)
                } else {
                    *vp
                };
                let base = mesh.vert_base as usize;
                let idx0 = mesh.index_base as usize;
                for t in 0..(mesh.index_count as usize / 3) {
                    let tri: [PV; 3] = core::array::from_fn(|k| {
                        let vi = pak.indices[idx0 + t * 3 + k] as usize + base;
                        let pv = &pak.verts[vi];
                        to_clip_opts(
                            &mvp,
                            eye,
                            vec3(
                                pv.x as f32 + mesh.off_x as f32,
                                pv.y as f32,
                                pv.z as f32 + mesh.off_y as f32,
                            ),
                            mesh.pull,
                            pv.uf(),
                            pv.vf(),
                            abgr_to_rgba_f(pv.abgr),
                            true,
                        )
                    });
                    draw_clip_tri(&mut frame, tri, Some(&tex), DepthMode::LessWrite, false);
                }
            }

            Item::ShadowDecal { corners, abgr } => {
                let rgba = abgr_to_rgba_f(*abgr);
                let quad: [PV; 4] = core::array::from_fn(|i| {
                    to_clip(
                        vp,
                        eye,
                        vec3(corners[i][0], corners[i][1], corners[i][2]),
                        0.0,
                        0.0,
                        0.0,
                        rgba,
                    )
                });
                quad_tris(quad, |t| {
                    draw_clip_tri(&mut frame, t, None, DepthMode::LessNoWrite, true)
                });
            }

            Item::Ghost { verts, pull, abgr } => {
                let rgba = abgr_to_rgba_f(*abgr);
                let quad: [PV; 4] = core::array::from_fn(|i| {
                    to_clip(
                        vp,
                        eye,
                        vec3(verts[i][0], verts[i][1], verts[i][2]),
                        *pull,
                        0.0,
                        0.0,
                        rgba,
                    )
                });
                quad_tris(quad, |t| {
                    draw_clip_tri(&mut frame, t, None, DepthMode::GreaterNoWrite, true)
                });
            }

            Item::Card {
                verts,
                page,
                uv,
                mirror,
                pull,
            } => {
                let Some(cp) = cache.pages.get(*page as usize) else {
                    continue;
                };
                let tex = TexCtx {
                    texels: &cp.frames[0],
                    w: cp.w,
                    h: cp.h,
                    // Cards carry no per-item palette: a sprite sheet's OBJ
                    // CLUT and a battle pic's species CLUT are properties of
                    // the PAGE, so resolve_pal reads them from VCOL itself.
                    pal: &tinted[pal_index(*page, cp.kind, COLOR_PAL_NONE)],
                };
                let (u0, u1) = if *mirror {
                    (uv[2], uv[0])
                } else {
                    (uv[0], uv[2])
                };
                let (v0, v1) = (uv[1], uv[3]);
                // Verts: bl, br, tr, tl; v0 is the texture top.
                let uvs = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)];
                let white = [255.0f32; 4];
                let quad: [PV; 4] = core::array::from_fn(|i| {
                    to_clip_opts(
                        vp,
                        eye,
                        vec3(verts[i][0], verts[i][1], verts[i][2]),
                        *pull,
                        uvs[i].0,
                        uvs[i].1,
                        white,
                        true,
                    )
                });
                quad_tris(quad, |t| {
                    draw_clip_tri(&mut frame, t, Some(&tex), DepthMode::LessWrite, false)
                });
            }

            Item::UiQuad {
                x,
                y,
                w,
                h,
                page,
                tile,
            } => {
                let Some(cp) = cache.pages.get(*page as usize) else {
                    continue;
                };
                let pal = &pak.palettes[cp.kind as usize]; // UI: untinted
                let cols = (cp.w / TILE_PX as usize).max(1);
                let tx0 = (*tile as usize % cols) * TILE_PX as usize;
                let ty0 = (*tile as usize / cols) * TILE_PX as usize;
                let px0 = x.floor().max(0.0) as usize;
                let px1 = ((x + w).ceil() as usize).min(W);
                let py0 = y.floor().max(0.0) as usize;
                let py1 = ((y + h).ceil() as usize).min(H);
                for py in py0..py1 {
                    let cyf = py as f32 + 0.5;
                    if cyf < *y || cyf >= y + h {
                        continue;
                    }
                    let sy = ((cyf - y) / h * TILE_PX as f32) as usize;
                    let sy = ty0 + sy.min(TILE_PX as usize - 1);
                    if sy >= cp.h {
                        continue;
                    }
                    for px in px0..px1 {
                        let cxf = px as f32 + 0.5;
                        if cxf < *x || cxf >= x + w {
                            continue;
                        }
                        let sx = ((cxf - x) / w * TILE_PX as f32) as usize;
                        let sx = tx0 + sx.min(TILE_PX as usize - 1);
                        if sx >= cp.w {
                            continue;
                        }
                        let c = pal[cp.frames[0][sy * cp.w + sx] as usize];
                        if (c >> 24) & 0xff < 0x80 {
                            continue;
                        }
                        frame.color[py * W + px] = 0xff00_0000 | (c & 0x00ff_ffff);
                    }
                }
            }
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clip-space quad (w = 1): NDC rect [x0,x1] x [y0,y1] at depth z.
    fn ndc_quad(x0: f32, y0: f32, x1: f32, y1: f32, z: f32, rgba: [f32; 4]) -> [PV; 4] {
        let pv = |x: f32, y: f32, u: f32, v: f32| PV {
            clip: [x, y, z, 1.0],
            u,
            v,
            rgba,
        };
        // bl, br, tr, tl in NDC (y up).
        [
            pv(x0, y0, 0.0, 1.0),
            pv(x1, y0, 1.0, 1.0),
            pv(x1, y1, 1.0, 0.0),
            pv(x0, y1, 0.0, 0.0),
        ]
    }

    fn draw_quad(frame: &mut Frame, q: [PV; 4], tex: Option<&TexCtx>, d: DepthMode, blend: bool) {
        quad_tris(q, |t| draw_clip_tri(frame, t, tex, d, blend));
    }

    fn count_not_background(frame: &Frame) -> usize {
        frame.color.iter().filter(|&&c| c != 0xff00_0000).count()
    }

    #[test]
    fn solid_quad_covers_exact_pixel_count() {
        let mut f = Frame::new();
        // NDC [-0.5, 0.5]^2 = 240 x 136 px exactly.
        let q = ndc_quad(-0.5, -0.5, 0.5, 0.5, 0.0, [255.0, 0.0, 0.0, 255.0]);
        draw_quad(&mut f, q, None, DepthMode::LessWrite, false);
        assert_eq!(count_not_background(&f), 240 * 136);
        // Red, opaque, alpha byte 0xff.
        assert_eq!(f.color[136 * W + 240], 0xff00_00ff);
    }

    #[test]
    fn depth_resolves_two_overlapping_tris() {
        let center = 136 * W + 240;
        for order in [false, true] {
            let mut f = Frame::new();
            let far = ndc_quad(-0.5, -0.5, 0.5, 0.5, 0.5, [255.0, 0.0, 0.0, 255.0]);
            let near = ndc_quad(-0.25, -0.25, 0.25, 0.25, 0.0, [0.0, 255.0, 0.0, 255.0]);
            if order {
                draw_quad(&mut f, far, None, DepthMode::LessWrite, false);
                draw_quad(&mut f, near, None, DepthMode::LessWrite, false);
            } else {
                draw_quad(&mut f, near, None, DepthMode::LessWrite, false);
                draw_quad(&mut f, far, None, DepthMode::LessWrite, false);
            }
            assert_eq!(f.color[center], 0xff00_ff00, "near quad wins either order");
        }
    }

    #[test]
    fn alpha_test_cuts_texels() {
        let mut f = Frame::new();
        let mut pal = [0xff00_00ffu32; 256];
        pal[0] = 0x0000_0000; // transparent
        let texels = vec![0u8, 1]; // left half cut, right half solid
        let tex = TexCtx {
            texels: &texels,
            w: 2,
            h: 1,
            pal: &pal,
        };
        let q = ndc_quad(-0.5, -0.5, 0.5, 0.5, 0.0, [255.0; 4]);
        draw_quad(&mut f, q, Some(&tex), DepthMode::LessWrite, false);
        assert_eq!(count_not_background(&f), 240 * 136 / 2);
        // Cut pixels also left no depth behind.
        assert_eq!(f.depth[136 * W + 200], f32::INFINITY);
        assert!(f.depth[136 * W + 280] < f32::INFINITY);
    }

    #[test]
    fn ghost_draws_only_where_occluded() {
        let mut f = Frame::new();
        // Occluder covers the left half of the screen at z = 0.
        let occ = ndc_quad(-1.0, -1.0, 0.0, 1.0, 0.0, [64.0, 64.0, 64.0, 255.0]);
        draw_quad(&mut f, occ, None, DepthMode::LessWrite, false);
        // Ghost spans both halves, deeper (z = 0.5), inverted test, blended.
        let ghost = ndc_quad(-0.5, -0.5, 0.5, 0.5, 0.5, [255.0, 0.0, 0.0, 128.0]);
        draw_quad(&mut f, ghost, None, DepthMode::GreaterNoWrite, true);
        let left = f.color[136 * W + 200]; // occluded: ghost blended over grey
        let right = f.color[136 * W + 280]; // open: untouched background
        assert_ne!(left, 0xff40_4040, "ghost tinted the occluded side");
        assert_eq!(right, 0xff00_0000, "ghost skipped the open side");
        // No depth writes from the ghost pass.
        assert_eq!(f.depth[136 * W + 280], f32::INFINITY);
    }

    #[test]
    fn sky_bands_fill_rows() {
        let list_colors = [0xff111111u32, 0xff222222, 0xff333333, 0xff444444];
        let mut frame = Frame::new();
        // Inline the SkyBands arm's logic through render() would need a pak;
        // exercise the row fill directly.
        let hr = 64usize;
        for (i, &c) in list_colors.iter().enumerate() {
            let y0 = hr * i / 4;
            let y1 = hr * (i + 1) / 4;
            frame.color[y0 * W..y1 * W].fill(c);
        }
        frame.color[hr * W..].fill(list_colors[3]);
        assert_eq!(frame.color[0], 0xff111111);
        assert_eq!(frame.color[63 * W], 0xff444444);
        assert_eq!(frame.color[200 * W], 0xff444444);
    }
}
