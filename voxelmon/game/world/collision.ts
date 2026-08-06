// Movement permission checks. Ports gen1recomp src/world/Collision.lua:
// tile passability, map bounds, entity occupancy, and the tile-pair
// (elevation) table from field.tilePairs. The Lua caches tilePairs through
// Collision.load(data); this port threads them as a parameter.

import type { GameMap } from "./map.ts";

export type Dir = "up" | "down" | "left" | "right";

// Collision.lua:8
export const DELTA: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export interface Mover {
  cellX: number;
  cellY: number;
  targetX?: number;
  targetY?: number;
  passable?: boolean;
  surfing?: boolean;
}

export interface TilePair {
  tileset: string;
  a: number;
  b: number;
}

export interface TilePairs {
  land?: TilePair[];
  water?: TilePair[];
}

// Collision.lua:11
export function target(cx: number, cy: number, dir: Dir): [number, number] {
  const d = DELTA[dir];
  return [cx + d[0], cy + d[1]];
}

// Collision.lua:20 — anything with cellX/cellY (and targetX/targetY while
// mid-step, so nobody walks into a cell being entered); e.passable entities
// never block.
export function occupied(
  entities: readonly Mover[],
  cx: number,
  cy: number,
  ignore?: Mover,
): Mover | null {
  for (const e of entities) {
    if (e !== ignore && !e.passable) {
      if (
        (e.cellX === cx && e.cellY === cy) ||
        (e.targetX === cx && e.targetY === cy)
      ) {
        return e;
      }
    }
  }
  return null;
}

// Collision.lua:40 pairBlocked — certain tile pairs can't be crossed in a
// given tileset (cave/forest ledges), in either order.
function pairBlocked(
  map: GameMap,
  mover: Mover,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  tilePairs?: TilePairs,
): boolean {
  if (!tilePairs) return false;
  const list = mover.surfing ? tilePairs.water : tilePairs.land;
  if (!list || list.length === 0) return false;
  const tileset = map.def.tileset;
  const a = map.cellTile(sx, sy);
  const b = map.cellTile(tx, ty);
  for (const p of list) {
    if (p.tileset === tileset && ((p.a === a && p.b === b) || (p.a === b && p.b === a))) {
      return true;
    }
  }
  return false;
}

export type BlockReason = "bounds" | "tile" | "entity";

/**
 * Collision.lua:84 canMove — may the mover step from its cell toward dir?
 * Out-of-bounds is blocked here; the overworld controller handles map
 * connections and edge warps before asking.
 */
export function canMove(
  map: GameMap,
  entities: readonly Mover[],
  mover: Mover,
  dir: Dir,
  tilePairs?: TilePairs,
): { ok: boolean; why?: BlockReason } {
  const [tx, ty] = target(mover.cellX, mover.cellY, dir);
  if (!map.inBounds(tx, ty)) {
    return { ok: false, why: "bounds" };
  }
  if (!map.isWalkableCell(tx, ty)) {
    // Collision.lua:61 — surfers may ride water cells
    if (!(mover.surfing && map.isWaterCell(tx, ty))) {
      return { ok: false, why: "tile" };
    }
  }
  if (pairBlocked(map, mover, mover.cellX, mover.cellY, tx, ty, tilePairs)) {
    return { ok: false, why: "tile" };
  }
  if (occupied(entities, tx, ty, mover)) {
    return { ok: false, why: "entity" };
  }
  return { ok: true };
}
