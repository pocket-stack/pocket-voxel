// Typed loader for the imported gen1recomp dataset (voxelmon/SCHEMA.md).
//
// One record shape per gen/ module, field names identical to the Lua tables
// under gen1recomp data/generated/ (grounded against the ROM-built checkout:
// pokemon.lua, moves.lua, type_chart.lua, encounters.lua, trainers.lua,
// items.lua, maps.lua, tilesets.lua, constants.lua). Lua 1-based arrays are
// JSON arrays indexed 0-based; absent optional fields are omitted.
//
// Two transports, one loader: Bun reads dist/voxelmon/gen/*.json directly
// (fromGenDir); on device the same JSON arrives as the pak's GAME section and
// the guest hands the parsed object to fromObject. Nothing here touches Bun
// outside fromGenDir, so the module loads in QuickJS.

// ---------------------------------------------------------------------------
// Record shapes (gen1recomp data/generated field names, verbatim)
// ---------------------------------------------------------------------------

export interface StatBlock {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  special: number;
}

export interface LearnsetEntry {
  level: number;
  move: string;
}

export interface EvolutionEntry {
  /** "LEVEL" | "ITEM" | "TRADE" (mod methods may add ids). */
  method: string;
  species: string;
  level?: number;
  item?: string;
}

export interface DexEntry {
  kind: string;
  heightFt: number;
  heightIn: number;
  weight: number;
  text: string;
}

export interface SpeciesDef {
  id: string;
  index: number;
  dex: number;
  name: string;
  types: string[];
  baseStats: StatBlock;
  catchRate: number;
  baseExp: number;
  level1Moves: string[];
  growthRate: string;
  tmhm: string[];
  learnset: LearnsetEntry[];
  evolutions: EvolutionEntry[];
  spriteFront?: string;
  spriteBack?: string;
  frontSize?: number;
  dexEntry?: DexEntry;
  source?: string;
}

export interface MoveDef {
  id: string;
  index: number;
  name: string;
  type: string;
  power: number;
  accuracy: number;
  pp: number;
  effect: string;
  /** Mod override; vanilla moves derive it from the type (TypeChart). */
  category?: "physical" | "special" | "status";
  priority?: number;
  highCrit?: boolean;
  anim?: { pitch: number; sound: string; tempo: number };
  source?: string;
}

export interface TypeChartRow {
  attacker: string;
  defender: string;
  /** x10: 20 super effective, 10 neutral, 5 not very, 0 immune. */
  multiplier: number;
}

export interface TypeRecord {
  name: string;
  category: "physical" | "special";
}

export interface TypeChartData {
  matchups: TypeChartRow[];
  /** Merged type records; absent in the ROM-built dataset (vanilla fallback). */
  types?: Record<string, TypeRecord>;
  names?: Record<string, string>;
  source?: string;
}

export interface EncounterSlot {
  species: string;
  level: number;
}

export interface EncounterGroup {
  rate: number;
  slots: EncounterSlot[];
  /** Optional per-def cumulative thresholds; last entry must be 256. */
  buckets?: number[];
}

export interface EncounterDef {
  grass?: EncounterGroup;
  water?: EncounterGroup;
}

export interface TrainerClass {
  id: string;
  index: number;
  name: string;
  baseMoney: number;
  aiMods?: number[];
  parties: EncounterSlot[][];
  pic?: string;
  source?: string;
}

export interface ItemDef {
  id: string;
  index: number;
  name: string;
  price: number;
  tossable?: boolean;
  ball?: string;
  machine?: { kind: string; number: number; move: string };
}

/** A 16x96 walk sheet (6 frames) or a 1..3-frame prop sheet (sprites.lua). */
export interface SpriteSheetDef {
  id: string;
  image?: string;
  frames: number;
  walker?: boolean;
  source?: string;
}

export interface MapConnection {
  map: string;
  offset: number;
}

export interface MapWarp {
  x: number;
  y: number;
  destMap: string;
  destWarp: number;
}

export interface MapObject {
  index: number;
  name: string;
  sprite: string;
  movement: string;
  range: string;
  text: string;
  x: number;
  y: number;
}

export interface MapSign {
  x: number;
  y: number;
  text: string;
}

export interface MapDef {
  id: string;
  index: number;
  label: string;
  tileset: string;
  width: number;
  height: number;
  blocks: number[];
  borderBlock: number;
  connections: Partial<Record<"north" | "south" | "east" | "west", MapConnection>>;
  warps: MapWarp[];
  objects: MapObject[];
  signs: MapSign[];
  /** Explicit Map.isOutdoor classification; legacy data falls back to the
   * OVERWORLD tileset convention. */
  outdoor?: boolean;
  source?: string;
}

export interface TilesetDef {
  id: string;
  image?: string;
  blocks: number[][];
  walkable: Record<string, boolean> | boolean[];
  counterTiles: number[];
  doorTiles: number[];
  warpTiles: number[];
  grassTile?: number;
  animation?: string;
  imageWidth?: number;
  imageHeight?: number;
  tilesPerRow?: number;
  /** Cooked tile-id -> positive entity support height; absent in raw gen/. */
  groundHeights?: number[];
  source?: string;
}

/**
 * data.constants is shape-open: the ROM-built module carries the order lists,
 * the seeded/merged runtime adds the caps the rules read. Every rules-side
 * read has the vanilla default folded in, so any subset loads.
 */
export interface ConstantsData {
  levelCap?: number;
  moveMax?: number;
  bagSize?: number;
  partyMax?: number;
  fallbackMove?: string;
  hmMoves?: string[];
  badges?: { id: string }[];
  encounterBuckets?: number[];
  exp?: { divisor?: number; tradedMult?: number; trainerMult?: number };
  mapOrder?: string[];
  moveOrder?: string[];
  speciesOrder?: string[];
  spriteOrder?: string[];
  tilesetOrder?: string[];
  [key: string]: unknown;
}

/** A merged growth-curve record (Growth.registerInto's shape). */
export interface GrowthRateRecord {
  expForLevel(level: number): number;
}

export interface VoxelmonData {
  /** Maps whose geometry the pak carries; absent (old gamedata) = all.
   * Anything else is a locked content boundary (world/overworld.ts). */
  cookedMaps?: string[];
  pokemon: Record<string, SpeciesDef>;
  moves: Record<string, MoveDef>;
  type_chart: TypeChartData;
  constants: ConstantsData;
  encounters: Record<string, EncounterDef>;
  items?: Record<string, ItemDef>;
  trainers?: Record<string, TrainerClass>;
  maps?: Record<string, MapDef>;
  tilesets?: Record<string, TilesetDef>;
  sprites?: Record<string, SpriteSheetDef>;
  field?: Record<string, unknown>;
  text?: Record<string, unknown>;
  text_pointers?: Record<string, unknown>;
  trainer_headers?: Record<string, unknown>;
  growth_rates?: Record<string, GrowthRateRecord>;
  evolution_methods?: Record<string, unknown>;
  /** Cooked map id -> SGB palette index (the cooker's buildMapPalette;
   * indexes the pak's SGB set). Absent pre-cook: the scene then emits -1
   * (the GB grayscale ramp) for every map. */
  mapPalette?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The rules modules cannot run without these. */
export const REQUIRED_MODULES = [
  "pokemon",
  "moves",
  "type_chart",
  "constants",
  "encounters",
] as const;

/** Everything gen/ may carry that the gameplay side reads (SCHEMA.md). */
export const GEN_MODULES = [
  ...REQUIRED_MODULES,
  "items",
  "trainers",
  "maps",
  "tilesets",
  "sprites",
  "field",
  "text",
  "text_pointers",
  "trainer_headers",
] as const;

/**
 * Accept an already-parsed dataset object — the on-device path (the pak GAME
 * section, one JSON.parse at boot) and the test-fixture path. Validates the
 * required modules are present; optional modules pass through as-is.
 */
export function fromObject(source: Record<string, unknown>): VoxelmonData {
  for (const name of REQUIRED_MODULES) {
    if (source[name] === undefined) {
      throw new Error(`voxelmon dataset is missing required module "${name}"`);
    }
  }
  return source as unknown as VoxelmonData;
}

/**
 * Bun transport: read dist/voxelmon/gen/*.json (one file per module, same
 * field names as the Lua — SCHEMA.md normalization). Missing optional
 * modules are skipped; missing required ones throw.
 */
export async function fromGenDir(dir: string): Promise<VoxelmonData> {
  const out: Record<string, unknown> = {};
  for (const name of GEN_MODULES) {
    const file = Bun.file(`${dir}/${name}.json`);
    if (await file.exists()) {
      out[name] = await file.json();
    }
  }
  return fromObject(out);
}

/**
 * The headless-run loader: prefer the cooked gamedata written next to the
 * pak (the GAME section verbatim — including the atlas page maps, without
 * which no battle card ops emit), so a Bun run records exactly what a
 * device run replays. Falls back to the raw import for pre-cook runs.
 */
export async function loadRuntimeData(genDir: string): Promise<VoxelmonData> {
  const at = genDir.lastIndexOf("/");
  const cooked = Bun.file(`${genDir.slice(0, at < 0 ? 0 : at)}/gamedata.json`);
  if (await cooked.exists()) return fromObject(JSON.parse(await cooked.text()));
  return fromGenDir(genDir);
}
