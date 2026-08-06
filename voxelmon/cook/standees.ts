// voxelmon/cook/standees.ts — profile-pinned per-pixel standees.
//
// Port of the FORCED paths of VoxelMod lib/Structures.lua extractObjects
// (:2305) + buildObject (:2550): a pinned billboard/signpost/prop/post cell
// is voxelized per pixel by decree — segmentation only decides which pixels
// are background. The free DETECTION path (sprite-likeness, cluster
// validation) is deliberately not ported: v1 ships pinned props only
// (docs/VOXEL.md §6).

import type { Shape } from "./classify.ts";
import { type Art, type GameMap, type Profile, shadeClassOf } from "./data.ts";
import { DIRS4, FACE, type Facing, keyOf, type Quad, type SGrid } from "./geom.ts";
import { mergeQuads } from "./merge.ts";

// VoxelMod Structures.lua:82 PINNED_DEPTH.
const PINNED_DEPTH: Record<string, number> = {
  billboard: 10,
  prop: 5,
  stool: 10,
  cutout: 1,
  console: 10,
  post: 6,
  signpost: 2,
  bike: 2,
};

// VoxelMod Structures.lua:2283 OBJ_SHADE.
export const OBJ_SHADE = { front: 1.0, back: 0.68, side: 0.78, top: 1.0, bottom: 0.55 };

export interface Region {
  tiles: [number, number][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface Ctx {
  S: SGrid;
  map: GameMap;
  art: Art;
  profile: Profile | null;
  /** When set, this region's quads become a cut-tree STMP stamp. */
  stampKey?: string;
}

/** prop_bg override (TileShape.lua:631 propBg): tile id -> shade-name set. */
function propBgOf(profile: Profile | null, tilesetId: string): Map<number, Set<string>> | null {
  const list = profile?.tilesets?.[tilesetId]?.prop_bg;
  // prop_bg in the shipped profile is a map (tile -> ground) ONLY for
  // prop_ground; the prop_bg list form is [{tiles, shades}].
  if (!Array.isArray(list)) return null;
  const SHADES = new Set(["black", "dark", "light", "white"]);
  const out = new Map<number, Set<string>>();
  for (const rule of list as { tiles?: number[]; shades?: string[] }[]) {
    if (!Array.isArray(rule.tiles) || !Array.isArray(rule.shades)) continue;
    const set = new Set(rule.shades.filter((s) => SHADES.has(s)));
    if (set.size === 0) continue;
    for (const t of rule.tiles) out.set(t, set);
  }
  return out.size > 0 ? out : null;
}

/**
 * Forced extraction of one pinned region (extractObjects with `force`).
 * `force` is true (shade-segmented pools) or "opaque" (the post pool).
 */
export function extractForced(ctx: Ctx, region: Region, force: true | "opaque"): void {
  const { S, map, art } = ctx;
  const perRow = map.tileset.tilesPerRow || 16;
  const bw = (region.maxX - region.minX + 1) * 8;
  const bh = (region.maxY - region.minY + 1) * 8;
  const member = new Set<number>();
  for (const [tx, ty] of region.tiles) member.add(keyOf(tx, ty));

  // Pixel states over the bbox + 1px apron (Structures.lua:2328-2378).
  const W = bw + 2;
  const H = bh + 2;
  const state: (string | null)[] = new Array(W * H).fill(null);
  const srcU = new Array<number>(W * H);
  const srcV = new Array<number>(W * H);
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix;
      const px = ix - 1;
      const py = iy - 1;
      const tx = region.minX + Math.floor(px / 8);
      const ty = region.minY + Math.floor(py / 8);
      const k = keyOf(tx, ty);
      const inside = px >= 0 && px < bw && py >= 0 && py < bh;
      if (inside && member.has(k)) {
        const tile = S.tileAt.get(k)!;
        const ax = (tile % perRow) * 8 + (((px % 8) + 8) % 8);
        const ay = Math.floor(tile / perRow) * 8 + (((py % 8) + 8) % 8);
        srcU[i] = ax;
        srcV[i] = ay;
        const cls = shadeClassOf(art.px(ax, ay));
        if (cls === "off") state[i] = "cand";
        else if (force !== "opaque") state[i] = cls;
        else state[i] = cls === "white" ? "cand" : "solid";
      } else if (inside || iy === H - 1 || iy === 0 || ix === 0 || ix === W - 1) {
        // forced props flood from every apron (Structures.lua:2344);
        // interior non-member pixels seed but never drain paint whites
        state[i] = inside ? "iair" : "air";
      } else {
        state[i] = "barrier";
      }
    }
  }

  // Shade-class segmentation for pinned pools (Structures.lua:2392-2451).
  if (force !== "opaque") {
    const first = S.shapeAt.get(keyOf(region.tiles[0][0], region.tiles[0][1]));
    const strict = first?.class === "cutout";
    const bg = new Set<string>();
    const named = propBgOf(ctx.profile, map.tileset.id);
    if (named) {
      for (const [tx, ty] of region.tiles) {
        const rule = named.get(S.tileAt.get(keyOf(tx, ty))!);
        if (rule) {
          for (const s of rule) bg.add(s);
          break;
        }
      }
    }
    if (bg.size === 0) {
      for (let iy = 0; iy < H; iy++) {
        for (let ix = 0; ix < W; ix++) {
          const px = ix - 1;
          const py = iy - 1;
          const edge = px === 0 || px === bw - 1 || py === 0 || py === bh - 1;
          const st = state[iy * W + ix];
          if (edge && (st === "dark" || st === "light" || st === "white")) bg.add(st);
        }
      }
      if (!bg.has("dark") && !bg.has("light") && !bg.has("white")) bg.add("white");
    }
    for (let i = 0; i < W * H; i++) {
      const st = state[i];
      if (strict) {
        if (st === "dark" || st === "light") state[i] = "cand";
        else if (st === "white") state[i] = "wcand";
        else if (st === "black") state[i] = "solid";
      } else if (st === "dark" || st === "light" || st === "white") {
        state[i] = bg.has(st) ? "cand" : "solid";
      } else if (st === "black") {
        state[i] = "solid";
      }
    }
  }

  // Flood background in from the aprons (Structures.lua:2454-2485).
  const flooded = new Uint8Array(W * H);
  const queue: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (state[i] === "air" || state[i] === "iair") {
      flooded[i] = 1;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const ix = i % W;
    const iy = Math.floor(i / W);
    for (const [dx, dy] of DIRS4) {
      const nx = ix + dx;
      const ny = iy + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (flooded[ni]) continue;
      const ns = state[ni];
      if (
        ns === "cand" ||
        ns === "air" ||
        ns === "iair" ||
        (ns === "wcand" && (state[i] === "air" || state[i] === "wcand"))
      ) {
        flooded[ni] = 1;
        queue.push(ni);
      }
    }
  }

  buildForcedObject(ctx, region, state, flooded, srcU, srcV, W);
}

// The force path of Structures.buildObject (:2550): per-pixel voxel columns
// standing in the depth band of their own drawn tile row.
function buildForcedObject(
  ctx: Ctx,
  cluster: Region,
  state: (string | null)[],
  flooded: Uint8Array,
  srcU: number[],
  srcV: number[],
  W: number,
): void {
  const { S, map } = ctx;
  const memberC = new Set<number>();
  for (const [tx, ty] of cluster.tiles) memberC.add(keyOf(tx, ty));

  const bw = (cluster.maxX - cluster.minX + 1) * 8;
  const bh = (cluster.maxY - cluster.minY + 1) * 8;
  const solidPx = new Array<number | undefined>(bw * bh);
  let count = 0;
  for (const [ctx_, cty] of cluster.tiles) {
    const rx = (ctx_ - cluster.minX) * 8;
    const ry = (cty - cluster.minY) * 8;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const i = (ry + py + 1) * W + (rx + px + 1);
        const st = state[i];
        const on = st !== null && st !== "air" && st !== "iair" && st !== "barrier" && !flooded[i];
        if (on) {
          solidPx[(ry + py) * bw + (rx + px)] = i;
          count++;
        }
      }
    }
  }
  if (count === 0) return;

  const cs = S.shapeAt.get(keyOf(cluster.tiles[0][0], cluster.tiles[0][1]));
  const depth = (cs && PINNED_DEPTH[cs.class]) || PINNED_DEPTH.billboard;
  const wx0 = cluster.minX * 8;

  // A pinned prop over an authored box stands ON it (Structures.lua:2662).
  let baseY = 0;
  let support: Shape | null = null;
  if (cs && cs.art !== "post") {
    const bs = S.shapeAt.get(keyOf(cluster.minX, cluster.maxY + 1));
    const blocked = !map.isWalkableCell(Math.floor(cluster.minX / 2), Math.floor(cluster.maxY / 2));
    if (
      blocked &&
      bs &&
      bs.authored &&
      (bs.h || 0) > 0 &&
      (bs.art === "upright" || bs.art === "bookcase" || bs.class === "building")
    ) {
      baseY = bs.h;
      support = bs;
    }
  }

  // Connected components, 8-connectivity (Structures.lua:2699-2735).
  interface Comp {
    lowY: number;
    n: number;
    z0: number;
    z1: number;
  }
  const comp = new Array<Comp | undefined>(bw * bh);
  const comps: Comp[] = [];
  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const idx = ly * bw + lx;
      if (solidPx[idx] === undefined || comp[idx]) continue;
      const c: Comp = { lowY: ly, n: 0, z0: 0, z1: 0 };
      comps.push(c);
      const stack = [idx];
      comp[idx] = c;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const px = p % bw;
        const py = Math.floor(p / bw);
        c.n++;
        if (py > c.lowY) c.lowY = py;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            const ny = py + dy;
            if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
            const ni = ny * bw + nx;
            if (solidPx[ni] !== undefined && !comp[ni]) {
              comp[ni] = c;
              stack.push(ni);
            }
          }
        }
      }
    }
  }
  for (const c of comps) {
    c.z0 = cluster.minY * 8 + Math.floor(c.lowY / 8) * 8 + (support ? 8 : 0) + (8 - depth) / 2;
    c.z1 = c.z0 + depth;
  }

  // cutout/console: one object by contract — keep the largest component.
  if (cs && (cs.class === "cutout" || cs.class === "console") && comps.length > 1) {
    let biggest = comps[0];
    for (const c of comps) if (c.n > biggest.n) biggest = c;
    for (let idx = 0; idx < bw * bh; idx++) {
      if (comp[idx] && comp[idx] !== biggest) solidPx[idx] = undefined;
    }
  }

  const at = (lx: number, ly: number): number | undefined => {
    if (lx < 0 || lx >= bw || ly < 0 || ly >= bh) return undefined;
    return solidPx[ly * bw + lx];
  };

  const out: Quad[] = [];
  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const i = at(lx, ly);
      if (i === undefined) continue;
      const c = comp[ly * bw + lx]!;
      const z0 = c.z0;
      const z1 = c.z1;
      const x = wx0 + lx;
      const y = baseY + c.lowY - ly;
      const u = srcU[i] + 0.5;
      const v = srcV[i] + 0.5;
      const quad = (cs4: [number, number, number][], shade: number, f: Facing): void => {
        out.push({ c: cs4, u, v, shade, f });
      };
      // z1 = z0 + depth, so the drawing (front) is the SOUTH face.
      quad(
        [
          [x, y, z1],
          [x + 1, y, z1],
          [x + 1, y + 1, z1],
          [x, y + 1, z1],
        ],
        OBJ_SHADE.front,
        FACE.south,
      );
      quad(
        [
          [x + 1, y, z0],
          [x, y, z0],
          [x, y + 1, z0],
          [x + 1, y + 1, z0],
        ],
        OBJ_SHADE.back,
        FACE.north,
      );
      if (at(lx, ly - 1) === undefined) {
        quad(
          [
            [x, y + 1, z0],
            [x + 1, y + 1, z0],
            [x + 1, y + 1, z1],
            [x, y + 1, z1],
          ],
          OBJ_SHADE.top,
          FACE.up,
        );
      }
      if (y > baseY && at(lx, ly + 1) === undefined) {
        quad(
          [
            [x, y, z1],
            [x + 1, y, z1],
            [x + 1, y, z0],
            [x, y, z0],
          ],
          OBJ_SHADE.bottom,
          FACE.down,
        );
      }
      if (at(lx - 1, ly) === undefined) {
        quad(
          [
            [x, y, z0],
            [x, y, z1],
            [x, y + 1, z1],
            [x, y + 1, z0],
          ],
          OBJ_SHADE.side,
          FACE.west,
        );
      }
      if (at(lx + 1, ly) === undefined) {
        quad(
          [
            [x + 1, y, z1],
            [x + 1, y, z0],
            [x + 1, y + 1, z0],
            [x + 1, y + 1, z1],
          ],
          OBJ_SHADE.side,
          FACE.east,
        );
      }
    }
  }
  // cook-time merge: same-shade flat faces collapse (see merge.ts)
  const merged = mergeQuads(out, (u, v) => ctx.art.px(Math.floor(u), Math.floor(v)));
  if (ctx.stampKey) S.stampQuads.set(ctx.stampKey, merged);
  else S.objectQuads.push(...merged);

  // Ground under the claim: the commonest flat neighbour
  // (Structures.lua:2799-2862, support branches included).
  const votes = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (const [tx, ty] of cluster.tiles) {
    for (const [dx, dy] of DIRS4) {
      const nk = keyOf(tx + dx, ty + dy);
      const ns = S.shapeAt.get(nk);
      if (ns && ns.flat && ns.class !== "void" && !memberC.has(nk)) {
        const t = S.tileAt.get(nk)!;
        const n = (votes.get(t) ?? 0) + 1;
        votes.set(t, n);
        if (n > bestN) {
          best = t;
          bestN = n;
        }
      }
    }
  }
  for (const [tx, ty] of cluster.tiles) {
    const k = keyOf(tx, ty);
    if (
      support &&
      (support.class === "wall" ||
        support.class === "cliff" ||
        support.art === "bookcase" ||
        support.class === "building")
    ) {
      S.skip.add(k);
      S.ground.set(k, best ?? S.ground.get(k) ?? false);
    } else if (support) {
      // the claimed tile keeps rendering as the box the prop stands on
      S.shapeAt.set(k, support);
      let src = keyOf(tx, cluster.maxY + 1);
      outer: for (let dx = 1; dx <= 3; dx++) {
        for (const sx of [tx - dx, tx + dx]) {
          const nk = keyOf(sx, ty);
          const ns = S.shapeAt.get(nk);
          if (!memberC.has(nk) && ns && ns.authored && ns.class === support.class) {
            src = nk;
            break outer;
          }
        }
      }
      const st = S.tileAt.get(src);
      if (st !== undefined) S.tileAt.set(k, st);
    } else {
      S.skip.add(k);
      S.ground.set(k, best ?? false);
    }
  }
}

/**
 * The pinned-pool scans of Structures.forMap (:371-440): billboard-art
 * clusters (same class), then per-CELL post pools. Cut-tree cells route
 * their quads to STMP stamps via `cuttable`.
 */
export function buildPinnedStandees(
  S: SGrid,
  map: GameMap,
  art: Art,
  profile: Profile | null,
  cuttable: Set<string>,
): void {
  const ctx: Ctx = { S, map, art, profile };

  // billboard-art clusters, flooded by class (Structures.lua:373-407)
  const seenB = new Set<number>();
  for (let ty = S.y0; ty <= S.y1; ty++) {
    for (let tx = S.x0; tx <= S.x1; tx++) {
      const k = keyOf(tx, ty);
      const s = S.shapeAt.get(k);
      if (!s || s.art !== "billboard" || seenB.has(k)) continue;
      const reg: Region = { tiles: [], minX: tx, maxX: tx, minY: ty, maxY: ty };
      const queue: [number, number][] = [[tx, ty]];
      seenB.add(k);
      while (queue.length > 0) {
        const c = queue.pop()!;
        reg.tiles.push(c);
        reg.minX = Math.min(reg.minX, c[0]);
        reg.maxX = Math.max(reg.maxX, c[0]);
        reg.minY = Math.min(reg.minY, c[1]);
        reg.maxY = Math.max(reg.maxY, c[1]);
        for (const [dx, dy] of DIRS4) {
          const nk = keyOf(c[0] + dx, c[1] + dy);
          const ns = S.shapeAt.get(nk);
          // same CLASS, not just billboard art: separate pools cluster
          // separately so touching drawings never stack
          if (ns && ns.art === "billboard" && ns.class === s.class && !seenB.has(nk)) {
            seenB.add(nk);
            queue.push([c[0] + dx, c[1] + dy]);
          }
        }
      }
      // A cluster whose cell is a cuttable bush becomes a STMP stamp: the
      // stamp key is the cluster's CELL (its tiles span exactly one cell).
      const cellX = Math.floor(reg.minX / 2);
      const cellY = Math.floor(reg.minY / 2);
      const cellKey = `${cellX},${cellY}`;
      const isStamp =
        cuttable.has(cellKey) && reg.maxX - reg.minX <= 1 && reg.maxY - reg.minY <= 1;
      extractForced({ ...ctx, stampKey: isStamp ? cellKey : undefined }, reg, true);
    }
  }

  // post pools: each CELL extracts alone (Structures.lua:409-440)
  const postCells = new Map<number, [number, number][]>();
  for (let ty = S.y0; ty <= S.y1; ty++) {
    for (let tx = S.x0; tx <= S.x1; tx++) {
      const s = S.shapeAt.get(keyOf(tx, ty));
      if (s && s.art === "post") {
        const ck = keyOf(Math.floor(tx / 2), Math.floor(ty / 2));
        let list = postCells.get(ck);
        if (!list) postCells.set(ck, (list = []));
        list.push([tx, ty]);
      }
    }
  }
  for (const ck of [...postCells.keys()].sort((a, b) => a - b)) {
    const tiles = postCells.get(ck)!;
    const reg: Region = {
      tiles,
      minX: tiles[0][0],
      maxX: tiles[0][0],
      minY: tiles[0][1],
      maxY: tiles[0][1],
    };
    for (const [tx, ty] of tiles) {
      reg.minX = Math.min(reg.minX, tx);
      reg.maxX = Math.max(reg.maxX, tx);
      reg.minY = Math.min(reg.minY, ty);
      reg.maxY = Math.max(reg.maxY, ty);
    }
    extractForced(ctx, reg, "opaque");
  }
}
