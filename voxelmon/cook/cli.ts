// Bun/Node adapter for the browser-safe in-memory cooker in core.ts.
//
//   bun voxelmon/cook/cli.ts [--maps PALLET_TOWN,ROUTE_1,...] [--out f]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  cookVoxelPak,
  DEFAULT_MAPS,
  type CookArtifacts,
  type CookInput,
  type CookOptions,
  type CookProgress,
  type CookProgressHook,
} from "./core.ts";
import {
  GEN_DIR,
  genMissingReason,
  loadGen,
  loadProfile,
  loadRedpp,
  ROOT,
} from "./data-node.ts";

export {
  cookVoxelPak,
  DEFAULT_MAPS,
  type CookArtifacts,
  type CookInput,
  type CookOptions,
  type CookProgress,
  type CookProgressHook,
} from "./core.ts";

export interface CookResult extends Omit<CookArtifacts, "pak" | "gameJson"> {
  outPath: string;
}

/** Backward-compatible filesystem cook used by tools/voxel.ts and existing
 * tests. All content work is delegated to cookVoxelPak. */
export function cook(mapNames: readonly string[], outPath: string, genDir = GEN_DIR): CookResult {
  const audioJsonPath = join(genDir, "audio.json");
  const audioProgramPath = join(genDir, "programs.bin");
  const hasAudio = existsSync(audioJsonPath) && existsSync(audioProgramPath);
  const artifacts = cookVoxelPak({
    gen: loadGen(genDir),
    profile: loadProfile(),
    redpp: loadRedpp(genDir),
    audioJson: hasAudio ? new Uint8Array(readFileSync(audioJsonPath)) : undefined,
    audioPrograms: hasAudio ? new Uint8Array(readFileSync(audioProgramPath)) : undefined,
    mapNames,
    options: {
      keepHidden: process.env.VOXEL_KEEP_HIDDEN === "1",
      treeBoxes: process.env.VOXEL_TREE_BOXES === "1",
    },
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, artifacts.pak);
  // The Bun headless sim consumes the exact GAME section bytes.
  writeFileSync(join(dirname(outPath), "gamedata.json"), artifacts.gameJson);
  const { pak: _pak, gameJson: _gameJson, ...result } = artifacts;
  return { outPath, ...result };
}

function main(): number {
  const args = process.argv.slice(2);
  let mapNames: string[] = [...DEFAULT_MAPS];
  let outPath = join(ROOT, "dist/voxelmon/voxelmon.vxpak");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--maps" && args[i + 1]) {
      mapNames = args[++i].split(",").filter(Boolean);
    } else if (args[i] === "--out" && args[i + 1]) {
      outPath = args[++i];
    } else {
      console.error("usage: bun voxelmon/cook/cli.ts [--maps A,B,...] [--out file]");
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
  for (const section of result.sections) {
    console.log(`  ${section.tag}  ${section.bytes} bytes`);
  }
  for (const map of result.mapStats) {
    console.log(
      `  map ${map.id} (#${map.mapId}): ${map.chunks} chunks, ${map.verts} verts, ` +
        `${map.verts / 4} quads, ${map.stamps} stamps`,
    );
  }
  const buildings = result.buildingStats;
  console.log(
    `  buildings: ${buildings.placements} placements, built [${buildings.built.join(", ")}], ` +
      `claim-only [${buildings.claimOnly.join(", ")}], skipped desk-sets ` +
      `[${buildings.skipped.join(", ")}]`,
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

if (import.meta.main) process.exit(main());
