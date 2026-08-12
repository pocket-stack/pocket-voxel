// voxelmon/cook/data.ts — cook-time inputs (voxelmon/SCHEMA.md).
//
// Browser-safe data model shared by the importer and cooker. Filesystem and
// LuaJIT adapters live in data-node.ts; nothing in this module may depend on
// Bun, Node, paths, environment variables, or a process-global cache.

// ---------------------------------------------------------------------------
// gen/ dataset
// ---------------------------------------------------------------------------

export interface TilesetDef {
  id: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  tilesPerRow: number;
  blocks: number[][];
  walkable: number[];
  counterTiles?: number[];
  grassTile?: number;
  doorTiles?: number[];
  warpTiles?: number[];
  waterTiles?: number[];
  shoreTiles?: number[];
  animation?: string;
}

export interface MapDef {
  id: string;
  index: number;
  tileset: string;
  width: number;
  height: number;
  blocks: number[];
  borderBlock: number;
  connections?: Record<string, { map: string; offset: number }>;
  warps?: { x: number; y: number; destMap: string; destWarp: number }[];
  signs?: unknown[];
  objects?: unknown[];
  outdoor?: boolean;
}

export interface GfxEntry {
  off: number;
  w: number;
  h: number;
  walker?: boolean;
}

/** The imported SGB palette module (gen/palettes.json — ROM SuperPalettes):
 * 37 named 4-color palettes, lightest shade first, plus the ROM's own order
 * (the pak's SGB set is packed in exactly this order) and the species map. */
export interface PalettesDef {
  palettes: Record<string, [number, number, number][]>;
  order: string[];
  pokemon: Record<string, string>;
  source?: string;
}

/** One imported sprite record; `source` carries the ROM crosswalk the RED++
 * OBJ-palette assignment is keyed by ("ROM:SpriteSheetPointerTable[N]"). */
export interface SpriteDef {
  id: string;
  source: string;
  image: string;
  frames: number;
  walker?: boolean;
}

export interface GenData {
  maps: Record<string, MapDef>;
  tilesets: Record<string, TilesetDef>;
  palettes: PalettesDef;
  sprites: Record<string, SpriteDef>;
  gfx: Record<string, GfxEntry>;
  gfxBin: Uint8Array;
  font: {
    mainBase: number;
    extraBase: number;
    glyphsPerRow: number;
    charmap: { code: number; seq: string }[];
  };
  constants: Record<string, unknown>;
  encounters: Record<string, unknown>;
  moves: unknown;
  pokemon: Record<string, Record<string, unknown>>;
  items: unknown;
  typeChart: unknown;
  trainers: unknown;
  text: unknown;
  textPointers: unknown;
  trainerHeaders: unknown;
  field: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// tile art — gfx.bin is 1 byte/px: 0..3 = GB shade (0 lightest), 0xff = clear
// ---------------------------------------------------------------------------

/** Transparent-pixel byte in gfx.bin. */
export const PX_CLEAR = 0xff;

/** Indexed-bitmap view over one gfx.json entry. */
export class Art {
  constructor(
    readonly bin: Uint8Array,
    readonly off: number,
    readonly w: number,
    readonly h: number,
  ) {}

  /** Raw shade byte (0..3, or PX_CLEAR) at (x, y); out of range = clear. */
  px(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return PX_CLEAR;
    return this.bin[this.off + y * this.w + x];
  }
}

export function artOf(gen: GenData, key: string): Art | null {
  const e = gen.gfx[key];
  if (!e) return null;
  return new Art(gen.gfxBin, e.off, e.w, e.h);
}

/** gfx.json key of a tileset's atlas sheet ("assets/generated/x.png" → "x"). */
export function sheetKeyOf(tileset: TilesetDef): string {
  return tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

// Shade classes, matching the upstream cutoffs on min(r,g,b) of the GB
// palette PNGs (shade 0 = 1.0, 1 = 0.666, 2 = 0.333, 3 = 0):
//   VoxelMod Structures.lua:2289 shadeClass / Buildings.lua:116 shadeOf.
// Our gfx bytes ARE the class: 0=white, 1=light/grey, 2=dark, 3=black.
export type ShadeName = "off" | "white" | "light" | "dark" | "black";
const SHADE_NAMES: ShadeName[] = ["white", "light", "dark", "black"];

export function shadeClassOf(byte: number): ShadeName {
  if (byte === PX_CLEAR) return "off";
  return SHADE_NAMES[byte & 3];
}

// ---------------------------------------------------------------------------
// runtime Map semantics (gen1recomp src/world/Map.lua)
// ---------------------------------------------------------------------------

// Map.lua:20-22 stale-cache fallbacks: water $14 everywhere, shore $32/$48
// everywhere except SHIP_PORT.
const WATER_TILES = [0x14];
const SHORE_TILES = [0x32, 0x48];
const NO_SHORE_TILESETS = new Set(["SHIP_PORT"]);

export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export class GameMap {
  readonly def: MapDef;
  readonly tileset: TilesetDef;
  readonly id: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly walkable: Set<number>;
  readonly doorTiles: Set<number>;
  readonly waterTiles: Set<number>;

  constructor(def: MapDef, tileset: TilesetDef) {
    this.def = def;
    this.tileset = tileset;
    this.id = def.id;
    this.widthTiles = def.width * 4;
    this.heightTiles = def.height * 4;
    this.walkable = new Set(tileset.walkable);
    this.doorTiles = new Set(tileset.doorTiles ?? []);
    // VoxelMod Map.lua:128-131 — water and shore share one lookup.
    this.waterTiles = new Set(tileset.waterTiles ?? WATER_TILES);
    const shore = tileset.shoreTiles ?? (NO_SHORE_TILESETS.has(def.tileset) ? [] : SHORE_TILES);
    for (const t of shore) this.waterTiles.add(t);
  }

  // Map.lua:196 blockAt — border-extends with the map's own borderBlock.
  blockAt(bx: number, by: number): number {
    if (bx < 0 || by < 0 || bx >= this.def.width || by >= this.def.height) {
      return this.def.borderBlock;
    }
    return this.def.blocks[by * this.def.width + bx];
  }

  // Map.lua:204 tileAt — tile id at 8px tile coordinates, border-extended.
  tileAt(tx: number, ty: number): number {
    const block = this.tileset.blocks[this.blockAt(Math.floor(tx / 4), Math.floor(ty / 4))];
    return block[mod(ty, 4) * 4 + mod(tx, 4)];
  }

  // Map.lua:212 cellTile — the collision tile: the cell's bottom-left tile.
  cellTile(cx: number, cy: number): number {
    return this.tileAt(cx * 2, cy * 2 + 1);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.def.width * 2 && cy < this.def.height * 2;
  }

  isWalkableCell(cx: number, cy: number): boolean {
    return this.walkable.has(this.cellTile(cx, cy));
  }

  isWaterCell(cx: number, cy: number): boolean {
    return this.waterTiles.has(this.cellTile(cx, cy));
  }

  // Map.lua:224 isGrassCell — off-map cells never count (border filler).
  isGrassCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const grass = this.tileset.grassTile;
    return grass !== undefined && this.cellTile(cx, cy) === grass;
  }

  // Map.lua:148 isOutdoor.
  get outdoor(): boolean {
    if (this.def.outdoor !== undefined) return this.def.outdoor;
    return this.def.tileset === "OVERWORLD";
  }
}

// ---------------------------------------------------------------------------
// the VoxelMod profile (data/voxel_heights.lua after lua-dump normalization)
// ---------------------------------------------------------------------------

// The profile's shape after lua-dump normalization: numeric keys stringify.
export interface Profile {
  heights?: Record<string, number>;
  tilesets?: Record<string, ProfileTileset>;
  buildings?: Record<string, BuildingTemplate[]>;
}

export interface ProfileTileset {
  heights?: Record<string, number>;
  when_above?: Record<string, { above?: number[]; class: string }[]>;
  when_below?: Record<string, { below?: number[]; class: string }[]>;
  prop_ground?: Record<string, number>;
  // class name -> tile-id list (everything else in the entry).
  [cls: string]: unknown;
}

export interface BuildingTemplate {
  id?: string;
  tiles: number[][];
  topRows?: number[][];
  claimOnly?: boolean;
  roofRows?: number;
  roofBack?: number;
  roofFront?: number;
  roofCycle?: [number, number];
  slab?: number;
  frontEave?: number;
  ledge?: [number, number] | null;
  seal?: string;
  panes?: boolean;
  depth?: number;
  depthPx?: number;
  keep?: number[];
  support?: number;
  scrub?: [number, number, number, number][];
  // desk-set fields (not built in v1 — see cook/buildings.ts):
  parts?: unknown;
  desk?: unknown;
  tray?: unknown;
  wall?: unknown;
}
