// voxelmon/cook/cli.ts — cook the imported dataset into the VXPK pak.
//
//   bun voxelmon/cook/cli.ts [--maps PALLET_TOWN,ROUTE_1,...] [--out f]
//
// Pipeline (docs/VOXEL.md §5): classify -> volumes/buildings/trees/standees
// -> mesh per 16x16-tile chunk into the MESH_KIND streams -> atlases +
// palettes -> GAME + CMAP -> dist/voxelmon/voxelmon.vxpak. Prints per-stage
// stats. Skips (exit 1, printed reason) when gen/ is absent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  buildPicPage,
  buildSpritePage,
  buildTerrainPage,
  buildPalettes,
  buildUiPage,
  paletteBase,
  type PageDef,
} from "./atlas.ts";
import type { BuildingStats } from "./buildings.ts";
import {
  GameMap,
  GEN_DIR,
  genMissingReason,
  loadGen,
  loadProfile,
  loadRedpp,
  ROOT,
} from "./data.ts";
import { buildCharmap, buildGamedata, type AtlasIndex } from "./gamedata.ts";
import { BAKE_PAGE_H, bakeGround, BAKE_MAX_Y, BAKE_TEXELS, foldFacades } from "./groundbake.ts";
import { packMap, runGeometry, type MapGeometry, type UvTransform } from "./mesh.ts";
import { writePak } from "./pak.ts";
import { planColour, Redpp, type ColourPlan, type PageOwner } from "./redpp.ts";
import { analyseMap } from "./structures.ts";

export const DEFAULT_MAPS = [
  "REDS_HOUSE_1F",
  "REDS_HOUSE_2F",
  "PALLET_TOWN",
  "OAKS_LAB",
  "ROUTE_1",
  "VIRIDIAN_CITY",
  // Viridian's north exit is a REAL connection in the ROM: without this
  // map the border tree ring paints across the exit path and the player
  // "stands in the bush" at a dead end. Route 2's own far ends (Pewter,
  // the gates, Diglett's cave) are the new content boundary, held by the
  // cookedMaps guards.
  "ROUTE_2",
  "BLUES_HOUSE",
];

export interface CookResult {
  outPath: string;
  mapStats: { id: string; mapId: number; chunks: number; verts: number; stamps: number }[];
  buildingStats: BuildingStats;
  pakBytes: number;
  sections: { tag: string; bytes: number }[];
  /** RED++ color stats, or null when the pack was absent (cook is legacy). */
  colour: ColourPlan["stats"] | null;
  palettes: number;
}

export function cook(mapNames: string[], outPath: string, genDir = GEN_DIR): CookResult {
  const gen = loadGen(genDir);
  const profile = loadProfile();
  const pack = loadRedpp(genDir);
  const redpp = pack ? new Redpp(pack) : null;

  const maps = mapNames.map((name) => {
    const def = gen.maps[name];
    if (!def) throw new Error(`unknown map: ${name}`);
    const tileset = gen.tilesets[def.tileset];
    if (!tileset) throw new Error(`unknown tileset: ${def.tileset} (map ${name})`);
    return new GameMap(def, tileset);
  });

  // v1 bakes ONE terrain page shared by every map, so the reference's three
  // per-map tile-id exceptions (Celadon Mart) cannot apply — none of those
  // maps is reachable from v1's set, and cooking one silently mis-colored is
  // worse than refusing (docs/VOXEL.md §6, "what does not match RED++").
  if (redpp) {
    const needExceptions = Redpp.mapExceptions(mapNames);
    if (needExceptions.length > 0) {
      throw new Error(
        `RED++ color: ${needExceptions.join(", ")} need per-map tile-id ` +
          `exceptions, which one shared terrain page cannot carry`,
      );
    }
  }

  // --- atlases -------------------------------------------------------------
  // Page order: terrain (page 0 — the core binds the first TERRAIN page for
  // every chunk), ui, sprite sheets, emotes, pics.
  const terrainPage = 0;
  const terrain = buildTerrainPage(gen, maps.map((m) => m.tileset), redpp);
  const pages: PageDef[] = [terrain.page];
  const pageOwners: PageOwner[] = [{ kind: terrain.page.kind }];
  const uiPage = pages.length;
  pages.push(buildUiPage(gen));
  pageOwners.push({ kind: ATLAS_KIND.ui });

  const spriteIndex: Record<string, number> = {};
  const spriteKeys = Object.keys(gen.gfx)
    .filter((k) => k.startsWith("sprites/"))
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
    .filter((k) => k.startsWith("battle/front/"))
    .sort();
  // species -> front page resolves through the pokemon record's pic path
  const frontPageByKey = new Map<string, number>();
  for (const key of frontKeys) {
    frontPageByKey.set(key, pages.length);
    pages.push(buildPicPage(gen, key));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }
  // Back pics mirror the front path: one page per sheet, species-keyed —
  // the battle staging reads atlas.picBack[species] for the player's card.
  const backKeys = Object.keys(gen.gfx)
    .filter((k) => k.startsWith("battle/back/"))
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
  // The trainer back pic lives at battle/redb (no back/ prefix upstream).
  // It carries no species, so it takes no RED++ pic palette and keeps
  // today's binding (the SGB selection, else the kind ramp).
  if (gen.gfx["battle/redb"]) {
    backIndex.redb = pages.length;
    pages.push(buildPicPage(gen, "battle/redb"));
    pageOwners.push({ kind: ATLAS_KIND.pics });
  }

  // --- mesh ---------------------------------------------------------------
  const buildingStats: BuildingStats = { built: [], claimOnly: [], skipped: [], placements: 0 };
  const mapStats: CookResult["mapStats"] = [];
  const geos: { geo: MapGeometry; uvt: UvTransform }[] = [];
  const packedMaps = maps.map((map) => {
    const S = analyseMap(gen, map, profile, buildingStats);
    const geo = runGeometry(map, S);
    const uvt: UvTransform = {
      baseY: terrain.baseY.get(sheetKey(map)) ?? 0,
      pageW: terrain.page.w,
      pageH: terrain.page.h,
    };
    geos.push({ geo, uvt });
    const { chunks, stamps } = packMap(geo, uvt);
    const verts = chunks.reduce(
      (n, c) => n + c.meshes.reduce((m, mesh) => m + mesh.verts.length, 0),
      0,
    );
    mapStats.push({ id: map.id, mapId: map.def.index, chunks: chunks.length, verts, stamps: stamps.length });
    return { mapId: map.def.index, chunks, stamps };
  });

  // --- GAME + CMAP + pack --------------------------------------------------
  const atlas: AtlasIndex = {
    sprites: spriteIndex,
    picFront: frontIndex,
    picBack: backIndex,
    emotePage,
    uiPage,
    terrainPage,
  };
  const gameJson = buildGamedata(gen, atlas, mapNames);
  const glyphs = buildCharmap(gen);
  // The chip synth's input rides in its own AUDI section: the importer's
  // audio.json + programs.bin, spliced verbatim (the guest is the only
  // parser). Absent for a dataset imported before the audio stage existed —
  // AUDI is then written empty and the game runs silent.
  const audioJsonPath = join(genDir, "audio.json");
  const audioProgramPath = join(genDir, "programs.bin");
  const hasAudio = existsSync(audioJsonPath) && existsSync(audioProgramPath);
  // The RED++ bindings (cook/redpp.ts): the VPAL tail plus the VCOL records
  // naming, per map and per page, which entry of it that draw resolves
  // through. Absent pack -> no tail, no bake, and writePak fills VCOL with
  // COLOR_PAL_NONE, which renders exactly as a pre-color pak did.
  const colour = redpp
    ? planColour(gen, redpp, {
        base: paletteBase(gen),
        maps: maps.map((m) => ({
          id: m.id,
          mapId: m.def.index,
          tileset: m.def.tileset,
          index: m.def.index,
          sheetKey: sheetKey(m),
        })),
        bakedSheets: terrain.bakedSheets,
        terrainPage,
        pages: pageOwners,
      })
    : null;
  const palettes = buildPalettes(gen, colour?.palettes ?? []);

  // --- the ground bake (docs/VOXEL.md §4a): per eligible chunk, one page ---
  // Transparency is judged in the palette the page DRAWS through: the
  // map's RED++ world palette when it has one, else the terrain kind ramp
  // (palettes[0] misjudges group*4+shade indices on a RED++ pak).
  let bakedChunks = 0;
  packedMaps.forEach((m, mi) => {
    const { geo, uvt } = geos[mi];
    const worldPal = colour?.maps.find((cm) => cm.mapId === m.mapId)?.worldPal;
    const pal = worldPal !== undefined && worldPal !== COLOR_PAL_NONE ? palettes[worldPal] : palettes[0];
    const transparentIdx = (index: number) => (pal[index] >>> 24) === 0;
    let clearIndex = 0;
    for (let i = 0; i < 256; i++) {
      if ((pal[i] >>> 24) === 0) {
        clearIndex = i;
        break;
      }
    }
    const canvases = bakeGround(m.chunks, geo, terrain.page, uvt, transparentIdx, clearIndex);
    for (const [ci, canvas] of canvases) {
      const c = m.chunks[ci];
      // The KEEP stream: every terrain quad taller than the bake line,
      // duplicated out of the packed terrain (4 verts per quad — the
      // packQuads layout). Drawn with the bake in place of the full stream;
      // the full stream stays untouched for the identity path.
      const keep: { verts: (typeof c.meshes)[0]["verts"]; indices: number[] } = {
        verts: [],
        indices: [],
      };
      const t = c.meshes[MESH_KIND.terrain];
      for (let q = 0; q * 4 < t.verts.length; q++) {
        const quad = t.verts.slice(q * 4, q * 4 + 4);
        if (Math.max(...quad.map((v2) => v2.y)) <= BAKE_MAX_Y) continue;
        const base = keep.verts.length;
        keep.verts.push(...quad);
        keep.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      // The full bake page: ground rows on top, facade strips below.
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
      c.meshes[MESH_KIND.terrainKeep] = kept;
      c.bakePage = pages.length;
      pages.push({
        w: BAKE_TEXELS,
        h: BAKE_PAGE_H,
        kind: ATLAS_KIND.terrain,
        frames: [fullCanvas],
        name: `bake/${m.mapId}/${c.cx},${c.cy}`,
      });
      pageOwners.push({ kind: ATLAS_KIND.terrain });
      const x0 = c.cx * 128;
      const z0 = c.cy * 128;
      // An 8x8 grid, not one quad: across a 128 px span the GE's and the
      // rasterizer's perspective interpolation drift apart by whole texels
      // (measured: one quad diverged diffusely over the whole baked field,
      // AE ~16k), while the 16 px spans the rest of the pak is built from
      // demonstrably agree. 128 triangles a chunk against ~1500 replaced.
      const N = 8;
      const groundVScale = BAKE_TEXELS / BAKE_PAGE_H; // ground = top rows
      const verts = [];
      for (let gz = 0; gz <= N; gz++) {
        for (let gx = 0; gx <= N; gx++) {
          verts.push({
            u: gx / N,
            v: (gz / N) * groundVScale,
            abgr: 0xffffffff,
            x: x0 + (gx * 128) / N,
            y: 0,
            z: z0 + (gz * 128) / N,
          });
        }
      }
      const indices: number[] = [];
      for (let gz = 0; gz < N; gz++) {
        for (let gx = 0; gx < N; gx++) {
          const b = gz * (N + 1) + gx;
          indices.push(b, b + 1, b + N + 2, b, b + N + 2, b + N + 1);
        }
      }
      // Facade strips ride the SAME page and mesh (docs §4a): a building
      // wall of dozens of band quads redraws as one painted grid.
      const fb = verts.length;
      verts.push(...folded.facadeVerts);
      indices.push(...folded.facadeIndices.map((i) => i + fb));
      c.meshes[MESH_KIND.groundBake] = { verts, indices };
      bakedChunks++;
    }
  });
  // Bake pages carry no page palette of their own: their CLUT arrives
  // through the chunk mesh's world palette (resolve_pal rung 1), so the
  // VCOL page table just says NONE for each.
  if (colour) {
    while (colour.pagePal.length < pages.length) colour.pagePal.push(COLOR_PAL_NONE);
  }
  // The pak states what it carries: a chunk with a treeBox mesh has BOTH
  // tree levels of detail, so a runtime may pick per chunk. A cook that
  // carved no hulls (VOXEL_TREE_BOXES=1) produces neither tree mesh and
  // declares nothing, and the core then draws whatever the terrain stream
  // holds — the pre-LOD behaviour, unchanged.
  const treeLod = packedMaps.some((m) =>
    m.chunks.some((c) => c.meshes[MESH_KIND.treeBox].indices.length > 0),
  );
  const treeCoarse = packedMaps.some((m) =>
    m.chunks.some((c) => c.meshes[MESH_KIND.treeCoarse].indices.length > 0),
  );
  const { bytes, stats } = writePak({
    palettes,
    pages,
    maps: packedMaps,
    glyphs,
    gameJson,
    audioJson: hasAudio ? new Uint8Array(readFileSync(audioJsonPath)) : undefined,
    audioPrograms: hasAudio ? new Uint8Array(readFileSync(audioProgramPath)) : undefined,
    emotePage,
    metaFlags:
      (treeLod ? VXPK_META_FLAG_TREE_LOD : 0) |
      (treeCoarse ? VXPK_META_FLAG_TREE_COARSE : 0) |
      (bakedChunks > 0 ? VXPK_META_FLAG_GROUND_BAKE : 0),
    colour: colour
      ? { maps: colour.maps, pagePal: colour.pagePal, flags: colour.flags }
      : undefined,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);
  // The Bun headless sim loads this instead of re-deriving from gen/, so
  // both hosts see the SAME gamedata (the pak GAME section verbatim —
  // notably the atlas page maps, without which no battle card ops emit and
  // the recorded trace would diverge from a live device run).
  writeFileSync(join(dirname(outPath), "gamedata.json"), gameJson);

  return {
    outPath,
    mapStats,
    buildingStats,
    pakBytes: stats.bytes,
    sections: stats.sections,
    colour: colour?.stats ?? null,
    palettes: palettes.length,
  };
}

function sheetKey(map: GameMap): string {
  return map.tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

function main(): number {
  const args = process.argv.slice(2);
  let mapNames = DEFAULT_MAPS;
  let outPath = join(ROOT, "dist/voxelmon/voxelmon.vxpak");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--maps" && args[i + 1]) {
      mapNames = args[++i].split(",").filter(Boolean);
    } else if (args[i] === "--out" && args[i + 1]) {
      outPath = args[++i];
    } else {
      console.error(`usage: bun voxelmon/cook/cli.ts [--maps A,B,...] [--out file]`);
      return 2;
    }
  }

  const reason = genMissingReason();
  if (reason) {
    console.error(`voxel cook: skipped — ${reason}`);
    return 1;
  }

  const t0 = performance.now();
  const result = cook(mapNames, outPath);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);

  console.log(`voxel cook: ${result.outPath} (${result.pakBytes} bytes, ${dt}s)`);
  for (const s of result.sections) console.log(`  ${s.tag}  ${s.bytes} bytes`);
  for (const m of result.mapStats) {
    console.log(
      `  map ${m.id} (#${m.mapId}): ${m.chunks} chunks, ${m.verts} verts, ` +
        `${m.verts / 4} quads, ${m.stamps} stamps`,
    );
  }
  const b = result.buildingStats;
  console.log(
    `  buildings: ${b.placements} placements, built [${b.built.join(", ")}], ` +
      `claim-only [${b.claimOnly.join(", ")}], skipped desk-sets [${b.skipped.join(", ")}]`,
  );
  console.log(
    result.colour
      ? `  color: RED++ per-tile — ${result.palettes} palettes ` +
          `(${result.colour.world} world, ${result.colour.obj} OBJ over ` +
          `${result.colour.sprites} sprite pages, ${result.colour.pic} pic over ` +
          `${result.colour.pics} pic pages)`
      : `  color: SGB per-map only (no RED++ pack), ${result.palettes} palettes`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
