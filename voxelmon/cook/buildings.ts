// voxelmon/cook/buildings.ts — buildings voxelized from their sprites.
//
// Port of VoxelMod lib/Buildings.lua, the four-stage pipeline:
//   read     composite the template from the atlas, flood the silhouette in
//            from the border through light pixels (col <= GREY)
//   measure  top[x] roof elevation profile, the drawn ground line, panes
//            (non-black regions sealed by black frames, bbox < 24 both dims)
//   model    roof slab following top[x] with the roofSy rim/cycle mapping,
//            awning rows, facade extrusion with recesses, interior de-outline
//   emit     shell cull + merge texel-adjacent face runs, capped at the 8px
//            lattice (runCap)
// One model per template, stamped at every placement; first claim wins in
// list order. Desk-set templates (`parts`/`tray`) are interior furniture and
// are NOT built in v1 — they are skipped and reported.

import type { Shape } from "./classify.ts";
import { type Art, type GameMap, mod, type BuildingTemplate, type Profile } from "./data.ts";
import { FACE, type Facing, keyOf, type Quad, type SGrid } from "./geom.ts";

// VoxelMod Buildings.lua:58 — the four GB shades, lightest first.
const WHITE = 0;
const GREY = 1;
const DARK = 2;
const BLACK = 3;

// Buildings.lua:64 RECESS_MAX.
const RECESS_MAX = 24;

// Buildings.lua:68 SHADE.
const SHADE = { top: 0.95, south: 1.0, north: 0.68, side: 0.78, bottom: 0.5 };

// Buildings.lua:103 CELL — a merged run stops at the next 8px lattice line.
const CELL = 8;
const runCap = (a: number): number => CELL - mod(a, CELL);

interface Sprite {
  W: number;
  H: number;
  col: number[];
  ax: number[];
  ay: number[];
  inside: boolean[];
}

interface Measure {
  top: number[];
  ytop: number;
  D: number;
  ground: number;
  recess: Set<number>;
  interior: number[];
  shadeTexel: number[];
}

interface Model {
  at: (x: number, y: number, z: number) => number | undefined;
  W: number;
  ytop: number;
  zmin: number;
  zmax: number;
}

export interface BuiltModel {
  quads: Quad[];
  voxels: number;
  shell: number;
}

export interface BuildingStats {
  built: string[];
  claimOnly: string[];
  skipped: string[];
  placements: number;
}

// Buildings.lua:116 shadeOf — our gfx byte IS the shade code; clear = WHITE.
function shadeOf(byte: number): number {
  return byte === 0xff ? WHITE : byte & 3;
}

// ------------------------------------------------------------------ read --
// Buildings.lua:152.
function read(t: BuildingTemplate, art: Art, perRow: number): Sprite {
  let tiles = t.tiles;
  if (t.topRows) tiles = [...t.topRows, ...t.tiles];
  const bh = tiles.length;
  const bw = t.tiles[0].length;
  const W = bw * 8;
  const H = bh * 8;
  const col = new Array<number>(W * H);
  const ax = new Array<number>(W * H);
  const ay = new Array<number>(W * H);
  for (let sy = 0; sy < H; sy++) {
    const row = tiles[Math.floor(sy / 8)];
    for (let sx = 0; sx < W; sx++) {
      const tile = row[Math.floor(sx / 8)];
      const px = (tile % perRow) * 8 + (sx % 8);
      const py = Math.floor(tile / perRow) * 8 + (sy % 8);
      const i = sy * W + sx;
      ax[i] = px;
      ay[i] = py;
      col[i] = shadeOf(art.px(px, py));
    }
  }

  const outside = new Array<boolean>(W * H).fill(false);
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    const i = y * W + x;
    if (!outside[i] && col[i] <= GREY) {
      outside[i] = true;
      queue.push(i);
    }
  };
  const seal = t.seal ?? "";
  const sealed = (side: string): boolean => seal.includes(side);
  for (let x = 0; x < W; x++) {
    if (!sealed("n")) seed(x, 0);
    if (!sealed("s")) seed(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    if (!sealed("w")) seed(0, y);
    if (!sealed("e")) seed(W - 1, y);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % W;
    const y = Math.floor(i / W);
    if (x + 1 < W) seed(x + 1, y);
    if (x > 0) seed(x - 1, y);
    if (y + 1 < H) seed(x, y + 1);
    if (y > 0) seed(x, y - 1);
  }

  const inside = new Array<boolean>(W * H);
  for (let i = 0; i < W * H; i++) inside[i] = !outside[i];

  // `scrub` (Buildings.lua:224): rects repainted as the plain field shade.
  if (t.scrub) {
    const inRect = (x: number, y: number): boolean => {
      for (const r of t.scrub!) {
        if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return true;
      }
      return false;
    };
    let donor: number | null = null;
    for (let i = 0; i < W * H; i++) {
      if (col[i] === GREY && inside[i] && !inRect(i % W, Math.floor(i / W))) {
        donor = i;
        break;
      }
    }
    if (donor !== null) {
      for (let i = 0; i < W * H; i++) {
        if (inRect(i % W, Math.floor(i / W))) {
          col[i] = GREY;
          ax[i] = ax[donor];
          ay[i] = ay[donor];
          inside[i] = true;
        }
      }
    }
  }
  return { W, H, col, ax, ay, inside };
}

// --------------------------------------------------------------- measure --
// Buildings.lua:252.
function measure(sp: Sprite, t: BuildingTemplate): Measure {
  const { W, H } = sp;
  const roofRows = t.roofRows!;

  // The drawn taper IS the slope.
  const top = new Array<number>(W);
  for (let x = 0; x < W; x++) {
    let r = roofRows;
    for (let y = 0; y < roofRows; y++) {
      if (sp.inside[y * W + x]) {
        r = y;
        break;
      }
    }
    top[x] = r;
  }

  // The drawing's own ground line: the row after the last drawn one.
  let ground = roofRows;
  for (let sy = H - 1; sy >= roofRows; sy--) {
    let drawn = false;
    for (let sx = 0; sx < W; sx++) {
      if (sp.inside[sy * W + sx]) {
        drawn = true;
        break;
      }
    }
    if (drawn) {
      ground = sy + 1;
      break;
    }
  }

  const wallH = ground - roofRows;
  const ytop = wallH - 1 + t.slab!;

  // de-outline: walk inward for the first painted colour.
  const interior = new Array<number>(W * H);
  for (let sy = roofRows; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const i = sy * W + sx;
      let src = i;
      if (sp.inside[i] && sp.col[i] === BLACK) {
        const step = sx < W / 2 ? 1 : -1;
        for (let d = 1; d <= 3; d++) {
          const nx = sx + step * d;
          if (nx >= 0 && nx < W) {
            const ni = sy * W + nx;
            if (sp.inside[ni] && sp.col[ni] !== BLACK) {
              src = ni;
              break;
            }
          }
        }
      }
      interior[i] = src;
    }
  }

  // Panes: non-black regions across the black frames; small ones sink.
  let recess = new Set<number>();
  const seen = new Set<number>();
  for (let sy = roofRows; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const i0 = sy * W + sx;
      if (seen.has(i0) || !sp.inside[i0] || sp.col[i0] === BLACK) continue;
      const cells: number[] = [];
      const stack = [i0];
      seen.add(i0);
      let x0 = sx;
      let x1 = sx;
      let y0 = sy;
      let y1 = sy;
      const step = (nx: number, ny: number): void => {
        if (nx < 0 || nx >= W || ny < roofRows || ny >= H) return;
        const ni = ny * W + nx;
        if (!seen.has(ni) && sp.inside[ni] && sp.col[ni] !== BLACK) {
          seen.add(ni);
          stack.push(ni);
        }
      };
      while (stack.length > 0) {
        const i = stack.pop()!;
        cells.push(i);
        const cx = i % W;
        const cy = Math.floor(i / W);
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        step(cx + 1, cy);
        step(cx - 1, cy);
        step(cx, cy + 1);
        step(cx, cy - 1);
      }
      if (x1 - x0 < RECESS_MAX && y1 - y0 < RECESS_MAX) {
        for (const i of cells) recess.add(i);
      }
    }
  }
  if (t.panes === false) recess = new Set();

  // One representative texel per shade, from the building's own art.
  const shadeTexel = new Array<number>(4);
  const found = new Array<boolean>(4).fill(false);
  for (let i = 0; i < sp.W * sp.H; i++) {
    if (sp.inside[i] && !found[sp.col[i]]) {
      found[sp.col[i]] = true;
      shadeTexel[sp.col[i]] = i;
    }
  }
  for (let s = WHITE; s <= BLACK; s++) {
    if (!found[s]) shadeTexel[s] = found[BLACK] ? shadeTexel[BLACK] : 0;
  }

  return {
    top,
    ytop,
    D: t.depthPx ?? (t.depth ?? t.tiles.length) * 8,
    ground,
    recess,
    interior,
    shadeTexel,
  };
}

// ----------------------------------------------------------------- model --
// Buildings.lua:880 (the standard facade+roof path; desk sets skipped).
function model(sp: Sprite, pr: Measure, t: BuildingTemplate): Model {
  const { W } = sp;
  const D = pr.D;
  const slab = t.slab!;
  const roofRows = t.roofRows!;
  const { top, ytop, ground } = pr;

  // The roof's drawn span (a sprite inset from its box).
  let x0d: number | undefined;
  let x1d = 0;
  for (let x = 0; x < W; x++) {
    if (top[x] < roofRows) {
      x0d ??= x;
      x1d = x;
    }
  }
  let ledge0: number | undefined;
  let ledge1 = 0;
  if (t.ledge) {
    ledge0 = t.ledge[0];
    ledge1 = t.ledge[1];
  }

  const rz0 = 0;
  const rz1 = D - 1 + (t.frontEave ?? 0);
  const back = t.roofBack!;
  const front = t.roofFront!;
  const cyc0 = t.roofCycle![0];
  const cyc1 = t.roofCycle![1];
  const cycN = cyc1 - cyc0 + 1;

  // Which drawn row lies at depth z (Buildings.lua:911).
  const roofSy = new Array<number>(rz1 + 1);
  for (let z = rz0; z <= rz1; z++) {
    const df = z - rz0;
    const db = rz1 - z;
    if (df < back) roofSy[z] = df;
    else if (db < front) roofSy[z] = roofRows - 1 - db;
    else roofSy[z] = cyc0 + mod(df - cyc0, cycN);
  }

  const T = new Array<number>(W);
  for (let x = 0; x < W; x++) T[x] = ytop - top[x];

  const at = (x: number, y: number, z: number): number | undefined => {
    if (x < 0 || x >= W) return undefined;
    const tx = T[x];

    // roof: a solid of constant thickness following the elevation profile
    if (top[x] < roofRows && y > tx - slab && y <= tx && z >= rz0 && z <= rz1) {
      if (y === tx && x > x0d! && x < x1d && z > rz0 && z < rz1) {
        let sy = roofSy[z];
        if (sy < top[x]) sy = top[x];
        return sy * W + x;
      }
      const outer = x === x0d || x === x1d || z === rz0 || z === rz1;
      if (!outer) return pr.shadeTexel[DARK];
      if (y === tx || y === tx - slab + 1) return pr.shadeTexel[BLACK];
      return pr.shadeTexel[DARK];
    }

    // trimmed: under the slope
    if (top[x] < roofRows && y > tx - slab) return undefined;

    // the awning: the band juts two voxels past the walls, front and back
    if (ledge0 !== undefined && (z === -2 || z === -1 || z === D || z === D + 1)) {
      const sy = ground - 1 - y;
      if (sy >= ledge0 && sy <= ledge1 && sp.inside[sy * W + x]) return sy * W + x;
      return undefined;
    }

    // the facade, extruded straight back over the footprint
    if (z < 0 || z >= D) return undefined;
    let sy = ground - 1 - y;
    let i = sy * W + x;
    if (y === 0 && !sp.inside[i] && sy > 0 && sp.inside[i - W]) {
      sy -= 1;
      i -= W;
    }
    if (!sp.inside[i]) return undefined;
    if (z === D - 1) {
      if (pr.recess.has(i)) return undefined;
      return i;
    }
    if (z === 0) return i;
    return pr.interior[i];
  };

  return {
    at,
    W,
    ytop,
    zmin: ledge0 !== undefined ? -2 : 0,
    zmax: Math.max(rz1, ledge0 !== undefined ? D + 1 : 0),
  };
}

// ------------------------------------------------------------------ emit --
// Buildings.lua:999 — cull to the shell and merge runs.
function emit(m: Model, sp: Sprite): BuiltModel {
  const W = m.W;
  const quads: Quad[] = [];
  let voxels = 0;
  let shell = 0;

  const { zmin, zmax, ytop } = m;
  const zn = zmax - zmin + 1;
  const cell = new Array<number | undefined>((ytop + 1) * zn * W);
  const ci = (x: number, y: number, z: number): number | undefined => {
    if (x < 0 || x >= W || y < 0 || y > ytop || z < zmin || z > zmax) return undefined;
    return cell[(y * zn + (z - zmin)) * W + x];
  };
  for (let y = 0; y <= ytop; y++) {
    for (let z = zmin; z <= zmax; z++) {
      const base = (y * zn + (z - zmin)) * W;
      for (let x = 0; x < W; x++) {
        const v = m.at(x, y, z);
        cell[base + x] = v;
        if (v !== undefined) voxels++;
      }
    }
  }
  for (let y = 0; y <= ytop; y++) {
    for (let z = zmin; z <= zmax; z++) {
      for (let x = 0; x < W; x++) {
        if (
          ci(x, y, z) !== undefined &&
          !(
            ci(x + 1, y, z) !== undefined &&
            ci(x - 1, y, z) !== undefined &&
            ci(x, y + 1, z) !== undefined &&
            ci(x, y - 1, z) !== undefined &&
            ci(x, y, z + 1) !== undefined &&
            ci(x, y, z - 1) !== undefined
          )
        ) {
          shell++;
        }
      }
    }
  }

  // u/v of a run in sheet px (0.05 insets — Buildings.lua:1041 uvOf).
  const uvOf = (i: number, strip: boolean, n: number): [number, number, number, number] => {
    const x0 = sp.ax[i];
    const y0 = sp.ay[i];
    const x1 = strip ? x0 + n : x0 + 1;
    return [x0 + 0.05, x1 - 0.05, y0 + 0.05, y0 + 1 - 0.05];
  };

  const put = (
    c1: [number, number, number],
    c2: [number, number, number],
    c3: [number, number, number],
    c4: [number, number, number],
    uv: [number, number][],
    shade: number,
    f: Facing,
  ): void => {
    quads.push({ c: [c1, c2, c3, c4], uv, shade, f, own: true });
  };

  // How far a run of exposed faces reaches from `x` (Buildings.lua:1055).
  const runX = (
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    x: number,
  ): [number, boolean, number] => {
    const i0 = ci(x, y, z)!;
    let strip: boolean | null = null;
    let n = 1;
    const cap = runCap(x);
    while (n < cap) {
      const nx = x + n;
      const i = ci(nx, y, z);
      if (i === undefined || ci(nx + dx, y + dy, z + dz) !== undefined) break;
      const prev = ci(nx - 1, y, z)!;
      if (sp.ay[i] !== sp.ay[prev]) break;
      const d = sp.ax[i] - sp.ax[prev];
      if (d === 1) {
        if (strip === false) break;
        strip = true;
      } else if (d === 0) {
        if (strip === true) break;
        strip = false;
      } else break;
      n++;
    }
    return [i0, strip === true, n];
  };

  // faces along +-Z (the facade, the roof's rims): merge along x
  for (const d of [1, -1]) {
    const shade = d === 1 ? SHADE.south : SHADE.north;
    // The model's z translates straight to world z at placement (+mz), so a
    // +z model face IS a south face.
    const face = d === 1 ? FACE.south : FACE.north;
    for (let y = 0; y <= ytop; y++) {
      for (let z = zmin; z <= zmax; z++) {
        let x = 0;
        while (x < W) {
          if (ci(x, y, z) !== undefined && ci(x, y, z + d) === undefined) {
            const [i, strip, n] = runX(y, z, 0, 0, d, x);
            const [u0, u1, v0, v1] = uvOf(i, strip, n);
            const zf = d === 1 ? z + 1 : z;
            if (d === 1) {
              put(
                [x, y, zf],
                [x + n, y, zf],
                [x + n, y + 1, zf],
                [x, y + 1, zf],
                [
                  [u0, v1],
                  [u1, v1],
                  [u1, v0],
                  [u0, v0],
                ],
                shade,
                face,
              );
            } else {
              put(
                [x + n, y, zf],
                [x, y, zf],
                [x, y + 1, zf],
                [x + n, y + 1, zf],
                [
                  [u1, v1],
                  [u0, v1],
                  [u0, v0],
                  [u1, v0],
                ],
                shade,
                face,
              );
            }
            x += n;
          } else x++;
        }
      }
    }
  }

  // faces along +-Y (roof surfaces, undersides): merge along x
  for (const d of [1, -1]) {
    const shade = d === 1 ? SHADE.top : SHADE.bottom;
    const face = d === 1 ? FACE.up : FACE.down;
    for (let y = 0; y <= ytop; y++) {
      if (d === -1 && y === 0) continue; // the underside of the bottom layer
      for (let z = zmin; z <= zmax; z++) {
        let x = 0;
        while (x < W) {
          if (ci(x, y, z) !== undefined && ci(x, y + d, z) === undefined) {
            const [i, strip, n] = runX(y, z, 0, d, 0, x);
            const [u0, u1, v0, v1] = uvOf(i, strip, n);
            const yf = d === 1 ? y + 1 : y;
            if (d === 1) {
              put(
                [x, yf, z],
                [x + n, yf, z],
                [x + n, yf, z + 1],
                [x, yf, z + 1],
                [
                  [u0, v0],
                  [u1, v0],
                  [u1, v1],
                  [u0, v1],
                ],
                shade,
                face,
              );
            } else {
              put(
                [x, yf, z + 1],
                [x + n, yf, z + 1],
                [x + n, yf, z],
                [x, yf, z],
                [
                  [u0, v1],
                  [u1, v1],
                  [u1, v0],
                  [u0, v0],
                ],
                shade,
                face,
              );
            }
            x += n;
          } else x++;
        }
      }
    }
  }

  // faces along +-X (the flanks): merge along z, one texel each
  for (const d of [1, -1]) {
    for (let y = 0; y <= ytop; y++) {
      for (let x = 0; x < W; x++) {
        let z = zmin;
        while (z <= zmax) {
          const i = ci(x, y, z);
          if (i !== undefined && ci(x + d, y, z) === undefined) {
            let n = 1;
            const cap = runCap(z);
            while (n < cap && z + n <= zmax) {
              const j = ci(x, y, z + n);
              if (j !== i || ci(x + d, y, z + n) !== undefined) break;
              n++;
            }
            const [u0, u1, v0, v1] = uvOf(i, false, n);
            const xf = d === 1 ? x + 1 : x;
            if (d === 1) {
              put(
                [xf, y, z + n],
                [xf, y, z],
                [xf, y + 1, z],
                [xf, y + 1, z + n],
                [
                  [u0, v1],
                  [u1, v1],
                  [u1, v0],
                  [u0, v0],
                ],
                SHADE.side,
                FACE.east,
              );
            } else {
              put(
                [xf, y, z],
                [xf, y, z + n],
                [xf, y + 1, z + n],
                [xf, y + 1, z],
                [
                  [u0, v1],
                  [u1, v1],
                  [u1, v0],
                  [u0, v0],
                ],
                SHADE.side,
                FACE.west,
              );
            }
            z += n;
          } else z++;
        }
      }
    }
  }

  return { quads, voxels, shell };
}

/**
 * Build one template's model without a placement — the coverage probe
 * (`does every standard band table run through the ported pipeline?`).
 * Returns quad/voxel/shell counts, or the thrown error message.
 */
export function probeTemplate(
  t: BuildingTemplate,
  art: Art,
  perRow: number,
): { quads: number; voxels: number; shell: number } | { error: string } {
  if (t.parts || t.tray || t.desk) return { error: "desk-set (not built in v1)" };
  if (t.claimOnly) return { quads: 0, voxels: 0, shell: 0 };
  try {
    const sp = read(t, art, perRow);
    const pr = measure(sp, t);
    const m = emit(model(sp, pr, t), sp);
    return { quads: m.quads.length, voxels: m.voxels, shell: m.shell };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------- placement --

// Buildings.lua:1185 matches.
function matches(S: SGrid, t: BuildingTemplate, tx: number, ty: number): boolean {
  const tiles = t.tiles;
  for (let r = 0; r < tiles.length; r++) {
    const row = tiles[r];
    for (let c = 0; c < row.length; c++) {
      if (S.tileAt.get(keyOf(tx + c, ty + r)) !== row[c]) return false;
    }
  }
  return true;
}

const models = new Map<string, BuiltModel>();

// Buildings.lua:1202 build — find placements, build once, stamp.
export function buildBuildings(
  S: SGrid,
  map: GameMap,
  art: Art,
  profile: Profile | null,
  stats: BuildingStats,
): void {
  const list = profile?.buildings?.[map.tileset.id];
  if (!list) return;
  const perRow = map.tileset.tilesPerRow || 16;
  const tw = map.def.width * 4;
  const th = map.def.height * 4;

  list.forEach((t, index) => {
    if (!Array.isArray(t.tiles) || t.tiles.length === 0) return;
    if (t.parts || t.tray || t.desk) {
      // desk-set templates (interior furniture) are not built in v1
      if (!stats.skipped.includes(t.id ?? `#${index}`)) stats.skipped.push(t.id ?? `#${index}`);
      return;
    }
    const bh = t.tiles.length;
    const bw = t.tiles[0].length;
    const first = t.tiles[0][0];
    let built: BuiltModel | null = null;
    for (let ty = 0; ty <= th - bh; ty++) {
      for (let tx = 0; tx <= tw - bw; tx++) {
        // first claim wins: never stamp into claimed cells
        let free = S.tileAt.get(keyOf(tx, ty)) === first;
        if (free) {
          outer: for (let r = 0; r < bh; r++) {
            for (let c = 0; c < bw; c++) {
              if (S.skip.has(keyOf(tx + c, ty + r))) {
                free = false;
                break outer;
              }
            }
          }
        }
        if (free && matches(S, t, tx, ty)) {
          if (!built) {
            const key = `${map.tileset.id}:${index}`;
            let m = models.get(key);
            if (!m) {
              if (t.claimOnly) {
                m = { quads: [], voxels: 0, shell: 0 };
                if (!stats.claimOnly.includes(t.id ?? key)) stats.claimOnly.push(t.id ?? key);
              } else {
                const sp = read(t, art, perRow);
                const pr = measure(sp, t);
                m = emit(model(sp, pr, t), sp);
                if (!stats.built.includes(t.id ?? key)) stats.built.push(t.id ?? key);
              }
              models.set(key, m);
            }
            built = m;
          }
          stampBuilding(S, built, tx, ty, bw, bh, t);
          stats.placements++;
        }
      }
    }
  });
}

// Buildings.lua:1281 stamp — claim tiles, vote ground, copy quads in place.
function stampBuilding(
  S: SGrid,
  built: BuiltModel,
  tx: number,
  ty: number,
  bw: number,
  bh: number,
  t: BuildingTemplate,
): void {
  const shape: Shape = {
    class: "building",
    h: t.support ?? 0,
    art: "building",
    flat: false,
    authored: true,
  };
  const keep = t.keep ? new Set(t.keep) : null;

  const votes = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  const vote = (x: number, y: number): void => {
    const k = keyOf(x, y);
    const ns = S.shapeAt.get(k);
    if (ns && ns.flat && ns.class !== "void") {
      const tile = S.tileAt.get(k)!;
      const n = (votes.get(tile) ?? 0) + 1;
      votes.set(tile, n);
      if (n > bestN) {
        best = tile;
        bestN = n;
      }
    }
  };
  for (let c = 0; c < bw; c++) {
    vote(tx + c, ty - 1);
    vote(tx + c, ty + bh);
  }
  for (let r = 0; r < bh; r++) {
    vote(tx - 1, ty + r);
    vote(tx + bw, ty + r);
  }

  for (let r = 0; r < bh; r++) {
    for (let c = 0; c < bw; c++) {
      const k = keyOf(tx + c, ty + r);
      if (keep?.has(S.tileAt.get(k)!)) {
        S.ground.set(k, best ?? false);
      } else {
        S.shapeAt.set(k, shape);
        S.skip.add(k);
        S.ground.set(k, best ?? false);
      }
    }
  }

  const mx = tx * 8;
  const mz = ty * 8;
  for (const q of built.quads) {
    S.objectQuads.push({
      c: [
        [q.c[0][0] + mx, q.c[0][1], q.c[0][2] + mz],
        [q.c[1][0] + mx, q.c[1][1], q.c[1][2] + mz],
        [q.c[2][0] + mx, q.c[2][1], q.c[2][2] + mz],
        [q.c[3][0] + mx, q.c[3][1], q.c[3][2] + mz],
      ],
      uv: q.uv,
      shade: q.shade,
      f: q.f,
      own: true,
    });
  }
}
