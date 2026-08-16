// Input resolution for the voxelmon pipeline (voxelmon/SCHEMA.md):
// everything ROM-adjacent comes from env vars with local-developer defaults;
// anything missing must SKIP with a printed reason, never fail CI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export { RED_SHA1 } from "./constants.ts";

// SCHEMA.md: no default ROM path is committed to docs; this is the local
// developer default for this machine.
const DEFAULT_ROM =
  "/Users/evan/Library/Mobile Documents/com~apple~CloudDocs/Documents/project-assets/pokemon/PokemonRed.gb";

export interface VoxelEnv {
  romPath: string;
  g1rDir: string;
  voxelmodDir: string;
  manifestPath: string;
  refGeneratedDir: string;
  genDir: string;
}

export function resolveEnv(): VoxelEnv {
  const g1rDir = process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
  return {
    romPath: process.env.VOXELMON_ROM ?? DEFAULT_ROM,
    g1rDir,
    voxelmodDir: process.env.VOXELMON_VOXELMOD ?? join(homedir(), "code/DramaticShapeVoxelMod"),
    manifestPath: join(g1rDir, "tools/rom_manifest.json"),
    refGeneratedDir: join(g1rDir, "data/generated"),
    genDir: join(ROOT, "dist/voxelmon/gen"),
  };
}

/** Returns a printable reason the pipeline cannot run, or null when it can. */
export function missingInputReason(env: VoxelEnv): string | null {
  if (!existsSync(env.romPath)) return `ROM not found: ${env.romPath} (set VOXELMON_ROM)`;
  if (!existsSync(env.manifestPath)) {
    return `gen1recomp manifest not found: ${env.manifestPath} (set VOXELMON_G1R)`;
  }
  return null;
}
