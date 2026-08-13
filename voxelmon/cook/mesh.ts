// voxelmon/cook/mesh.ts — the terrain mesher + chunk packer.
//
// Port of VoxelMod lib/ChunkMesher.lua runGeometry (:233): flat tops, side
// faces cut into 8px bands with CROPPED art, the volume fold (band k samples
// the map row k tiles north of the front), gables with hipped flanks, baked
// per-vertex AO, synthesized ground under claimed tiles, water routed to its
// own stream — then everything partitioned into 16x16-tile CHUNKs and packed
// as GE vertices (i16 world px, f32 UV into the combined terrain page).

import {
  AO,
  CHUNK_PX,
  FACE_SHADE,
  GABLE_TOP_SHADE,
  MAX_VERTS_PER_CHUNK_MESH,
  MESH_KIND,
  MESH_KINDS,
  VXPK_CHUNK_FLAG_BORDER_RING,
  VOLUME_TOP_SHADE,
} from "../../contracts/spec/voxel-spec.ts";
import type { GameMap } from "./data.ts";
import { cullHidden, FACE, keyOf, PULLED, type Quad, type SGrid } from "./geom.ts";
import { RING } from "./structures.ts";

// VoxelMod ChunkMesher.lua:86 INSET — a sliver of a texel, deliberately not
// half a texel (half squeezes 8 texels into a 7-texel range and drifts).
const INSET = 0.02;

// FACE_SHADE by direction id (Voxel3D.lua:63).
const DIR_SHADE: Record<number, number> = {
  1: FACE_SHADE.east,
  2: FACE_SHADE.west,
  3: FACE_SHADE.up,
  4: FACE_SHADE.down,
  5: FACE_SHADE.south,
  6: FACE_SHADE.north,
};

// Horizontal neighbours: tile step, face direction id (ChunkMesher.lua:98).
const SIDES: [number, number, number][] = [
  [1, 0, 1], // +X east
  [-1, 0, 2], // -X west
  [0, 1, 5], // +Z south
  [0, -1, 6], // -Z north
];

// ChunkMesher.lua:334 LATERAL — flanking columns per face, left then right
// as seen from outside.
const LATERAL: Record<number, [number, number, number, number]> = {
  1: [0, 1, 0, -1],
  2: [0, -1, 0, 1],
  5: [-1, 0, 1, 0],
  6: [1, 0, -1, 0],
};

export interface MapGeometry {
  /** Terrain, carved tree hulls included and marked (`Quad.tree`). */
  terrain: Quad[];
  /**
   * The MIDDLE level of detail: the same hulls carved at 2x2-px voxels
   * (trees.ts `step`), ~1/4 the fine quads with full-resolution art on the
   * faces. Its own stream — unlike the fine hulls it never rides terrain,
   * because nothing about the identity rung depends on its order.
   */
  treeCoarse: Quad[];
  /**
   * The FAR level of detail: every hull-claimed cell re-extruded as the plain
   * box the mesher would have built for it had no hull been carved. Drawn
   * INSTEAD of the carved levels past `treeCoarseDist`, never with them.
   */
  treeBox: Quad[];
  water: Quad[];
  grass: Quad[];
  flower: Quad[];
  /** Cut-tree stamps: cell key "cx,cy" -> quads. */
  stamps: Map<string, Quad[]>;
}

/** One connected neighbour body's bounds in this map's world-pixel space. */
export interface BorderMask {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

type BorderScope = "body" | "ring";

function masked(
  masks: readonly BorderMask[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  closed: boolean,
): boolean {
  return masks.some((mask) =>
    closed
      ? x1 >= mask.x0 && x0 <= mask.x1 && z1 >= mask.z0 && z0 <= mask.z1
      : x1 > mask.x0 && x0 < mask.x1 && z1 > mask.z0 && z0 < mask.z1,
  );
}

function containedInMask(
  masks: readonly BorderMask[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  return masks.some(
    (mask) => x0 >= mask.x0 && x1 <= mask.x1 && z0 >= mask.z0 && z1 <= mask.z1,
  );
}

function quadBounds(q: Quad): [number, number, number, number] {
  const xs = q.c.map((corner) => corner[0]);
  const zs = q.c.map((corner) => corner[2]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

function extentScope(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  bodyW: number,
  bodyH: number,
  masks: readonly BorderMask[],
): BorderScope | null {
  const overBody = x1 > 0 && x0 < bodyW && z1 > 0 && z0 < bodyH;
  if (overBody) return "body";
  return masked(masks, x0, z0, x1, z1, true) ? null : "ring";
}

function outwardOnBodyEdge(q: Quad, bodyW: number, bodyH: number): boolean {
  const [x0, z0, x1, z1] = quadBounds(q);
  if (z0 === z1 && (z0 === 0 || z0 === bodyH) && x1 > 0 && x0 < bodyW) {
    return (z0 === bodyH && q.f === FACE.south) || (z0 === 0 && q.f === FACE.north);
  }
  if (x0 === x1 && (x0 === 0 || x0 === bodyW) && z1 > 0 && z0 < bodyH) {
    return (x0 === bodyW && q.f === FACE.east) || (x0 === 0 && q.f === FACE.west);
  }
  return false;
}

function scoped(q: Quad, scope: BorderScope): Quad {
  return scope === "ring" ? { ...q, borderRing: true } : { ...q, borderRing: undefined };
}

/** Emit one map body plus its masked, current-map-only protective ring. */
export function runGeometry(
  map: GameMap,
  S: SGrid,
  masks: readonly BorderMask[] = [],
  keepHidden = false,
): MapGeometry {
  const terrain: Quad[] = [];
  const water: Quad[] = [];
  const perRow = map.tileset.tilesPerRow || 16;
  let emittingBorderRing = false;

  // Two readings of the same grid. `heightAt` is the cook's own: a claimed
  // cell is flat ground, because an object stands on it. `boxHeightAt` is
  // what the grid would have said had the round hulls never been carved —
  // a hull-claimed cell extrudes to its class height — and it is what the
  // tree-box level of detail is meshed against, so a run of trees does not
  // grow interior walls between its own cells.
  const heightIn =
    (boxes: boolean) =>
    (tx: number, ty: number): number => {
      const k = keyOf(tx, ty);
      if (boxes && S.round.has(k)) {
        const s = S.shapeAt.get(k);
        return s ? s.h : 0;
      }
      if (S.skip.has(k)) return 0;
      const run = S.runs.get(k);
      if (run) return run.h;
      const s = S.shapeAt.get(k);
      return s ? s.h : 0;
    };
  const heightAt = heightIn(false);
  const boxHeightAt = heightIn(true);

  // one atlas-rect UV in SHEET px, optionally cropped to art rows
  // [vTop, vBot] of 8 (ChunkMesher.lua:252 uvRect)
  const uvRect = (tile: number, vTop: number, vBot: number): [number, number, number, number] => {
    const ax = (tile % perRow) * 8;
    const ay = Math.floor(tile / perRow) * 8;
    const vi = Math.min(INSET, (vBot - vTop) / 4);
    return [ax + INSET, ax + 8 - INSET, ay + vTop + vi, ay + vBot - vi];
  };

  // ---- baked ambient occlusion (ChunkMesher.lua:283-369; spec AO) ----
  const aoShades = (
    tx: number,
    ty: number,
    h: number,
    shade: number,
    ha: (tx: number, ty: number) => number = heightAt,
  ): number | number[] => {
    const n = ha(tx, ty - 1) > h;
    const s = ha(tx, ty + 1) > h;
    const e = ha(tx + 1, ty) > h;
    const w = ha(tx - 1, ty) > h;
    const nw = ha(tx - 1, ty - 1) > h;
    const ne = ha(tx + 1, ty - 1) > h;
    const sw = ha(tx - 1, ty + 1) > h;
    const se = ha(tx + 1, ty + 1) > h;
    if (!(n || s || e || w || nw || ne || sw || se)) return shade;
    const corner = (a: boolean, b: boolean, d: boolean): number => {
      let k = 0;
      if (a) k++;
      if (b) k++;
      // a diagonal wedged behind both of its edges adds nothing
      if (d && !(a && b)) k++;
      return shade * Math.max(AO.floor, 1 - AO.step * k);
    };
    // corners in topQuad order: NW, NE, SE, SW
    return [corner(n, w, nw), corner(n, e, ne), corner(s, e, se), corner(s, w, sw)];
  };

  const AO_CORNER = Math.max(AO.floor, AO.edge * AO.edge);
  const sideShades = (
    hl: number,
    hr: number,
    y0: number,
    y1: number,
    crease: boolean,
    shade: number,
  ): number | number[] => {
    if (!(crease || hl > y0 || hr > y0)) return shade;
    // corners run bottom-left, bottom-right, top-right, top-left
    const base = crease ? AO.edge : 1;
    return [
      shade * (hl > y0 ? (crease ? AO_CORNER : AO.edge) : base),
      shade * (hr > y0 ? (crease ? AO_CORNER : AO.edge) : base),
      shade * (hr > y1 ? AO.edge : 1),
      shade * (hl > y1 ? AO.edge : 1),
    ];
  };

  const topQuad = (
    x0: number,
    z0: number,
    h: number,
    tile: number,
    shade: number,
    to?: Quad[],
    ha?: (tx: number, ty: number) => number,
  ): void => {
    const [u0, u1, v0, v1] = uvRect(tile, 0, 8);
    (to ?? terrain).push({
      c: [
        [x0, h, z0],
        [x0 + 8, h, z0],
        [x0 + 8, h, z0 + 8],
        [x0, h, z0 + 8],
      ],
      uv: [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      shade: aoShades(x0 / 8, z0 / 8, h, shade, ha),
      f: FACE.up,
      borderRing: emittingBorderRing || undefined,
    });
  };

  // vertical quad for face direction `d` (ChunkMesher.lua:386 sideQuad)
  const sideQuad = (
    d: number,
    x0: number,
    z0: number,
    y0: number,
    y1: number,
    tile: number,
    vTop: number,
    vBot: number,
    shade: number | number[],
    to: Quad[] = terrain,
  ): void => {
    const x1 = x0 + 8;
    const z1 = z0 + 8;
    let c: [number, number, number][];
    if (d === 5) {
      c = [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
    } else if (d === 6) {
      c = [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ];
    } else if (d === 1) {
      c = [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ];
    } else {
      c = [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ];
    }
    const [u0, u1, v0, v1] = uvRect(tile, vTop, vBot);
    to.push({
      c,
      uv: [
        [u0, v1],
        [u1, v1],
        [u1, v0],
        [u0, v0],
      ],
      shade,
      // `d` IS the direction id: SIDES carries 1/2/5/6 and no other face
      // direction ever reaches sideQuad.
      f: d as 1 | 2 | 5 | 6,
      borderRing: emittingBorderRing || undefined,
    });
  };

  const tw = map.def.width * 4;
  const th = map.def.height * 4;
  const r = RING;

  for (let ty = -r; ty < th + r; ty++) {
    for (let tx = -r; tx < tw + r; tx++) {
      const k = keyOf(tx, ty);
      let s = S.shapeAt.get(k);
      const tile = S.tileAt.get(k);
      const inBody = tx >= 0 && ty >= 0 && tx < tw && ty < th;
      emittingBorderRing = !inBody;

      // Tile cells use OPEN rectangle overlap, exactly like Lua's `masked`:
      // merely sharing the neighbour body's boundary does not erase a cell.
      if (
        !inBody &&
        masked(masks, tx * 8, ty * 8, tx * 8 + 8, ty * 8 + 8, false)
      ) {
        continue;
      }

      // under the TREES fill the border wall is modelled or it is not there
      if (!inBody && S.hideBareRing && !S.skip.has(k)) s = undefined;
      if (!s || tile === undefined) continue;

      if (S.skip.has(k)) {
        // an object stands here; paint its synthesized ground, and keep
        // the shoreline bands where water recesses next door
        const g = S.ground.get(k);
        if (g !== undefined && g !== false) {
          topQuad(tx * 8, ty * 8, 0, g, 1);
          for (const [sx, sy, d] of SIDES) {
            const nh = heightAt(tx + sx, ty + sy);
            if (nh < 0) {
              const lat = LATERAL[d];
              const hl = heightAt(tx + lat[0], ty + lat[1]);
              const hr = heightAt(tx + lat[2], ty + lat[3]);
              for (let band = Math.floor(nh / 8); band <= -1; band++) {
                const y0 = Math.max(nh, band * 8);
                const y1 = Math.min(0, band * 8 + 8);
                if (y1 > y0) {
                  sideQuad(
                    d,
                    tx * 8,
                    ty * 8,
                    y0,
                    y1,
                    g,
                    band * 8 + 8 - y1,
                    band * 8 + 8 - y0,
                    sideShades(hl, hr, y0, y1, y0 <= nh, DIR_SHADE[d]),
                  );
                }
              }
            }
          }
        }
        continue;
      }

      const run = S.runs.get(k);
      const h = run ? run.h : s.h;
      const x0 = tx * 8;
      const z0 = ty * 8;

      // ---- top face ----
      if (run && run.rise > 0) {
        // GABLE (ChunkMesher.lua:503-529): rises to a ridge across the
        // footprint's middle, back mirrors, exposed flanks hip.
        const mid = run.extent / 2;
        const gableH = (d: number): number => {
          const t = d <= mid ? d / mid : (run.extent - d) / (run.extent - mid);
          return run.h + run.rise * Math.max(0, Math.min(1, t));
        };
        const d0 = run.front - ty;
        const hS = gableH(d0);
        const hN = gableH(d0 + 1);
        const rel = 1 - Math.abs(d0 + 0.5 - mid) / Math.max(mid, 0.5);
        const idx = Math.min(run.roofRows - 1, Math.floor((1 - rel) * run.roofRows));
        const roofTile = map.tileAt(tx, run.north + idx);
        let swY = hS;
        let seY = hS;
        let neY = hN;
        let nwY = hN;
        if (heightAt(tx - 1, ty) < run.h) {
          swY = Math.max(run.h, hS - 8);
          nwY = Math.max(run.h, hN - 8);
        }
        if (heightAt(tx + 1, ty) < run.h) {
          seY = Math.max(run.h, hS - 8);
          neY = Math.max(run.h, hN - 8);
        }
        const [u0, u1, v0, v1] = uvRect(roofTile, 0, 8);
        terrain.push({
          c: [
            [x0, swY, z0 + 8],
            [x0 + 8, seY, z0 + 8],
            [x0 + 8, neY, z0],
            [x0, nwY, z0],
          ],
          uv: [
            [u0, v1],
            [u1, v1],
            [u1, v0],
            [u0, v0],
          ],
          shade: GABLE_TOP_SHADE,
          // A pitched roof plane: tilted, but +Y dominant at every gable
          // rise the volume measurer produces.
          f: FACE.up,
          borderRing: emittingBorderRing || undefined,
        });
      } else if (run) {
        const m = Math.min(2, run.extent);
        const topTile = map.tileAt(tx, run.north + (((ty - run.north) % m) + m) % m);
        topQuad(x0, z0, h, topTile, VOLUME_TOP_SHADE);
      } else {
        let topTile = tile;
        if (s.art === "upright" && s.authored) {
          // top art for a pinned box (ChunkMesher.lua:536-571)
          let north = ty;
          let front = ty;
          while (ty - north < 6) {
            const bs = S.shapeAt.get(keyOf(tx, north - 1));
            if (bs && bs.authored && bs.class === s.class) north--;
            else break;
          }
          while (front - ty < 6) {
            const bs = S.shapeAt.get(keyOf(tx, front + 1));
            if (bs && bs.authored && bs.class === s.class) front++;
            else break;
          }
          let row = Math.min(ty, front - Math.floor(h / 8));
          if (row < north) {
            const above = S.shapeAt.get(keyOf(tx, north - 1));
            row = above && above.authored && above.art === "upright" ? north - 1 : north;
          }
          const t2 = S.tileAt.get(keyOf(tx, row));
          if (t2 !== undefined) topTile = t2;
        }
        // water's surface — and only water's — routes to the water stream
        topQuad(
          x0,
          z0,
          h,
          topTile,
          s.art === "upright" ? VOLUME_TOP_SHADE : 1,
          s.class === "water" ? water : undefined,
        );
      }

      // ---- sides: 8px bands wherever the neighbour is lower ----
      for (const [sx, sy, d] of SIDES) {
        const nh = heightAt(tx + sx, ty + sy);
        if (nh >= h) continue;
        const lat = LATERAL[d];
        const hl = heightAt(tx + lat[0], ty + lat[1]);
        const hr = heightAt(tx + lat[2], ty + lat[3]);
        for (let band = Math.floor(nh / 8); band <= Math.ceil(h / 8) - 1; band++) {
          const y0 = Math.max(nh, band * 8);
          const y1 = Math.min(h, band * 8 + 8);
          if (y1 <= y0) continue;
          let src = tile;
          let shade = DIR_SHADE[d];
          if (run) {
            // fold the structure's artwork up this face
            // (ChunkMesher.lua:600-615)
            if (d === 6) src = map.tileAt(tx, Math.min(run.front, run.north + band));
            else src = map.tileAt(tx, Math.max(run.north, run.front - band));
            if (d === 5) shade = 1;
          } else if (s.art === "upright") {
            // profile-authored upright: fold the drawing up the face
            // (ChunkMesher.lua:616-639)
            if (d === 5) shade = 1;
            let front = ty;
            while (front < ty + 6) {
              const fs2 = S.shapeAt.get(keyOf(tx, front + 1));
              if (fs2 && fs2.authored && fs2.class === s.class) front++;
              else break;
            }
            const fk = keyOf(tx, front - band);
            const fs = S.shapeAt.get(fk);
            if (fs && fs.authored && fs.class === s.class) src = S.tileAt.get(fk)!;
          }
          sideQuad(
            d,
            x0,
            z0,
            y0,
            y1,
            src,
            band * 8 + 8 - y1,
            band * 8 + 8 - y0,
            sideShades(hl, hr, y0, y1, y0 <= nh, shade),
          );
        }
      }
    }
  }

  // ---- prebuilt object quads + round-tree stamps ----
  // Ground-contact AO (ChunkMesher.lua:347 groundShades).
  const groundShades = (q: Quad): number | number[] => {
    if (typeof q.shade !== "number") return q.shade;
    const ys = q.c.map((c) => c[1]);
    if (Math.min(...ys) >= AO.risePx) return q.shade;
    return ys.map((y) => {
      const t = y / AO.risePx;
      return (q.shade as number) * (t >= 1 ? 1 : 1 - AO.ground * (1 - t));
    });
  };

  for (const q of S.objectQuads) {
    const bounds = quadBounds(q);
    const scope =
      q.own || outwardOnBodyEdge(q, tw * 8, th * 8)
        ? "body"
        : extentScope(...bounds, tw * 8, th * 8, masks);
    if (scope) terrain.push(scoped({ ...q, shade: groundShades(q) }, scope));
  }
  // The carved hulls ride the TERRAIN stream, marked. They are split into
  // MESH_KIND.treeHull at pack time, not here, so every later stage — the
  // hidden-face cull, the chunk partition, the u16 batching — sees the same
  // array it saw before tree LOD existed and the near level of detail keeps
  // its exact quad order.
  const treeCoarse: Quad[] = [];
  for (const st of S.roundStamps) {
    const sr = st.r ?? 8;
    const stampBounds: [number, number, number, number] = [
      st.mx - sr,
      st.mz - sr,
      st.mx + sr,
      st.mz + sr,
    ];
    const stampOverBody =
      stampBounds[2] > 0 &&
      stampBounds[0] < tw * 8 &&
      stampBounds[3] > 0 &&
      stampBounds[1] < th * 8;
    if (!stampOverBody && containedInMask(masks, ...stampBounds)) continue;
    for (const q of st.quads) {
      const moved: Quad = {
        c: q.c.map(([x, y, z]) => [x + st.mx, y, z + st.mz]) as [number, number, number][],
        uv: q.uv,
        u: q.u,
        v: q.v,
        shade: q.shade,
        f: q.f,
      };
      const scope = extentScope(...quadBounds(moved), tw * 8, th * 8, masks);
      if (scope) {
        terrain.push(scoped({ ...moved, shade: groundShades(moved), tree: true }, scope));
      }
    }
    // The middle level stamps beside the fine one, into its own stream —
    // the same translation, the same ground darkening. Its NORTH faces are
    // dropped outright: a carved ball is convex and the camera is always
    // south of and above what it draws, so the rear hemisphere is
    // self-occluded at every pitch rung (proven by pixel-diff over the
    // pitch ladder tape). The fine carve keeps its backs — it is the
    // identity rung's geometry and not ours to thin.
    for (const q of st.coarse) {
      if (q.f === FACE.north) continue;
      const moved: Quad = {
        c: q.c.map(([x, y, z]) => [x + st.mx, y, z + st.mz]) as [number, number, number][],
        uv: q.uv,
        u: q.u,
        v: q.v,
        shade: q.shade,
        f: q.f,
      };
      const scope = extentScope(...quadBounds(moved), tw * 8, th * 8, masks);
      if (scope) treeCoarse.push(scoped({ ...moved, shade: groundShades(moved) }, scope));
    }
  }

  // ---- the far level of detail: the same cells, extruded as plain boxes ----
  // This is the geometry a VOXEL_TREE_BOXES=1 cook produces for these cells,
  // built here alongside the hulls rather than in place of them: one flat top
  // plus 8px side bands wherever the (box-reading) neighbour is lower. The
  // synthesized ground the hull path already wrote under each claimed tile
  // stays in the terrain stream and simply sits under the box.
  const treeBox: Quad[] = [];
  for (let ty = -r; ty < th + r; ty++) {
    for (let tx = -r; tx < tw + r; tx++) {
      const k = keyOf(tx, ty);
      if (!S.round.has(k)) continue;
      const inBody = tx >= 0 && ty >= 0 && tx < tw && ty < th;
      emittingBorderRing = !inBody;
      if (
        !inBody &&
        masked(masks, tx * 8, ty * 8, tx * 8 + 8, ty * 8 + 8, false)
      ) {
        continue;
      }
      const s = S.shapeAt.get(k);
      const tile = S.tileAt.get(k);
      if (!s || tile === undefined) continue;
      const h = s.h;
      const x0 = tx * 8;
      const z0 = ty * 8;
      topQuad(x0, z0, h, tile, 1, treeBox, boxHeightAt);
      for (const [sx, sy, d] of SIDES) {
        const nh = boxHeightAt(tx + sx, ty + sy);
        if (nh >= h) continue;
        const lat = LATERAL[d];
        const hl = boxHeightAt(tx + lat[0], ty + lat[1]);
        const hr = boxHeightAt(tx + lat[2], ty + lat[3]);
        for (let band = Math.floor(nh / 8); band <= Math.ceil(h / 8) - 1; band++) {
          const y0 = Math.max(nh, band * 8);
          const y1 = Math.min(h, band * 8 + 8);
          if (y1 <= y0) continue;
          sideQuad(
            d,
            x0,
            z0,
            y0,
            y1,
            tile,
            band * 8 + 8 - y1,
            band * 8 + 8 - y0,
            sideShades(hl, hr, y0, y1, y0 <= nh, DIR_SHADE[d]),
            treeBox,
          );
        }
      }
    }
  }

  const stamps = new Map<string, Quad[]>();
  for (const [key, quads] of S.stampQuads) {
    stamps.set(
      key,
      quads.map((q) => ({ ...q, shade: groundShades(q) })),
    );
  }

  // THE drop site: every stream this cooker produces funnels through
  // cullHidden here, so the camera rule (geom.ts) is applied exactly once,
  // after the shading and ground votes that read the full face set. Grass
  // and flower pass PULLED — the backend displaces their vertices toward the
  // camera, so their cooked facing is not their drawn facing.
  for (const [key, quads] of stamps) stamps.set(key, cullHidden(quads, false, keepHidden));
  return {
    terrain: cullHidden(terrain, false, keepHidden),
    treeCoarse: cullHidden(treeCoarse, false, keepHidden),
    treeBox: cullHidden(treeBox, false, keepHidden),
    water: cullHidden(water, false, keepHidden),
    grass: cullHidden(
      S.grassQuads.map((q) => ({ ...q, shade: groundShades(q) })),
      PULLED,
      keepHidden,
    ),
    flower: cullHidden(
      S.flowerQuads.map((q) => ({ ...q, shade: groundShades(q) })),
      PULLED,
      keepHidden,
    ),
    stamps,
  };
}

// ---------------------------------------------------------------------------
// chunk packing
// ---------------------------------------------------------------------------

export interface PackedVert {
  u: number;
  v: number;
  abgr: number;
  x: number;
  y: number;
  z: number;
}

export interface PackedMesh {
  verts: PackedVert[];
  indices: number[];
}

export interface ChunkOut {
  cx: number;
  cy: number;
  /** VXPK_CHUNK_FLAG_* bits; omitted means an ordinary map-body record. */
  flags?: number;
  /** Atlas page of this chunk's baked ground, when eligible (v6). */
  bakePage?: number;
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  /** One mesh per spec MESH_KIND, in MESH_KIND order. */
  meshes: PackedMesh[];
}

export interface StampOut {
  cx: number;
  cy: number;
  mesh: PackedMesh;
}

/** UV conversion: sheet px -> combined terrain page UV. */
export interface UvTransform {
  baseY: number;
  pageW: number;
  pageH: number;
}

function shadeColor(shade: number): number {
  const v = Math.max(0, Math.min(255, Math.round(255 * shade)));
  return (0xff000000 | (v << 16) | (v << 8) | v) >>> 0;
}

function packQuads(quads: Quad[], uvt: UvTransform): PackedMesh {
  const verts: PackedVert[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = verts.length;
    for (let i = 0; i < 4; i++) {
      const [x, y, z] = q.c[i];
      const [uPx, vPx] = q.uv ? q.uv[i] : [q.u ?? 0, q.v ?? 0];
      const shade = typeof q.shade === "number" ? q.shade : q.shade[i];
      verts.push({
        u: uPx / uvt.pageW,
        v: (vPx + uvt.baseY) / uvt.pageH,
        abgr: shadeColor(shade),
        x: Math.round(x),
        y: Math.round(y),
        z: Math.round(z),
      });
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (verts.length > MAX_VERTS_PER_CHUNK_MESH) {
    throw new Error(`chunk mesh overflows u16 indices: ${verts.length} verts`);
  }
  return { verts, indices };
}

/** Partition a map's geometry into CHUNK_TILES chunks + stamp meshes. */
export function packMap(geo: MapGeometry, uvt: UvTransform): { chunks: ChunkOut[]; stamps: StampOut[] } {
  // treeHull has no stream of its own: its quads are carried inside terrain
  // and cut out of each BATCH below, which is what keeps the near level of
  // detail byte-identical to the pre-LOD cook.
  const streams: [number, Quad[]][] = [
    [MESH_KIND.terrain, geo.terrain],
    [MESH_KIND.treeCoarse, geo.treeCoarse],
    [MESH_KIND.treeBox, geo.treeBox],
    [MESH_KIND.water, geo.water],
    [MESH_KIND.grass, geo.grass],
    [MESH_KIND.flower, geo.flower],
  ];
  const byChunk = new Map<string, { flags: number; streams: Quad[][] }>();
  streams.forEach(([kind, quads]) => {
    for (const q of quads) {
      let cxSum = 0;
      let czSum = 0;
      for (const [x, , z] of q.c) {
        cxSum += x;
        czSum += z;
      }
      const cx = Math.floor(cxSum / 4 / CHUNK_PX);
      const cy = Math.floor(czSum / 4 / CHUNK_PX);
      const flags = q.borderRing ? VXPK_CHUNK_FLAG_BORDER_RING : 0;
      const key = `${cx},${cy},${flags}`;
      let entry = byChunk.get(key);
      if (!entry) {
        entry = { flags, streams: Array.from({ length: MESH_KINDS }, () => []) };
        byChunk.set(key, entry);
      }
      entry.streams[kind].push(q);
    }
  });

  // A mesh range's vert_count and index_count are u16: cap quads per record
  // and emit multiple chunk records at the same coords when a chunk's
  // streams overflow (the reader draws every record it is handed).
  const QUADS_PER_MESH = 10000; // 40000 verts, 60000 indices — u16-safe
  const chunks: ChunkOut[] = [];
  const keys = [...byChunk.keys()].sort((a, b) => {
    const [ax, ay, af] = a.split(",").map(Number);
    const [bx, by, bf] = b.split(",").map(Number);
    // Ring first, body last: any equal-depth boundary contest is owned by
    // the real map body, matching the 2D renderer's neighbour-over-ring rule.
    return ay - by || ax - bx || bf - af;
  });
  for (const key of keys) {
    const [cx, cy] = key.split(",").map(Number);
    const entry = byChunk.get(key)!;
    const batches = Math.max(
      1,
      ...entry.streams.map((q) => Math.ceil(q.length / QUADS_PER_MESH)),
    );
    for (let b = 0; b < batches; b++) {
      const slices = entry.streams.map((quads) =>
        quads.slice(b * QUADS_PER_MESH, (b + 1) * QUADS_PER_MESH),
      );
      // Cut the carved hulls out of this batch's terrain slice. They were
      // appended after every tile and object quad, so within a chunk — and
      // therefore within a batch of one — they are a SUFFIX, and
      // [terrain, treeHull] concatenates back to exactly the array the
      // pre-LOD cook packed as one mesh. draw.rs draws the pair in that
      // order for the same chunk, so the top rung's triangles keep both
      // their values and their sequence.
      const terr = slices[MESH_KIND.terrain];
      const cut = terr.findIndex((q) => q.tree);
      if (cut >= 0) {
        const hull = terr.slice(cut);
        if (!hull.every((q) => q.tree)) {
          throw new Error("carved tree quads are not a suffix of the terrain stream");
        }
        slices[MESH_KIND.terrain] = terr.slice(0, cut);
        slices[MESH_KIND.treeHull] = hull;
      }
      // The detail streams pack STRATIFIED: draw.rs thins them by drawing a
      // PREFIX (`detailDensity`), so the prefix must be a spatially uniform
      // sample of the field. (Packed row-major, the prefix was each chunk's
      // north rows: half density meant a bald south half, not thinner
      // grass.) The order is round-robin by within-cell rank — every cell's
      // first quad, then every cell's second — with cells visited in
      // bit-reversed order so any prefix stays evenly spread. Rank order is
      // preserved WITHIN a cell on purpose: a tuft's two slabs cross at
      // equal depth, where draw order decides the shared pixels, so
      // reordering across ranks moves the identity anchor (measured: a
      // plain bit-reversal of the whole stream did).
      for (const kind of [MESH_KIND.grass, MESH_KIND.flower]) {
        const quads = slices[kind];
        if (quads.length < 2) continue;
        const groups: Quad[][] = [];
        let prev: string | null = null;
        for (const q of quads) {
          let mx = Infinity;
          let mz = Infinity;
          for (const [x, , z] of q.c) {
            mx = Math.min(mx, x);
            mz = Math.min(mz, z);
          }
          const key = `${Math.floor(mx / 8)},${Math.floor(mz / 8)}`;
          if (key !== prev) {
            groups.push([]);
            prev = key;
          }
          groups.at(-1)!.push(q);
        }
        let bits = 1;
        while (1 << bits < groups.length) bits++;
        const order: number[] = [];
        for (let p = 0; p < 1 << bits; p++) {
          let j = 0;
          for (let b = 0; b < bits; b++) j |= ((p >> b) & 1) << (bits - 1 - b);
          if (j < groups.length) order.push(j);
        }
        const ordered: Quad[] = [];
        const maxLen = Math.max(...groups.map((g) => g.length));
        for (let k = 0; k < maxLen; k++) {
          for (const j of order) {
            const q = groups[j][k];
            if (q) ordered.push(q);
          }
        }
        slices[kind] = ordered;
      }
      const meshes = slices.map((quads) => packQuads(quads, uvt));
      const aabbMin: [number, number, number] = [32767, 32767, 32767];
      const aabbMax: [number, number, number] = [-32768, -32768, -32768];
      let any = false;
      for (const m of meshes) {
        for (const v of m.verts) {
          any = true;
          aabbMin[0] = Math.min(aabbMin[0], v.x);
          aabbMin[1] = Math.min(aabbMin[1], v.y);
          aabbMin[2] = Math.min(aabbMin[2], v.z);
          aabbMax[0] = Math.max(aabbMax[0], v.x);
          aabbMax[1] = Math.max(aabbMax[1], v.y);
          aabbMax[2] = Math.max(aabbMax[2], v.z);
        }
      }
      if (!any) continue;
      chunks.push({ cx, cy, flags: entry.flags || undefined, aabbMin, aabbMax, meshes });
    }
  }

  const stamps: StampOut[] = [];
  const stampKeys = [...geo.stamps.keys()].sort((a, b) => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return ay - by || ax - bx;
  });
  for (const key of stampKeys) {
    const [cx, cy] = key.split(",").map(Number);
    stamps.push({ cx, cy, mesh: packQuads(geo.stamps.get(key)!, uvt) });
  }

  return { chunks, stamps };
}
