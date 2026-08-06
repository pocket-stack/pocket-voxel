// voxelmon/cook/merge.ts — color-lossless quad merging.
//
// The per-pixel passes (tree hulls, standees, grass tufts) emit one quad per
// exposed voxel face, each sampling a SINGLE texel (point u/v). Upstream
// ships these unmerged — free on a desktop GPU, ~40MB of vertex data in a
// pak. GB art has four shades, so two flat quads whose sampled shade BYTES
// are equal render identically whatever texel they name: coplanar
// same-shade rects merge without visual change. This pass is a cook-time
// addition over the upstream geometry (VoxelMod has no equivalent); it
// never touches uv-rect quads (the per-pixel drawing itself).

import type { Art } from "./data.ts";
import type { Quad } from "./geom.ts";

interface Rect {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  template: Quad;
  /** template corner classification: [aIsMin, bIsMin] per corner. */
  pattern: [boolean, boolean][];
}

const AXES: [number, number, number][] = [
  [0, 1, 2], // x-plane: a = y, b = z
  [1, 0, 2], // y-plane: a = x, b = z
  [2, 0, 1], // z-plane: a = x, b = y
];

/**
 * Merge point-sampled coplanar quads with equal flat shade and equal
 * sampled shade byte. `sample(u, v)` returns the art byte at sheet px.
 */
export function mergeQuads(quads: Quad[], sample: (u: number, v: number) => number): Quad[] {
  const out: Quad[] = [];
  const groups = new Map<string, Rect[]>();

  for (const q of quads) {
    if (q.u === undefined || q.v === undefined || q.uv || typeof q.shade !== "number") {
      out.push(q);
      continue;
    }
    // find the constant axis
    let axis = -1;
    for (const [ax] of AXES) {
      if (q.c.every((c) => c[ax] === q.c[0][ax])) {
        axis = ax;
        break;
      }
    }
    if (axis < 0) {
      out.push(q);
      continue;
    }
    const [, aAx, bAx] = AXES[axis];
    const as = q.c.map((c) => c[aAx]);
    const bs = q.c.map((c) => c[bAx]);
    const a0 = Math.min(...as);
    const a1 = Math.max(...as);
    const b0 = Math.min(...bs);
    const b1 = Math.max(...bs);
    if (a0 === a1 || b0 === b1) {
      out.push(q);
      continue;
    }
    // facing: winding sign of the projected polygon
    const u1 = [q.c[1][aAx] - q.c[0][aAx], q.c[1][bAx] - q.c[0][bAx]];
    const v1 = [q.c[2][aAx] - q.c[0][aAx], q.c[2][bAx] - q.c[0][bAx]];
    const sign = Math.sign(u1[0] * v1[1] - u1[1] * v1[0]);
    const byte = sample(q.u, q.v);
    // `f` joins the key so a merge can never span two facings even where a
    // winding accident makes their projected signs agree — the merged quad
    // carries one facing to the cull (geom.ts `cullHidden`).
    const key = `${axis}|${q.c[0][axis]}|${sign}|${q.f}|${q.shade}|${byte}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push({
      a0,
      a1,
      b0,
      b1,
      template: q,
      pattern: q.c.map((c) => [c[aAx] === a0, c[bAx] === b0]) as [boolean, boolean][],
    });
  }

  for (const [key, rects] of groups) {
    const axis = Number(key.split("|")[0]);
    const [, aAx, bAx] = AXES[axis];
    // merge along a (rects sharing an exact b-span and touching in a),
    // then along b — two passes of the classic strip merge.
    const mergePass = (
      list: Rect[],
      lo: "a0" | "b0",
      hi: "a1" | "b1",
      olo: "a0" | "b0",
      ohi: "a1" | "b1",
    ): Rect[] => {
      const sorted = [...list].sort(
        (p, q2) => p[olo] - q2[olo] || p[ohi] - q2[ohi] || p[lo] - q2[lo],
      );
      const merged: Rect[] = [];
      for (const r of sorted) {
        const prev = merged[merged.length - 1];
        if (prev && prev[olo] === r[olo] && prev[ohi] === r[ohi] && prev[hi] === r[lo]) {
          prev[hi] = r[hi];
        } else {
          merged.push({ ...r });
        }
      }
      return merged;
    };
    let merged = mergePass(rects, "a0", "a1", "b0", "b1");
    merged = mergePass(merged, "b0", "b1", "a0", "a1");

    for (const r of merged) {
      const t = r.template;
      const c = t.c.map((corner, i) => {
        const next: [number, number, number] = [...corner];
        next[aAx] = r.pattern[i][0] ? r.a0 : r.a1;
        next[bAx] = r.pattern[i][1] ? r.b0 : r.b1;
        return next;
      }) as [number, number, number][];
      out.push({ c, u: t.u, v: t.v, shade: t.shade, f: t.f, own: t.own });
    }
  }
  return out;
}
