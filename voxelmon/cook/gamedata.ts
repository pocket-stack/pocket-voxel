// voxelmon/cook/gamedata.ts — the GAME section + CMAP pairs.
//
// gamedata packs the gameplay subset of gen/ (voxelmon/SCHEMA.md
// §gamedata) plus an `atlas` object carrying the page-index maps the guest
// needs: sprite sheet name -> page, species -> front-pic page, the player
// back page and the emote page — and `mapPalette`, the per-map SGB palette
// index the guest emits at map entry. CMAP maps each charmap entry's UTF-16
// code point to its GB tile code, multi-character sequences included at their
// minted LIGATURE_BASE point; the UI page lays glyphs at their GB codes, so
// tile id == code.

import { LIGATURE_BASE } from "../game/ui/tiles.ts";
import type { GenData, MapDef, TilesetDef } from "./data.ts";

export interface AtlasIndex {
  /** sprite sheet name ("red", "oak", ...) -> atlas page. */
  sprites: Record<string, number>;
  /** species id -> front-pic atlas page (the guest accessor contract). */
  picFront: Record<string, number>;
  /** species id (+ "redb") -> back-pic atlas page. */
  picBack: Record<string, number>;
  emotePage: number | null;
  uiPage: number;
  terrainPage: number;
}

/** The tileset subset the guest needs (collision + animation semantics). */
function tilesetSubset(ts: TilesetDef): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ts.id,
    // blocks are collision-relevant: cell resolution needs block -> tiles
    blocks: ts.blocks,
    walkable: ts.walkable,
    counterTiles: ts.counterTiles ?? [],
    doorTiles: ts.doorTiles ?? [],
    warpTiles: ts.warpTiles ?? [],
    animation: ts.animation,
  };
  if (ts.grassTile !== undefined) out.grassTile = ts.grassTile;
  if (ts.waterTiles !== undefined) out.waterTiles = ts.waterTiles;
  if (ts.shoreTiles !== undefined) out.shoreTiles = ts.shoreTiles;
  return out;
}

// ---------------------------------------------------------------------------
// map -> SGB palette (pokered engine/gfx/palettes.asm SetPal_Overworld)
// ---------------------------------------------------------------------------
//
// Ports gen1recomp's paletteNameFor cascade — the vanilla data lives in
// src/world/FieldDefaults.lua:16-30 (PALETTES: byMap towns + the two Elite
// Four rooms, byTileset Pokemon Tower/caves, byPrefix routes, default) and
// the lookup order in src/world/OverworldController.lua:560-569
// (paletteLookup: byMap, then byTileset, then byPrefix) and :603-623
// (paletteNameFor: the map itself, else the last OUTDOOR map — pokered's
// wLastMap — else the ROUTE default).
//
// The reference resolves interiors DYNAMICALLY through its lastOutdoor
// memory (rememberOutdoor, OverworldController.lua:3948-3952, armed on any
// transition off a map whose tileset is in outsideTilesets = OVERWORLD /
// PLATEAU — :4005-4015, FieldDefaults.lua:136). The pak needs one static
// index per map, so the cooker resolves the same memory closed-form: an
// interior can only be entered through warps from some outdoor map, so a
// multi-source BFS over warp edges from every outside-tileset map assigns
// each interior the outdoor map it is reached from (LAST_MAP warps point
// back out and carry no edge). Vanilla interiors are reachable from exactly
// one town/route, so the walk is exact, not approximate.

const PALETTE_BY_MAP: Record<string, string> = {
  PALLET_TOWN: "PALLET",
  VIRIDIAN_CITY: "VIRIDIAN",
  PEWTER_CITY: "PEWTER",
  CERULEAN_CITY: "CERULEAN",
  LAVENDER_TOWN: "LAVENDER",
  VERMILION_CITY: "VERMILION",
  CELADON_CITY: "CELADON",
  FUCHSIA_CITY: "FUCHSIA",
  CINNABAR_ISLAND: "CINNABAR",
  INDIGO_PLATEAU: "INDIGO",
  SAFFRON_CITY: "SAFFRON",
  LORELEIS_ROOM: "PALLET",
  BRUNOS_ROOM: "CAVE",
};
const PALETTE_BY_TILESET: Record<string, string> = { CEMETERY: "GRAYMON", CAVERN: "CAVE" };
const PALETTE_BY_PREFIX: { prefix: string; palette: string }[] = [
  { prefix: "ROUTE_", palette: "ROUTE" },
];
const PALETTE_DEFAULT = "ROUTE";
/** CheckIfInOutsideMap's tilesets (FieldDefaults.lua:136 outsideTilesets). */
const OUTSIDE_TILESETS = new Set(["OVERWORLD", "PLATEAU"]);

/** One cascade rung (OverworldController.lua:560-569 paletteLookup). */
function paletteLookup(mapId: string, tileset: string | undefined): string | null {
  if (PALETTE_BY_MAP[mapId]) return PALETTE_BY_MAP[mapId];
  if (tileset && PALETTE_BY_TILESET[tileset]) return PALETTE_BY_TILESET[tileset];
  for (const row of PALETTE_BY_PREFIX) {
    if (mapId.startsWith(row.prefix)) return row.palette;
  }
  return null;
}

/**
 * mapId -> index into the SGB set (palettes.json `order`, the same order
 * buildPalettes packs after the 4 kind defaults) for every imported map.
 * The guest emits `palette(mapPalette[map] ?? -1)` at map entry.
 */
export function buildMapPalette(gen: GenData): Record<string, number> {
  // Deterministic order: the ROM's own map indices.
  const ids = Object.keys(gen.maps).sort((a, b) => gen.maps[a].index - gen.maps[b].index);
  const def = (id: string): MapDef => gen.maps[id];

  // The static lastOutdoor: level-by-level multi-source BFS so every
  // interior takes its NEAREST outdoor entrance (vanilla has one anyway).
  const outdoorOf = new Map<string, string>();
  let frontier: string[] = [];
  for (const id of ids) {
    if (OUTSIDE_TILESETS.has(def(id).tileset)) {
      outdoorOf.set(id, id);
      frontier.push(id);
    }
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const src = outdoorOf.get(id)!;
      for (const warp of def(id).warps ?? []) {
        const dest = warp.destMap;
        if (dest === "LAST_MAP" || !gen.maps[dest] || outdoorOf.has(dest)) continue;
        outdoorOf.set(dest, src);
        next.push(dest);
      }
    }
    frontier = next;
  }

  const out: Record<string, number> = {};
  for (const id of ids) {
    // paletteNameFor (OverworldController.lua:603-623): the map itself,
    // else its outdoor's lookup, else the ROUTE default.
    let name = paletteLookup(id, def(id).tileset);
    if (!name) {
      const last = outdoorOf.get(id);
      name = (last && paletteLookup(last, def(last).tileset)) || PALETTE_DEFAULT;
    }
    const index = gen.palettes.order.indexOf(name);
    if (index >= 0) out[id] = index;
  }
  return out;
}

export function buildGamedata(gen: GenData, atlas: AtlasIndex, cookedMaps: string[]): Uint8Array {
  // pokemon minus pic paths
  const pokemon: Record<string, unknown> = {};
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const { spriteFront: _f, spriteBack: _b, ...rest } = def;
    pokemon[id] = rest;
  }
  const tilesets: Record<string, unknown> = {};
  for (const [id, ts] of Object.entries(gen.tilesets)) tilesets[id] = tilesetSubset(ts);

  const game = {
    constants: gen.constants,
    // The maps whose geometry this pak actually carries. gamedata keeps
    // EVERY map def (warp targets, connection math), but the guest must
    // treat anything outside this list as a locked content boundary: warps
    // bump, connections neither show nor cross (world/overworld.ts).
    cookedMaps,
    maps: gen.maps,
    tilesets,
    encounters: gen.encounters,
    moves: gen.moves,
    pokemon,
    items: gen.items,
    type_chart: gen.typeChart,
    trainers: gen.trainers,
    text: gen.text,
    text_pointers: gen.textPointers,
    trainer_headers: gen.trainerHeaders,
    field: gen.field,
    atlas,
    mapPalette: buildMapPalette(gen),
  };
  return new TextEncoder().encode(JSON.stringify(game));
}

/**
 * CMAP pairs: UTF-16 code point of each glyph -> its GB tile code, strictly
 * ascending, first entry wins on duplicates.
 *
 * A multi-character sequence (`'s`, `<PK>`) is ONE glyph on the GB but has no
 * code point of its own, so it gets a minted one at LIGATURE_BASE + code —
 * the guest's `toCells` emits that, which is what makes a uiText string one
 * code point per cell.
 */
export function buildCharmap(gen: GenData): [number, number][] {
  const seen = new Map<number, number>();
  for (const entry of gen.font.charmap) {
    if (typeof entry.seq !== "string" || entry.seq.length !== 1) continue;
    const cp = entry.seq.charCodeAt(0);
    if (cp > 0xffff) continue;
    if (!seen.has(cp)) seen.set(cp, entry.code);
  }
  for (const entry of gen.font.charmap) {
    if (typeof entry.seq !== "string" || entry.seq.length === 1) continue;
    const cp = LIGATURE_BASE + entry.code;
    if (cp > 0xffff) continue;
    if (!seen.has(cp)) seen.set(cp, entry.code);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}
