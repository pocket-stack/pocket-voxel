//! VXPK writer, mirroring the reader's pinned payload shapes byte-for-byte.
//!
//! The TS cooker (`voxelmon/cook/`) will be ported against this module;
//! until then it is the sim tests' pak source. Build-time errors are
//! `panic!`s — the builder runs at cook time on trusted input, never on
//! device (gated behind `test`/`std`).

use alloc::vec::Vec;

use super::{EMOTE_PAGE_NONE, MeshRange, PakVert, swizzle_rows, swizzle_stride};
use crate::spec::{
    self, COLOR_PAL_NONE, MESH_KINDS, VXPK_ALIGN, VXPK_CHUNK_RECORD_SIZE, VXPK_ENTRY_SIZE,
    VXPK_HEADER_SIZE,
};

/// One chunk record for [`PakBuilder::map`].
#[derive(Clone, Copy, Debug)]
pub struct ChunkDef {
    /// Baked-ground atlas page, or `spec::BAKE_PAGE_NONE`.
    pub bake_page: u16,
    pub cx: i16,
    pub cy: i16,
    pub aabb_min: [i16; 3],
    pub aabb_max: [i16; 3],
    /// One range per `spec::mesh_kind`; empty ranges are all-zero.
    pub meshes: [MeshRange; MESH_KINDS],
}

/// Swizzle linear CLUT8 texels into the GE's 16-byte x 8-row block order —
/// the inverse of [`super::unswizzle`], and the exact transform the TS
/// cooker performs at pack time.
pub fn swizzle(w: usize, h: usize, linear: &[u8]) -> Vec<u8> {
    assert_eq!(linear.len(), w * h, "linear texel size mismatch");
    let stride = swizzle_stride(w);
    let rows = swizzle_rows(h);
    let mut out = alloc::vec![0u8; stride * rows];
    let mut dst = 0usize;
    for block_y in 0..rows / 8 {
        for block_x in 0..stride / 16 {
            for row in 0..8 {
                let y = block_y * 8 + row;
                for column in 0..16 {
                    let x = block_x * 16 + column;
                    if x < w && y < h {
                        out[dst + column] = linear[y * w + x];
                    }
                }
                dst += 16;
            }
        }
    }
    out
}

struct AtlasDef {
    w: u16,
    h: u16,
    kind: u16,
    /// Swizzled frames, all the same length.
    frames: Vec<Vec<u8>>,
}

struct MapDef {
    map_id: u32,
    chunks: Vec<ChunkDef>,
}

pub struct PakBuilder {
    palettes: Vec<[u32; 256]>,
    atlases: Vec<AtlasDef>,
    verts: Vec<PakVert>,
    indices: Vec<u16>,
    maps: Vec<MapDef>,
    stamp_maps: Vec<(u32, Vec<(i16, i16, MeshRange)>)>,
    glyphs: Vec<(u16, u16)>,
    game: Vec<u8>,
    audio_json: Vec<u8>,
    audio_programs: Vec<u8>,
    emote_page: u32,
    meta_flags: u32,
    color_flags: u16,
    /// map_id -> (world_pal, terrain_page); maps not named here take NONE.
    color_maps: Vec<(u32, u16, u16)>,
    /// page -> palette; pages past the end take NONE.
    color_pages: Vec<u16>,
}

impl PakBuilder {
    pub fn new() -> Self {
        Self {
            palettes: Vec::new(),
            atlases: Vec::new(),
            verts: Vec::new(),
            indices: Vec::new(),
            maps: Vec::new(),
            stamp_maps: Vec::new(),
            glyphs: Vec::new(),
            game: Vec::new(),
            audio_json: Vec::new(),
            audio_programs: Vec::new(),
            emote_page: EMOTE_PAGE_NONE,
            meta_flags: 0,
            color_flags: 0,
            color_maps: Vec::new(),
            color_pages: Vec::new(),
        }
    }

    /// A VCOL map record: the world CLUT (and terrain page) this map's chunk
    /// meshes bind. Pass `COLOR_PAL_NONE` for either to keep the legacy path.
    pub fn map_color(&mut self, map_id: u32, world_pal: u16, terrain_page: u16) {
        self.color_maps.push((map_id, world_pal, terrain_page));
    }

    /// A VCOL page record: the CLUT this atlas page binds (sprite OBJ /
    /// battle pic). Pages left unset take `COLOR_PAL_NONE`.
    pub fn page_color(&mut self, page: u16, pal: u16) {
        if self.color_pages.len() <= page as usize {
            self.color_pages.resize(page as usize + 1, COLOR_PAL_NONE);
        }
        self.color_pages[page as usize] = pal;
    }

    /// VCOL flags (`spec::VXPK_COLOR_FLAG_WORLD` when the terrain page is
    /// group-baked).
    pub fn color_flags(&mut self, flags: u16) {
        self.color_flags = flags;
    }

    /// Append a 256-entry ABGR palette. Palette index = atlas kind, so add
    /// them in `ATLAS_KIND` order; entries past the 4 kind defaults form the
    /// SGB set the `palette` op selects from (`draw::SGB_PAL_BASE`).
    pub fn palette(&mut self, pal: [u32; 256]) -> u16 {
        self.palettes.push(pal);
        (self.palettes.len() - 1) as u16
    }

    /// Append an atlas page from LINEAR CLUT8 frames (`w * h` bytes each);
    /// the builder swizzles. Returns the page index.
    pub fn atlas_linear(&mut self, w: u16, h: u16, kind: u16, frames: &[&[u8]]) -> u16 {
        assert!(!frames.is_empty(), "a page needs at least one frame");
        self.atlases.push(AtlasDef {
            w,
            h,
            kind,
            frames: frames
                .iter()
                .map(|f| swizzle(w as usize, h as usize, f))
                .collect(),
        });
        (self.atlases.len() - 1) as u16
    }

    /// META flags: what this pak CARRIES (`spec::VXPK_META_FLAG_TREE_LOD`
    /// when every chunk holds both tree levels of detail).
    pub fn meta_flags(&mut self, flags: u32) {
        self.meta_flags = flags;
    }

    /// The page emote bubbles sample (16x16 cells stacked vertically).
    pub fn emote_page(&mut self, page: u16) {
        self.emote_page = page as u32;
    }

    /// Append a mesh to the shared pools. `indices` are relative to the
    /// mesh's own first vertex (as they are stored).
    pub fn mesh(&mut self, verts: &[PakVert], indices: &[u16]) -> MeshRange {
        assert!(indices.len().is_multiple_of(3), "triangle list required");
        assert!(
            verts.len() <= u16::MAX as usize,
            "mesh vertex count overflow"
        );
        assert!(
            indices.iter().all(|&i| (i as usize) < verts.len()),
            "index out of mesh range"
        );
        let range = MeshRange {
            vert_base: self.verts.len() as u32,
            vert_count: verts.len() as u16,
            index_count: indices.len() as u16,
            index_base: self.indices.len() as u32,
        };
        self.verts.extend_from_slice(verts);
        self.indices.extend_from_slice(indices);
        range
    }

    pub fn map(&mut self, map_id: u32, chunks: &[ChunkDef]) {
        assert!(
            !self.maps.iter().any(|m| m.map_id == map_id),
            "duplicate map id"
        );
        self.maps.push(MapDef {
            map_id,
            chunks: chunks.to_vec(),
        });
    }

    pub fn stamps(&mut self, map_id: u32, stamps: &[(i16, i16, MeshRange)]) {
        assert!(
            !self.stamp_maps.iter().any(|(id, _)| *id == map_id),
            "duplicate stamp map id"
        );
        self.stamp_maps.push((map_id, stamps.to_vec()));
    }

    pub fn glyph(&mut self, code_point: u16, ui_tile: u16) {
        self.glyphs.push((code_point, ui_tile));
    }

    pub fn game(&mut self, json: &[u8]) {
        self.game = json.to_vec();
    }

    /// The AUDI halves: the synth manifest (JSON) and the concatenated ROM
    /// sound banks. Leave both unset for a pak without audio — AUDI is then
    /// written empty and the guest runs silent.
    pub fn audio(&mut self, json: &[u8], programs: &[u8]) {
        self.audio_json = json.to_vec();
        self.audio_programs = programs.to_vec();
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.glyphs.sort_unstable_by_key(|&(c, _)| c);
        assert!(
            self.glyphs.windows(2).all(|w| w[0].0 < w[1].0),
            "duplicate glyph code point"
        );

        let chunk_total: usize = self.maps.iter().map(|m| m.chunks.len()).sum();
        let stamp_total: usize = self.stamp_maps.iter().map(|(_, s)| s.len()).sum();

        // --- META ---
        let mut meta = Vec::new();
        for v in [
            self.maps.len() as u32,
            self.atlases.len() as u32,
            self.palettes.len() as u32,
            stamp_total as u32,
            self.glyphs.len() as u32,
            self.emote_page,
            spec::VIEW_W as u32,
            spec::VIEW_H as u32,
            self.meta_flags,
            0,
        ] {
            meta.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(meta.len(), spec::VXPK_META_SIZE, "META record size");

        // --- VPAL ---
        let mut vpal = Vec::new();
        vpal.extend_from_slice(&(self.palettes.len() as u16).to_le_bytes());
        for pal in &self.palettes {
            for c in pal {
                vpal.extend_from_slice(&c.to_le_bytes());
            }
        }

        // --- ATLS: headers first, then 16-aligned texel blobs ---
        let mut atls = Vec::new();
        atls.extend_from_slice(&(self.atlases.len() as u16).to_le_bytes());
        let headers_end = 2 + self.atlases.len() * 16;
        let mut blob_off = headers_end.div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        let mut blob_offsets = Vec::new();
        for page in &self.atlases {
            blob_offsets.push(blob_off);
            blob_off += page.frames[0].len() * page.frames.len();
            blob_off = blob_off.div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        }
        for (page, &off) in self.atlases.iter().zip(&blob_offsets) {
            let frame_len = page.frames[0].len();
            assert!(page.frames.iter().all(|f| f.len() == frame_len));
            atls.extend_from_slice(&page.w.to_le_bytes());
            atls.extend_from_slice(&page.h.to_le_bytes());
            atls.extend_from_slice(&page.kind.to_le_bytes());
            atls.extend_from_slice(&(page.frames.len() as u16).to_le_bytes());
            atls.extend_from_slice(&(off as u32).to_le_bytes());
            atls.extend_from_slice(&(frame_len as u32).to_le_bytes());
        }
        for (page, &off) in self.atlases.iter().zip(&blob_offsets) {
            atls.resize(off, 0);
            for frame in &page.frames {
                atls.extend_from_slice(frame);
            }
        }

        // --- CHNK ---
        let mut chnk = Vec::new();
        chnk.extend_from_slice(&(self.maps.len() as u16).to_le_bytes());
        chnk.extend_from_slice(&0u16.to_le_bytes());
        chnk.extend_from_slice(&(chunk_total as u32).to_le_bytes());
        let dir_end = 32 + self.maps.len() * 12 + chunk_total * VXPK_CHUNK_RECORD_SIZE;
        let verts_off = dir_end.div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        let verts_len = self.verts.len() * spec::VERTEX_STRIDE;
        let indices_off = (verts_off + verts_len).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        let indices_len = self.indices.len() * 2;
        for v in [
            verts_off as u32,
            verts_len as u32,
            indices_off as u32,
            indices_len as u32,
            0,
            0,
        ] {
            chnk.extend_from_slice(&v.to_le_bytes());
        }
        let mut first = 0u32;
        for m in &self.maps {
            chnk.extend_from_slice(&m.map_id.to_le_bytes());
            chnk.extend_from_slice(&first.to_le_bytes());
            chnk.extend_from_slice(&(m.chunks.len() as u32).to_le_bytes());
            first += m.chunks.len() as u32;
        }
        let write_range = |out: &mut Vec<u8>, r: &MeshRange| {
            out.extend_from_slice(&r.vert_base.to_le_bytes());
            out.extend_from_slice(&r.vert_count.to_le_bytes());
            out.extend_from_slice(&r.index_count.to_le_bytes());
            out.extend_from_slice(&r.index_base.to_le_bytes());
        };
        for m in &self.maps {
            for c in &m.chunks {
                chnk.extend_from_slice(&c.cx.to_le_bytes());
                chnk.extend_from_slice(&c.cy.to_le_bytes());
                for v in c.aabb_min.iter().chain(&c.aabb_max) {
                    chnk.extend_from_slice(&v.to_le_bytes());
                }
                chnk.extend_from_slice(&c.bake_page.to_le_bytes());
                chnk.extend_from_slice(&0u16.to_le_bytes());
                for r in &c.meshes {
                    write_range(&mut chnk, r);
                }
            }
        }
        chnk.resize(verts_off, 0);
        for v in &self.verts {
            chnk.extend_from_slice(&v.u.to_le_bytes());
            chnk.extend_from_slice(&v.v.to_le_bytes());
            chnk.extend_from_slice(&v.abgr.to_le_bytes());
            for c in [v.x, v.y, v.z, v.pad] {
                chnk.extend_from_slice(&c.to_le_bytes());
            }
        }
        chnk.resize(indices_off, 0);
        for i in &self.indices {
            chnk.extend_from_slice(&i.to_le_bytes());
        }

        // --- STMP ---
        let mut stmp = Vec::new();
        stmp.extend_from_slice(&(self.stamp_maps.len() as u16).to_le_bytes());
        stmp.extend_from_slice(&0u16.to_le_bytes());
        stmp.extend_from_slice(&(stamp_total as u32).to_le_bytes());
        let mut first = 0u32;
        for (map_id, stamps) in &self.stamp_maps {
            stmp.extend_from_slice(&map_id.to_le_bytes());
            stmp.extend_from_slice(&first.to_le_bytes());
            stmp.extend_from_slice(&(stamps.len() as u32).to_le_bytes());
            first += stamps.len() as u32;
        }
        for (_, stamps) in &self.stamp_maps {
            for (cx, cy, mesh) in stamps {
                stmp.extend_from_slice(&cx.to_le_bytes());
                stmp.extend_from_slice(&cy.to_le_bytes());
                write_range(&mut stmp, mesh);
            }
        }

        // --- CMAP ---
        let mut cmap = Vec::new();
        for (code, tile) in &self.glyphs {
            cmap.extend_from_slice(&code.to_le_bytes());
            cmap.extend_from_slice(&tile.to_le_bytes());
        }

        // --- AUDI: 16-byte header, JSON, 16-aligned program banks ---
        let mut audi = Vec::new();
        if !self.audio_json.is_empty() || !self.audio_programs.is_empty() {
            audi.extend_from_slice(&(self.audio_json.len() as u32).to_le_bytes());
            audi.extend_from_slice(&(self.audio_programs.len() as u32).to_le_bytes());
            audi.extend_from_slice(&0u32.to_le_bytes());
            audi.extend_from_slice(&0u32.to_le_bytes());
            audi.extend_from_slice(&self.audio_json);
            let programs_off =
                (spec::VXPK_AUDIO_HEADER_SIZE + self.audio_json.len()).div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
            audi.resize(programs_off, 0);
            audi.extend_from_slice(&self.audio_programs);
        }

        // --- VCOL: 16-byte header, map records, page records ---
        let mut vcol = Vec::new();
        vcol.extend_from_slice(&spec::VXPK_COLOR_VERSION.to_le_bytes());
        vcol.extend_from_slice(&(self.maps.len() as u16).to_le_bytes());
        vcol.extend_from_slice(&(self.atlases.len() as u16).to_le_bytes());
        vcol.extend_from_slice(&self.color_flags.to_le_bytes());
        vcol.extend_from_slice(&0u32.to_le_bytes());
        vcol.extend_from_slice(&0u32.to_le_bytes());
        for m in &self.maps {
            let rec = self.color_maps.iter().find(|(id, _, _)| *id == m.map_id);
            let (world_pal, terrain_page) =
                rec.map_or((COLOR_PAL_NONE, COLOR_PAL_NONE), |&(_, w, t)| (w, t));
            vcol.extend_from_slice(&m.map_id.to_le_bytes());
            vcol.extend_from_slice(&world_pal.to_le_bytes());
            vcol.extend_from_slice(&terrain_page.to_le_bytes());
        }
        for page in 0..self.atlases.len() {
            let pal = self
                .color_pages
                .get(page)
                .copied()
                .unwrap_or(COLOR_PAL_NONE);
            vcol.extend_from_slice(&pal.to_le_bytes());
        }

        // --- container: ascending tag order, 16-aligned payloads ---
        let mut sections = [
            (spec::tag::META, meta, 1u32),
            (spec::tag::COLOR, vcol, 1),
            (spec::tag::GAME, self.game.clone(), 1),
            (spec::tag::AUDIO, audi, 1),
            (spec::tag::CHUNKS, chnk, self.maps.len() as u32),
            (spec::tag::PALETTE, vpal, self.palettes.len() as u32),
            (spec::tag::CHARMAP, cmap, self.glyphs.len() as u32),
            (spec::tag::STAMPS, stmp, self.stamp_maps.len() as u32),
            (spec::tag::ATLAS, atls, self.atlases.len() as u32),
        ];
        sections.sort_by_key(|(tag, _, _)| *tag);

        let table_end = VXPK_HEADER_SIZE + sections.len() * VXPK_ENTRY_SIZE;
        let mut offset = table_end.div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        let mut out = Vec::new();
        out.extend_from_slice(&spec::VXPK_MAGIC.to_le_bytes());
        out.extend_from_slice(&spec::VXPK_VERSION.to_le_bytes());
        out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
        let total_len_at = out.len();
        out.extend_from_slice(&0u32.to_le_bytes()); // patched below
        out.extend_from_slice(&0u32.to_le_bytes());
        for (tag, payload, count) in &sections {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
            offset += payload.len().div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        }
        for (_, payload, _) in &sections {
            let aligned = out.len().div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
            out.resize(aligned, 0);
            out.extend_from_slice(payload);
        }
        let aligned = out.len().div_ceil(VXPK_ALIGN) * VXPK_ALIGN;
        out.resize(aligned, 0);
        let total = out.len() as u32;
        out[total_len_at..total_len_at + 4].copy_from_slice(&total.to_le_bytes());
        out
    }
}

impl Default for PakBuilder {
    fn default() -> Self {
        Self::new()
    }
}
