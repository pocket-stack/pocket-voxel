// Browser-safe in-memory VXPK cooker. Node/Bun input discovery and output
// writes stay in cli.ts/data-node.ts.

import {
  ATLAS_KIND,
  COLOR_PAL_NONE,
  MESH_KIND,
  VXPK_META_FLAG_GROUND_BAKE,
  VXPK_META_FLAG_TREE_COARSE,
  VXPK_META_FLAG_TREE_LOD,
} from "../../contracts/spec/voxel-spec.ts";
import {
  buildEmotePage,
  buildPalettes,
  buildPicPage,
  buildSpritePage,
  buildTerrainPage,
  buildUiPage,
  paletteBase,
  type PageDef,
} from "./atlas.ts";
import type { BuildingStats } from "./buildings.ts";
import { GameMap, type GenData, type Profile } from "./data.ts";
import { buildCharmap, buildGamedata, type AtlasIndex } from "./gamedata.ts";
import { BAKE_MAX_Y, BAKE_PAGE_H, BAKE_TEXELS, bakeGround, foldFacades } from "./groundbake.ts";
import { packMap, runGeometry, type MapGeometry, type UvTransform } from "./mesh.ts";
import { writePak, type PakInput } from "./pak.ts";
import {
  planColour,
  Redpp,
  type ColourPlan,
  type PageOwner,
  type RedppPack,
} from "./redpp.ts";
import { analyseMap } from "./structures.ts";

export const DEFAULT_MAPS: readonly string[] = [
  "REDS_HOUSE_1F",
  "REDS_HOUSE_2F",
  "PALLET_TOWN",
  "OAKS_LAB",
  "ROUTE_1",
  "VIRIDIAN_CITY",
  // Viridian's north exit is a real ROM connection. Route 2 prevents the
  // border tree ring from painting across it.
  "ROUTE_2",
  "BLUES_HOUSE",
];

export interface CookOptions {
  /** Keep faces the fixed camera set cannot see (the diagnostic A/B mode). */
  keepHidden?: boolean;
  /** Skip all carved tree levels (the legacy boxes-everywhere floor). */
  treeBoxes?: boolean;
}

export interface CookInput {
  gen: GenData;
  profile: Profile | null;
  redpp: RedppPack | null;
  audioJson?: Uint8Array;
  audioPrograms?: Uint8Array;
  mapNames?: readonly string[];
  options?: CookOptions;
}

export interface CookProgress {
  phase: "atlas" | "map" | "ground-bake" | "pack";
  completed: number;
  total: number;
  label: string;
}

export type CookProgressHook = (progress: CookProgress) => void;

export interface CookArtifacts {
  pak: Uint8Array;
  gameJson: Uint8Array;
  mapStats: { id: string; mapId: number; chunks: number; verts: number; stamps: number }[];
  buildingStats: BuildingStats;
  pakBytes: number;
  sections: { tag: string; bytes: number }[];
  colour: ColourPlan["stats"] | null;
  palettes: number;
}

function sheetKey(map: GameMap): string {
  return map.tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

/** Cook one complete VXPK in memory. All metadata is injected, making the
 * dependency closure suitable for a browser worker. */
export function cookVoxelPak(
  input: CookInput,
  onProgress?: CookProgressHook,
): CookArtifacts {
  const { gen, profile } = input;
  const mapNames = input.mapNames ?? DEFAULT_MAPS;
  const options = input.options ?? {};
  const redpp = input.redpp ? new Redpp(input.redpp) : null;

  const maps = mapNames.map((name) => {
    const def = gen.maps[name];
    if (!def) throw new Error(`unknown map: ${name}`);
    const tileset = gen.tilesets[def.tileset];
    if (!tileset) throw new Error(`unknown tileset: ${def.tileset} (map ${name})`);
    return new GameMap(def, tileset);
  });

  if (redpp) {
    const needExceptions = Redpp.mapExceptions([...mapNames]);
    if (needExceptions.length > 0) {
      throw new Error(
        `RED++ color: ${needExceptions.join(", ")} need per-map tile-id ` +
          `exceptions, which one shared terrain page cannot carry`,
      );
    }
  }

  // --- atlases -----------------------------------------------------------
  const terrainPage = 0;
  const terrain = buildTerrainPage(gen, maps.map((m) => m.tileset), redpp);
  const pages: PageDef[] = [terrain.page];
  const pageOwners: PageOwner[] = [{ kind: terrain.page.kind }];
  const uiPage = pages.length;
  pages.push(buildUiPage(gen));
  pageOwners.push({ kind: ATLAS_KIND.ui });

  const spriteIndex: Record<string, number> = {};
  const spriteKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("sprites/"))
    .sort();
  for (const key of spriteKeys) {
    spriteIndex[key.slice("sprites/".length)] = pages.length;
    pages.push(buildSpritePage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.sprites, spriteKey: key });
  }

  let emotePage: number | null = null;
  const emotes = buildEmotePage(gen);
  if (emotes) {
    emotePage = pages.length;
    pages.push(emotes);
    pageOwners.push({ kind: ATLAS_KIND.sprites });
  }

  const frontIndex: Record<string, number> = {};
  const backIndex: Record<string, number> = {};
  const frontKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("battle/front/"))
    .sort();
  const frontPageByKey = new Map<string, number>();
  for (const key of frontKeys) {
    frontPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  const backKeys = Object.keys(gen.gfx)
    .filter((key) => key.startsWith("battle/back/"))
    .sort();
  const backPageByKey = new Map<string, number>();
  for (const key of backKeys) {
    backPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  const pageForPath = (byKey: Map<string, number>, path: string | undefined) => {
    if (!path) return undefined;
    const key = path.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
    return byKey.get(key);
  };
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const front = pageForPath(frontPageByKey, def.spriteFront as string | undefined);
    if (front !== undefined) {
      frontIndex[id] = front;
      pageOwners[front].species = id;
    }
    const back = pageForPath(backPageByKey, def.spriteBack as string | undefined);
    if (back !== undefined) {
      backIndex[id] = back;
      pageOwners[back].species = id;
    }
  }
  if (gen.gfx["battle/redb"]) {
    backIndex.redb = pages.length;
    pages.push(buildPicPage(gen, "battle/redb"));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  onProgress?.({ phase: "atlas", completed: 1, total: 1, label: "atlases" });

  // Colour planning depends on atlas ownership and map metadata, not geometry.
  // Doing it before the map loop lets each MapGeometry be ground-baked and
  // released immediately instead of retaining all maps at once.
  const colour = redpp
    ? planColour(gen, redpp, {
        base: paletteBase(gen),
        maps: maps.map((map) => ({
          id: map.id,
          mapId: map.def.index,
          tileset: map.def.tileset,
          index: map.def.index,
          sheetKey: sheetKey(map),
        })),
        bakedSheets: terrain.bakedSheets,
        terrainPage,
        pages: pageOwners,
      })
    : null;
  const palettes = buildPalettes(gen, colour?.palettes ?? []);

  // --- maps + immediate ground bake -------------------------------------
  const buildingStats: BuildingStats = { built: [], claimOnly: [], skipped: [], placements: 0 };
  const mapStats: CookArtifacts["mapStats"] = [];
  const packedMaps: PakInput["maps"] = [];
  let bakedChunks = 0;

  for (let mi = 0; mi < maps.length; mi++) {
    const map = maps[mi];
    let analysis: ReturnType<typeof analyseMap> | null = analyseMap(
      gen,
      map,
      profile,
      buildingStats,
      options.treeBoxes ?? false,
    );
    let geometry: MapGeometry | null = runGeometry(map, analysis, options.keepHidden ?? false);
    // runGeometry has consumed every analysis product into its own streams.
    // Drop the large grids before ground baking this map.
    analysis = null;

    const uvt: UvTransform = {
      baseY: terrain.baseY.get(sheetKey(map)) ?? 0,
      pageW: terrain.page.w,
      pageH: terrain.page.h,
    };
    const packed = packMap(geometry, uvt);
    const verts = packed.chunks.reduce(
      (n, chunk) => n + chunk.meshes.reduce((m, mesh) => m + mesh.verts.length, 0),
      0,
    );
    mapStats.push({
      id: map.id,
      mapId: map.def.index,
      chunks: packed.chunks.length,
      verts,
      stamps: packed.stamps.length,
    });
    onProgress?.({ phase: "map", completed: mi + 1, total: maps.length, label: map.id });

    const worldPal = colour?.maps.find((entry) => entry.mapId === map.def.index)?.worldPal;
    const pal =
      worldPal !== undefined && worldPal !== COLOR_PAL_NONE ? palettes[worldPal] : palettes[0];
    const transparentIdx = (index: number) => (pal[index] >>> 24) === 0;
    let clearIndex = 0;
    for (let i = 0; i < 256; i++) {
      if ((pal[i] >>> 24) === 0) {
        clearIndex = i;
        break;
      }
    }
    const canvases = bakeGround(
      packed.chunks,
      geometry,
      terrain.page,
      uvt,
      transparentIdx,
      clearIndex,
    );
    for (const [ci, canvas] of canvases) {
      const chunk = packed.chunks[ci];
      const keep: { verts: (typeof chunk.meshes)[0]["verts"]; indices: number[] } = {
        verts: [],
        indices: [],
      };
      const terrainMesh = chunk.meshes[MESH_KIND.terrain];
      for (let q = 0; q * 4 < terrainMesh.verts.length; q++) {
        const quad = terrainMesh.verts.slice(q * 4, q * 4 + 4);
        if (Math.max(...quad.map((vertex) => vertex.y)) <= BAKE_MAX_Y) continue;
        const base = keep.verts.length;
        keep.verts.push(...quad);
        keep.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const fullCanvas = new Uint8Array(BAKE_TEXELS * BAKE_PAGE_H).fill(clearIndex);
      fullCanvas.set(canvas, 0);
      const folded = foldFacades(
        keep.verts,
        fullCanvas,
        terrain.page.frames[0],
        terrain.page.w,
        terrain.page.h,
        transparentIdx,
      );
      const keptVerts = folded.keep;
      const kept: typeof keep = { verts: keptVerts, indices: [] };
      for (let q = 0; q * 4 < keptVerts.length; q++) {
        kept.indices.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
      }
      chunk.meshes[MESH_KIND.terrainKeep] = kept;
      chunk.bakePage = pages.length;
      pages.push({
        w: BAKE_TEXELS,
        h: BAKE_PAGE_H,
        kind: ATLAS_KIND.terrain,
        frames: [fullCanvas],
        name: `bake/${map.def.index}/${chunk.cx},${chunk.cy}`,
      });
      pageOwners.push({ kind: ATLAS_KIND.terrain });

      const x0 = chunk.cx * 128;
      const z0 = chunk.cy * 128;
      const n = 8;
      const groundVScale = BAKE_TEXELS / BAKE_PAGE_H;
      const bakeVerts = [];
      for (let gz = 0; gz <= n; gz++) {
        for (let gx = 0; gx <= n; gx++) {
          bakeVerts.push({
            u: gx / n,
            v: (gz / n) * groundVScale,
            abgr: 0xffffffff,
            x: x0 + (gx * 128) / n,
            y: 0,
            z: z0 + (gz * 128) / n,
          });
        }
      }
      const bakeIndices: number[] = [];
      for (let gz = 0; gz < n; gz++) {
        for (let gx = 0; gx < n; gx++) {
          const base = gz * (n + 1) + gx;
          bakeIndices.push(
            base,
            base + 1,
            base + n + 2,
            base,
            base + n + 2,
            base + n + 1,
          );
        }
      }
      const facadeBase = bakeVerts.length;
      bakeVerts.push(...folded.facadeVerts);
      bakeIndices.push(...folded.facadeIndices.map((index) => index + facadeBase));
      chunk.meshes[MESH_KIND.groundBake] = { verts: bakeVerts, indices: bakeIndices };
      bakedChunks += 1;
    }
    onProgress?.({
      phase: "ground-bake",
      completed: mi + 1,
      total: maps.length,
      label: map.id,
    });

    packedMaps.push({ mapId: map.def.index, ...packed });
    // This explicit release is material in browser workers: before this
    // refactor eight full MapGeometry graphs stayed live through the bake.
    geometry = null;
  }

  if (colour) {
    while (colour.pagePal.length < pages.length) colour.pagePal.push(COLOR_PAL_NONE);
  }

  // --- GAME + CMAP + pack ------------------------------------------------
  const atlas: AtlasIndex = {
    sprites: spriteIndex,
    picFront: frontIndex,
    picBack: backIndex,
    emotePage,
    uiPage,
    terrainPage,
  };
  const gameJson = buildGamedata(gen, atlas, [...mapNames], profile);
  const glyphs = buildCharmap(gen);
  const treeLod = packedMaps.some((map) =>
    map.chunks.some((chunk) => chunk.meshes[MESH_KIND.treeBox].indices.length > 0),
  );
  const treeCoarse = packedMaps.some((map) =>
    map.chunks.some((chunk) => chunk.meshes[MESH_KIND.treeCoarse].indices.length > 0),
  );

  onProgress?.({ phase: "pack", completed: 0, total: 1, label: "vxpk" });
  const { bytes: pak, stats } = writePak({
    palettes,
    pages,
    maps: packedMaps,
    glyphs,
    gameJson,
    audioJson: input.audioJson,
    audioPrograms: input.audioPrograms,
    emotePage,
    metaFlags:
      (treeLod ? VXPK_META_FLAG_TREE_LOD : 0) |
      (treeCoarse ? VXPK_META_FLAG_TREE_COARSE : 0) |
      (bakedChunks > 0 ? VXPK_META_FLAG_GROUND_BAKE : 0),
    colour: colour
      ? { maps: colour.maps, pagePal: colour.pagePal, flags: colour.flags }
      : undefined,
  });
  onProgress?.({ phase: "pack", completed: 1, total: 1, label: "vxpk" });

  return {
    pak,
    gameJson,
    mapStats,
    buildingStats,
    pakBytes: stats.bytes,
    sections: stats.sections,
    colour: colour?.stats ?? null,
    palettes: palettes.length,
  };
}
