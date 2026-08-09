// Build the Pocket Voxel browser runtime and generate its wasm-bindgen glue.
// This script is intentionally WASM-only; the web app's own build stays in
// the web host.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(root, "target/wasm32-unknown-unknown/release/pocketvoxel_wasm.wasm");
const out = resolve(root, "web/generated");
const bindgenVersion = "0.2.126";

function run(command: string[], cwd = root, env?: Record<string, string | undefined>): void {
  const proc = Bun.spawnSync(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

function cargoInvocation(): { command: string[]; env?: Record<string, string | undefined> } {
  const rustup = Bun.which("rustup");
  if (!rustup) return { command: ["cargo"] };
  const active = Bun.spawnSync(["rustup", "show", "active-toolchain"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  const toolchain = active.stdout.toString().trim().split(/\s+/)[0];
  if (active.exitCode !== 0 || !toolchain) return { command: ["cargo"] };
  const proxyDirectory = dirname(rustup);
  return {
    command: [resolve(proxyDirectory, "cargo")],
    // A Homebrew cargo/rustc may precede rustup in PATH. Keep both rustup
    // proxies first so rustc also receives the toolchain's linker environment.
    env: {
      ...process.env,
      PATH: `${proxyDirectory}:${process.env.PATH ?? ""}`,
      RUSTUP_TOOLCHAIN: toolchain,
    },
  };
}

const version = Bun.spawnSync(["wasm-bindgen", "--version"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
if (version.exitCode !== 0 || version.stdout.toString().trim() !== `wasm-bindgen ${bindgenVersion}`) {
  console.error(
    `Pocket Voxel wasm: need wasm-bindgen ${bindgenVersion}; ` +
      `run: cargo install wasm-bindgen-cli --version ${bindgenVersion} --locked`,
  );
  process.exit(1);
}

const cargo = cargoInvocation();
run([
  ...cargo.command,
  "build",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
  "-p",
  "pocketvoxel-wasm",
], root, cargo.env);
if (!existsSync(target)) {
  console.error(`Pocket Voxel wasm: build succeeded but ${target} is missing`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
run([
  "wasm-bindgen",
  target,
  "--target",
  "web",
  "--out-dir",
  out,
  "--out-name",
  "pocketvoxel_wasm",
]);

const wasm = resolve(out, "pocketvoxel_wasm_bg.wasm");
const size = Bun.file(wasm).size;
console.log(
  `Pocket Voxel wasm: web/generated/pocketvoxel_wasm.js + ` +
    `pocketvoxel_wasm_bg.wasm (${(size / 1024).toFixed(1)} KiB)`,
);
