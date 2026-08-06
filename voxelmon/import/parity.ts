// `tools/voxel.ts parity` — deep-compare dist/voxelmon/gen/*.json against
// the reference $VOXELMON_G1R/data/generated/*.lua (dumped to JSON through
// lua-dump.lua). Field-for-field VALUE equality post-normalization is the
// bar (voxelmon/SCHEMA.md); the first N mismatching paths print per
// file.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { VoxelEnv } from "./env.ts";

const LUA_DUMP = fileURLToPath(new URL("lua-dump.lua", import.meta.url));

/** The datasets the importer produces (battle_anims/icons/audio deferred). */
export const PARITY_FILES = [
  "constants",
  "tilesets",
  "maps",
  "font",
  "sprites",
  "moves",
  "items",
  "type_chart",
  "palettes",
  "pokemon",
  "trainers",
  "encounters",
  "text",
  "text_pointers",
  "trainer_headers",
  "field",
];

const MAX_MISMATCHES_PER_FILE = 20;

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

function short(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

type Allow = (path: string, ref: unknown, gen: unknown) => string | null;

function diff(
  ref: unknown,
  gen: unknown,
  path: string,
  mismatches: string[],
  allowed: string[],
  allow: Allow,
): void {
  const allowedNote = allow(path, ref, gen);
  if (allowedNote !== null) {
    allowed.push(`${path}: ${allowedNote}`);
    return;
  }
  // A Lua {} dumps as {} whether the value was an empty array or an empty
  // map; the two are the same empty table.
  if (isEmptyContainer(ref) && isEmptyContainer(gen)) return;
  if (Array.isArray(ref) && Array.isArray(gen)) {
    if (ref.length !== gen.length) {
      mismatches.push(`${path}: array length ${ref.length} != ${gen.length}`);
    }
    const n = Math.min(ref.length, gen.length);
    for (let i = 0; i < n; i++) {
      if (mismatches.length > MAX_MISMATCHES_PER_FILE) return;
      diff(ref[i], gen[i], `${path}[${i}]`, mismatches, allowed, allow);
    }
    return;
  }
  const refObj = typeof ref === "object" && ref !== null && !Array.isArray(ref);
  const genObj = typeof gen === "object" && gen !== null && !Array.isArray(gen);
  if (refObj && genObj) {
    const refRec = ref as Record<string, unknown>;
    const genRec = gen as Record<string, unknown>;
    const keys = new Set([...Object.keys(refRec), ...Object.keys(genRec)]);
    for (const key of [...keys].sort()) {
      if (mismatches.length > MAX_MISMATCHES_PER_FILE) return;
      const sub = path === "" ? key : `${path}.${key}`;
      if (!(key in refRec)) {
        if (allow(sub, undefined, genRec[key]) !== null) {
          allowed.push(`${sub}: ${allow(sub, undefined, genRec[key])}`);
          continue;
        }
        mismatches.push(`${sub}: only in gen (${short(genRec[key])})`);
      } else if (!(key in genRec)) {
        mismatches.push(`${sub}: only in reference (${short(refRec[key])})`);
      } else {
        diff(refRec[key], genRec[key], sub, mismatches, allowed, allow);
      }
    }
    return;
  }
  if (ref !== gen) {
    mismatches.push(`${path}: ref ${short(ref)} != gen ${short(gen)}`);
  }
}

async function luaDump(refPath: string): Promise<unknown> {
  const proc = Bun.spawn(["luajit", LUA_DUMP, refPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`lua-dump failed for ${refPath}:\n${stderr}`);
  return JSON.parse(stdout);
}

export async function runParity(env: VoxelEnv): Promise<number> {
  if (!Bun.which("luajit")) {
    console.error("voxel parity: luajit is not installed (needed to dump the reference .lua)");
    return 1;
  }
  if (!existsSync(env.genDir)) {
    console.error(`voxel parity: ${env.genDir} missing — run \`bun tools/voxel.ts import\` first`);
    return 1;
  }

  // The one known semantic divergence between the two upstream extractors:
  // RomExtractor.lua:1317-1325 fills the empty OPP_CHIEF party from the
  // manifest's trainerPartyOverrides (ChiefData is cut content, no ROM bytes
  // exist), while tools/build_rom_data.py — which built the reference —
  // leaves it empty. The importer follows the Lua; parity accepts exactly
  // the manifest override there.
  const manifest = (await Bun.file(env.manifestPath).json()) as {
    trainerPartyOverrides?: Record<string, unknown>;
  };
  const trainersAllow: Allow = (path, ref, gen) => {
    if (!path.endsWith(".parties")) return null;
    const trainerId = path.split(".")[0];
    const override = manifest.trainerPartyOverrides?.[trainerId];
    if (!override) return null;
    if (!isEmptyContainer(ref)) return null;
    if (JSON.stringify(gen) !== JSON.stringify([override])) return null;
    return "manifest trainerPartyOverrides (RomExtractor.lua:1317; reference extractor omits it)";
  };
  const noAllow: Allow = () => null;

  let failures = 0;
  for (const name of PARITY_FILES) {
    const refPath = join(env.refGeneratedDir, `${name}.lua`);
    const genPath = join(env.genDir, `${name}.json`);
    if (!existsSync(refPath)) {
      console.error(`FAIL ${name}: reference missing (${refPath})`);
      failures += 1;
      continue;
    }
    if (!existsSync(genPath)) {
      console.error(`FAIL ${name}: gen output missing (${genPath})`);
      failures += 1;
      continue;
    }
    const ref = await luaDump(refPath);
    const gen = await Bun.file(genPath).json();
    const mismatches: string[] = [];
    const allowed: string[] = [];
    diff(ref, gen, "", mismatches, allowed, name === "trainers" ? trainersAllow : noAllow);
    if (mismatches.length === 0) {
      const note = allowed.length > 0 ? ` (allowed: ${allowed.join("; ")})` : "";
      console.log(`ok   ${name}${note}`);
    } else {
      failures += 1;
      console.error(`FAIL ${name} — first ${Math.min(mismatches.length, MAX_MISMATCHES_PER_FILE)} mismatches:`);
      for (const line of mismatches.slice(0, MAX_MISMATCHES_PER_FILE)) {
        console.error(`  ${line}`);
      }
    }
  }
  console.log(
    failures === 0
      ? `voxel parity: all ${PARITY_FILES.length} datasets match the reference`
      : `voxel parity: ${failures}/${PARITY_FILES.length} datasets FAILED`,
  );
  return failures === 0 ? 0 : 1;
}
