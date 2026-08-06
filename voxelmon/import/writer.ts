// gen/*.json writer — Lua-shape-preserving per voxelmon/SCHEMA.md:
// dense 1..n numeric-keyed tables become 0-indexed JSON arrays (FIELD VALUES
// keep their Lua meaning), everything else becomes an object; absent optional
// fields are omitted, never null.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Both upstreams int()-convert the per-map trainer-header keys
 * (RomExtractor.lua:1466, build_rom_data.py extract_text), which makes a
 * table like {"1": a, "2": b} a dense Lua array. Mirror that here: dense
 * 1..n numeric-string keys collapse to an array, anything else (sparse, or
 * 0-based like field trashCans.adjacent) stays an object.
 */
export function numericKeyed(value: Record<string, unknown>): unknown {
  const keys = Object.keys(value);
  if (keys.length === 0) return value;
  if (!keys.every((k) => /^[1-9][0-9]*$/.test(k))) return value;
  const ints = keys.map(Number).sort((a, b) => a - b);
  for (let i = 0; i < ints.length; i++) {
    if (ints[i] !== i + 1) return value;
  }
  return ints.map((k) => value[String(k)]);
}

export function writeJson(genDir: string, name: string, value: unknown): void {
  mkdirSync(genDir, { recursive: true });
  // JSON.stringify drops undefined object fields — the "omitted, never null"
  // rule falls out; nothing here may place undefined inside an array.
  writeFileSync(join(genDir, `${name}.json`), JSON.stringify(value));
}
