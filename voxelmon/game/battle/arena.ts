// Arena selection: where the fight is staged on the map. Ports the SEARCH
// half of DramaticShapeVoxelMod lib/BattleArena.lua (openCell :139,
// openGrid :153, fits :165, place :177, search :335): the two shapes scan
// the whole map for fully-open footprints, minimizing squared distance
// from the player to the shape midpoint, wide before narrow.
//
// v1 SEAMS, both flagged: no authored battle_arenas table (the cooker's
// data path; BattleArena.lua:43-98 authoredFor), and NO clearance walk —
// the guest has no terrain-height data, so the two-pass clear/obstructed
// search (BattleArena.lua:243-258 clearance, :338 needClear) collapses to
// one pass. When neither shape fits, the battle stages nothing and the ui
// battle screen stands alone ("a mod that cannot find a stage does not
// invent one").

import { ARENA_SHAPE } from "../../../contracts/spec/voxel-spec.ts";
import type { GameMap } from "../world/map.ts";

export interface ArenaShapeDef {
  id: number;
  w: number;
  h: number;
  enemy: [number, number];
  player: [number, number];
}

/** BattleArena.SHAPES (:107-110), ids from the spec's ARENA_SHAPE. */
export const SHAPES: ArenaShapeDef[] = [
  { id: ARENA_SHAPE.wide, w: 3, h: 6, enemy: [1, 1], player: [1, 4] },
  { id: ARENA_SHAPE.narrow, w: 1, h: 4, enemy: [0, 0], player: [0, 3] },
];

export interface Arena {
  shape: number;
  x: number;
  y: number;
  w: number;
  h: number;
  enemyCell: [number, number];
  playerCell: [number, number];
}

/**
 * BattleArena.lua:139-146 openCell — the walk test the player answers to:
 * in bounds, no warp, not a warp tile, NOT tall grass (it eats the sprite
 * from a low camera), and walkable (water only for a surfer).
 */
export function openCell(map: GameMap, cx: number, cy: number, surfing: boolean): boolean {
  if (!map.inBounds(cx, cy)) return false;
  if (map.warpAtCell(cx, cy)) return false;
  if (map.isWarpTileCell(cx, cy)) return false;
  if (map.isGrassCell(cx, cy)) return false;
  if (map.isWalkableCell(cx, cy)) return true;
  return surfing && map.isWaterCell(cx, cy);
}

/** BattleArena.lua:153-163 openGrid — one flat boolean grid per search. */
function openGrid(map: GameMap, surfing: boolean): [boolean[], number, number] {
  const w = map.widthCells;
  const h = map.heightCells;
  const grid: boolean[] = new Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    const row = cy * w;
    for (let cx = 0; cx < w; cx++) {
      grid[row + cx] = openCell(map, cx, cy, surfing);
    }
  }
  return [grid, w, h];
}

/** BattleArena.lua:165-173 fits. */
function fits(grid: boolean[], gw: number, x: number, y: number, w: number, h: number): boolean {
  for (let cy = y; cy < y + h; cy++) {
    const row = cy * gw;
    for (let cx = x; cx < x + w; cx++) {
      if (!grid[row + cx]) return false;
    }
  }
  return true;
}

/** BattleArena.lua:177-192 place — the record the staging layer reads. */
function place(shape: ArenaShapeDef, x: number, y: number): Arena {
  return {
    shape: shape.id,
    x,
    y,
    w: shape.w,
    h: shape.h,
    enemyCell: [x + shape.enemy[0], y + shape.enemy[1]],
    playerCell: [x + shape.player[0], y + shape.player[1]],
  };
}

/**
 * BattleArena.lua:335-361 search — the nearest arena the map can offer, or
 * null when neither shape fits anywhere. Both shapes are searched over the
 * whole map before the next one is tried: a wide arena on the far side
 * still beats a narrow one underfoot. Distance is player-to-midpoint
 * squared (:343-346). The needClear pass is the v1 seam (module header).
 */
export function search(
  map: GameMap,
  fromX: number,
  fromY: number,
  surfing: boolean,
): Arena | null {
  const [grid, gw, gh] = openGrid(map, surfing);
  for (const shape of SHAPES) {
    let best: Arena | null = null;
    let bestD = Infinity;
    for (let y = 0; y <= gh - shape.h; y++) {
      for (let x = 0; x <= gw - shape.w; x++) {
        if (!fits(grid, gw, x, y, shape.w, shape.h)) continue;
        const mx = x + (shape.w - 1) / 2;
        const my = y + (shape.h - 1) / 2;
        const dx = mx - fromX;
        const dy = my - fromY;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          best = place(shape, x, y);
          bestD = d;
        }
      }
    }
    if (best) return best;
  }
  return null;
}
