// Bun/Node adapter for the browser-safe in-memory importer in core.ts.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { importRedRom } from "./core.ts";
import type { VoxelEnv } from "./env.ts";
import type { Manifest } from "./manifest.ts";
import { writeJson } from "./writer.ts";

export { importRedRom, sha1Hex } from "./core.ts";
export type { ImportedContent, ImportProgress, ImportProgressHook } from "./core.ts";

export async function runImport(env: VoxelEnv): Promise<void> {
  const romData = new Uint8Array(await Bun.file(env.romPath).arrayBuffer());
  const manifest = (await Bun.file(env.manifestPath).json()) as Manifest;
  const imported = await importRedRom(romData, manifest, (progress) => {
    if (progress.phase !== "extract") return;
    console.log(
      `voxel import [${String(progress.completed).padStart(2)}/${progress.total}] ` +
        `${progress.label.padEnd(10)} ${progress.elapsedMs.toFixed(0).padStart(5)} ms`,
    );
  });

  const { gen, audioJson, audioPrograms } = imported;
  const genDir = env.genDir;
  writeJson(genDir, "constants", gen.constants);
  writeJson(genDir, "tilesets", gen.tilesets);
  writeJson(genDir, "maps", gen.maps);
  writeJson(genDir, "font", gen.font);
  writeJson(genDir, "sprites", gen.sprites);
  writeJson(genDir, "moves", gen.moves);
  writeJson(genDir, "items", gen.items);
  writeJson(genDir, "type_chart", gen.typeChart);
  writeJson(genDir, "palettes", gen.palettes);
  writeJson(genDir, "pokemon", gen.pokemon);
  writeJson(genDir, "trainers", gen.trainers);
  writeJson(genDir, "encounters", gen.encounters);
  writeJson(genDir, "text", gen.text);
  writeJson(genDir, "text_pointers", gen.textPointers);
  writeJson(genDir, "trainer_headers", gen.trainerHeaders);
  writeJson(genDir, "field", gen.field);
  writeFileSync(join(genDir, "audio.json"), audioJson);
  writeFileSync(join(genDir, "programs.bin"), audioPrograms);
  writeFileSync(join(genDir, "gfx.bin"), gen.gfxBin);
  writeJson(genDir, "gfx", gen.gfx);

  console.log(`voxel import done -> ${genDir} (${Object.keys(gen.gfx).length} gfx entries)`);
}
