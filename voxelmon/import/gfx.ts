// Indexed-bitmap decode + composition, port of gen1recomp
// src/import/ImageWriter.lua onto the gen/gfx.bin format
// (voxelmon/SCHEMA.md): 1 byte per pixel, 0..3 = GB shade
// (0 = white/lightest), 0xff = transparent. No PNGs are written.

import { check } from "./ctx.ts";

export const TRANSPARENT = 0xff;

export class GfxImage {
  readonly px: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    fill: number = TRANSPARENT,
  ) {
    this.px = new Uint8Array(w * h).fill(fill);
  }

  get(x: number, y: number): number {
    return this.px[y * this.w + x];
  }

  set(x: number, y: number, value: number): void {
    this.px[y * this.w + x] = value;
  }
}

function assertDimensions(raw: number[], width: number, height: number, bits: number): void {
  check(
    width % 8 === 0 && height % 8 === 0,
    `${bits}bpp dimensions must be tile-aligned: ${width}x${height}`,
  );
  const expected = (width * height * bits) / 8;
  check(raw.length === expected, `${bits}bpp payload is ${raw.length} bytes, expected ${expected}`);
}

/**
 * gen1recomp ImageWriter.lua:20 — GB 2bpp: per tile row the LOW byte comes
 * first, then the high byte; tiles are row-major across the sheet.
 * `transparent` maps shade 0 to 0xff (the color-0-transparent sheets).
 */
export function decode2bpp(
  raw: number[],
  width: number,
  height: number,
  transparent = false,
): GfxImage {
  assertDimensions(raw, width, height, 2);
  const image = new GfxImage(width, height, 0);
  const tilesPerRow = width / 8;
  for (let tile = 0; tile < raw.length / 16; tile++) {
    const tileX = (tile % tilesPerRow) * 8;
    const tileY = Math.floor(tile / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      const low = raw[tile * 16 + y * 2];
      const high = raw[tile * 16 + y * 2 + 1];
      for (let x = 0; x < 8; x++) {
        const shift = 7 - x;
        const shade = ((high >> shift) & 1) * 2 + ((low >> shift) & 1);
        image.set(tileX + x, tileY + y, transparent && shade === 0 ? TRANSPARENT : shade);
      }
    }
  }
  return image;
}

/**
 * gen1recomp ImageWriter.lua:45 — 1bpp: a set bit is black (shade 3), a
 * clear bit is white (shade 0) or transparent when requested.
 */
export function decode1bpp(
  raw: number[],
  width: number,
  height: number,
  transparent = false,
): GfxImage {
  assertDimensions(raw, width, height, 1);
  const image = new GfxImage(width, height, 0);
  const tilesPerRow = width / 8;
  for (let tile = 0; tile < raw.length / 8; tile++) {
    const tileX = (tile % tilesPerRow) * 8;
    const tileY = Math.floor(tile / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      const row = raw[tile * 8 + y];
      for (let x = 0; x < 8; x++) {
        const filled = ((row >> (7 - x)) & 1) !== 0;
        image.set(tileX + x, tileY + y, filled ? 3 : transparent ? TRANSPARENT : 0);
      }
    }
  }
  return image;
}

/** gen1recomp ImageWriter.lua:73 — raw copy; transparent pixels copy too. */
export function blit(
  target: GfxImage,
  source: GfxImage,
  targetX: number,
  targetY: number,
  sourceX = 0,
  sourceY = 0,
  width = source.w,
  height = source.h,
  flipX = false,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sampleX = flipX ? sourceX + width - 1 - x : sourceX + x;
      target.set(targetX + x, targetY + y, source.get(sampleX, sourceY + y));
    }
  }
}

/**
 * gen1recomp ImageWriter.lua:86 — flood from ALL border pixels through pure
 * white (opaque shade 0) only, turning the reached pixels transparent.
 * Interior whites (eyes, highlights) survive; never key out all white.
 */
export function matteColor0(image: GfxImage): GfxImage {
  const { w, h } = { w: image.w, h: image.h };
  const queueX: number[] = [];
  const queueY: number[] = [];
  const seen = new Uint8Array(w * h);
  const add = (x: number, y: number): void => {
    const key = y * w + x;
    if (seen[key]) return;
    if (image.px[key] !== 0) return; // only opaque shade-0 spreads
    seen[key] = 1;
    queueX.push(x);
    queueY.push(y);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let head = 0;
  while (head < queueX.length) {
    const x = queueX[head];
    const y = queueY[head];
    head += 1;
    image.set(x, y, TRANSPARENT);
    if (x > 0) add(x - 1, y);
    if (x + 1 < w) add(x + 1, y);
    if (y > 0) add(x, y - 1);
    if (y + 1 < h) add(x, y + 1);
  }
  return image;
}

export interface GfxEntry {
  off: number;
  w: number;
  h: number;
  walker?: boolean;
}

/** The gen/gfx.bin builder: entries appended in stage order. */
export class GfxBin {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  readonly directory: Record<string, GfxEntry> = {};

  add(key: string, image: GfxImage, extra?: { walker?: boolean }): void {
    check(!(key in this.directory), `duplicate gfx key: ${key}`);
    const entry: GfxEntry = { off: this.size, w: image.w, h: image.h };
    if (extra?.walker !== undefined) entry.walker = extra.walker;
    this.directory[key] = entry;
    this.chunks.push(image.px);
    this.size += image.px.length;
  }

  has(key: string): boolean {
    return key in this.directory;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    return out;
  }
}
