// Warp resolution. Ports gen1recomp src/world/Warp.lua — a warp fires when:
//   * the player finishes a step onto a warp cell whose collision tile is a
//     door or warp tile (stairs, doors, mats, cave entrances), or
//   * the player stands on a warp cell and tries to walk off the map edge
//     (exit carpets at the bottom of interiors), or
//   * the player stands on a warp cell and the "extra" check passes.
// Mirrors pokered CheckWarpsNoCollision / CheckWarpsCollision /
// ExtraWarpCheck (home/overworld.asm).

import type { MapWarp, VoxelmonData } from "../data.ts";
import { target, type Dir } from "./collision.ts";
import type { GameMap, WarpAt } from "./map.ts";

export interface WarpCarpets {
  edgeMaps: string[];
  function2Maps: string[];
  function2Tilesets: string[];
  ssAnneBow: { map: string; tile: number };
  tiles: Record<Dir, number[]>;
}

export interface LastOutdoor {
  id: string;
  x: number;
  y: number;
}

// Warp.lua:17 onArrive — the warp entry to take when arriving at (cx,cy).
export function onArrive(map: GameMap, cx: number, cy: number): WarpAt | null {
  const w = map.warpAtCell(cx, cy);
  if (w && map.isWarpTileCell(cx, cy)) {
    return w;
  }
  return null;
}

// Warp.lua:38 extraCheck (ExtraWarpCheck): on the carpet maps/tilesets the
// tile in FRONT of the player must be a warp-carpet tile for the facing
// direction; everywhere else the player must face the map edge. The map
// exceptions are tested before the tileset.
export function extraCheck(
  map: GameMap,
  carpets: WarpCarpets | undefined,
  cx: number,
  cy: number,
  dir: Dir,
): boolean {
  const facingEdge =
    (dir === "up" && cy === 0) ||
    (dir === "down" && cy === map.heightCells - 1) ||
    (dir === "left" && cx === 0) ||
    (dir === "right" && cx === map.widthCells - 1);
  if (!carpets) return facingEdge;
  let useCarpet: boolean;
  if (carpets.edgeMaps.includes(map.id)) {
    useCarpet = false;
  } else if (carpets.function2Maps.includes(map.id)) {
    useCarpet = true;
  } else {
    useCarpet = carpets.function2Tilesets.includes(map.def.tileset);
  }
  if (!useCarpet) return facingEdge;
  const [tx, ty] = target(cx, cy, dir);
  const front = map.cellTile(tx, ty);
  if (map.id === carpets.ssAnneBow.map) {
    return front === carpets.ssAnneBow.tile;
  }
  return carpets.tiles[dir].includes(front);
}

// Warp.lua:67 onCollision — standing on (cx,cy), the extra check passes
// toward dir (fired from a blocked step, or on arrival with the d-pad held).
export function onCollision(
  map: GameMap,
  carpets: WarpCarpets | undefined,
  cx: number,
  cy: number,
  dir: Dir,
): WarpAt | null {
  const w = map.warpAtCell(cx, cy);
  if (w && extraCheck(map, carpets, cx, cy, dir)) {
    return w;
  }
  return null;
}

// Warp.lua:77 onEdge — standing on (cx,cy) and moving toward dir takes the
// player out of bounds.
export function onEdge(map: GameMap, cx: number, cy: number, dir: Dir): WarpAt | null {
  const w = map.warpAtCell(cx, cy);
  if (!w) return null;
  const [tx, ty] = target(cx, cy, dir);
  if (!map.inBounds(tx, ty)) {
    return w;
  }
  return null;
}

// Warp.lua:93 resolve + :118 destination — resolve a warp's destination to
// map id + cell. LAST_MAP destinations resolve against the remembered
// outdoor map; the landing cell is that map's warp entry named by the warp
// id (two-sided route gates land you on the side you exit).
//
// destWarp in the dataset is 1-based (SCHEMA parity kept Lua values), so
// indexing the 0-based JSON warps array subtracts one.
export function destination(
  data: Pick<VoxelmonData, "maps">,
  warpDef: MapWarp,
  lastOutdoor?: LastOutdoor,
): { map: string; x: number; y: number } {
  let destMap = warpDef.destMap;
  if (destMap === "LAST_MAP") {
    if (!lastOutdoor) {
      throw new Error("LAST_MAP warp with no remembered outdoor map");
    }
    destMap = lastOutdoor.id;
    const destDef = data.maps?.[destMap];
    const dw = destDef?.warps[warpDef.destWarp - 1];
    if (dw) {
      return { map: destMap, x: dw.x, y: dw.y };
    }
    // out-of-range data: fall back to where the player entered
    return { map: destMap, x: lastOutdoor.x, y: lastOutdoor.y };
  }
  const destDef = data.maps?.[destMap];
  if (!destDef) throw new Error(`warp to unknown map ${destMap}`);
  const dw = destDef.warps[warpDef.destWarp - 1];
  if (!dw) throw new Error(`warp to ${destMap}#${warpDef.destWarp} out of range`);
  return { map: destMap, x: dw.x, y: dw.y };
}
