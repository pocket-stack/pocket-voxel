// Refresh the browser cooker's non-ROM reference data from the two MIT
// upstream checkouts. The generated JSON is committed: a browser user brings
// only their ROM, and the page never uploads it or asks for local checkouts.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const outDir = join(root, "web/reference");
const gen1recomp = process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
const voxelmod =
  process.env.VOXELMON_VOXELMOD ?? join(homedir(), "code/DramaticShapeVoxelMod");
const luaDump = join(root, "voxelmon/import/lua-dump.lua");

function run(command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

async function jsonFile(path: string): Promise<string> {
  const source = await Bun.file(path).json();
  return `${JSON.stringify(source)}\n`;
}

function dumpedLua(path: string): string {
  const source = run(["luajit", luaDump, path]);
  // Parse and re-stringify so malformed or non-JSON Lua dump output cannot be
  // published as a browser reference asset.
  return `${JSON.stringify(JSON.parse(source))}\n`;
}

mkdirSync(outDir, { recursive: true });

await Promise.all([
  Bun.write(
    join(outDir, "rom-manifest.json"),
    await jsonFile(join(gen1recomp, "tools/rom_manifest.json")),
  ),
  Bun.write(
    join(outDir, "voxel-profile.json"),
    dumpedLua(join(voxelmod, "data/voxel_heights.lua")),
  ),
  Bun.write(
    join(outDir, "palettes-gbc.json"),
    dumpedLua(join(gen1recomp, "data/palettes_gbc.lua")),
  ),
  Bun.write(
    join(outDir, "gen1recomp-LICENSE.md"),
    Bun.file(join(gen1recomp, "LICENSE.MD")),
  ),
  Bun.write(
    join(outDir, "DramaticShapeVoxelMod-LICENSE.txt"),
    Bun.file(join(voxelmod, "LICENSE")),
  ),
]);

const provenance = {
  sources: {
    gen1recomp: {
      url: "https://github.com/bryanthaboi/gen1recomp",
      commit: run(["git", "rev-parse", "HEAD"], gen1recomp),
      files: ["tools/rom_manifest.json", "data/palettes_gbc.lua"],
    },
    DramaticShapeVoxelMod: {
      url: "https://github.com/DramaticShape/DramaticShapeVoxelMod",
      commit: run(["git", "rev-parse", "HEAD"], voxelmod),
      files: ["data/voxel_heights.lua"],
    },
  },
} as const;

await Bun.write(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`browser references -> ${outDir}`);
