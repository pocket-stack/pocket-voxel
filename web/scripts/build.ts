// Build the complete static browser player without Vite or a frontend runtime.

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "web");
const out = join(root, "dist/web");

function run(command: string[]): void {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

run(["bun", "web/scripts/build-wasm.ts"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "generated"), { recursive: true });
mkdirSync(join(out, "third-party"), { recursive: true });
mkdirSync(join(out, "assets", "game-boy"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(web, "main.ts"), join(web, "cook.worker.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "external",
  naming: "[name].[ext]",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const name of ["index.html", "styles.css", "audio-worklet.js"]) {
  cpSync(join(web, name), join(out, name));
}
for (const name of ["pocketvoxel_wasm.js", "pocketvoxel_wasm_bg.wasm"]) {
  cpSync(join(web, "generated", name), join(out, "generated", name));
}
cpSync(
  join(web, "reference", "gen1recomp-LICENSE.md"),
  join(out, "third-party", "gen1recomp-LICENSE.md"),
);
cpSync(
  join(web, "reference", "DramaticShapeVoxelMod-LICENSE.txt"),
  join(out, "third-party", "DramaticShapeVoxelMod-LICENSE.txt"),
);
cpSync(join(web, "reference", "provenance.json"), join(out, "third-party", "provenance.json"));
cpSync(join(web, "reference", "third-party"), join(out, "third-party", "runtime"), {
  recursive: true,
});
for (const name of ["profile.json", "gameboy-stage.glb", "ATTRIBUTION.md"]) {
  cpSync(join(web, "assets", "game-boy", name), join(out, "assets", "game-boy", name));
}

const forbidden = readdirSync(out, { recursive: true })
  .map(String)
  .filter(
    (name) =>
      [".gb", ".gbc", ".vxpak"].includes(extname(name).toLowerCase()) ||
      ["gamedata.json", "gfx.bin", "programs.bin", "audio.json"].includes(
        basename(name).toLowerCase(),
      ),
  );
if (forbidden.length > 0) {
  console.error(`web build refused ROM-derived output: ${forbidden.join(", ")}`);
  process.exit(1);
}

const bytes = readdirSync(out, { recursive: true })
  .map(String)
  .filter((name) => statSync(join(out, name)).isFile())
  .reduce((sum, name) => sum + Bun.file(join(out, name)).size, 0);
console.log(`Pocket Voxel web: dist/web (${(bytes / 1024 / 1024).toFixed(1)} MiB static)`);
