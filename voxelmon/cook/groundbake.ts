// voxelmon/cook/groundbake.ts — the baked ground plane (docs/VOXEL.md
// §4a, "the ground bake"). For every LOW-RELIEF chunk, composite its ground
// picture — terrain, grass and flowers, obliquely projected along the rung-2
// view direction onto the y=0 plane — into one 128x128 CLUT8 canvas the
// runtime draws as a single quad past `groundBakeDist`.
//
// Everything happens in INDEX space: an output texel is a texel index of the
// combined terrain page, so the bake pages stay in the terrain palette
// domain and RED++ world palettes plus the day tint keep working untouched.
//
// The projection is exact for the pitch the game plays at (rung 2, 35°):
// p' = (x, z - y*tan(35°)). Every cooked quad is an axis-aligned plane, so a
// projected footprint is a rectangle — the rasterizer below is a rect fill
// with affine UV and a per-texel depth key (y, then z; larger wins — the
// first hit along the down-north view ray).

import { CHUNK_PX, PITCH_RUNGS } from "../../contracts/spec/voxel-spec.ts";
import type { PageDef } from "./atlas.ts";
import type { Quad } from "./geom.ts";
import type { ChunkOut, MapGeometry, UvTransform } from "./mesh.ts";

/** Bake canvas edge in texels: 1 world px per texel over a 128 px chunk
 * (the view renders 2 screen px per world px, so this is 2 screen px per
 * bake texel — soft at the transition ring, sharp enough past it). */
export const BAKE_TEXELS = 128;
const STEP = CHUNK_PX / BAKE_TEXELS; // world px per texel

/** The bake line, PER QUAD: terrain quads topping out at or under this are
 * painted into the canvas (and dropped from a baked chunk's draw); taller
 * structures — fences (10), signs (12), the border tree walls (16 px MESHER
 * BOXES in the terrain stream), buildings — stay geometry, duplicated into
 * `MESH_KIND.terrainKeep`. 8 keeps ledges (6) and the water lip paintable.
 * A chunk-level line was tried twice: at 16 it flattened tree walls into
 * leaf-print flooring, at 8 one wall segment disqualified whole chunks and
 * coverage collapsed to nothing (device run K). */
export const BAKE_MAX_Y = 8;

const TAN_PITCH = Math.tan((PITCH_RUNGS[2] * Math.PI) / 180);

interface Sample {
  /** Depth keys: larger y wins, then larger z (nearer the camera). */
  y: number;
  z: number;
  index: number;
}

/**
 * Bake every eligible chunk of one map. Returns a canvas per eligible chunk
 * (keyed by index into `chunks`); the caller appends pages and stamps
 * `bakePage` + the ground-quad mesh.
 */
export function bakeGround(
  chunks: ChunkOut[],
  geo: MapGeometry,
  page: PageDef,
  uvt: UvTransform,
  transparent: (index: number) => boolean,
  /** An index whose CLUT alpha is 0: what unpainted texels are filled with,
   * so off-map canvas regions alpha-test away on BOTH backends instead of
   * flipping between an opaque leftover and clear under sub-texel drift. */
  clearIndex: number,
): Map<number, Uint8Array> {
  const texels = page.frames[0];
  // TERRAIN ONLY (v1): grass and flower speckles are high-frequency, and at
  // the far field's foreshortening two correct rasterizers pick different
  // texels per pixel (measured: painting them pushed the GE-vs-sim e2e to
  // AE 16k on ROUTE_1; terrain tiles are low-frequency and agree). Grass
  // and flowers keep drawing as geometry over the bake, on their own dials.
  const quads: Quad[] = [...geo.terrain];
  const out = new Map<number, Uint8Array>();

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const x0 = c.cx * CHUNK_PX;
    const z0 = c.cy * CHUNK_PX;
    const best: (Sample | undefined)[] = new Array(BAKE_TEXELS * BAKE_TEXELS);

    for (const q of quads) {
      // Only the LOW quads paint (the ones the bake replaces); the tall
      // structures stay geometry through the keep stream.
      if (Math.max(...q.c.map((co) => co[1])) > BAKE_MAX_Y) continue;
      // Projected footprint: axis-aligned rect over (x, z - y*tanP).
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, y, z] of q.c) {
        const pz = z - y * TAN_PITCH;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      if (maxX <= x0 || minX >= x0 + CHUNK_PX || maxZ <= z0 || minZ >= z0 + CHUNK_PX) {
        continue;
      }
      if (maxX - minX < 1e-6 || maxZ - minZ < 1e-6) continue; // edge-on
      // Corner attributes for affine interpolation over the rect. The quad
      // corners are bl, br, tr, tl in SOME axis order; recover per-corner
      // (u, v, y, z) and interpolate bilinearly by normalized rect coords.
      const corners = q.c.map(([x, y, z], i) => {
        const [u, v] = q.uv ? q.uv[i] : [q.u ?? 0, q.v ?? 0];
        return { px: x, pz: z - y * TAN_PITCH, u, v: v + uvt.baseY, y, z };
      });
      const lerpAt = (px: number, pz: number) => {
        // Inverse-bilinear on an axis-aligned projected rect degenerates to
        // two independent lerps; pick the two spanning axes from extents.
        const tx = (px - minX) / (maxX - minX);
        const tz = (pz - minZ) / (maxZ - minZ);
        // Interpolate via the rect corner closest-fit: weights from tx/tz
        // against each corner's own normalized position.
        let u = 0;
        let v = 0;
        let y = 0;
        let z = 0;
        let wsum = 0;
        for (const co of corners) {
          const cx = (co.px - minX) / (maxX - minX);
          const cz = (co.pz - minZ) / (maxZ - minZ);
          const w = (cx > 0.5 ? tx : 1 - tx) * (cz > 0.5 ? tz : 1 - tz);
          u += co.u * w;
          v += co.v * w;
          y += co.y * w;
          z += co.z * w;
          wsum += w;
        }
        return { u: u / wsum, v: v / wsum, y: y / wsum, z: z / wsum };
      };

      const i0 = Math.max(0, Math.floor((minX - x0) / STEP));
      const i1 = Math.min(BAKE_TEXELS - 1, Math.ceil((maxX - x0) / STEP));
      const j0 = Math.max(0, Math.floor((minZ - z0) / STEP));
      const j1 = Math.min(BAKE_TEXELS - 1, Math.ceil((maxZ - z0) / STEP));
      for (let j = j0; j <= j1; j++) {
        const pz = z0 + (j + 0.5) * STEP;
        if (pz < minZ || pz > maxZ) continue;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * STEP;
          if (px < minX || px > maxX) continue;
          const s = lerpAt(px, pz);
          const su = Math.min(page.w - 1, Math.max(0, Math.floor(s.u)));
          const sv = Math.min(page.h - 1, Math.max(0, Math.floor(s.v)));
          const index = texels[sv * page.w + su];
          if (transparent(index)) continue;
          const at = j * BAKE_TEXELS + i;
          const prev = best[at];
          if (!prev || s.y > prev.y || (s.y === prev.y && s.z >= prev.z)) {
            best[at] = { y: s.y, z: s.z, index };
          }
        }
      }
    }

    // A chunk the map does not fully cover (edge chunks) has unpainted
    // texels: fill them with a TRANSPARENT index, uniformly. Filling from a
    // painted neighbour was tried and made the off-map region high-frequency
    // (opaque leftovers beside clear texels), which two correct rasterizers
    // sample apart under foreshortening — whole chunks flickered red in the
    // GE-vs-sim diff. Transparent everywhere off-map, the geometry behind
    // shows through on both backends alike.
    const canvas = new Uint8Array(BAKE_TEXELS * BAKE_TEXELS);
    let painted = 0;
    for (let at = 0; at < best.length; at++) {
      const s = best[at];
      if (s) {
        canvas[at] = s.index;
        painted++;
      } else {
        canvas[at] = clearIndex;
      }
    }
    if (painted === 0) continue; // nothing to show: keep geometry
    out.set(ci, canvas);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The facade fold: keep-stream quads absorbed into the bake page
// ---------------------------------------------------------------------------

/** Bake page height (v8 cook layout): ground rows 0..BAKE_TEXELS-1, facade
 * strips shelf-packed below. Both dimensions power-of-two for the GE. */
export const BAKE_PAGE_H = 256;

interface PV2 {
  u: number;
  v: number;
  abgr: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Group a baked chunk's KEEP quads by axis-aligned plane and fold each big
 * group into a painted strip on the chunk's bake page + a 16px-subdivided
 * grid of quads for the groundBake mesh. Building walls are dozens of 8px
 * band quads on a handful of planes; one strip redraws a whole wall.
 *
 * Only quads whose four vertex colors match the group's facing shade fold
 * (index-space painting cannot carry per-vertex AO); the rest — and any
 * group the 128x128 facade shelf cannot hold — stay in keep. Returns the
 * surviving keep quads and the facade geometry to append to the bake mesh.
 */
export function foldFacades(
  keepVerts: PV2[],
  canvas: Uint8Array,
  srcTexels: Uint8Array,
  srcW: number,
  srcH: number,
  transparent: (index: number) => boolean,
): { keep: PV2[]; facadeVerts: PV2[]; facadeIndices: number[] } {
  interface Group {
    axis: "x" | "z" | "y";
    coord: number;
    quads: number[];
    abgr: number;
  }
  const groups = new Map<string, Group>();
  const quadCount = keepVerts.length / 4;
  for (let q = 0; q < quadCount; q++) {
    const vs = keepVerts.slice(q * 4, q * 4 + 4);
    const axis = vs.every((v) => v.x === vs[0].x)
      ? "x"
      : vs.every((v) => v.z === vs[0].z)
        ? "z"
        : vs.every((v) => v.y === vs[0].y)
          ? "y"
          : null;
    if (!axis) continue; // sloped (gables): stays geometry
    if (!vs.every((v) => v.abgr === vs[0].abgr)) continue; // AO-shaded corner
    const coord = axis === "x" ? vs[0].x : axis === "z" ? vs[0].z : vs[0].y;
    const key = `${axis}:${coord}:${vs[0].abgr}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { axis: axis as Group["axis"], coord, quads: [], abgr: vs[0].abgr }));
    g.quads.push(q);
  }

  // Plane 2D mapping: (h, v) axes per plane orientation.
  const to2d = (g: Group, v: PV2): [number, number] =>
    g.axis === "z" ? [v.x, v.y] : g.axis === "x" ? [v.z, v.y] : [v.x, v.z];

  const absorbed = new Set<number>();
  const facadeVerts: PV2[] = [];
  const facadeIndices: number[] = [];
  // Shelf packer over the facade half of the canvas.
  let shelfY = BAKE_TEXELS;
  let shelfX = 0;
  let shelfH = 0;

  const candidates = [...groups.values()]
    .filter((g) => g.quads.length >= 4)
    .sort((a, b) => b.quads.length - a.quads.length);
  for (const g of candidates) {
    let h0 = Infinity;
    let h1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const q of g.quads) {
      for (const v of keepVerts.slice(q * 4, q * 4 + 4)) {
        const [hh, vv] = to2d(g, v);
        if (hh < h0) h0 = hh;
        if (hh > h1) h1 = hh;
        if (vv < v0) v0 = vv;
        if (vv > v1) v1 = vv;
      }
    }
    const w = Math.ceil(h1 - h0);
    const h = Math.ceil(v1 - v0);
    if (w <= 0 || h <= 0 || w > BAKE_TEXELS) continue;
    // Shelf placement (1 texel = 1 world px).
    if (shelfX + w > BAKE_TEXELS) {
      shelfY += shelfH;
      shelfX = 0;
      shelfH = 0;
    }
    if (shelfY + h > BAKE_PAGE_H) continue; // shelf full: stays geometry
    const sx = shelfX;
    const sy = shelfY;
    shelfX += w;
    shelfH = Math.max(shelfH, h);

    // Paint every quad of the group into its strip cell (nearest, painter).
    for (const q of g.quads) {
      const vs = keepVerts.slice(q * 4, q * 4 + 4);
      const p2 = vs.map((v) => to2d(g, v));
      const qh0 = Math.min(...p2.map((p) => p[0]));
      const qh1 = Math.max(...p2.map((p) => p[0]));
      const qv0 = Math.min(...p2.map((p) => p[1]));
      const qv1 = Math.max(...p2.map((p) => p[1]));
      if (qh1 - qh0 < 1e-6 || qv1 - qv0 < 1e-6) continue;
      // Affine UV over the quad's 2D rect (corner-weight interpolation).
      const lerpUv = (hh: number, vv: number): [number, number] => {
        const th = (hh - qh0) / (qh1 - qh0);
        const tv = (vv - qv0) / (qv1 - qv0);
        let u = 0;
        let vq = 0;
        let ws = 0;
        for (let i = 0; i < 4; i++) {
          const ch = (p2[i][0] - qh0) / (qh1 - qh0);
          const cv = (p2[i][1] - qv0) / (qv1 - qv0);
          const wgt = (ch > 0.5 ? th : 1 - th) * (cv > 0.5 ? tv : 1 - tv);
          u += vs[i].u * wgt;
          vq += vs[i].v * wgt;
          ws += wgt;
        }
        return [u / ws, vq / ws];
      };
      const i0 = Math.max(0, Math.floor(qh0 - h0));
      const i1 = Math.min(w - 1, Math.ceil(qh1 - h0));
      const j0 = Math.max(0, Math.floor(qv0 - v0));
      const j1 = Math.min(h - 1, Math.ceil(qv1 - v0));
      for (let j = j0; j <= j1; j++) {
        const vv = v0 + j + 0.5;
        if (vv < qv0 || vv > qv1) continue;
        for (let i = i0; i <= i1; i++) {
          const hh = h0 + i + 0.5;
          if (hh < qh0 || hh > qh1) continue;
          const [uu, vq] = lerpUv(hh, vv);
          const tx = Math.min(srcW - 1, Math.max(0, Math.floor(uu * srcW)));
          const ty = Math.min(srcH - 1, Math.max(0, Math.floor(vq * srcH)));
          const index = srcTexels[ty * srcW + tx];
          if (transparent(index)) continue;
          // v axis: strip row 0 = TOP of the plane rect (v1), growing down.
          canvas[(sy + (h - 1 - j)) * BAKE_TEXELS + sx + i] = index;
        }
      }
      absorbed.add(q);
    }

    // Emit the facade rect as a <=16px grid on the plane, UV into the strip.
    const cols = Math.max(1, Math.ceil(w / 16));
    const rows = Math.max(1, Math.ceil(h / 16));
    const base = facadeVerts.length;
    for (let r = 0; r <= rows; r++) {
      for (let cix = 0; cix <= cols; cix++) {
        const hh = h0 + (cix * w) / cols;
        const vv = v1 - (r * h) / rows; // top row first
        const pos =
          g.axis === "z"
            ? { x: hh, y: vv, z: g.coord }
            : g.axis === "x"
              ? { x: g.coord, y: vv, z: hh }
              : { x: hh, y: g.coord, z: vv };
        facadeVerts.push({
          u: (sx + (cix * w) / cols) / BAKE_TEXELS,
          v: (sy + (r * h) / rows) / BAKE_PAGE_H,
          abgr: g.abgr,
          ...pos,
        });
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let cix = 0; cix < cols; cix++) {
        const b = base + r * (cols + 1) + cix;
        facadeIndices.push(b, b + 1, b + cols + 2, b, b + cols + 2, b + cols + 1);
      }
    }
  }

  const keep: PV2[] = [];
  for (let q = 0; q < quadCount; q++) {
    if (!absorbed.has(q)) keep.push(...keepVerts.slice(q * 4, q * 4 + 4));
  }
  return { keep, facadeVerts, facadeIndices };
}
