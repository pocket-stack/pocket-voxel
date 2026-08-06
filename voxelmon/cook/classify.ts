// voxelmon/cook/classify.ts — the tile classifier.
//
// Port of VoxelMod lib/TileShape.lua: resolve every tile of a tileset to an
// extrusion shape. Resolution order (TileShape.lua:5-24):
//   per tile   1. hand-authored profile pin (conditional pins first — they
//                 need the position)
//   per CELL   2. the cell is water  -> water
//              3. the cell is walkable -> ground
//   per tile   4. tile-level fallback: water set -> water, walkable -> ground,
//                 else wall
// Cell semantics judge by the cell's bottom-left tile (data.ts GameMap).

import { CLASS_HEIGHT } from "../../contracts/spec/voxel-spec.ts";
import type { GameMap, Profile } from "./data.ts";

// Class heights: the spec pins the classes the runtime states facts about
// (CLASS_HEIGHT, imported never re-declared); the profile's extra interior
// classes extend it — VoxelMod TileShape.lua:48-120 FALLBACK_HEIGHTS.
const EXTRA_HEIGHTS: Record<string, number> = {
  can: 9,
  planter: 32,
  billboard: 16,
  signpost: 16,
  post: 16,
  bed: 7,
  stool: 8,
  backrest: 12,
  cutout: 16,
  bike: 16,
  console: 16,
  relief: 3,
  bookcase: 32,
  stair_e: 16,
  stair_w: 16,
  stair_down_e: 16,
  stair_down_w: 16,
};

export const FALLBACK_HEIGHTS: Record<string, number> = {
  ...CLASS_HEIGHT,
  ...EXTRA_HEIGHTS,
};

// VoxelMod TileShape.lua:135-209 ART — how the mesher draws each class.
export const ART: Record<string, string> = {
  ground: "flat",
  water: "flat",
  void: "flat",
  ledge: "top",
  roof: "top",
  wall: "upright",
  cliff: "upright",
  tree: "upright",
  fence: "upright",
  sign: "upright",
  cylinder: "cylinder",
  canopy: "canopy",
  stump: "cylinder",
  can: "cylinder",
  planter: "planter",
  billboard: "billboard",
  signpost: "billboard",
  post: "post",
  grass: "grass",
  flower: "flower",
  bed: "top",
  backrest: "top",
  stool: "billboard",
  counter: "upright",
  table: "upright",
  desk: "upright",
  prop: "billboard",
  cutout: "billboard",
  bike: "billboard",
  console: "billboard",
  relief: "relief",
  bookcase: "bookcase",
  stair_e: "stair",
  stair_w: "stair",
  stair_down_e: "stair",
  stair_down_w: "stair",
};

export interface Shape {
  class: string;
  h: number;
  art: string;
  flat: boolean;
  authored: boolean;
}

interface CondRule {
  side: "above" | "below";
  set: Set<number>;
  class: string;
}

export interface TileShapes {
  /** Per tile id (0..count-1). */
  tiles: (Shape | undefined)[];
  /** One canonical shape per class, for the cell-level overrides. */
  classes: Record<string, Shape>;
  /** Conditional pins: tile id -> ordered rules (TileShape.lua:279). */
  cond: Map<number, CondRule[]> | null;
  /** A conditional pin's own AUTHORED shape per class (TileShape.lua:383). */
  condShape: Record<string, Shape>;
  count: number;
}

// TileShape.lua:311 shapeFor.
function shapeFor(cls: string, heights: Record<string, number>, authored = false): Shape {
  const art = ART[cls] ?? "upright";
  return {
    class: cls,
    h: heights[cls] ?? 0,
    art,
    flat: art === "flat" || cls === "grass" || cls === "flower",
    authored,
  };
}

// TileShape.lua:230 heights + per-tileset overrides (forMap:333-351).
export function classHeights(profile: Profile | null, tilesetId: string): Record<string, number> {
  const out: Record<string, number> = { ...FALLBACK_HEIGHTS };
  for (const [cls, h] of Object.entries(profile?.heights ?? {})) {
    if (typeof h === "number" && cls in FALLBACK_HEIGHTS) out[cls] = h;
  }
  const over = profile?.tilesets?.[tilesetId]?.heights;
  for (const [cls, h] of Object.entries(over ?? {})) {
    if (typeof h === "number" && cls in FALLBACK_HEIGHTS) out[cls] = h;
  }
  return out;
}

// TileShape.lua:243 authoredGroups — unknown class names are dropped.
function authoredGroups(
  profile: Profile | null,
  tilesetId: string,
  heights: Record<string, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  const entry = profile?.tilesets?.[tilesetId];
  if (!entry) return out;
  for (const cls of Object.keys(entry).sort()) {
    const tiles = entry[cls];
    if (heights[cls] !== undefined && Array.isArray(tiles)) {
      for (const t of tiles) {
        if (typeof t === "number") out.set(t, cls);
      }
    }
  }
  return out;
}

// TileShape.lua:279 authoredConditions.
function authoredConditions(
  profile: Profile | null,
  tilesetId: string,
  heights: Record<string, number>,
): Map<number, CondRule[]> | null {
  const entry = profile?.tilesets?.[tilesetId];
  if (!entry) return null;
  const out = new Map<number, CondRule[]>();

  const collect = (spec: unknown, side: "above" | "below"): void => {
    if (typeof spec !== "object" || spec === null) return;
    for (const key of Object.keys(spec as Record<string, unknown>).sort((a, b) => +a - +b)) {
      const tile = Number(key);
      const rules = (spec as Record<string, unknown>)[key];
      if (!Number.isFinite(tile) || !Array.isArray(rules)) continue;
      const list = out.get(tile) ?? [];
      for (const rule of rules) {
        const r = rule as { class?: string } & Record<string, unknown>;
        const sideList = r[side];
        if (r.class && heights[r.class] !== undefined && Array.isArray(sideList)) {
          list.push({ side, set: new Set(sideList as number[]), class: r.class });
        }
      }
      if (list.length > 0) out.set(tile, list);
    }
  };
  collect(entry.when_above, "above");
  collect(entry.when_below, "below");
  return out.size > 0 ? out : null;
}

const shapesCache = new Map<string, TileShapes>();

/**
 * Resolved TILE-LEVEL shapes for the tileset `map` uses
 * (TileShape.lua:328 forMap). Cached per tileset id.
 */
export function tileShapesFor(map: GameMap, profile: Profile | null): TileShapes {
  const tileset = map.tileset;
  const hit = shapesCache.get(tileset.id);
  if (hit) return hit;

  const heights = classHeights(profile, tileset.id);
  const authored = authoredGroups(profile, tileset.id, heights);
  const count =
    Math.floor((tileset.imageWidth || 128) / 8) * Math.floor((tileset.imageHeight || 48) / 8);

  // Derived pin (TileShape.lua:357-376): a tile the tileset animates by
  // FRAME REWRITE is the flower; grassTile is the tall grass.
  const flowerTiles = new Set<number>();
  for (const spec of defaultAnimatedTiles(tileset.animation)) {
    if (spec.kind === "frames") flowerTiles.add(spec.tile);
  }

  const classes: Record<string, Shape> = {};
  for (const cls of Object.keys(FALLBACK_HEIGHTS)) classes[cls] = shapeFor(cls, heights);

  const cond = authoredConditions(profile, tileset.id, heights);
  const condShape: Record<string, Shape> = {};
  if (cond) {
    for (const rules of cond.values()) {
      for (const rule of rules) {
        condShape[rule.class] ??= shapeFor(rule.class, heights, true);
      }
    }
  }

  const tiles: (Shape | undefined)[] = [];
  for (let t = 0; t < count; t++) {
    const cls = authored.get(t);
    if (cls) {
      tiles[t] = shapeFor(cls, heights, true);
    } else if (t === tileset.grassTile) {
      tiles[t] = shapeFor("grass", heights, true);
    } else if (flowerTiles.has(t)) {
      tiles[t] = shapeFor("flower", heights, true);
    } else if (map.waterTiles.has(t)) {
      tiles[t] = classes.water;
    } else if (map.walkable.has(t)) {
      tiles[t] = classes.ground;
    } else {
      tiles[t] = classes.wall;
    }
  }

  const shapes: TileShapes = { tiles, classes, cond, condShape, count };
  shapesCache.set(tileset.id, shapes);
  return shapes;
}

/**
 * The shape of the tile at TILE coordinates (TileShape.lua:420 at) —
 * conditional pins outrank the flat pin and the cell rules; authored tiles
 * bypass the cell rules.
 */
export function shapeAt(
  map: GameMap,
  shapes: TileShapes,
  tile: number,
  tx: number,
  ty: number,
): Shape | undefined {
  const rules = shapes.cond?.get(tile);
  if (rules) {
    for (const rule of rules) {
      // NOTE map.tileAt border-EXTENDS (TileShape.lua:429).
      const n = map.tileAt(tx, rule.side === "above" ? ty - 1 : ty + 1);
      if (rule.set.has(n)) return shapes.condShape[rule.class];
    }
  }
  const s = shapes.tiles[tile];
  if (!s || s.authored) return s;
  const cx = Math.floor(tx / 2);
  const cy = Math.floor(ty / 2);
  if (map.isWaterCell(cx, cy)) return shapes.classes.water;
  if (map.isWalkableCell(cx, cy)) return shapes.classes.ground;
  return s;
}

// ---------------------------------------------------------------------------
// tile animation defaults (gen1recomp src/render/TileRenderer.lua:74-328)
// ---------------------------------------------------------------------------

export const WATER_TILE = 0x14;
export const FLOWER_TILE = 0x03;
/** Cumulative pixel offset per animation step (the rrca/rlca sequence). */
export const WATER_OFFSETS = [1, 2, 3, 2, 1, 0, 7, 0];
/** Flower frame per step (wMovingBGTilesCounter2 & 3: <2 -> 1, 2, 3). */
export const FLOWER_FRAMES = [1, 2, 3, 1, 1, 2, 3, 1];
export const ANIM_STEPS = 8;

export type AnimSpec =
  | { kind: "hshift"; tile: number; offsets: number[] }
  | { kind: "frames"; tile: number; sequence: number[] };

// TileRenderer.lua:309 defaultAnimatedTiles (spinner toggles are contextual
// VRAM patches, not ambient animation — not baked).
export function defaultAnimatedTiles(animation: string | undefined): AnimSpec[] {
  const out: AnimSpec[] = [];
  if (animation === "TILEANIM_WATER" || animation === "TILEANIM_WATER_FLOWER") {
    out.push({ kind: "hshift", tile: WATER_TILE, offsets: WATER_OFFSETS });
  }
  if (animation === "TILEANIM_WATER_FLOWER") {
    out.push({ kind: "frames", tile: FLOWER_TILE, sequence: FLOWER_FRAMES });
  }
  return out;
}
