// Node/Bun adapters for the browser-safe cook data model in data.ts.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GenData, Profile } from "./data.ts";
import type { RedppPack } from "./redpp.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const GEN_DIR = join(ROOT, "dist/voxelmon/gen");

export function genMissingReason(genDir = GEN_DIR): string | null {
  if (!existsSync(join(genDir, "maps.json"))) {
    return `imported dataset not found: ${genDir} (run \`bun tools/voxel.ts import\`)`;
  }
  return null;
}

function readJson<T>(genDir: string, name: string): T {
  return JSON.parse(readFileSync(join(genDir, name), "utf8")) as T;
}

export function loadGen(genDir = GEN_DIR): GenData {
  return {
    maps: readJson(genDir, "maps.json"),
    tilesets: readJson(genDir, "tilesets.json"),
    palettes: readJson(genDir, "palettes.json"),
    sprites: readJson(genDir, "sprites.json"),
    gfx: readJson(genDir, "gfx.json"),
    gfxBin: new Uint8Array(readFileSync(join(genDir, "gfx.bin"))),
    font: readJson(genDir, "font.json"),
    constants: readJson(genDir, "constants.json"),
    encounters: readJson(genDir, "encounters.json"),
    moves: readJson(genDir, "moves.json"),
    pokemon: readJson(genDir, "pokemon.json"),
    items: readJson(genDir, "items.json"),
    typeChart: readJson(genDir, "type_chart.json"),
    trainers: readJson(genDir, "trainers.json"),
    text: readJson(genDir, "text.json"),
    textPointers: readJson(genDir, "text_pointers.json"),
    trainerHeaders: readJson(genDir, "trainer_headers.json"),
    field: readJson(genDir, "field.json"),
  };
}

const LUA_DUMP = fileURLToPath(new URL("../import/lua-dump.lua", import.meta.url));

export function voxelmodDir(): string {
  return process.env.VOXELMON_VOXELMOD ?? join(homedir(), "code/DramaticShapeVoxelMod");
}

/** Load data/voxel_heights.lua, or null (with a printed reason) when absent. */
export function loadProfile(): Profile | null {
  const path = join(voxelmodDir(), "data/voxel_heights.lua");
  if (!existsSync(path)) {
    console.error(`voxel cook: profile not found: ${path} (set VOXELMON_VOXELMOD)`);
    return null;
  }
  if (!Bun.which("luajit")) {
    console.error("voxel cook: luajit is not installed (needed to read voxel_heights.lua)");
    return null;
  }
  const proc = Bun.spawnSync(["luajit", LUA_DUMP, path]);
  if (proc.exitCode !== 0) {
    throw new Error(`lua-dump failed for ${path}:\n${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString()) as Profile;
}

export function gen1recompDir(): string {
  return process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
}

/**
 * Load `data/palettes_gbc.lua` (pokered-gbc-derived, MIT, NOT ROM-derived),
 * using the existing generated cache when it is current.
 */
export function loadRedpp(genDir = GEN_DIR): RedppPack | null {
  const path = join(gen1recompDir(), "data/palettes_gbc.lua");
  const cache = join(genDir, "palettes_gbc.json");
  if (!existsSync(path)) {
    console.error(`voxel cook: RED++ color pack not found: ${path} (set VOXELMON_G1R)`);
    return null;
  }
  const fresh = existsSync(cache) && statSync(cache).mtimeMs >= statSync(path).mtimeMs;
  if (fresh) return JSON.parse(readFileSync(cache, "utf8")) as RedppPack;
  if (!Bun.which("luajit")) {
    console.error("voxel cook: luajit is not installed (needed to read palettes_gbc.lua)");
    return null;
  }
  const proc = Bun.spawnSync(["luajit", LUA_DUMP, path]);
  if (proc.exitCode !== 0) {
    throw new Error(`lua-dump failed for ${path}:\n${proc.stderr.toString()}`);
  }
  const json = proc.stdout.toString();
  mkdirSync(genDir, { recursive: true });
  writeFileSync(cache, json);
  return JSON.parse(json) as RedppPack;
}
