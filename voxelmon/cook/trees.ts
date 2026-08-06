// voxelmon/cook/trees.ts — round scenery: outline-hulled voxel balls.
//
// Port of VoxelMod lib/Structures.lua roundTemplate (:604) + buildCylinders
// (:1278) for the PLAIN hull paths: the one-cell `cylinder` (lone canopies,
// the border tree wall) and the 2x2-cell `canopy` group. The stump/can cut
// faces, the planter spray and the taper are interior-only refinements and
// are not ported in v1 — such cells fall back to the plain hull or the box
// path (reported by the CLI).
//
// A hull is carved ONCE per (tileset, tiles, ground set) signature and
// stamped per cell (Structures.lua:1268-1276 roundCache).

import { type Art, type GameMap, mod, shadeClassOf } from "./data.ts";
import { FACE, keyOf, type Quad, type SGrid } from "./geom.ts";
import { mergeQuads } from "./merge.ts";

// VoxelMod Structures.lua:571 ROUND_SHADE.
const ROUND_SHADE = { front: 1.0, back: 0.68, side: 0.78, top: 1.0, bottom: 0.55 };

// VoxelMod Structures.lua:64 ROUND_RING — hull carving stops this many
// tiles beyond the body; the far ring is simply not built.
export const ROUND_RING = 4;

/** GB shade byte -> brightness 0..1 (white = 1), clear reads white. */
function lum(byte: number): number {
  if (byte === 0xff) return 1;
  return (3 - (byte & 3)) / 3;
}

interface Template {
  quads: Quad[];
  /** The 2x2-px carve of the same drawing (`MESH_KIND.treeCoarse`). */
  coarse: Quad[];
  bg: number | false;
}

const roundCache = new Map<string, Template>();

interface Carve {
  quads: Quad[];
  bg: number | false;
}

// Structures.lua:604 roundTemplate, plain-hull subset (N x N x NY canvas).
//
// `step` is the voxel size in art px: 1 is the mod's own carve; 2 runs the
// SAME algorithm on a half-resolution canvas — every canvas pixel covers a
// step x step art block — and scales the emitted geometry back up, so the
// silhouette quantises to `step` px while the art on the faces stays
// full-resolution (UVs span the block's real texels and interpolate).
// step = 1 is float-identical to the pre-parameter code: every ` * step`
// multiplies by 1.0 and every classification block is a single texel.
function roundTemplate(
  S: SGrid,
  map: GameMap,
  art: Art,
  cx: number,
  cy: number,
  groundTiles: number[],
  N: number,
  step = 1,
): Carve {
  const NX = N / step;
  const NY = NX;
  const N2 = NX / 2;
  const perRow = map.tileset.tilesPerRow || 16;

  const tileOf = (px: number, py: number): number | undefined =>
    S.tileAt.get(
      keyOf(cx * 2 + Math.floor((px * step) / 8), cy * 2 + Math.floor((py * step) / 8)),
    );
  const texel = (px: number, py: number): [number, number] => {
    const tile = tileOf(px, py) ?? 0;
    return [
      (tile % perRow) * 8 + mod(px * step, 8),
      Math.floor(tile / perRow) * 8 + mod(py * step, 8),
    ];
  };

  // A canvas pixel is a step x step art block. The point-sampled faces
  // below (side walls, disc-step tops, undersides) borrow a representative
  // texel because the drawing has no art for those directions — and at
  // step 1 one texel IS the block, so the borrowed pixel participates in
  // the art's own dither. A coarse block cannot be spoken for by any single
  // pixel: GB canopies are dithered white-on-dark, so every pure pick is
  // wrong somewhere (corner picks dressed a light tree's flanks in outline
  // black; majority picks painted white slabs over dense crowns). Coarse
  // faces therefore carry the whole block as a UV SPAN — the mix renders
  // as the mix — via blockUv below; the helpers keep returning the chosen
  // block's origin texel.

  // Shade class of every canvas pixel. A coarse canvas pixel classifies its
  // whole art block, solidest class first: the outline ("black") must stay
  // CLOSED under downsampling — it is the flood barrier below — so a block
  // touching the outline IS outline, and "off" survives only where the
  // whole block is off.
  const CLS_RANK: Record<string, number> = { black: 0, dark: 1, light: 2, white: 3, off: 4 };
  const cls: string[] = new Array(NX * NY);
  for (let py = 0; py < NY; py++) {
    for (let px = 0; px < NX; px++) {
      const [ax, ay] = texel(px, py);
      let c = shadeClassOf(art.px(ax, ay));
      for (let dy = 0; dy < step && step > 1; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const c2 = shadeClassOf(art.px(ax + dx, ay + dy));
          if (CLS_RANK[c2] < CLS_RANK[c]) c = c2;
        }
      }
      cls[py * NX + px] = c;
    }
  }

  // 4-connected flood from a row band's border through `passable` classes
  const floodOutside = (passable: Set<string>, y0: number, y1: number): Set<number> => {
    const out = new Set<number>();
    const stack: number[] = [];
    const seed = (i: number): void => {
      if (!out.has(i) && passable.has(cls[i])) {
        out.add(i);
        stack.push(i);
      }
    };
    for (let px = 0; px < NX; px++) {
      seed(y0 * NX + px);
      seed(y1 * NX + px);
    }
    for (let py = y0; py <= y1; py++) {
      seed(py * NX);
      seed(py * NX + NX - 1);
    }
    while (stack.length > 0) {
      const i = stack.pop()!;
      const px = i % NX;
      const py = Math.floor(i / NX);
      if (px > 0) seed(i - 1);
      if (px < NX - 1) seed(i + 1);
      if (py > y0) seed(i - NX);
      if (py < y1) seed(i + NX);
    }
    return out;
  };

  // The mask: darkest-pixel outline plus its enclosure, dither fallback,
  // per cell band (Structures.lua:666-699).
  const mask = new Set<number>();
  for (let band = 0; band < NY / NX; band++) {
    const y0 = band * NX;
    const y1 = band * NX + NX - 1;
    let out = floodOutside(new Set(["off", "dark", "light", "white"]), y0, y1);
    let enclosed = 0;
    for (let i = y0 * NX; i < (y1 + 1) * NX; i++) {
      if (!out.has(i)) {
        mask.add(i);
        if (cls[i] !== "black") enclosed++;
      }
    }
    if (enclosed < (NX * NX) / 8) {
      out = floodOutside(new Set(["off", "light", "white"]), y0, y1);
      for (let i = y0 * NX; i < (y1 + 1) * NX; i++) {
        if (!out.has(i) && cls[i] !== "off") mask.add(i);
        else mask.delete(i);
      }
    }
  }
  if (mask.size === 0) return { quads: [], bg: false };

  // The ground the ball stands on: score flat ground tiles against the
  // cell's unmasked light pixels (Structures.lua:805-835).
  let bg: number | false = false;
  if (groundTiles.length > 0) {
    let bestScore: number | null = null;
    for (const t of groundTiles) {
      const ox = (t % perRow) * 8;
      const oy = Math.floor(t / perRow) * 8;
      let score = 0;
      let n = 0;
      for (let py = 0; py < NY; py++) {
        for (let px = 0; px < NX; px++) {
          const i = py * NX + px;
          const c = cls[i];
          if (!mask.has(i) && (c === "light" || c === "white")) {
            const [ax, ay] = texel(px, py);
            const d = lum(art.px(ax, ay)) - lum(art.px(ox + mod(px, 8), oy + mod(py, 8)));
            score += 3 * d * d;
            n++;
          }
        }
      }
      if (n > 0) {
        score /= n;
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          bg = t;
        }
      }
    }
  }

  // discs: per mask pixel a z chord [z0, z1) from its row's span circle
  // (Structures.lua:841-875).
  const z0 = new Array<number | undefined>(NX * NY);
  const z1 = new Array<number>(NX * NY);
  const src = new Array<number>(NX * NY);
  const loRow = new Array<number | undefined>(NY);
  const hiRow = new Array<number>(NY);
  let yBot: number | undefined;
  for (let iy = 0; iy < NY; iy++) {
    let lo: number | undefined;
    let hi = 0;
    for (let ix = 0; ix < NX; ix++) {
      if (mask.has(iy * NX + ix)) {
        lo ??= ix;
        hi = ix;
      }
    }
    if (lo === undefined) continue;
    loRow[iy] = lo;
    hiRow[iy] = hi;
    yBot = iy;
    const c = (lo + hi + 1) / 2;
    const hw = (hi - lo + 1) / 2;
    for (let ix = lo; ix <= hi; ix++) {
      const i = iy * NX + ix;
      if (!mask.has(i)) continue;
      const dx = ix + 0.5 - c;
      let n = 1;
      if (hw * hw > dx * dx) {
        n = Math.max(1, Math.floor(2 * Math.sqrt(hw * hw - dx * dx) + 0.5));
      }
      z0[i] = Math.floor(N2 - n / 2 + 0.5);
      z1[i] = z0[i]! + n;
      src[i] = iy;
    }
  }

  // foot: rows under the mask repeat the bottom row's discs, wearing the
  // bottom row's pixels (Structures.lua:914-924).
  for (let iy = yBot! + 1; iy < NY; iy++) {
    loRow[iy] = loRow[yBot!];
    hiRow[iy] = hiRow[yBot!];
    for (let ix = loRow[yBot!]!; ix <= hiRow[yBot!]; ix++) {
      const b = yBot! * NX + ix;
      if (z0[b] !== undefined) {
        const i = iy * NX + ix;
        z0[i] = z0[b];
        z1[i] = z1[b];
        src[i] = yBot!;
      }
    }
  }

  const solidAt = (ix: number, iy: number, iz: number): boolean => {
    if (ix < 0 || ix > NX - 1 || iy < 0 || iy > NY - 1) return false;
    const i = iy * NX + ix;
    if (z0[i] === undefined) return false;
    return iz >= z0[i]! && iz < z1[i];
  };

  // cap interiors sample the canopy a couple of rows deeper
  const deepTexel = (ix: number, iy: number): [number, number] => {
    for (let iy2 = iy + 2; iy2 <= Math.min(NY - 1, iy + 4); iy2++) {
      const i = iy2 * NX + ix;
      if (mask.has(i) && cls[i] !== "black") return texel(ix, iy2);
    }
    return texel(ix, iy);
  };

  // side walls read as material: de-outline walk (Structures.lua:1067-1085)
  const sideTexel = (ix: number, iy: number): [number, number] => {
    const r = yBot !== undefined && iy > yBot ? yBot : src[iy * NX + ix];
    const dir = ix + ix < loRow[iy]! + hiRow[iy] ? 1 : -1;
    for (let step = 0; step <= 3; step++) {
      const x2 = ix + dir * step;
      const i2 = r * NX + x2;
      if (x2 < 0 || x2 > NX - 1 || !mask.has(i2)) break;
      if (cls[i2] !== "black") return texel(x2, r);
    }
    return texel(ix, r);
  };

  // The span-or-point choice for a borrowed-texel face (see blockUv note
  // above): fine faces keep their single texel; coarse faces stretch the
  // block across the quad so dithered material renders as the mix. The
  // 0.05 inset mirrors the drawing faces' seam guard. A UNIFORM block —
  // every pixel the same value — keeps the point form: the span would show
  // the same pixels, and point faces still collapse in the cook-time merge
  // (span-ifying them cost ~20% more coarse quads for zero visible change).
  const blockUv = (
    ax: number,
    ay: number,
  ): { u?: number; v?: number; uv?: [number, number][] } => {
    if (step === 1) return { u: ax + 0.5, v: ay + 0.5 };
    const p0 = art.px(ax, ay);
    let uniform = true;
    for (let dy = 0; dy < step && uniform; dy++) {
      for (let dx = 0; dx < step; dx++) {
        if (art.px(ax + dx, ay + dy) !== p0) {
          uniform = false;
          break;
        }
      }
    }
    if (uniform) return { u: ax + 0.5, v: ay + 0.5 };
    return {
      uv: [
        [ax + 0.05, ay + step - 0.05],
        [ax + step - 0.05, ay + step - 0.05],
        [ax + step - 0.05, ay + 0.05],
        [ax + 0.05, ay + 0.05],
      ],
    };
  };

  const quads: Quad[] = [];

  for (let iy = 0; iy < NY; iy++) {
    if (loRow[iy] === undefined) continue;
    const yB = NY - 1 - iy;
    const yT = NY - iy;

    // front and back: the drawing per-pixel, columns merged where they
    // share a chord plane; a run never crosses the 8px atlas tile seam
    let ix = loRow[iy]!;
    while (ix <= hiRow[iy]) {
      const i = iy * NX + ix;
      if (z0[i] === undefined) {
        ix++;
        continue;
      }
      let ix2 = ix;
      while (ix2 + 1 <= hiRow[iy]) {
        const j = iy * NX + ix2 + 1;
        if (
          z0[j] === z0[i] &&
          z1[j] === z1[i] &&
          src[j] === src[i] &&
          Math.floor(((ix2 + 1) * step) / 8) === Math.floor((ix * step) / 8)
        ) {
          ix2++;
        } else break;
      }
      const x0 = ix - N2;
      const x1 = ix2 - N2 + 1;
      const zF = z1[i] - N2;
      const zB = z0[i]! - N2;
      const row = src[i];
      const [ax0, ay] = texel(ix, row);
      const [ax1] = texel(ix2, row);
      // A canvas pixel is a step x step art block: the run's art span ends
      // at the LAST texel of its last block, and the face is `step` art
      // rows tall — the full-resolution art rides the coarse geometry.
      const u0 = ax0 + 0.05;
      const u1 = ax1 + (step - 1) + 0.95;
      const v0 = ay + 0.05;
      const v1 = ay + (step - 1) + 0.95;
      quads.push({
        c: [
          [x0, yB, zF],
          [x1, yB, zF],
          [x1, yT, zF],
          [x0, yT, zF],
        ],
        uv: [
          [u0, v1],
          [u1, v1],
          [u1, v0],
          [u0, v0],
        ],
        shade: ROUND_SHADE.front,
        // zF > zB by construction (the depth scan fills z1 > z0) and the
        // stamp translates in +z, so the drawing's own face is the SOUTH one.
        f: FACE.south,
      });
      quads.push({
        c: [
          [x1, yB, zB],
          [x0, yB, zB],
          [x0, yT, zB],
          [x1, yT, zB],
        ],
        uv: [
          [u1, v1],
          [u0, v1],
          [u0, v0],
          [u1, v0],
        ],
        shade: ROUND_SHADE.back,
        f: FACE.north,
      });
      ix = ix2 + 1;
    }

    // sides, steps, undersides: borrowed-texel quads over the z runs a
    // neighbour doesn't cover (Structures.lua:1165-1262)
    for (let ix3 = loRow[iy]!; ix3 <= hiRow[iy]; ix3++) {
      const i = iy * NX + ix3;
      if (z0[i] === undefined) continue;
      const [ax, ayp] = texel(ix3, src[i]);
      const ownUv = blockUv(ax, ayp);
      const x0 = ix3 - N2;
      const x1 = ix3 - N2 + 1;

      const pieces = (
        nx: number,
        ny: number,
        emit: (zA: number, zB: number, izA: number, izB: number) => void,
      ): void => {
        let iz = z0[i]!;
        const zHi = z1[i];
        while (iz < zHi) {
          if (!solidAt(nx, ny, iz)) {
            let iz2 = iz;
            while (iz2 + 1 < zHi && !solidAt(nx, ny, iz2 + 1)) iz2++;
            emit(iz - N2, iz2 - N2 + 1, iz, iz2);
            iz = iz2 + 1;
          } else iz++;
        }
      };

      const [sax, say] = sideTexel(ix3, iy);
      const sideUv = blockUv(sax, say);
      pieces(ix3 - 1, iy, (zA, zB) => {
        quads.push({
          c: [
            [x0, yB, zA],
            [x0, yB, zB],
            [x0, yT, zB],
            [x0, yT, zA],
          ],
          ...sideUv,
          shade: ROUND_SHADE.side,
          f: FACE.west,
        });
      });
      pieces(ix3 + 1, iy, (zA, zB) => {
        quads.push({
          c: [
            [x1, yB, zB],
            [x1, yB, zA],
            [x1, yT, zA],
            [x1, yT, zB],
          ],
          ...sideUv,
          shade: ROUND_SHADE.side,
          f: FACE.east,
        });
      });
      pieces(ix3, iy - 1, (zA, zB, izA, izB) => {
        const top = (
          za: number,
          zb: number,
          tuv: ReturnType<typeof blockUv>,
        ): void => {
          quads.push({
            c: [
              [x0, yT, za],
              [x1, yT, za],
              [x1, yT, zb],
              [x0, yT, zb],
            ],
            ...tuv,
            shade: ROUND_SHADE.top,
            f: FACE.up,
          });
        };
        if (izA === z0[i] && izB === z1[i] - 1 && izB - izA >= 2) {
          // the dome cap: outline on the rim cells, canopy inside
          const [du, dv] = deepTexel(ix3, iy);
          top(zA, zA + 1, ownUv);
          top(zA + 1, zB - 1, blockUv(du, dv));
          top(zB - 1, zB, ownUv);
        } else {
          top(zA, zB, ownUv);
        }
      });
      if (iy < NY - 1) {
        pieces(ix3, iy + 1, (zA, zB) => {
          quads.push({
            c: [
              [x0, yB, zB],
              [x1, yB, zB],
              [x1, yB, zA],
              [x0, yB, zA],
            ],
            ...ownUv,
            shade: ROUND_SHADE.bottom,
            f: FACE.down,
          });
        });
      }
    }
  }
  // cook-time merge: same-shade flat faces collapse (see merge.ts)
  const merged = mergeQuads(quads, (u, v) => art.px(Math.floor(u), Math.floor(v)));
  // Canvas units -> world px. step = 1 skips the map entirely, so the fine
  // carve's floats are untouched by the parameter's existence.
  if (step !== 1) {
    for (const q of merged) {
      q.c = q.c.map(([x, y, z]) => [x * step, y * step, z * step]) as [number, number, number][];
    }
  }
  return { quads: merged, bg };
}

// Structures.lua:1278 buildCylinders — the cylinder/canopy scans.
export function buildCylinders(
  S: SGrid,
  map: GameMap,
  art: Art,
  groundTiles: number[],
): void {
  // The quality ladder's PREDECESSOR, superseded by the `treeHullDist` dial
  // (contracts/spec/voxel-spec.ts §quality ladder): VOXEL_TREE_BOXES=1 skips
  // ALL hull carving, so every round-scenery cell — including the one the
  // player stands next to — falls to the mesher's plain box. The ladder cooks
  // BOTH levels instead and picks per chunk at runtime, which is what this
  // global switch could never do. Kept because it is still the cheapest way
  // to price the boxes-everywhere floor; a pak cooked with it carries neither
  // tree mesh kind and declares no VXPK_META_FLAG_TREE_LOD.
  if (process.env.VOXEL_TREE_BOXES === "1") return;
  const tw = map.def.width * 4;
  const th = map.def.height * 4;
  const gsig = [...groundTiles].sort((a, b) => a - b).join(",");
  const tsid = map.tileset.id;

  const grouped = new Set<number>();
  for (let cy = Math.floor(S.y0 / 2); cy <= Math.floor(S.y1 / 2); cy++) {
    for (let cx = Math.floor(S.x0 / 2); cx <= Math.floor(S.x1 / 2); cx++) {
      const ckey = cy * 8192 + cx;
      const k = keyOf(cx * 2, cy * 2);
      const s = !grouped.has(ckey) ? S.shapeAt.get(k) : undefined;
      const near =
        cx * 2 >= -ROUND_RING &&
        cx * 2 < tw + ROUND_RING &&
        cy * 2 >= -ROUND_RING &&
        cy * 2 < th + ROUND_RING;
      if (s && s.art === "canopy" && near) {
        // ONE 32px hull over the 2x2-cell drawing (Structures.lua:1337).
        let whole = true;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const ps = S.shapeAt.get(keyOf((cx + dx) * 2, (cy + dy) * 2));
          if (!(ps && (ps.art === "cylinder" || ps.art === "canopy"))) whole = false;
        }
        if (!whole) continue;
        const ids: number[] = [];
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            ids.push(S.tileAt.get(keyOf(cx * 2 + dx, cy * 2 + dy)) ?? -1);
          }
        }
        const sig = `${tsid}|g32|${gsig}|${ids.join(":")}`;
        let tpl = roundCache.get(sig);
        if (!tpl) {
          const fine = roundTemplate(S, map, art, cx, cy, groundTiles, 32);
          // The middle level: same drawing, 2x2-px voxels, no ground vote
          // (the fine pass owns bg).
          const coarse = roundTemplate(S, map, art, cx, cy, [], 32, 2).quads;
          tpl = { quads: fine.quads, coarse, bg: fine.bg };
          roundCache.set(sig, tpl);
        }
        S.roundStamps.push({
          quads: tpl.quads,
          coarse: tpl.coarse,
          mx: cx * 16 + 16,
          mz: cy * 16 + 16,
          r: 16,
        });
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            const tk = keyOf(cx * 2 + dx, cy * 2 + dy);
            S.skip.add(tk);
            S.round.add(tk);
            S.ground.set(tk, tpl.bg);
          }
        }
        grouped.add(ckey + 1);
        grouped.add(ckey + 8192);
        grouped.add(ckey + 8193);
      } else if (s && s.art === "cylinder" && near) {
        // one 16px hull per cell (stump/can cut faces not ported: plain hull)
        const ids = [
          S.tileAt.get(k) ?? -1,
          S.tileAt.get(keyOf(cx * 2 + 1, cy * 2)) ?? -1,
          S.tileAt.get(keyOf(cx * 2, cy * 2 + 1)) ?? -1,
          S.tileAt.get(keyOf(cx * 2 + 1, cy * 2 + 1)) ?? -1,
        ];
        // BUDGET DEVIATION (reported): cells drawn with the border tree
        // wall's own tiles — the ring and the in-town hedge rows, one
        // drawing repeated for hundreds of cells — stay unclaimed and fall
        // through to the mesher's plain box, the mod's own degraded mode
        // for scenery past ROUND_RING. Carved, each cell replicates a
        // ~700-quad hull into the pools and a town pak balloons past 30MB.
        if (S.wallTiles && ids.every((t) => S.wallTiles!.has(t))) continue;
        const sig = `${tsid}|${gsig}|${ids.join(":")}`;
        let tpl = roundCache.get(sig);
        if (!tpl) {
          const fine = roundTemplate(S, map, art, cx, cy, groundTiles, 16);
          const coarse = roundTemplate(S, map, art, cx, cy, [], 16, 2).quads;
          tpl = { quads: fine.quads, coarse, bg: fine.bg };
          roundCache.set(sig, tpl);
        }
        S.roundStamps.push({
          quads: tpl.quads,
          coarse: tpl.coarse,
          mx: cx * 16 + 8,
          mz: cy * 16 + 8,
        });
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const tk = keyOf(cx * 2 + dx, cy * 2 + dy);
            S.skip.add(tk);
            S.round.add(tk);
            S.ground.set(tk, tpl.bg);
          }
        }
      }
    }
  }
}
