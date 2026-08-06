// voxelmon/cook/structures.ts — the per-map scene analysis.
//
// Port of VoxelMod lib/Structures.lua forMap (:137): resolve the whole
// body+ring grid once, model buildings first (claims win), fold doors into
// their buildings, carve pinned round scenery, extract pinned standees,
// flood structural regions and measure their volumes, stand grass tufts and
// flower cutouts, then resolve synthesized ground.
//
// Not ported in v1 (docs/VOXEL.md §6 — pinned props only): the free object
// DETECTOR (extractObjects without force), stairs, bookcases, figures,
// mounted objects and relief props. Cells of those pools render through the
// mesher's plain box path.

import { type Shape, shapeAt as tileShapeAt, tileShapesFor } from "./classify.ts";
import {
  type Art,
  artOf,
  type GameMap,
  type GenData,
  PX_CLEAR,
  type Profile,
  sheetKeyOf,
} from "./data.ts";
import { DIRS4, keyOf, type SGrid } from "./geom.ts";
import { type BuildingStats, buildBuildings } from "./buildings.ts";
import { buildCylinders, ROUND_RING } from "./trees.ts";
import { buildGrass, buildFlowers } from "./grassflowers.ts";
import { buildPinnedStandees } from "./standees.ts";
import { buildVolume } from "./volumes.ts";

// VoxelMod ChunkMesher.lua:69 / Structures.lua:56 — ring width in tiles
// (3 blocks, matching the 2D renderer's border fill).
export const RING = 12;

// gen1recomp TileRenderer.lua:18 — OVERWORLD maps ring with the solid tree
// wall under the default "trees" void fill.
const TREE_WALL_BLOCK = 0x0f;

// Structures.lua:104 voidTiles — all-black-or-transparent art never extrudes.
const voidCache = new Map<string, Set<number>>();

function voidTiles(map: GameMap, art: Art): Set<number> {
  const id = map.tileset.id;
  const hit = voidCache.get(id);
  if (hit) return hit;
  const perRow = map.tileset.tilesPerRow || 16;
  const count = Math.floor(art.w / 8) * Math.floor(art.h / 8);
  const set = new Set<number>();
  for (let t = 0; t < count; t++) {
    const ox = (t % perRow) * 8;
    const oy = Math.floor(t / perRow) * 8;
    let isVoid = true;
    scan: for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const b = art.px(ox + px, oy + py);
        // a > 0 and max(r,g,b) > 0.17: any opaque non-black pixel
        if (b !== PX_CLEAR && b !== 3) {
          isVoid = false;
          break scan;
        }
      }
    }
    if (isVoid) set.add(t);
  }
  voidCache.set(id, set);
  return set;
}

/** Cells (body, "cx,cy") whose block Cut swaps and whose tiles are the
 *  pinned bush — these become removable STMP stamps. */
function cuttableCells(map: GameMap, gen: GenData, S: SGrid): Set<string> {
  const out = new Set<string>();
  const swaps = gen.field.cutTreeSwaps as { before: number; after: number }[] | undefined;
  if (!Array.isArray(swaps)) return out;
  const before = new Set(swaps.map((s) => s.before));
  for (let cy = 0; cy < map.def.height * 2; cy++) {
    for (let cx = 0; cx < map.def.width * 2; cx++) {
      const block = map.blockAt(Math.floor(cx / 2), Math.floor(cy / 2));
      if (!before.has(block)) continue;
      let allProp = true;
      for (let dy = 0; dy < 2 && allProp; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const s = S.shapeAt.get(keyOf(cx * 2 + dx, cy * 2 + dy));
          if (!(s && s.authored && s.class === "prop")) {
            allProp = false;
            break;
          }
        }
      }
      if (allProp) out.add(`${cx},${cy}`);
    }
  }
  return out;
}

export function analyseMap(
  gen: GenData,
  map: GameMap,
  profile: Profile | null,
  buildingStats: BuildingStats,
): SGrid {
  const art = artOf(gen, sheetKeyOf(map.tileset));
  if (!art) throw new Error(`missing tileset art: ${sheetKeyOf(map.tileset)}`);
  const shapes = tileShapesFor(map, profile);
  const voids = voidTiles(map, art);

  const tw = map.def.width * 4;
  const th = map.def.height * 4;
  const x0 = -RING;
  const x1 = tw + RING - 1;
  const y0 = -RING;
  const y1 = th + RING - 1;

  // Ring positions use the border override the 2D renderer draws with
  // (Structures.lua:150-197): outdoor maps ring with the tree wall, and the
  // TREES fill stops carving at ROUND_RING — beyond it nothing is built.
  const borderId = map.def.tileset === "OVERWORLD" ? TREE_WALL_BLOCK : map.def.borderBlock;
  const borderBlk: number[] | null =
    borderId !== undefined && borderId !== null ? map.tileset.blocks[borderId] : null;
  const hullRingOnly = borderBlk !== null && map.def.tileset === "OVERWORLD";

  const tileLookup = (tx: number, ty: number): number | null => {
    if (tx >= 0 && ty >= 0 && tx < tw && ty < th) return map.tileAt(tx, ty);
    if (!borderBlk) return null;
    if (
      hullRingOnly &&
      (tx < -ROUND_RING || ty < -ROUND_RING || tx >= tw + ROUND_RING || ty >= th + ROUND_RING)
    ) {
      return null;
    }
    return borderBlk[(((ty % 4) + 4) % 4) * 4 + (((tx % 4) + 4) % 4)] ?? 0;
  };

  const S: SGrid = {
    shapeAt: new Map(),
    tileAt: new Map(),
    outdoor: map.outdoor,
    // Upstream hides unclaimed ring cells so bare boxes never stand beside
    // carved wall hulls; with the wall on the BOX path (budget — see
    // trees.ts) the ring boxes ARE the render, so nothing hides.
    hideBareRing: false,
    wallTiles: hullRingOnly && borderBlk ? new Set(borderBlk) : null,
    runs: new Map(),
    skip: new Set(),
    ground: new Map(),
    doorFold: new Set(),
    objectQuads: [],
    grassQuads: [],
    flowerQuads: [],
    roundStamps: [],
    round: new Set(),
    stampQuads: new Map(),
    x0,
    x1,
    y0,
    y1,
  };

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const tile = tileLookup(tx, ty);
      if (tile === null) continue;
      const k = keyOf(tx, ty);
      let s = tileShapeAt(map, shapes, tile, tx, ty);
      if (s && voids.has(tile) && !s.authored) s = shapes.classes.void;
      if (s) S.shapeAt.set(k, s);
      S.tileAt.set(k, tile);
    }
  }

  // ---- buildings first: their claims keep every later pass off them ----
  buildBuildings(S, map, art, profile, buildingStats);

  // ---- door fold (Structures.lua:250-272) ----
  for (let cy = Math.floor(y0 / 2); cy <= Math.floor(y1 / 2); cy++) {
    for (let cx = Math.floor(x0 / 2); cx <= Math.floor(x1 / 2); cx++) {
      if (!map.doorTiles.has(map.cellTile(cx, cy))) continue;
      const ns = S.shapeAt.get(keyOf(cx * 2, cy * 2 - 1));
      if (ns && ns.art === "upright") {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const dk = keyOf(cx * 2 + dx, cy * 2 + dy);
            const ds = S.shapeAt.get(dk);
            if (!(ds && ds.authored)) {
              S.shapeAt.set(dk, shapes.classes.wall);
              S.doorFold.add(dk);
            }
          }
        }
      }
    }
  }

  // a structure cell: solid art the detector may model
  const structural = (k: number): boolean => {
    const s = S.shapeAt.get(k);
    return !!s && s.art === "upright" && !s.authored;
  };

  // ---- cylinders: the flat ground tiles this map places pick hull floors
  const groundTiles: number[] = [];
  {
    const seen = new Set<number>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = keyOf(tx, ty);
        const s = S.shapeAt.get(k);
        if (s && s.flat && s.class === "ground") {
          const t = S.tileAt.get(k)!;
          if (!seen.has(t)) {
            seen.add(t);
            groundTiles.push(t);
          }
        }
      }
    }
  }
  buildCylinders(S, map, art, groundTiles);

  // ---- flood-fill regions of structural tiles -> volumes ----
  const seen = new Set<number>();
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const k = keyOf(tx, ty);
      if (!structural(k) || seen.has(k)) continue;
      const tiles: [number, number][] = [];
      const queue: [number, number][] = [[tx, ty]];
      seen.add(k);
      while (queue.length > 0) {
        const c = queue.pop()!;
        tiles.push(c);
        for (const [dx, dy] of DIRS4) {
          const nx = c[0] + dx;
          const ny = c[1] + dy;
          if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
            const nk = keyOf(nx, ny);
            if (structural(nk) && !seen.has(nk)) {
              seen.add(nk);
              queue.push([nx, ny]);
            }
          }
        }
      }
      // v1: no per-pixel object detection — the whole region is volume.
      buildVolume(S, map, tiles);
    }
  }

  // ---- pinned standees (billboards, signposts, props, posts) ----
  const cuttable = cuttableCells(map, gen, S);
  buildPinnedStandees(S, map, art, profile, cuttable);

  // ---- tall grass (BODY only) + flowers ----
  buildGrass(S, map, art);
  buildFlowers(S, map, art, gen);

  // ---- authored ground under pinned props (prop_ground) ----
  const pg = profile?.tilesets?.[map.tileset.id]?.prop_ground;
  if (pg && typeof pg === "object") {
    for (const k of S.skip) {
      const g = (pg as Record<string, number>)[String(S.tileAt.get(k))];
      if (g !== undefined) S.ground.set(k, g);
    }
  }

  // ---- commonest-ground fallback for unresolved claims ----
  const votes = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const k = keyOf(tx, ty);
      const s = S.shapeAt.get(k);
      if (s && s.flat && s.class === "ground") {
        const t = S.tileAt.get(k)!;
        const n = (votes.get(t) ?? 0) + 1;
        votes.set(t, n);
        if (n > bestN) {
          best = t;
          bestN = n;
        }
      }
    }
  }
  for (const [k, g] of S.ground) {
    if (g === false && best !== undefined) S.ground.set(k, best);
  }

  return S;
}

export type { Shape };
