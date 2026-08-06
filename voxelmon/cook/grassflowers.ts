// voxelmon/cook/grassflowers.ts — tall grass tufts and animated flowers.
//
// Port of VoxelMod lib/Structures.lua buildGrass (:3462) + buildFlowers
// (:3674) and their templates. A tall-grass CELL is four tufts: each 8x8
// tile stands as its own thin slab at its OWN tile depth (centred zMid = 4)
// over the flat grass base; the animated flower tile stands as a 1px-thick
// cutout of its darkest tones plus their enclosure, unioned over every
// animation frame (the atlas frames trim the silhouette in texture space).
//
// SIDE_INSET (upstream 0.03, a z-fight guard for coplanar caps under
// culling-off rendering) is dropped: pak positions are i16 world px and the
// depth-tested rasterizer resolves coplanar interior caps.

import { GRASS_THICK_PX } from "../../contracts/spec/voxel-spec.ts";
import { type Art, type GameMap, type GenData, artOf, PX_CLEAR } from "./data.ts";
import { DIRS4, FACE, keyOf, type Quad, type SGrid } from "./geom.ts";
import { mergeQuads } from "./merge.ts";
import { OBJ_SHADE } from "./standees.ts";

interface TileArtRef {
  art: Art;
  ax0: number;
  ay0: number;
}

function tileRef(art: Art, map: GameMap, tileId: number): TileArtRef {
  const perRow = map.tileset.tilesPerRow || 16;
  return { art, ax0: (tileId % perRow) * 8, ay0: Math.floor(tileId / perRow) * 8 };
}

// Structures.lua:3335 sideQuads — the run's two end walls (or every pixel).
function sideQuads(
  quads: Quad[],
  ix: number,
  ix2: number,
  yBot: number,
  yTop: number,
  zB: number,
  zF: number,
  ax0: number,
  ay0: number,
  py: number,
  lit: (px: number, py: number) => boolean,
  everyPixel: boolean,
): void {
  const left = (px: number, at: number): void => {
    quads.push({
      c: [
        [at, yBot, zB],
        [at, yBot, zF],
        [at, yTop, zF],
        [at, yTop, zB],
      ],
      u: ax0 + px + 0.5,
      v: ay0 + py + 0.5,
      shade: OBJ_SHADE.side,
      // "left as seen from outside" is the low-x end of the run: -X.
      f: FACE.west,
    });
  };
  const right = (px: number, at: number): void => {
    quads.push({
      c: [
        [at, yBot, zF],
        [at, yBot, zB],
        [at, yTop, zB],
        [at, yTop, zF],
      ],
      u: ax0 + px + 0.5,
      v: ay0 + py + 0.5,
      shade: OBJ_SHADE.side,
      f: FACE.east,
    });
  };
  if (everyPixel) {
    for (let px = ix; px <= ix2; px++) {
      left(px, px);
      right(px, px + 1);
    }
    return;
  }
  if (!lit(ix - 1, py)) left(ix, ix);
  if (!lit(ix2 + 1, py)) right(ix2, ix2 + 1);
}

// Structures.lua:3386 grassTemplate — one tile is ONE standing piece.
function grassTemplate(ref: TileArtRef): Quad[] {
  const { art, ax0, ay0 } = ref;
  const opaque = (px: number, py: number): boolean => {
    if (px < 0 || px > 7 || py < 0 || py > 7) return false;
    const b = art.px(ax0 + px, ay0 + py);
    return b !== PX_CLEAR && b >= 1; // a > 0 and min(r,g,b) <= 0.83
  };

  const quads: Quad[] = [];
  const zMid = 4;
  const zB = zMid - GRASS_THICK_PX / 2;
  const zF = zMid + GRASS_THICK_PX / 2;
  for (let iy = 0; iy < 8; iy++) {
    const yTop = 8 - iy;
    const yBot = yTop - 1;
    let ix = 0;
    while (ix < 8) {
      if (!opaque(ix, iy)) {
        ix++;
        continue;
      }
      let ix2 = ix;
      while (ix2 + 1 < 8 && opaque(ix2 + 1, iy)) ix2++;
      const u0 = ax0 + ix + 0.05;
      const u1 = ax0 + ix2 + 0.95;
      const v0 = ay0 + iy + 0.05;
      const v1 = ay0 + iy + 0.95;
      quads.push({
        c: [
          [ix, yBot, zF],
          [ix2 + 1, yBot, zF],
          [ix2 + 1, yTop, zF],
          [ix, yTop, zF],
        ],
        uv: [
          [u0, v1],
          [u1, v1],
          [u1, v0],
          [u0, v0],
        ],
        shade: 1,
        // zF = zMid + THICK/2 > zB: the tuft's drawn face is the south one
        // (shade 1 / 0.68 are OBJ_SHADE.front / .back written out).
        f: FACE.south,
      });
      quads.push({
        c: [
          [ix2 + 1, yBot, zB],
          [ix, yBot, zB],
          [ix, yTop, zB],
          [ix2 + 1, yTop, zB],
        ],
        uv: [
          [u1, v1],
          [u0, v1],
          [u0, v0],
          [u1, v0],
        ],
        shade: 0.68,
        f: FACE.north,
      });
      if (!opaque(ix, iy - 1)) {
        quads.push({
          c: [
            [ix, yTop, zB],
            [ix2 + 1, yTop, zB],
            [ix2 + 1, yTop, zF],
            [ix, yTop, zF],
          ],
          uv: [
            [u0, v0],
            [u1, v0],
            [u1, v0],
            [u0, v0],
          ],
          shade: 1,
          f: FACE.up,
        });
      }
      if (!opaque(ix, iy + 1)) {
        quads.push({
          c: [
            [ix, yBot, zF],
            [ix2 + 1, yBot, zF],
            [ix2 + 1, yBot, zB],
            [ix, yBot, zB],
          ],
          uv: [
            [u0, v1],
            [u1, v1],
            [u1, v1],
            [u0, v1],
          ],
          shade: OBJ_SHADE.bottom,
          f: FACE.down,
        });
      }
      sideQuads(quads, ix, ix2, yBot, yTop, zB, zF, ax0, ay0, iy, opaque, false);
      ix = ix2 + 1;
    }
  }
  // cook-time merge of the same-shade end walls (see merge.ts)
  return mergeQuads(quads, (u, v) => art.px(Math.floor(u), Math.floor(v)));
}

// Structures.lua:3462 buildGrass — BODY only, tufts only where the CELL is
// tall grass by the engine's own rule.
export function buildGrass(S: SGrid, map: GameMap, art: Art): void {
  const templates = new Map<number, Quad[]>();
  const tw = map.def.width * 4;
  const th = map.def.height * 4;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const k = keyOf(tx, ty);
      const s = S.shapeAt.get(k);
      if (!s || s.art !== "grass") continue;
      if (!map.isGrassCell(Math.floor(tx / 2), Math.floor(ty / 2))) continue;
      const tileId = S.tileAt.get(k)!;
      let tpl = templates.get(tileId);
      if (!tpl) templates.set(tileId, (tpl = grassTemplate(tileRef(art, map, tileId))));
      const wx = tx * 8;
      const wz = ty * 8;
      for (const q of tpl) {
        S.grassQuads.push({
          c: q.c.map(([x, y, z]) => [x + wx, y, z + wz]) as [number, number, number][],
          uv: q.uv,
          u: q.u,
          v: q.v,
          shade: q.shade,
          f: q.f,
        });
      }
    }
  }
}

// Structures.lua:3516/3535 flower frames + template.
const FLOWER_THICK = 1;

function flowerTemplate(gen: GenData, ref: TileArtRef): Quad[] {
  const { art, ax0, ay0 } = ref;

  // dark tones + border-flood enclosure, per image, unioned
  const dark = new Set<number>();
  const markMask = (img: Art, ox: number, oy: number): void => {
    const d = new Set<number>();
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const b = img.px(ox + px, oy + py);
        if (b !== PX_CLEAR && b >= 2) d.add(py * 8 + px); // min <= 0.5
      }
    }
    const reach = new Set<number>();
    const stack: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (const s of [i, 56 + i, i * 8, i * 8 + 7]) {
        if (!d.has(s) && !reach.has(s)) {
          reach.add(s);
          stack.push(s);
        }
      }
    }
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % 8;
      const py = Math.floor(p / 8);
      for (const [dx, dy] of DIRS4) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
          const ni = ny * 8 + nx;
          if (!d.has(ni) && !reach.has(ni)) {
            reach.add(ni);
            stack.push(ni);
          }
        }
      }
    }
    for (let i = 0; i < 64; i++) {
      if (d.has(i) || !reach.has(i)) dark.add(i);
    }
  };
  markMask(art, ax0, ay0);
  for (const key of ["tilesets/flower1", "tilesets/flower2", "tilesets/flower3"]) {
    const frame = artOf(gen, key);
    if (frame) markMask(frame, 0, 0);
  }

  const on = (px: number, py: number): boolean => {
    if (px < 0 || px > 7 || py < 0 || py > 7) return false;
    return dark.has(py * 8 + px);
  };

  const quads: Quad[] = [];
  const zB = 4 - FLOWER_THICK / 2;
  const zF = zB + FLOWER_THICK;
  for (let py = 0; py < 8; py++) {
    const yTop = 8 - py;
    const yBot = 7 - py;
    let ix = 0;
    while (ix < 8) {
      if (!on(ix, py)) {
        ix++;
        continue;
      }
      let ix2 = ix;
      while (ix2 + 1 < 8 && on(ix2 + 1, py)) ix2++;
      const u0 = ax0 + ix + 0.05;
      const u1 = ax0 + ix2 + 0.95;
      const v0 = ay0 + py + 0.05;
      const v1 = ay0 + py + 0.95;
      quads.push({
        c: [
          [ix, yBot, zF],
          [ix2 + 1, yBot, zF],
          [ix2 + 1, yTop, zF],
          [ix, yTop, zF],
        ],
        uv: [
          [u0, v1],
          [u1, v1],
          [u1, v0],
          [u0, v0],
        ],
        shade: OBJ_SHADE.front,
        f: FACE.south,
      });
      quads.push({
        c: [
          [ix2 + 1, yBot, zB],
          [ix, yBot, zB],
          [ix, yTop, zB],
          [ix2 + 1, yTop, zB],
        ],
        uv: [
          [u1, v1],
          [u0, v1],
          [u0, v0],
          [u1, v0],
        ],
        shade: OBJ_SHADE.back,
        f: FACE.north,
      });
      // every pixel gets caps on all four remaining faces: a pixel keyed
      // out by the CURRENT frame exposes them (Structures.lua:3620-3662)
      for (let px = ix; px <= ix2; px++) {
        const tu = ax0 + px + 0.5;
        const tv = ay0 + py + 0.5;
        quads.push({
          c: [
            [px, yTop, zB],
            [px + 1, yTop, zB],
            [px + 1, yTop, zF],
            [px, yTop, zF],
          ],
          u: tu,
          v: tv,
          shade: OBJ_SHADE.top,
          f: FACE.up,
        });
        quads.push({
          c: [
            [px, yBot, zF],
            [px + 1, yBot, zF],
            [px + 1, yBot, zB],
            [px, yBot, zB],
          ],
          u: tu,
          v: tv,
          shade: OBJ_SHADE.bottom,
          f: FACE.down,
        });
      }
      sideQuads(quads, ix, ix2, yBot, yTop, zB, zF, ax0, ay0, py, on, true);
      ix = ix2 + 1;
    }
  }
  return quads;
}

// Structures.lua:3674 buildFlowers — synthesized ground everywhere, standee
// BODY only.
export function buildFlowers(S: SGrid, map: GameMap, art: Art, gen: GenData): void {
  const templates = new Map<number, Quad[]>();
  const tw = map.def.width * 4;
  const th = map.def.height * 4;
  for (let ty = S.y0; ty <= S.y1; ty++) {
    for (let tx = S.x0; tx <= S.x1; tx++) {
      const k = keyOf(tx, ty);
      const s = S.shapeAt.get(k);
      if (!s || s.art !== "flower") continue;
      S.skip.add(k);
      const votes = new Map<number, number>();
      let best: number | undefined;
      let bestN = 0;
      for (const [dx, dy] of DIRS4) {
        const nk = keyOf(tx + dx, ty + dy);
        const ns = S.shapeAt.get(nk);
        if (ns && ns.flat && ns.class !== "void" && ns.class !== "flower") {
          const t = S.tileAt.get(nk)!;
          const n = (votes.get(t) ?? 0) + 1;
          votes.set(t, n);
          if (n > bestN) {
            best = t;
            bestN = n;
          }
        }
      }
      S.ground.set(k, best ?? false);

      if (tx >= 0 && ty >= 0 && tx < tw && ty < th) {
        const tileId = S.tileAt.get(k)!;
        let tpl = templates.get(tileId);
        if (!tpl) templates.set(tileId, (tpl = flowerTemplate(gen, tileRef(art, map, tileId))));
        const wx = tx * 8;
        const wz = ty * 8;
        for (const q of tpl) {
          S.flowerQuads.push({
            c: q.c.map(([x, y, z]) => [x + wx, y, z + wz]) as [number, number, number][],
            uv: q.uv,
            u: q.u,
            v: q.v,
            shade: q.shade,
            f: q.f,
          });
        }
      }
    }
  }
}
