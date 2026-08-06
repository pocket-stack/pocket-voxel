// Runtime map over the imported dataset. Ports gen1recomp src/world/Map.lua:
// all queries use "cells", the 16x16 walk grid (2x2 tiles); a map is
// width x height blocks, each block 2x2 cells (4x4 tiles). A cell is
// passable when the BOTTOM-LEFT 8x8 tile of the cell is in the tileset's
// walkable list (pokered checks the tile at the sprite's feet).
//
// Lua 1-based indexing folded out per SCHEMA.md: blocks/tileset arrays are
// read 0-based here; warp indices stay 0-based in the runtime table.

import type { MapDef, MapSign, MapWarp, TilesetDef } from "../data.ts";

// Map.lua:20-22 stale-cache fallbacks (item_effects.asm
// IsNextTileShoreOrWater / home/overworld.asm CollisionCheckOnWater): $14 is
// water everywhere; shore $32/$48 everywhere except SHIP_PORT where $32 is
// the dock's boarding platform.
const WATER_TILES = [0x14];
const SHORE_TILES = [0x32, 0x48];
const NO_SHORE_TILESETS = new Set(["SHIP_PORT"]);

// Map.lua:25 what counts as "outside" for the wLastMap memory
// (CheckIfInOutsideMap): OVERWORLD plus PLATEAU.
const OUTSIDE_TILESETS = ["OVERWORLD", "PLATEAU"];

// Map.lua:37 warp pads and fall-through holes
// (data/tilesets/warp_pad_hole_tile_ids.asm WarpPadAndHoleData).
const WARP_PAD_TILES: Record<string, Record<number, "pad" | "hole">> = {
  FACILITY: { 0x20: "pad", 0x11: "hole" },
  CAVERN: { 0x22: "hole" },
  INTERIOR: { 0x55: "pad" },
};

export interface WarpAt {
  /** 0-based position in def.warps (the Lua stores the 1-based ipairs i). */
  index: number;
  def: MapWarp;
}

function walkableList(ts: TilesetDef): number[] {
  // the ROM-built dataset stores walkable as a tile-id list (SCHEMA.md)
  return Array.isArray(ts.walkable) ? (ts.walkable as unknown as number[]) : [];
}

function waterTileSet(def: MapDef, ts: TilesetDef): Set<number> {
  const t = ts as unknown as { waterTiles?: number[]; shoreTiles?: number[] };
  const water = new Set(t.waterTiles ?? WATER_TILES);
  let shore = t.shoreTiles;
  if (shore === undefined && !NO_SHORE_TILESETS.has(def.tileset)) shore = SHORE_TILES;
  for (const s of shore ?? []) water.add(s);
  return water;
}

/**
 * Map.lua:52 defCellTile — collision tile (bottom-left 8x8) of a cell on an
 * UNLOADED map def: the connected neighbor during an edge crossing.
 */
export function defCellTile(
  def: MapDef | undefined,
  ts: TilesetDef | undefined,
  cx: number,
  cy: number,
): number | null {
  if (!def || !ts || !ts.blocks) return null;
  const tx = cx * 2;
  const ty = cy * 2 + 1;
  const bx = Math.floor(tx / 4);
  const by = Math.floor(ty / 4);
  let id: number;
  if (bx < 0 || by < 0 || bx >= def.width || by >= def.height) {
    id = def.borderBlock;
  } else {
    id = def.blocks[by * def.width + bx];
  }
  const block = ts.blocks[id ?? 0];
  if (!block) return null;
  return block[(ty % 4) * 4 + (tx % 4)];
}

/** Map.lua:83 defIsWalkableCell. */
export function defIsWalkableCell(
  def: MapDef | undefined,
  ts: TilesetDef | undefined,
  cx: number,
  cy: number,
): boolean {
  if (!ts || !ts.walkable) return false;
  const tile = defCellTile(def, ts, cx, cy);
  if (tile === null) return false;
  return walkableList(ts).includes(tile);
}

/** Map.lua:77 defIsWaterCell. */
export function defIsWaterCell(
  def: MapDef | undefined,
  ts: TilesetDef | undefined,
  cx: number,
  cy: number,
): boolean {
  if (!def || !ts) return false;
  const tile = defCellTile(def, ts, cx, cy);
  if (tile === null) return false;
  return waterTileSet(def, ts).has(tile);
}

/**
 * Map.lua:100 defPassable — passability on an unloaded neighbor def. Fails
 * closed: no tileset data means the landing cannot be proven safe, so the
 * step bumps (the Pallet south-shore stranding guard).
 */
export function defPassable(
  def: MapDef | undefined,
  ts: TilesetDef | undefined,
  cx: number,
  cy: number,
  surfing?: boolean,
): boolean {
  if (!def || !ts || !ts.blocks || !ts.walkable) return false;
  if (defIsWalkableCell(def, ts, cx, cy)) return true;
  if (surfing && defIsWaterCell(def, ts, cx, cy)) return true;
  return false;
}

/** Map.lua:148 isOutdoor — town/route surface (door SFX, walk-out step). */
export function isOutdoor(def: MapDef): boolean {
  const d = def as unknown as { outdoor?: boolean };
  if (d.outdoor !== undefined) return d.outdoor;
  return def.tileset === "OVERWORLD";
}

/** Map.lua:155 isOutside — CheckIfInOutsideMap, strictly wider (PLATEAU). */
export function isOutside(def: MapDef, tilesets?: string[]): boolean {
  if (isOutdoor(def)) return true;
  for (const ts of tilesets ?? OUTSIDE_TILESETS) {
    if (ts === def.tileset) return true;
  }
  return false;
}

export class GameMap {
  readonly def: MapDef;
  readonly tileset: TilesetDef;
  readonly id: string;
  readonly widthCells: number;
  readonly heightCells: number;
  private walkable = new Set<number>();
  private doorTiles = new Set<number>();
  private warpTiles = new Set<number>();
  private waterTiles: Set<number>;
  private warpAt = new Map<number, WarpAt>();
  private signAt = new Map<number, MapSign>();

  // Map.lua:112 Map.new
  constructor(def: MapDef, tilesetDef: TilesetDef) {
    this.def = def;
    this.tileset = tilesetDef;
    this.id = def.id;
    this.widthCells = def.width * 2;
    this.heightCells = def.height * 2;
    for (const t of walkableList(tilesetDef)) this.walkable.add(t);
    for (const t of tilesetDef.doorTiles ?? []) this.doorTiles.add(t);
    for (const t of tilesetDef.warpTiles ?? []) this.warpTiles.add(t);
    this.waterTiles = waterTileSet(def, tilesetDef);
    (def.warps ?? []).forEach((w, i) => {
      this.warpAt.set(w.y * this.widthCells + w.x, { index: i, def: w });
    });
    for (const s of def.signs ?? []) {
      this.signAt.set(s.y * this.widthCells + s.x, s);
    }
  }

  // Map.lua:196 blockAt — border-extended
  blockAt(bx: number, by: number): number {
    if (bx < 0 || by < 0 || bx >= this.def.width || by >= this.def.height) {
      return this.def.borderBlock;
    }
    return this.def.blocks[by * this.def.width + bx];
  }

  // Map.lua:204 tileAt — tile id at 8px tile coordinates, border-extended
  tileAt(tx: number, ty: number): number {
    const bx = Math.floor(tx / 4);
    const by = Math.floor(ty / 4);
    const block = this.tileset.blocks[this.blockAt(bx, by)];
    return block[(ty % 4) * 4 + (tx % 4)];
  }

  // Map.lua:211 cellTile — the collision tile of a cell: bottom-left 8x8
  cellTile(cx: number, cy: number): number {
    return this.tileAt(cx * 2, cy * 2 + 1);
  }

  // Map.lua:216
  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.widthCells && cy < this.heightCells;
  }

  // Map.lua:220
  isWalkableCell(cx: number, cy: number): boolean {
    return this.walkable.has(this.cellTile(cx, cy));
  }

  // Map.lua:224 — off-map cells never count as tall grass (issue #217: the
  // border filler carries the grass tile in some border blocks, and the
  // seam step parks the player at cellY = -1).
  isGrassCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const grass = this.tileset.grassTile;
    return grass !== undefined && this.cellTile(cx, cy) === grass;
  }

  // Map.lua:242 — water and eastern-shore tiles share one lookup
  isWaterCell(cx: number, cy: number): boolean {
    return this.waterTiles.has(this.cellTile(cx, cy));
  }

  // Map.lua:256 (pokered IsPlayerStandingOnDoorTile)
  isDoorTileCell(cx: number, cy: number): boolean {
    return this.doorTiles.has(this.cellTile(cx, cy));
  }

  // Map.lua:261 — door or warp-activating tile
  isWarpTileCell(cx: number, cy: number): boolean {
    const t = this.cellTile(cx, cy);
    return this.doorTiles.has(t) || this.warpTiles.has(t);
  }

  // Map.lua:268 (IsPlayerStandingOnWarpPadOrHole)
  warpPadOrHoleAt(cx: number, cy: number): "pad" | "hole" | undefined {
    const t = this.tileset as unknown as {
      warpPadTiles?: Record<number, "pad" | "hole">;
    };
    const table = t.warpPadTiles ?? WARP_PAD_TILES[this.def.tileset];
    if (!table) return undefined;
    return table[this.cellTile(cx, cy)];
  }

  // Map.lua:275 — counter tiles allow talking to NPCs across them
  isCounterCell(cx: number, cy: number): boolean {
    const t = this.cellTile(cx, cy);
    return (this.tileset.counterTiles ?? []).includes(t);
  }

  // Map.lua:283
  warpAtCell(cx: number, cy: number): WarpAt | undefined {
    return this.warpAt.get(cy * this.widthCells + cx);
  }

  // Map.lua:287
  signAtCell(cx: number, cy: number): MapSign | undefined {
    return this.signAt.get(cy * this.widthCells + cx);
  }

  // Map.lua:291
  connection(dir: "north" | "south" | "east" | "west") {
    return this.def.connections?.[dir];
  }
}
