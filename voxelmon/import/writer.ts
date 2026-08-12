// gen/*.json writer — Lua-shape-preserving per voxelmon/SCHEMA.md:
// dense 1..n numeric-keyed tables become 0-indexed JSON arrays (FIELD VALUES
// keep their Lua meaning), everything else becomes an object; absent optional
// fields are omitted, never null.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export { numericKeyed } from "./normalization.ts";

export function writeJson(genDir: string, name: string, value: unknown): void {
  mkdirSync(genDir, { recursive: true });
  // JSON.stringify drops undefined object fields — the "omitted, never null"
  // rule falls out; nothing here may place undefined inside an array.
  writeFileSync(join(genDir, `${name}.json`), JSON.stringify(value));
}
