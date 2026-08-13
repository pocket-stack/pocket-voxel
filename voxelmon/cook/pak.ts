// voxelmon/cook/pak.ts — the VXPK writer.
//
// Byte-for-byte mirror of crates/pocketvoxel-core/src/
// pak/builder.rs (the reader in ../pak.rs is the ground truth): META 40B,
// VPAL u16 count + 1024B palettes, ATLS u16 count + 16B headers +
// 16-aligned swizzled blobs, CHNK header + 12B map dirs + 128B chunk records
// + 16-aligned vert/index pools, STMP 16B records into the CHNK pools, CMAP
// ascending u16 pairs, GAME raw JSON, AUDI 16B header + JSON + 16-aligned
// program banks, VCOL 16B header + 8B map records + u16 page records;
// section table in ascending numeric tag order, 16-aligned ascending
// payloads, total_len patched last.

import {
  BAKE_PAGE_NONE,
  COLOR_PAL_NONE,
  MESH_KIND,
  VERTEX_STRIDE,
  VXPK_CHUNK_RECORD_SIZE,
  VXPK_CHUNK_FLAG_BORDER_RING,
  VIEW_H,
  VIEW_W,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
  VXPK_COLOR_VERSION,
  VXPK_ENTRY_SIZE,
  VXPK_HEADER_SIZE,
  VXPK_MAGIC,
  VXPK_META_SIZE,
  VXPK_TAG,
  VXPK_VERSION,
} from "../../contracts/spec/voxel-spec.ts";
import { swizzle } from "./atlas.ts";
import type { PageDef } from "./atlas.ts";
import type { ChunkOut, PackedMesh, StampOut } from "./mesh.ts";

const EMOTE_PAGE_NONE = 0xffffffff;

class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;

  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number {
    return this.len;
  }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.grow(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }

  i16(v: number): void {
    this.u16(v < 0 ? v + 0x10000 : v);
  }

  u32(v: number): void {
    this.grow(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  f32(v: number): void {
    this.grow(4);
    const dv = new DataView(this.buf.buffer, this.len, 4);
    dv.setFloat32(0, v, true);
    this.len += 4;
  }

  bytes(b: Uint8Array): void {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Zero-pad to `n` bytes (builder.rs `resize`). */
  padTo(n: number): void {
    if (n < this.len) throw new Error("padTo backwards");
    this.grow(n - this.len);
    this.len = n;
  }

  align(a: number): void {
    this.padTo(Math.ceil(this.len / a) * a);
  }

  out(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export interface PakInput {
  palettes: Uint32Array[];
  pages: PageDef[];
  /** Cooked maps in pack order: map id + chunks + stamps. */
  maps: { mapId: number; chunks: ChunkOut[]; stamps: StampOut[] }[];
  /** (code_point, ui_tile), strictly ascending by code point. */
  glyphs: [number, number][];
  gameJson: Uint8Array;
  /** The AUDI halves; omit (or leave empty) for a pak without audio. */
  audioJson?: Uint8Array;
  audioPrograms?: Uint8Array;
  emotePage: number | null;
  /**
   * META flags — what this pak CARRIES, not how to draw it
   * (`VXPK_META_FLAG_TREE_LOD` when every chunk holds both tree levels of
   * detail). Omitted = 0, which is what an older cook stated by having no
   * field at all.
   */
  metaFlags?: number;
  /**
   * The VCOL bindings (cook/redpp.ts). Omit for a pak with no RED++ pack:
   * the section is still written (it is required), with every index
   * COLOR_PAL_NONE and no flags — which renders exactly as a v2 pak did.
   */
  colour?: {
    maps: { mapId: number; worldPal: number; terrainPage: number }[];
    pagePal: number[];
    flags: number;
  };
}

export interface PakStats {
  bytes: number;
  sections: { tag: string; bytes: number }[];
  verts: number;
  indices: number;
  chunks: number;
  stamps: number;
}

export function writePak(input: PakInput): { bytes: Uint8Array; stats: PakStats } {
  // --- shared vertex/index pools + mesh ranges -----------------------------
  const verts = new ByteWriter();
  const indexPool = new ByteWriter();
  let vertCount = 0;
  let indexCount = 0;

  interface Range {
    vertBase: number;
    vertCount: number;
    indexCount: number;
    indexBase: number;
  }
  const emptyRange: Range = { vertBase: 0, vertCount: 0, indexCount: 0, indexBase: 0 };

  const appendMesh = (mesh: PackedMesh): Range => {
    if (mesh.verts.length === 0) return emptyRange;
    // 16-byte-align every mesh's index range (pad entries are never
    // referenced — each mesh reads exactly [indexBase, indexBase+count)).
    // The PSP GE fetches the range in place, and a 2-mod-4 start is the
    // difference between its fast path and a per-fetch misalignment stall
    // (2026-08-06 device A/B: unaligned in-place indices cost the GE ~20 ms
    // a Pallet frame vs a 16-aligned staging copy of the same bytes).
    while (indexCount % 8 !== 0) {
      indexPool.u16(0);
      indexCount += 1;
    }
    const range: Range = {
      vertBase: vertCount,
      vertCount: mesh.verts.length,
      indexCount: mesh.indices.length,
      indexBase: indexCount,
    };
    for (const v of mesh.verts) {
      // v8 fixed-point UV: the GE divides TEXTURE_16BIT coords by 32768.
      verts.u16(Math.min(32767, Math.round(v.u * 32768)));
      verts.u16(Math.min(32767, Math.round(v.v * 32768)));
      verts.u32(v.abgr);
      verts.i16(v.x);
      verts.i16(v.y);
      verts.i16(v.z);
      verts.i16(0);
    }
    for (const i of mesh.indices) indexPool.u16(i);
    vertCount += mesh.verts.length;
    indexCount += mesh.indices.length;
    return range;
  };

  interface ChunkRec {
    cx: number;
    cy: number;
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    bakePage?: number;
    flags: number;
    meshes: Range[];
  }
  const chunkRecs: { mapId: number; chunks: ChunkRec[] }[] = [];
  const stampRecs: { mapId: number; stamps: { cx: number; cy: number; mesh: Range }[] }[] = [];
  for (const m of input.maps) {
    const chunks: ChunkRec[] = m.chunks.map((c) => {
      // Append order is NOT record-slot order: the v6/v7 additions (the
      // baked-ground quad, the kept structures) append LAST, so the carved
      // hulls' vertices still
      // land immediately after their chunk's terrain vertices in the shared
      // pool — the suffix invariant the identity rung's quad order rests on
      // (tests/voxel-cook.test.ts pins it). Ranges are explicit, so slots
      // need not follow pool order.
      const meshes: Range[] = new Array(c.meshes.length);
      for (let k = 0; k < c.meshes.length; k++) {
        if (k === MESH_KIND.groundBake || k === MESH_KIND.terrainKeep) continue;
        meshes[k] = appendMesh(c.meshes[k]);
      }
      meshes[MESH_KIND.terrainKeep] = appendMesh(c.meshes[MESH_KIND.terrainKeep]);
      meshes[MESH_KIND.groundBake] = appendMesh(c.meshes[MESH_KIND.groundBake]);
      const flags = c.flags ?? 0;
      if ((flags & ~VXPK_CHUNK_FLAG_BORDER_RING) !== 0) {
        throw new Error(`chunk ${c.cx},${c.cy} has unknown flags 0x${flags.toString(16)}`);
      }
      return {
        cx: c.cx,
        cy: c.cy,
        aabbMin: c.aabbMin,
        aabbMax: c.aabbMax,
        bakePage: c.bakePage,
        flags,
        meshes,
      };
    });
    chunkRecs.push({ mapId: m.mapId, chunks });
    if (m.stamps.length > 0) {
      stampRecs.push({
        mapId: m.mapId,
        stamps: m.stamps.map((s) => ({ cx: s.cx, cy: s.cy, mesh: appendMesh(s.mesh) })),
      });
    }
  }
  const chunkTotal = chunkRecs.reduce((n, m) => n + m.chunks.length, 0);
  const stampTotal = stampRecs.reduce((n, m) => n + m.stamps.length, 0);

  // --- META ---
  const meta = new ByteWriter();
  meta.u32(input.maps.length);
  meta.u32(input.pages.length);
  meta.u32(input.palettes.length);
  meta.u32(stampTotal);
  meta.u32(input.glyphs.length);
  meta.u32(input.emotePage ?? EMOTE_PAGE_NONE);
  meta.u32(VIEW_W);
  meta.u32(VIEW_H);
  meta.u32(input.metaFlags ?? 0);
  meta.u32(0);
  if (meta.length !== VXPK_META_SIZE) throw new Error("META record size");

  // --- VPAL ---
  const vpal = new ByteWriter();
  vpal.u16(input.palettes.length);
  for (const pal of input.palettes) {
    for (let i = 0; i < 256; i++) vpal.u32(pal[i]);
  }

  // --- ATLS: headers first, then 16-aligned texel blobs ---
  const atls = new ByteWriter();
  atls.u16(input.pages.length);
  const swizzled = input.pages.map((p) => p.frames.map((f) => swizzle(p.w, p.h, f)));
  const headersEnd = 2 + input.pages.length * 16;
  let blobOff = Math.ceil(headersEnd / VXPK_ALIGN) * VXPK_ALIGN;
  const blobOffsets: number[] = [];
  for (const frames of swizzled) {
    blobOffsets.push(blobOff);
    blobOff += frames[0].length * frames.length;
    blobOff = Math.ceil(blobOff / VXPK_ALIGN) * VXPK_ALIGN;
  }
  input.pages.forEach((p, i) => {
    const frameLen = swizzled[i][0].length;
    atls.u16(p.w);
    atls.u16(p.h);
    atls.u16(p.kind);
    atls.u16(p.frames.length);
    atls.u32(blobOffsets[i]);
    atls.u32(frameLen);
  });
  input.pages.forEach((_, i) => {
    atls.padTo(blobOffsets[i]);
    for (const frame of swizzled[i]) atls.bytes(frame);
  });

  // --- CHNK ---
  const chnk = new ByteWriter();
  chnk.u16(input.maps.length);
  chnk.u16(0);
  chnk.u32(chunkTotal);
  const dirEnd = 32 + input.maps.length * 12 + chunkTotal * VXPK_CHUNK_RECORD_SIZE;
  const vertsOff = Math.ceil(dirEnd / VXPK_ALIGN) * VXPK_ALIGN;
  const vertsLen = vertCount * VERTEX_STRIDE;
  const indicesOff = Math.ceil((vertsOff + vertsLen) / VXPK_ALIGN) * VXPK_ALIGN;
  const indicesLen = indexCount * 2;
  chnk.u32(vertsOff);
  chnk.u32(vertsLen);
  chnk.u32(indicesOff);
  chnk.u32(indicesLen);
  chnk.u32(0);
  chnk.u32(0);
  let first = 0;
  for (const m of chunkRecs) {
    chnk.u32(m.mapId);
    chnk.u32(first);
    chnk.u32(m.chunks.length);
    first += m.chunks.length;
  }
  const writeRange = (w: ByteWriter, r: Range): void => {
    w.u32(r.vertBase);
    w.u16(r.vertCount);
    w.u16(r.indexCount);
    w.u32(r.indexBase);
  };
  for (const m of chunkRecs) {
    for (const c of m.chunks) {
      chnk.i16(c.cx);
      chnk.i16(c.cy);
      for (const v of [...c.aabbMin, ...c.aabbMax]) chnk.i16(v);
      chnk.u16(c.bakePage ?? BAKE_PAGE_NONE);
      chnk.u16(c.flags);
      for (const r of c.meshes) writeRange(chnk, r);
    }
  }
  chnk.padTo(vertsOff);
  chnk.bytes(verts.out());
  chnk.padTo(indicesOff);
  chnk.bytes(indexPool.out());

  // --- STMP ---
  const stmp = new ByteWriter();
  stmp.u16(stampRecs.length);
  stmp.u16(0);
  stmp.u32(stampTotal);
  first = 0;
  for (const m of stampRecs) {
    stmp.u32(m.mapId);
    stmp.u32(first);
    stmp.u32(m.stamps.length);
    first += m.stamps.length;
  }
  for (const m of stampRecs) {
    for (const s of m.stamps) {
      stmp.i16(s.cx);
      stmp.i16(s.cy);
      writeRange(stmp, s.mesh);
    }
  }

  // --- CMAP ---
  const cmap = new ByteWriter();
  for (const [code, tile] of input.glyphs) {
    cmap.u16(code);
    cmap.u16(tile);
  }

  // --- AUDI ---
  const audioJson = input.audioJson ?? new Uint8Array(0);
  const audioPrograms = input.audioPrograms ?? new Uint8Array(0);
  const audi = new ByteWriter();
  if (audioJson.length > 0 || audioPrograms.length > 0) {
    audi.u32(audioJson.length);
    audi.u32(audioPrograms.length);
    audi.u32(0);
    audi.u32(0);
    audi.bytes(audioJson);
    audi.padTo(
      Math.ceil((VXPK_AUDIO_HEADER_SIZE + audioJson.length) / VXPK_ALIGN) * VXPK_ALIGN,
    );
    audi.bytes(audioPrograms);
  }

  // --- VCOL: the RED++ color bindings (voxel-spec.ts §VXPK_TAG.color) ---
  const colour = input.colour ?? {
    maps: input.maps.map((m) => ({
      mapId: m.mapId,
      worldPal: COLOR_PAL_NONE,
      terrainPage: COLOR_PAL_NONE,
    })),
    pagePal: input.pages.map(() => COLOR_PAL_NONE),
    flags: 0,
  };
  if (colour.maps.length !== input.maps.length) {
    throw new Error("VCOL map record count disagrees with the cooked maps");
  }
  if (colour.pagePal.length !== input.pages.length) {
    throw new Error("VCOL page record count disagrees with the atlas pages");
  }
  const vcol = new ByteWriter();
  vcol.u16(VXPK_COLOR_VERSION);
  vcol.u16(colour.maps.length);
  vcol.u16(colour.pagePal.length);
  vcol.u16(colour.flags);
  vcol.u32(0);
  vcol.u32(0);
  for (const m of colour.maps) {
    vcol.u32(m.mapId);
    vcol.u16(m.worldPal);
    vcol.u16(m.terrainPage);
  }
  for (const p of colour.pagePal) vcol.u16(p);

  // --- container: ascending tag order, 16-aligned payloads ---
  const sections: [number, string, Uint8Array, number][] = [
    [VXPK_TAG.meta, "META", meta.out(), 1],
    [VXPK_TAG.color, "VCOL", vcol.out(), 1],
    [VXPK_TAG.game, "GAME", input.gameJson, 1],
    [VXPK_TAG.audio, "AUDI", audi.out(), 1],
    [VXPK_TAG.chunks, "CHNK", chnk.out(), input.maps.length],
    [VXPK_TAG.palette, "VPAL", vpal.out(), input.palettes.length],
    [VXPK_TAG.charmap, "CMAP", cmap.out(), input.glyphs.length],
    [VXPK_TAG.stamps, "STMP", stmp.out(), stampRecs.length],
    [VXPK_TAG.atlas, "ATLS", atls.out(), input.pages.length],
  ];
  sections.sort((a, b) => a[0] - b[0]);

  const tableEnd = VXPK_HEADER_SIZE + sections.length * VXPK_ENTRY_SIZE;
  let offset = Math.ceil(tableEnd / VXPK_ALIGN) * VXPK_ALIGN;
  const out = new ByteWriter();
  out.u32(VXPK_MAGIC);
  out.u16(VXPK_VERSION);
  out.u16(sections.length);
  const totalLenAt = out.length;
  out.u32(0); // patched below
  out.u32(0);
  for (const [tag, , payload, count] of sections) {
    out.u32(tag);
    out.u32(offset);
    out.u32(payload.length);
    out.u32(count);
    offset += Math.ceil(payload.length / VXPK_ALIGN) * VXPK_ALIGN;
  }
  for (const [, , payload] of sections) {
    out.align(VXPK_ALIGN);
    out.bytes(payload);
  }
  out.align(VXPK_ALIGN);
  const bytes = out.out();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setUint32(totalLenAt, bytes.length, true);

  return {
    bytes,
    stats: {
      bytes: bytes.length,
      sections: sections.map(([, tag, payload]) => ({ tag, bytes: payload.length })),
      verts: vertCount,
      indices: indexCount,
      chunks: chunkTotal,
      stamps: stampTotal,
    },
  };
}
