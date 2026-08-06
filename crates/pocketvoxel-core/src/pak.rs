//! The VXPK cooked-content reader (contracts/spec/voxel-spec.ts §VXPK).
//!
//! The container discipline is MONPAK/`.p3d`: a 16-byte header, a section
//! table of `(tag, offset, length, count)` entries, 16-byte-aligned payloads,
//! little-endian everywhere. The core is the only untrusted-byte reader in
//! the runtime: **every** offset, length and count is validated against the
//! blob and against the other sections before use; a corrupt pak returns
//! `Err(&'static str)` and never panics or indexes unchecked. Bulk GPU data
//! (vertex pool, index pool, atlas texels, the GAME JSON) is borrowed
//! zero-copy in place; small directories are parsed into `alloc` structures.
//!
//! ## Pinned payload shapes
//!
//! The spec pins the container and the section tags; the payload byte
//! layouts are pinned HERE and mirrored byte-for-byte by [`builder`] (the TS
//! cooker is written against the same shapes). All sections are required and
//! appear in ascending numeric tag order: META, GAME, AUDI, CHNK, VPAL,
//! VCOL, CMAP, STMP, ATLS.
//!
//! ```text
//! META  (table count = 1), VXPK_META_SIZE bytes:
//!   0  u32 map_count       == CHNK map_count
//!   4  u32 atlas_count     == ATLS page count
//!   8  u32 palette_count   == VPAL palette count
//!   12 u32 stamp_count     == STMP stamp_total
//!   16 u32 glyph_count     == CMAP pair count
//!   20 u32 emote_page      atlas page holding the emote-bubble card frames
//!                          (16x16 cells stacked vertically, frame = EMOTE
//!                          kind - 1); 0xffffffff = pak has no emote art
//!   24 u32 view_w          == spec::VIEW_W  — a pak cooked for another
//!   28 u32 view_h          == spec::VIEW_H    viewport is rejected
//!   32 u32 flags           what this pak CARRIES, not how to draw it. Bit 0
//!                          (VXPK_META_FLAG_TREE_LOD): every chunk holds both
//!                          tree levels of detail, so the runtime may pick
//!                          per chunk. Unknown bits are ignored, never
//!                          rejected — a newer cook stays loadable
//!   36 u32 pad = 0
//!
//! VPAL  (table count = palette count):
//!   0  u16 count
//!   2  count * 1024 bytes: 256 u32 ABGR entries per palette, packed
//!      immediately after the u16 (byte-wise reads; parsed into alloc).
//!   The list is the 4 ATLAS_KIND default (GB grayscale) palettes followed
//!   by the SGB set (`count` may exceed 4). By default an atlas page samples
//!   the palette indexed by its `kind` (ATLAS_KIND), so `count` must exceed
//!   every page kind — the day-tint CLUT rewrite is one palette per art
//!   family, the GB's own trick. When the `palette` op has selected an SGB
//!   entry, backends sample `VPAL[draw::SGB_PAL_BASE + palette]` in place of
//!   the kind's ramp for every non-ui kind (ui keeps its own raw ramp).
//!
//! ATLS  (table count = page count):
//!   0  u16 count
//!   2  count * 16-byte page headers (the spec-pinned shape):
//!        u16 w | u16 h | u16 kind | u16 frames | u32 offset | u32 len
//!      - w, h, frames >= 1; kind must be a known ATLAS_KIND
//!      - offset: from the START of the ATLS payload, 16-aligned
//!      - len: bytes of ONE frame variant of pre-swizzled CLUT8 texels,
//!        exactly swizzled_len(w, h) = align16(w) * align8(h)
//!      - `frames` variants back-to-back: [offset, offset + len * frames)
//!        must lie inside the payload
//!   .. texel blobs (borrowed zero-copy)
//!
//! CHNK  (table count = map count):
//!   0  u16 map_count | 2 u16 pad = 0
//!   4  u32 chunk_total
//!   8  u32 verts_off      from the CHNK payload start, 16-aligned
//!   12 u32 verts_len      bytes, multiple of VERTEX_STRIDE (16)
//!   16 u32 indices_off    from the CHNK payload start, 16-aligned
//!   20 u32 indices_len    bytes, multiple of 2
//!   24 u32 pad = 0 | 28 u32 pad = 0
//!   32 map directory, map_count * 12 bytes:
//!        u32 map_id | u32 first_chunk | u32 chunk_count
//!      (one map's chunk records are contiguous)
//!   .. chunk records, chunk_total * VXPK_CHUNK_RECORD_SIZE bytes each:
//!        i16 cx | i16 cy                      chunk coords (world px =
//!                                             c * CHUNK_PX, map-local)
//!        i16 min_x,min_y,min_z,max_x,max_y,max_z   AABB, map-local world px
//!        u16 bake_page | u16 pad = 0     baked-ground atlas page, or
//!                                        BAKE_PAGE_NONE (v6)
//!        MESH_KINDS mesh ranges in mesh_kind order (terrain, groundBake,
//!        treeHull, treeCoarse, treeBox, water, grass, flower):
//!          u32 vert_base | u16 vert_count | u16 index_count | u32 index_base
//!        - indices are RELATIVE to vert_base (GE batch style, u16-safe)
//!        - index_count % 3 == 0; every index < vert_count (checked at load)
//!   .. vertex pool  (verts_off; 16-byte GE verts, borrowed zero-copy)
//!   .. index pool   (indices_off; u16, borrowed zero-copy)
//!
//! STMP  (table count = map count):
//!   0  u16 map_count | 2 u16 pad = 0
//!   4  u32 stamp_total
//!   8  map directory, map_count * 12: u32 map_id | u32 first | u32 count
//!   .. stamp records, stamp_total * 16 bytes:
//!        i16 cx | i16 cy      the stamp's CELL coords (the `stamp` op key)
//!        u32 vert_base | u16 vert_count | u16 index_count | u32 index_base
//!      ranges point into the CHNK vertex/index pools.
//!
//! CMAP  (table count = pair count):
//!   count * 4 bytes: u16 code_point (UTF-16 BMP) | u16 ui_tile
//!   strictly ascending by code_point (binary-searchable), no duplicates.
//!
//! GAME  (table count = 1): raw JSON bytes, borrowed zero-copy; may be empty.
//!
//! AUDI  (table count = 1), the chip synth's input, borrowed zero-copy:
//!   0  u32 json_len       audio.json (UTF-8): header/song/sfx/cry tables
//!   4  u32 program_len    programs.bin: the ROM sound banks, concatenated
//!                         in `bankOrder`, 0x4000 bytes each
//!   8  u32 pad = 0 | 12 u32 pad = 0
//!   16 json bytes
//!   .. 16-aligned, program bytes
//!   Both halves may be zero-length (a pak cooked without audio); the guest
//!   then runs silent. The core never parses either half — it hands the
//!   whole payload to the guest through the `audiodata` op, the same
//!   one-cold-read discipline GAME has.
//!
//! VCOL  (table count = 1), the RED++ / pokered-gbc per-tile color bindings:
//!   0  u16 version = spec::VXPK_COLOR_VERSION
//!   2  u16 map_count      == CHNK map_count
//!   4  u16 page_count     == ATLS page count
//!   6  u16 flags          bit 0 (VXPK_COLOR_FLAG_WORLD) = the terrain page
//!                         carries `group * 4 + shade` texel indices, so a
//!                         world palette is MANDATORY for every map drawn
//!                         from a baked sheet
//!   8  u32 pad = 0 | 12 u32 pad = 0
//!   16 map_count * 8:  u32 map_id | u16 world_pal | u16 terrain_page
//!   .. page_count * 2: u16 page_pal
//!   Every index is COLOR_PAL_NONE or in range (palette_count / atlas
//!   count), checked here. Map ids are unique and must each name a CHNK map.
//! ```

use alloc::vec::Vec;

use crate::spec::{
    self, COLOR_PAL_NONE, MESH_KINDS, VERTEX_STRIDE, VXPK_ALIGN, VXPK_COLOR_HEADER_SIZE,
    VXPK_COLOR_VERSION, VXPK_ENTRY_SIZE, VXPK_HEADER_SIZE, VXPK_MAGIC, VXPK_META_FLAG_TREE_LOD,
    VXPK_META_SIZE, VXPK_VERSION,
};

pub type ReadError = &'static str;

/// META.emote_page value for "no emote art".
pub const EMOTE_PAGE_NONE: u32 = 0xffff_ffff;

/// The GE world vertex (voxel-spec.ts §VXPK, v8). repr(C), NOT packed:
/// 4-byte alignment, 16 bytes. UVs are page-normalized FIXED POINT —
/// `round(uv * 32768)` — because the GE's TEXTURE_16BIT coords divide by
/// 32768 in TRANSFORM_3D; [`PakVert::uf`]/[`PakVert::vf`] are the one
/// conversion both backends share.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PakVert {
    pub u: u16,
    pub v: u16,
    pub abgr: u32,
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub pad: i16,
}

impl PakVert {
    /// The fixed-point U as the fraction the GE computes.
    #[inline]
    pub fn uf(&self) -> f32 {
        self.u as f32 / 32768.0
    }
    /// The fixed-point V as the fraction the GE computes.
    #[inline]
    pub fn vf(&self) -> f32 {
        self.v as f32 / 32768.0
    }
}

const _: () = assert!(core::mem::size_of::<PakVert>() == VERTEX_STRIDE);
const _: () = assert!(core::mem::align_of::<PakVert>() == 4);

/// Swizzled row stride for a CLUT8 image: 16-byte blocks, so widths pad to 16.
pub const fn swizzle_stride(w: usize) -> usize {
    w.div_ceil(16) * 16
}

/// Swizzled row count: blocks are 8 rows tall.
pub const fn swizzle_rows(h: usize) -> usize {
    h.div_ceil(8) * 8
}

/// Byte size of one pre-swizzled CLUT8 frame.
pub const fn swizzled_len(w: usize, h: usize) -> usize {
    swizzle_stride(w) * swizzle_rows(h)
}

/// Expand one pre-swizzled CLUT8 frame back to linear `w * h` indices —
/// the GE consumes swizzled data in place; the sim rasterizer linearizes
/// once at load. Returns `Err` when `data` is shorter than the swizzled
/// size (the reader already guarantees the size for pak-borrowed frames).
pub fn unswizzle(w: usize, h: usize, data: &[u8]) -> Result<Vec<u8>, ReadError> {
    if data.len() < swizzled_len(w, h) {
        return Err("swizzled frame shorter than its dimensions");
    }
    let stride = swizzle_stride(w);
    let rows = swizzle_rows(h);
    let mut out = alloc::vec![0u8; w * h];
    let mut src = 0usize;
    for block_y in 0..rows / 8 {
        for block_x in 0..stride / 16 {
            for row in 0..8 {
                let y = block_y * 8 + row;
                for column in 0..16 {
                    let x = block_x * 16 + column;
                    if x < w && y < h {
                        out[y * w + x] = data[src + column];
                    }
                }
                src += 16;
            }
        }
    }
    Ok(out)
}

/// One atlas page: header parsed, texels borrowed swizzled in place.
#[derive(Clone, Copy, Debug)]
pub struct AtlasPage<'a> {
    pub w: u16,
    pub h: u16,
    pub kind: u16,
    pub frames: u16,
    /// Bytes of ONE swizzled frame (`frames` variants back-to-back).
    pub frame_len: u32,
    texels: &'a [u8],
}

impl<'a> AtlasPage<'a> {
    /// Swizzled CLUT8 texels of animation frame `i` (wraps past `frames`).
    pub fn frame(&self, i: u16) -> &'a [u8] {
        let i = (i % self.frames) as usize;
        let len = self.frame_len as usize;
        &self.texels[i * len..(i + 1) * len]
    }
}

/// A map's contiguous run of chunk (or stamp) records.
#[derive(Clone, Copy, Debug)]
pub struct MapDir {
    pub map_id: u32,
    pub first: u32,
    pub count: u32,
}

/// One mesh's vertex/index ranges over the shared pools. Indices are
/// relative to `vert_base` so a u16 index never overflows (GE batch style).
#[derive(Clone, Copy, Debug, Default)]
pub struct MeshRange {
    pub vert_base: u32,
    pub vert_count: u16,
    pub index_count: u16,
    pub index_base: u32,
}

/// One cooked 16x16-tile chunk: coords, cull AABB, one mesh per kind.
#[derive(Clone, Copy, Debug)]
pub struct Chunk {
    pub cx: i16,
    pub cy: i16,
    /// AABB in map-local world px: [min_x, min_y, min_z], [max_x, max_y, max_z].
    pub aabb_min: [i16; 3],
    pub aabb_max: [i16; 3],
    /// Atlas page of the baked ground quad (`mesh_kind::GROUND_BAKE`), or
    /// `spec::BAKE_PAGE_NONE` — this chunk is ineligible and always draws
    /// its geometry.
    pub bake_page: u16,
    /// Indexed by `spec::mesh_kind` (terrain, groundBake, treeHull,
    /// treeCoarse, treeBox, water, grass, flower).
    pub meshes: [MeshRange; MESH_KINDS],
}

/// One removable stamp (cut tree, moved boulder).
#[derive(Clone, Copy, Debug)]
pub struct Stamp {
    pub cx: i16,
    pub cy: i16,
    pub mesh: MeshRange,
}

/// One VCOL map record: which VPAL entry (and which terrain page) this map's
/// chunk meshes resolve their `group * 4 + shade` texels through.
#[derive(Clone, Copy, Debug)]
pub struct MapColor {
    pub map_id: u32,
    /// VPAL index, or [`spec::COLOR_PAL_NONE`].
    pub world_pal: u16,
    /// Atlas page index, or [`spec::COLOR_PAL_NONE`] (use `page_of_kind`).
    pub terrain_page: u16,
}

/// Parsed VCOL section — every RED++ binding the pak carries.
#[derive(Debug, Default)]
pub struct Color {
    pub flags: u16,
    pub maps: Vec<MapColor>,
    /// Per atlas page: VPAL index, or [`spec::COLOR_PAL_NONE`].
    pub pages: Vec<u16>,
}

/// Parsed META section.
#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub map_count: u32,
    pub atlas_count: u32,
    pub palette_count: u32,
    pub stamp_count: u32,
    pub glyph_count: u32,
    pub emote_page: u32,
    pub view_w: u32,
    pub view_h: u32,
    /// What the pak CARRIES (`spec::VXPK_META_FLAG_*`), not how to draw it.
    pub flags: u32,
}

/// A validated VXPK. Bulk data borrows from the source blob (which must
/// outlive the pak and be 16-byte aligned for GE consumption); directories
/// are owned.
pub struct Pak<'a> {
    pub meta: Meta,
    /// 256 ABGR entries per palette, indexed by atlas kind.
    pub palettes: Vec<[u32; 256]>,
    pub atlases: Vec<AtlasPage<'a>>,
    /// Shared vertex pool, 16-byte GE verts.
    pub verts: &'a [PakVert],
    /// Shared index pool (relative to each mesh's `vert_base`).
    pub indices: &'a [u16],
    pub maps: Vec<MapDir>,
    pub chunks: Vec<Chunk>,
    pub stamp_maps: Vec<MapDir>,
    pub stamps: Vec<Stamp>,
    /// `(code_point, ui_tile)` sorted ascending by code point.
    pub charmap: Vec<(u16, u16)>,
    /// The GAME section: gameplay JSON the guest parses at boot.
    pub game: &'a [u8],
    /// The AUDI section verbatim: the chip synth's manifest + program banks,
    /// handed to the guest by the `audiodata` op. Empty when the pak carries
    /// no audio.
    pub audio: &'a [u8],
    /// The VCOL section: RED++ per-tile color bindings. Every field is
    /// `COLOR_PAL_NONE` on a pak cooked without the color pack, and every
    /// lookup below then returns `None` — the legacy SGB path.
    pub color: Color,
}

impl<'a> Pak<'a> {
    /// The AUDI programs half: the ROM sound banks concatenated in the
    /// manifest's `bankOrder`, one 0x4000-byte window each. This is what the
    /// synth reads (`audio::Audio::render`); every audio op's `bank` argument
    /// is an index into these windows. Empty on a pak without audio.
    ///
    /// The layout was already validated by [`read`], so this only re-splits.
    pub fn audio_programs(&self) -> &'a [u8] {
        if self.audio.len() < spec::VXPK_AUDIO_HEADER_SIZE {
            return &[];
        }
        let json_len =
            u32::from_le_bytes(self.audio[0..4].try_into().unwrap()) as usize;
        let program_len =
            u32::from_le_bytes(self.audio[4..8].try_into().unwrap()) as usize;
        let off = (spec::VXPK_AUDIO_HEADER_SIZE + json_len).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        match off.checked_add(program_len) {
            Some(end) if end <= self.audio.len() => &self.audio[off..end],
            _ => &[],
        }
    }

    /// Chunk directory entry for `map_id`.
    pub fn find_map(&self, map_id: u32) -> Option<&MapDir> {
        self.maps.iter().find(|m| m.map_id == map_id)
    }

    /// The chunk records of one map directory entry.
    pub fn chunks_of(&self, dir: &MapDir) -> &[Chunk] {
        &self.chunks[dir.first as usize..(dir.first + dir.count) as usize]
    }

    /// Stamp lookup by the `stamp` op key.
    pub fn find_stamp(&self, map_id: u32, cx: i16, cy: i16) -> Option<&Stamp> {
        let dir = self.stamp_maps.iter().find(|m| m.map_id == map_id)?;
        self.stamps[dir.first as usize..(dir.first + dir.count) as usize]
            .iter()
            .find(|s| s.cx == cx && s.cy == cy)
    }

    /// Stamps of one map (paired with [`find_map`]-style directory walk).
    pub fn stamps_of(&self, map_id: u32) -> &[Stamp] {
        match self.stamp_maps.iter().find(|m| m.map_id == map_id) {
            Some(dir) => &self.stamps[dir.first as usize..(dir.first + dir.count) as usize],
            None => &[],
        }
    }

    /// First atlas page of `kind`, the binding for that art family.
    pub fn page_of_kind(&self, kind: u16) -> Option<u16> {
        self.atlases
            .iter()
            .position(|p| p.kind == kind)
            .map(|i| i as u16)
    }

    /// The map's RED++ world palette (VPAL index): the CLUT its terrain,
    /// water, grass and flower meshes sample. `None` = the legacy path.
    pub fn map_world_pal(&self, map_id: u32) -> Option<u16> {
        let rec = self.color.maps.iter().find(|m| m.map_id == map_id)?;
        (rec.world_pal != COLOR_PAL_NONE).then_some(rec.world_pal)
    }

    /// The map's own terrain atlas page, when VCOL names one (v1 always
    /// names the single combined page; the field exists so a per-tileset
    /// page split needs no format change).
    pub fn map_terrain_page(&self, map_id: u32) -> Option<u16> {
        let rec = self.color.maps.iter().find(|m| m.map_id == map_id)?;
        (rec.terrain_page != COLOR_PAL_NONE).then_some(rec.terrain_page)
    }

    /// The page's own RED++ palette (sprite OBJ / battle pic). `None` = the
    /// legacy path (the `palette` op's SGB selection, else the kind ramp).
    pub fn page_pal(&self, page: u16) -> Option<u16> {
        let pal = *self.color.pages.get(page as usize)?;
        (pal != COLOR_PAL_NONE).then_some(pal)
    }

    /// True when every chunk carries BOTH tree levels of detail, so the
    /// rung's `tree_hull_dist` may pick one per chunk. On a pak without it
    /// the core draws whichever level the cook produced — a pak carrying only
    /// carved hulls renders them at every rung rather than losing its trees,
    /// which is the degrade the flag exists to make possible.
    pub fn has_tree_lod(&self) -> bool {
        self.meta.flags & VXPK_META_FLAG_TREE_LOD != 0
    }

    /// True when the chunks also carry the MIDDLE tree level — the 2x2-px
    /// coarse carve (`mesh_kind::TREE_COARSE`). A rung asking for it on a
    /// pak without it draws the fine hulls instead: slower, never treeless.
    pub fn has_tree_coarse(&self) -> bool {
        self.meta.flags & spec::VXPK_META_FLAG_TREE_COARSE != 0
    }

    /// UI tile for a character; `None` when the pak has no glyph for it.
    pub fn glyph(&self, code_point: u16) -> Option<u16> {
        self.charmap
            .binary_search_by_key(&code_point, |&(c, _)| c)
            .ok()
            .map(|i| self.charmap[i].1)
    }
}

/// Little-endian cursor over a section payload, bounds-checked on every read
/// (the `.p3d` reader's `Rd` discipline).
struct Rd<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Rd<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], ReadError> {
        let end = self.pos.checked_add(n).ok_or("overflow")?;
        let s = self.data.get(self.pos..end).ok_or("truncated section")?;
        self.pos = end;
        Ok(s)
    }
    fn u16v(&mut self) -> Result<u16, ReadError> {
        Ok(u16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn i16v(&mut self) -> Result<i16, ReadError> {
        Ok(i16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn u32v(&mut self) -> Result<u32, ReadError> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
}

fn u16_slice(bytes: &[u8]) -> Result<&[u16], ReadError> {
    if !(bytes.as_ptr() as usize).is_multiple_of(2) {
        return Err("unaligned u16 pool");
    }
    if !bytes.len().is_multiple_of(2) {
        return Err("odd-length u16 pool");
    }
    // Safety: alignment and length checked; u16 has no invalid bit patterns;
    // the target is little-endian (compile-checked in lib.rs).
    Ok(unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const u16, bytes.len() / 2) })
}

fn vert_slice(bytes: &[u8]) -> Result<&[PakVert], ReadError> {
    if !(bytes.as_ptr() as usize).is_multiple_of(core::mem::align_of::<PakVert>()) {
        return Err("unaligned vertex pool");
    }
    if !bytes.len().is_multiple_of(VERTEX_STRIDE) {
        return Err("vertex pool size not a multiple of the vertex stride");
    }
    // Safety: alignment and length checked; every PakVert field type accepts
    // any bit pattern; size_of::<PakVert>() == VERTEX_STRIDE const-asserted.
    Ok(unsafe {
        core::slice::from_raw_parts(
            bytes.as_ptr() as *const PakVert,
            bytes.len() / VERTEX_STRIDE,
        )
    })
}

/// Read the directory (`map_id | first | count` runs over `total` records)
/// shared by CHNK and STMP.
fn read_map_dir(r: &mut Rd<'_>, map_count: usize, total: u32) -> Result<Vec<MapDir>, ReadError> {
    let mut maps = Vec::with_capacity(map_count);
    for _ in 0..map_count {
        let map_id = r.u32v()?;
        let first = r.u32v()?;
        let count = r.u32v()?;
        let end = first.checked_add(count).ok_or("map directory overflow")?;
        if end > total {
            return Err("map directory range out of bounds");
        }
        if maps.iter().any(|m: &MapDir| m.map_id == map_id) {
            return Err("duplicate map id in directory");
        }
        maps.push(MapDir {
            map_id,
            first,
            count,
        });
    }
    Ok(maps)
}

fn read_mesh_range(r: &mut Rd<'_>) -> Result<MeshRange, ReadError> {
    Ok(MeshRange {
        vert_base: r.u32v()?,
        vert_count: r.u16v()?,
        index_count: r.u16v()?,
        index_base: r.u32v()?,
    })
}

/// Validate one mesh range against the shared pools, including every index.
fn check_mesh_range(m: &MeshRange, verts: &[PakVert], indices: &[u16]) -> Result<(), ReadError> {
    let vert_end = m
        .vert_base
        .checked_add(m.vert_count as u32)
        .ok_or("mesh vertex range overflow")?;
    if vert_end as usize > verts.len() {
        return Err("mesh vertex range out of bounds");
    }
    if !(m.index_count as usize).is_multiple_of(3) {
        return Err("mesh index count is not a triangle list");
    }
    let index_end = m
        .index_base
        .checked_add(m.index_count as u32)
        .ok_or("mesh index range overflow")?;
    if index_end as usize > indices.len() {
        return Err("mesh index range out of bounds");
    }
    if indices[m.index_base as usize..index_end as usize]
        .iter()
        .any(|&i| i as u32 >= m.vert_count as u32)
    {
        return Err("mesh index references a vertex out of bounds");
    }
    Ok(())
}

/// Parse and validate a VXPK blob. `data` must stay alive as long as the pak
/// (GPU sections are borrowed, not copied) and should be 16-byte aligned so
/// the vertex/index pools meet GE alignment requirements (2/4-byte alignment
/// is verified; misaligned blobs are rejected, never mis-read).
pub fn read(data: &[u8]) -> Result<Pak<'_>, ReadError> {
    // --- container header + section table ---------------------------------
    let mut r = Rd::new(data);
    if r.u32v()? != VXPK_MAGIC {
        return Err("not a VXPK blob (bad magic)");
    }
    if r.u16v()? != VXPK_VERSION {
        return Err("unsupported VXPK version");
    }
    let section_count = r.u16v()? as usize;
    let total_len = r.u32v()? as usize;
    if r.u32v()? != 0 {
        return Err("reserved header word is not zero");
    }
    if total_len != data.len() {
        return Err("header length disagrees with the blob (truncated or padded)");
    }
    const TAGS: [u32; 9] = [
        spec::tag::META,
        spec::tag::GAME,
        spec::tag::CHUNKS,
        spec::tag::PALETTE,
        spec::tag::CHARMAP,
        spec::tag::STAMPS,
        spec::tag::ATLAS,
        spec::tag::AUDIO,
        spec::tag::COLOR,
    ];
    // All nine sections required, ascending tag order (spec: "sections
    // appear in tag order"), ascending non-overlapping payloads.
    if section_count != TAGS.len() {
        return Err("wrong section count");
    }
    let table_end = VXPK_HEADER_SIZE + section_count * VXPK_ENTRY_SIZE;
    let mut expected = TAGS;
    expected.sort_unstable();
    let mut sections = [(0usize, 0usize, 0u32); 9]; // (offset, length, count) in TAGS order
    let mut prev_end = table_end;
    for (i, &want) in expected.iter().enumerate() {
        let tag = r.u32v()?;
        let off = r.u32v()? as usize;
        let len = r.u32v()? as usize;
        let count = r.u32v()?;
        if tag != want {
            return Err("section table not in ascending tag order or missing a section");
        }
        if !off.is_multiple_of(VXPK_ALIGN) {
            return Err("section payload is not 16-byte aligned");
        }
        if off < prev_end {
            return Err("section payloads overlap or precede the table");
        }
        let end = off.checked_add(len).ok_or("section range overflow")?;
        if end > data.len() {
            return Err("section payload out of range");
        }
        prev_end = end;
        let slot = TAGS.iter().position(|&t| t == want).unwrap();
        sections[slot] = (off, len, count);
        let _ = i;
    }
    let payload = |slot: usize| -> &[u8] {
        let (off, len, _) = sections[slot];
        &data[off..off + len]
    };

    // --- META -------------------------------------------------------------
    let meta;
    {
        let (_, len, count) = sections[0];
        if count != 1 || len != VXPK_META_SIZE {
            return Err("META must be one VXPK_META_SIZE record");
        }
        let mut r = Rd::new(payload(0));
        meta = Meta {
            map_count: r.u32v()?,
            atlas_count: r.u32v()?,
            palette_count: r.u32v()?,
            stamp_count: r.u32v()?,
            glyph_count: r.u32v()?,
            emote_page: r.u32v()?,
            view_w: r.u32v()?,
            view_h: r.u32v()?,
            flags: r.u32v()?,
        };
        if r.u32v()? != 0 {
            return Err("META pad is not zero");
        }
        if meta.view_w != spec::VIEW_W as u32 || meta.view_h != spec::VIEW_H as u32 {
            return Err("pak was cooked for a different viewport");
        }
    }

    // --- GAME -------------------------------------------------------------
    let game = payload(1);
    if sections[1].2 != 1 {
        return Err("GAME table count must be 1");
    }

    // --- AUDI -------------------------------------------------------------
    // Handed to the guest verbatim; the core only checks that the payload's
    // own header agrees with its length, so a truncated blob is caught here
    // and not inside QuickJS.
    let audio = payload(7);
    if sections[7].2 != 1 {
        return Err("AUDI table count must be 1");
    }
    if !audio.is_empty() {
        if audio.len() < spec::VXPK_AUDIO_HEADER_SIZE {
            return Err("AUDI payload is shorter than its header");
        }
        let mut r = Rd::new(audio);
        let json_len = r.u32v()? as usize;
        let program_len = r.u32v()? as usize;
        if r.u32v()? != 0 || r.u32v()? != 0 {
            return Err("AUDI reserved words are not zero");
        }
        let programs_off = (spec::VXPK_AUDIO_HEADER_SIZE + json_len).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        let end = programs_off
            .checked_add(program_len)
            .ok_or("AUDI range overflow")?;
        if end > audio.len() {
            return Err("AUDI halves do not fit in the payload");
        }
    }

    // --- VPAL -------------------------------------------------------------
    let mut palettes = Vec::new();
    {
        let (_, _, table_count) = sections[3];
        let mut r = Rd::new(payload(3));
        let n = r.u16v()? as usize;
        if n as u32 != table_count || n as u32 != meta.palette_count {
            return Err("VPAL count disagrees with the table or META");
        }
        for _ in 0..n {
            let raw = r.bytes(256 * 4)?;
            let mut pal = [0u32; 256];
            for (i, entry) in pal.iter_mut().enumerate() {
                *entry = u32::from_le_bytes(raw[i * 4..i * 4 + 4].try_into().unwrap());
            }
            palettes.push(pal);
        }
    }

    // --- ATLS -------------------------------------------------------------
    let mut atlases = Vec::new();
    {
        let sect = payload(6);
        let (_, _, table_count) = sections[6];
        let mut r = Rd::new(sect);
        let n = r.u16v()? as usize;
        if n as u32 != table_count || n as u32 != meta.atlas_count {
            return Err("ATLS count disagrees with the table or META");
        }
        for _ in 0..n {
            let w = r.u16v()?;
            let h = r.u16v()?;
            let kind = r.u16v()?;
            let frames = r.u16v()?;
            let offset = r.u32v()? as usize;
            let len = r.u32v()? as usize;
            if w == 0 || h == 0 || frames == 0 {
                return Err("atlas page with zero dimension or frame count");
            }
            if kind > spec::atlas_kind::PICS {
                return Err("unknown atlas page kind");
            }
            if kind as u32 >= meta.palette_count {
                return Err("atlas page kind has no palette");
            }
            if len != swizzled_len(w as usize, h as usize) {
                return Err("atlas frame length disagrees with its dimensions");
            }
            if !offset.is_multiple_of(VXPK_ALIGN) {
                return Err("atlas texel blob is not 16-byte aligned");
            }
            let total = len
                .checked_mul(frames as usize)
                .ok_or("atlas size overflow")?;
            let end = offset.checked_add(total).ok_or("atlas range overflow")?;
            let texels = sect.get(offset..end).ok_or("atlas texels out of range")?;
            atlases.push(AtlasPage {
                w,
                h,
                kind,
                frames,
                frame_len: len as u32,
                texels,
            });
        }
        if meta.emote_page != EMOTE_PAGE_NONE && meta.emote_page as usize >= atlases.len() {
            return Err("META emote page out of range");
        }
    }

    // --- CHNK -------------------------------------------------------------
    let (verts, indices, maps, chunks);
    {
        let sect = payload(2);
        let (_, _, table_count) = sections[2];
        let mut r = Rd::new(sect);
        let map_count = r.u16v()? as usize;
        if r.u16v()? != 0 {
            return Err("CHNK pad is not zero");
        }
        if map_count as u32 != table_count || map_count as u32 != meta.map_count {
            return Err("CHNK map count disagrees with the table or META");
        }
        let chunk_total = r.u32v()?;
        let verts_off = r.u32v()? as usize;
        let verts_len = r.u32v()? as usize;
        let indices_off = r.u32v()? as usize;
        let indices_len = r.u32v()? as usize;
        if r.u32v()? != 0 || r.u32v()? != 0 {
            return Err("CHNK pad is not zero");
        }
        for (off, len, what) in [
            (verts_off, verts_len, "vertex"),
            (indices_off, indices_len, "index"),
        ] {
            let _ = what;
            if !off.is_multiple_of(VXPK_ALIGN) {
                return Err("CHNK pool is not 16-byte aligned");
            }
            let end = off.checked_add(len).ok_or("CHNK pool range overflow")?;
            if end > sect.len() {
                return Err("CHNK pool out of range");
            }
        }
        verts = vert_slice(&sect[verts_off..verts_off + verts_len])?;
        indices = u16_slice(&sect[indices_off..indices_off + indices_len])?;
        maps = read_map_dir(&mut r, map_count, chunk_total)?;
        let mut out = Vec::with_capacity(chunk_total as usize);
        for _ in 0..chunk_total {
            let cx = r.i16v()?;
            let cy = r.i16v()?;
            let aabb_min = [r.i16v()?, r.i16v()?, r.i16v()?];
            let aabb_max = [r.i16v()?, r.i16v()?, r.i16v()?];
            if aabb_min.iter().zip(&aabb_max).any(|(lo, hi)| lo > hi) {
                return Err("chunk AABB is inverted");
            }
            let bake_page = r.u16v()?;
            if r.u16v()? != 0 {
                return Err("chunk record pad is not zero");
            }
            if bake_page != spec::BAKE_PAGE_NONE && bake_page as u32 >= meta.atlas_count {
                return Err("chunk bake page out of range");
            }
            let mut meshes = [MeshRange::default(); MESH_KINDS];
            for mesh in &mut meshes {
                *mesh = read_mesh_range(&mut r)?;
                check_mesh_range(mesh, verts, indices)?;
            }
            out.push(Chunk {
                cx,
                cy,
                aabb_min,
                aabb_max,
                bake_page,
                meshes,
            });
        }
        chunks = out;
    }

    // --- STMP -------------------------------------------------------------
    let (stamp_maps, stamps);
    {
        let (_, _, table_count) = sections[5];
        let mut r = Rd::new(payload(5));
        let map_count = r.u16v()? as usize;
        if r.u16v()? != 0 {
            return Err("STMP pad is not zero");
        }
        if map_count as u32 != table_count {
            return Err("STMP map count disagrees with the table");
        }
        let stamp_total = r.u32v()?;
        if stamp_total != meta.stamp_count {
            return Err("STMP stamp count disagrees with META");
        }
        stamp_maps = read_map_dir(&mut r, map_count, stamp_total)?;
        let mut out = Vec::with_capacity(stamp_total as usize);
        for _ in 0..stamp_total {
            let cx = r.i16v()?;
            let cy = r.i16v()?;
            let mesh = read_mesh_range(&mut r)?;
            check_mesh_range(&mesh, verts, indices)?;
            out.push(Stamp { cx, cy, mesh });
        }
        stamps = out;
    }

    // --- CMAP -------------------------------------------------------------
    let mut charmap = Vec::new();
    {
        let (_, len, table_count) = sections[4];
        if table_count != meta.glyph_count || len != table_count as usize * 4 {
            return Err("CMAP length disagrees with its count");
        }
        let mut r = Rd::new(payload(4));
        for _ in 0..table_count {
            let code = r.u16v()?;
            let tile = r.u16v()?;
            if let Some(&(prev, _)) = charmap.last()
                && code <= prev
            {
                return Err("CMAP pairs are not strictly ascending");
            }
            charmap.push((code, tile));
        }
    }

    // --- VCOL -------------------------------------------------------------
    // The RED++ bindings. Every index is range-checked here so no backend
    // ever indexes VPAL or ATLS with a pak-supplied number unchecked.
    let color;
    {
        let (_, len, table_count) = sections[8];
        if table_count != 1 {
            return Err("VCOL table count must be 1");
        }
        let mut r = Rd::new(payload(8));
        if r.u16v()? != VXPK_COLOR_VERSION {
            return Err("unsupported VCOL version");
        }
        let map_count = r.u16v()? as usize;
        let page_count = r.u16v()? as usize;
        let flags = r.u16v()?;
        if r.u32v()? != 0 || r.u32v()? != 0 {
            return Err("VCOL reserved words are not zero");
        }
        if map_count as u32 != meta.map_count || page_count as u32 != meta.atlas_count {
            return Err("VCOL counts disagree with META");
        }
        if len != VXPK_COLOR_HEADER_SIZE + map_count * 8 + page_count * 2 {
            return Err("VCOL length disagrees with its counts");
        }
        let mut map_recs = Vec::with_capacity(map_count);
        for _ in 0..map_count {
            let map_id = r.u32v()?;
            let world_pal = r.u16v()?;
            let terrain_page = r.u16v()?;
            if !maps.iter().any(|m| m.map_id == map_id) {
                return Err("VCOL names a map the chunk directory does not have");
            }
            if map_recs.iter().any(|m: &MapColor| m.map_id == map_id) {
                return Err("duplicate map id in VCOL");
            }
            if world_pal != COLOR_PAL_NONE && world_pal as usize >= palettes.len() {
                return Err("VCOL world palette out of range");
            }
            if terrain_page != COLOR_PAL_NONE && terrain_page as usize >= atlases.len() {
                return Err("VCOL terrain page out of range");
            }
            // A group-baked terrain page has no meaning without its CLUT:
            // the texels are 0..31 group indices, not GB shades.
            if flags & spec::VXPK_COLOR_FLAG_WORLD != 0
                && world_pal == COLOR_PAL_NONE
                && terrain_page != COLOR_PAL_NONE
            {
                return Err("VCOL declares baked world color but a map has no palette");
            }
            map_recs.push(MapColor {
                map_id,
                world_pal,
                terrain_page,
            });
        }
        let mut pages = Vec::with_capacity(page_count);
        for _ in 0..page_count {
            let pal = r.u16v()?;
            if pal != COLOR_PAL_NONE && pal as usize >= palettes.len() {
                return Err("VCOL page palette out of range");
            }
            pages.push(pal);
        }
        color = Color {
            flags,
            maps: map_recs,
            pages,
        };
    }

    Ok(Pak {
        meta,
        palettes,
        atlases,
        verts,
        indices,
        maps,
        chunks,
        stamp_maps,
        stamps,
        charmap,
        game,
        audio,
        color,
    })
}

#[cfg(any(test, feature = "std"))]
pub mod builder;

/// 16-byte-aligned owned blob. `Vec<u8>` carries no alignment guarantee,
/// and the reader (correctly) rejects pools whose absolute address is
/// misaligned — hosts that load a pak from disk stage it here. The PSP
/// embeds the pak in `.rodata` with an align attribute instead.
#[cfg(any(test, feature = "std"))]
pub struct AlignedBlob {
    data: Vec<u128>,
    len: usize,
}

#[cfg(any(test, feature = "std"))]
impl AlignedBlob {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        let words = bytes.len().div_ceil(16);
        let mut data = alloc::vec![0u128; words];
        // Safety: u128 backing store is at least bytes.len() long.
        unsafe {
            core::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                data.as_mut_ptr() as *mut u8,
                bytes.len(),
            );
        }
        Self {
            data,
            len: bytes.len(),
        }
    }

    pub fn bytes(&self) -> &[u8] {
        // Safety: the store holds at least `len` initialized bytes.
        unsafe { core::slice::from_raw_parts(self.data.as_ptr() as *const u8, self.len) }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::builder::PakBuilder;
    use super::*;
    use crate::spec::atlas_kind;
    use alloc::vec;

    /// A tiny but fully-populated pak: one palette per kind in use, a 16x16
    /// two-frame terrain atlas, one map with one chunk (a ground quad), one
    /// stamp, two glyphs, a GAME blob.
    pub(crate) fn tiny_pak_bytes() -> Vec<u8> {
        let mut b = PakBuilder::new();
        let mut pal = [0xff00_0000u32; 256];
        pal[1] = 0xff00_ff00; // opaque green
        pal[2] = 0x0000_00ff; // transparent red (alpha test target)
        b.palette(pal); // kind 0 = terrain
        b.palette(pal); // kind 1 = sprites
        b.palette(pal); // kind 2 = ui
        let texels = vec![1u8; 16 * 16];
        b.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&texels, &texels]);
        b.atlas_linear(16, 32, atlas_kind::SPRITES, &[&vec![1u8; 16 * 32]]);
        b.atlas_linear(16, 16, atlas_kind::UI, &[&texels]);

        // One chunk: a ground quad spanning the whole chunk at height 0.
        let quad = |x0: i16, z0: i16, x1: i16, z1: i16, abgr: u32| -> (Vec<PakVert>, Vec<u16>) {
            let v = |x, z| PakVert {
                u: 8192, // 0.25 fixed point
                v: 8192,
                abgr,
                x,
                y: 0,
                z,
                pad: 0,
            };
            (
                vec![v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1)],
                vec![0, 1, 2, 0, 2, 3],
            )
        };
        let (verts, idx) = quad(0, 0, 128, 128, 0xffff_ffff);
        let terrain = b.mesh(&verts, &idx);
        let (sv, si) = quad(16, 16, 32, 32, 0xffff_ffff);
        let stamp_mesh = b.mesh(&sv, &si);
        b.map(
            7,
            &[builder::ChunkDef {
                cx: 0,
                cy: 0,
                aabb_min: [0, 0, 0],
                aabb_max: [128, 0, 128],
                bake_page: spec::BAKE_PAGE_NONE,
                meshes: [
                    terrain,
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                ],
            }],
        );
        b.stamps(7, &[(2, 2, stamp_mesh)]);
        b.glyph('A' as u16, 3);
        b.glyph('B' as u16, 4);
        b.game(br#"{"hello":1}"#);
        b.audio(br#"{"bankOrder":[2]}"#, &[0xaa; 40]);
        b.finish()
    }

    /// The same pak with RED++ bindings. VPAL: 0..3 the kind defaults, 4 the
    /// one SGB entry (`draw::SGB_PAL_BASE`), 5 a world CLUT, 6 an OBJ CLUT.
    /// Map 7 binds 5 over terrain page 0; the sprite page binds 6.
    pub(crate) const COLORED_WORLD_PAL: u16 = 5;
    pub(crate) const COLORED_OBJ_PAL: u16 = 6;
    pub(crate) fn colored_pak_bytes() -> Vec<u8> {
        let mut b = PakBuilder::new();
        let mut pal = [0xff00_0000u32; 256];
        pal[1] = 0xff00_ff00;
        pal[2] = 0x0000_00ff;
        for _ in 0..7 {
            b.palette(pal);
        }
        let texels = vec![1u8; 16 * 16];
        b.atlas_linear(16, 16, atlas_kind::TERRAIN, &[&texels, &texels]);
        b.atlas_linear(16, 32, atlas_kind::SPRITES, &[&vec![1u8; 16 * 32]]);
        b.atlas_linear(16, 16, atlas_kind::UI, &[&texels]);
        let v = |x: i16, z: i16| PakVert {
            u: 8192, // 0.25 fixed point
            v: 8192,
            abgr: 0xffff_ffff,
            x,
            y: 0,
            z,
            pad: 0,
        };
        let terrain = b.mesh(
            &[v(0, 0), v(128, 0), v(128, 128), v(0, 128)],
            &[0, 1, 2, 0, 2, 3],
        );
        b.map(
            7,
            &[builder::ChunkDef {
                cx: 0,
                cy: 0,
                aabb_min: [0, 0, 0],
                aabb_max: [128, 0, 128],
                bake_page: spec::BAKE_PAGE_NONE,
                meshes: [
                    terrain,
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                    MeshRange::default(),
                ],
            }],
        );
        b.stamps(7, &[]);
        b.glyph('A' as u16, 3);
        b.game(b"{}");
        b.color_flags(spec::VXPK_COLOR_FLAG_WORLD);
        b.map_color(7, COLORED_WORLD_PAL, 0);
        b.page_color(1, COLORED_OBJ_PAL);
        b.finish()
    }

    #[test]
    fn color_bindings_round_trip() {
        let blob = AlignedBlob::from_bytes(&colored_pak_bytes());
        let pak = read(blob.bytes()).expect("valid colored pak");
        assert_eq!(pak.color.flags, spec::VXPK_COLOR_FLAG_WORLD);
        assert_eq!(pak.map_world_pal(7), Some(COLORED_WORLD_PAL));
        assert_eq!(pak.map_terrain_page(7), Some(0));
        assert_eq!(pak.map_world_pal(9), None, "unknown map has no binding");
        assert_eq!(pak.page_pal(1), Some(COLORED_OBJ_PAL));
        assert_eq!(pak.page_pal(0), None, "terrain takes its CLUT per map");
        assert_eq!(pak.page_pal(99), None, "out-of-range page is None");

        // A pak cooked without the color pack carries the section with every
        // index NONE — every lookup falls through to the legacy path.
        let blob = AlignedBlob::from_bytes(&tiny_pak_bytes());
        let pak = read(blob.bytes()).expect("valid pak");
        assert_eq!(pak.color.flags, 0);
        assert_eq!(pak.color.maps.len(), 1);
        assert_eq!(pak.color.pages.len(), 3);
        assert_eq!(pak.map_world_pal(7), None);
        assert_eq!(pak.page_pal(0), None);
    }


    #[test]
    fn corrupt_color_section_errors() {
        let good = colored_pak_bytes();
        // Locate VCOL's payload.
        let mut vcol = None;
        for s in 0..9 {
            let entry = VXPK_HEADER_SIZE + s * VXPK_ENTRY_SIZE;
            let tag = u32::from_le_bytes(good[entry..entry + 4].try_into().unwrap());
            if tag == spec::tag::COLOR {
                vcol = Some(
                    u32::from_le_bytes(good[entry + 4..entry + 8].try_into().unwrap()) as usize,
                );
            }
        }
        let off = vcol.expect("VCOL present");
        let poke = |at: usize, v: u16| {
            let mut b = good.clone();
            b[at..at + 2].copy_from_slice(&v.to_le_bytes());
            b
        };
        must_err(&poke(off, 99), "unsupported VCOL version");
        must_err(&poke(off + 2, 5), "map_count disagrees with META");
        must_err(&poke(off + 4, 5), "page_count disagrees with META");
        must_err(&poke(off + 8, 1), "reserved word is not zero");
        // world_pal past the palette count (7 palettes here).
        must_err(&poke(off + 16 + 4, 50), "world palette out of range");
        // terrain_page past the atlas count.
        must_err(&poke(off + 16 + 6, 50), "terrain page out of range");
        // a map id the chunk directory does not carry.
        let mut b = good.clone();
        b[off + 16..off + 20].copy_from_slice(&99u32.to_le_bytes());
        must_err(&b, "VCOL names an unknown map");
        // page palette past the palette count.
        must_err(&poke(off + 16 + 8, 50), "page palette out of range");
        // flags claim baked world color but the map carries no palette.
        must_err(&poke(off + 16 + 4, COLOR_PAL_NONE), "baked but unpaletted");
    }

    #[test]
    fn round_trip() {
        let blob = AlignedBlob::from_bytes(&tiny_pak_bytes());
        let pak = read(blob.bytes()).expect("valid pak");
        assert_eq!(pak.meta.map_count, 1);
        assert_eq!(pak.palettes.len(), 3);
        assert_eq!(pak.atlases.len(), 3);
        assert_eq!(pak.atlases[0].frames, 2);
        assert_eq!(pak.atlases[0].frame_len as usize, swizzled_len(16, 16));
        assert_eq!(pak.verts.len(), 8);
        assert_eq!(pak.indices.len(), 12);
        let map = pak.find_map(7).expect("map 7");
        assert_eq!(pak.chunks_of(map).len(), 1);
        let chunk = &pak.chunks_of(map)[0];
        assert_eq!(chunk.meshes[0].vert_count, 4);
        assert_eq!(chunk.meshes[0].index_count, 6);
        assert!(pak.find_stamp(7, 2, 2).is_some());
        assert!(pak.find_stamp(7, 9, 9).is_none());
        assert_eq!(pak.glyph('A' as u16), Some(3));
        assert_eq!(pak.glyph('Z' as u16), None);
        assert_eq!(pak.game, br#"{"hello":1}"#);
        // AUDI: the header states both halves and they fit; the core hands
        // the payload on verbatim (the guest is the only parser).
        let json_len = u32::from_le_bytes(pak.audio[0..4].try_into().unwrap()) as usize;
        let program_len = u32::from_le_bytes(pak.audio[4..8].try_into().unwrap()) as usize;
        assert_eq!(json_len, br#"{"bankOrder":[2]}"#.len());
        assert_eq!(program_len, 40);
        assert_eq!(
            &pak.audio[spec::VXPK_AUDIO_HEADER_SIZE..spec::VXPK_AUDIO_HEADER_SIZE + json_len],
            br#"{"bankOrder":[2]}"#
        );
        let programs_off = (spec::VXPK_AUDIO_HEADER_SIZE + json_len).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        assert!(pak.audio[programs_off..programs_off + program_len]
            .iter()
            .all(|&b| b == 0xaa));
        // Unswizzle inverts the builder's swizzle.
        let frame = pak.atlases[0].frame(0);
        assert_eq!(unswizzle(16, 16, frame).unwrap(), vec![1u8; 256]);
    }

    #[test]
    fn every_truncation_errors() {
        let bytes = tiny_pak_bytes();
        for len in 0..bytes.len() {
            assert!(
                read(&bytes[..len]).is_err(),
                "truncation to {len} bytes must be rejected"
            );
        }
    }

    fn must_err(bytes: &[u8], why: &str) {
        let blob = AlignedBlob::from_bytes(bytes);
        assert!(read(blob.bytes()).is_err(), "{why}");
    }

    #[test]
    fn corrupt_header_and_offsets_error() {
        let good = tiny_pak_bytes();
        let poke = |off: usize| {
            let mut b = good.clone();
            b[off] = b[off].wrapping_add(1);
            b
        };
        must_err(&poke(0), "bad magic");
        must_err(&poke(4), "bad version");
        must_err(&poke(6), "bad section count");
        must_err(&poke(8), "bad total length");
        must_err(&poke(12), "nonzero reserved word");

        // Sweep every section-table entry: huge offset, huge length,
        // misaligned offset, corrupt tag.
        for s in 0..7 {
            let entry = VXPK_HEADER_SIZE + s * VXPK_ENTRY_SIZE;
            for field in [4usize, 8] {
                let mut b = good.clone();
                b[entry + field..entry + field + 4].copy_from_slice(&0xffff_fff0u32.to_le_bytes());
                must_err(&b, "huge section table field");
            }
            let mut b = good.clone();
            b[entry + 4] = b[entry + 4].wrapping_add(1); // break 16-alignment
            must_err(&b, "misaligned section offset");
            let mut b = good.clone();
            b[entry] = b[entry].wrapping_add(1); // corrupt tag
            must_err(&b, "corrupt section tag");
        }
    }

    #[test]
    fn corrupt_directories_error() {
        // Find the CHNK payload and corrupt interior counts/ranges.
        let good = tiny_pak_bytes();
        let blob = AlignedBlob::from_bytes(&good);
        let pak = read(blob.bytes()).unwrap();
        assert_eq!(pak.chunks.len(), 1);
        drop(pak);

        // Locate CHNK's table entry (slot order is ascending tag).
        let mut chnk_off = None;
        for s in 0..7 {
            let entry = VXPK_HEADER_SIZE + s * VXPK_ENTRY_SIZE;
            let tag = u32::from_le_bytes(good[entry..entry + 4].try_into().unwrap());
            if tag == spec::tag::CHUNKS {
                chnk_off = Some(
                    u32::from_le_bytes(good[entry + 4..entry + 8].try_into().unwrap()) as usize,
                );
            }
        }
        let chnk = chnk_off.expect("CHNK present");

        // chunk_total inflated: directory + record reads must fail, not index OOB.
        let mut b = good.clone();
        b[chnk + 4..chnk + 8].copy_from_slice(&1000u32.to_le_bytes());
        must_err(&b, "inflated chunk_total");

        // verts_len made non-multiple-of-stride.
        let mut b = good.clone();
        let vl = u32::from_le_bytes(good[chnk + 12..chnk + 16].try_into().unwrap());
        b[chnk + 12..chnk + 16].copy_from_slice(&(vl + 1).to_le_bytes());
        must_err(&b, "bad vertex pool length");

        // A mesh index pointing past its vert_count: corrupt the index pool.
        let io = u32::from_le_bytes(good[chnk + 16..chnk + 20].try_into().unwrap()) as usize;
        let mut b = good.clone();
        b[chnk + io] = 200; // index 200 >= vert_count 4
        must_err(&b, "index out of vertex range");
    }
}
