// tools/voxel.ts — the Pocket Voxel pipeline command (docs/VOXEL.md §2).
//
//   bun tools/voxel.ts import    ROM -> dist/voxelmon/gen/ (JSON + gfx.bin)
//   bun tools/voxel.ts parity    gen/*.json vs $VOXELMON_G1R/data/generated
//   bun tools/voxel.ts psp       gen+cook+trace + bundle game.js + cargo psp
//   bun tools/voxel.ts run       psp, then launch the EBOOT in PPSSPP
//
// Inputs resolve from VOXELMON_ROM / VOXELMON_G1R / VOXELMON_VOXELMOD
// (voxelmon/SCHEMA.md); anything missing prints a reason and exits
// without failing into a half-decoded state.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";

import { packageVitaVpk } from "../vendor/pocketjs/tools/vita-package.ts";
import { missingInputReason, resolveEnv } from "../voxelmon/import/env.ts";
import { runImport } from "../voxelmon/import/index.ts";
import { runParity } from "../voxelmon/import/parity.ts";
import { resolvePspBuildToolchain } from "./psp-toolchain.ts";

const USAGE = `usage: bun tools/voxel.ts <command>

commands:
  import    decode the ROM into dist/voxelmon/gen/ (SHA-1 gated)
  parity    deep-compare gen/*.json against the gen1recomp reference
  cook      voxelize + pack dist/voxelmon/voxelmon.vxpak
  sim       run the story tape headless -> dist/voxelmon/trace/story.vtrace
  check     import-if-missing + cook + all tapes + rasterize vs the hash
            goldens at BOTH pinned quality rungs: the shipped psp rung
            (<tape>.hashes) and the top rung, which must still be the
            pre-ladder identity (<tape>-max.hashes)
  record    like check, but (re)write the shipped psp goldens. The -max
            goldens are the identity anchor and are only re-proved, never
            rewritten
  shots     like check, but write PNG frames to
            dist/voxelmon/shots-<tape>-<tier>/ (local); --tier <name> for one
  wav       render the chip synth to dist/voxelmon/audio/*.wav (local)
  psp       gen+cook+trace + bundle game.js + cargo psp -> EBOOT.PBP
            (extra args pass to cargo psp, e.g. --release, --features capture)
  run       psp, then launch the EBOOT in PPSSPP
  vita      gen+cook+trace + bundle game.js + cargo vita -> a VPK carrying
            the pak (extra args pass to cargo vita, e.g. --release);
            --tier <psp|vita|desktop> names the quality rung the build asks
            the core for (default vita)
  cardputer import-if-missing + cook + bundle + aarch64 Linux build for the
            Cardputer Zero; --install deploys it through adb and refreshes
            APPLaunch

env: VOXELMON_ROM (canonical US Red), VOXELMON_G1R (~/code/gen1recomp),
     VOXELMON_VOXELMOD (~/code/DramaticShapeVoxelMod), VITASDK`;

const ROOT = new URL("..", import.meta.url).pathname;
/** Every tape's tested seed — their routes are plotted against it. */
const STORY_SEED = "17";
const PAK = "dist/voxelmon/voxelmon.vxpak";

/** The tapes every verdict runs. Each records its own trace and goldens. */
const TAPES = ["story", "battle", "computer"] as const;
const trace = (tape: string) => `dist/voxelmon/trace/${tape}.vtrace`;

/**
 * The two rungs the goldens pin (contracts/spec/voxel-spec.ts §quality
 * ladder). `shipped` is what the PSP runs, so its hashes move whenever a
 * rung's dials move — that is the point of recording them. `max` is the top
 * rung, which is the IDENTITY: `<tape>-max.hashes` are the pre-ladder frame
 * hashes and must stay byte-for-byte true forever. `record` deliberately
 * refuses to rewrite them — a max-tier mismatch means the ladder's top rung
 * stopped being the identity, and the fix is the code, never the golden.
 */
const SHIPPED_TIER = "psp";
const MAX_TIER = "desktop";
const goldens = (tape: string, tier: "shipped" | "max") =>
  `tests/goldens/voxel/${tape}${tier === "max" ? "-max" : ""}.hashes`;

/** `--name value` off the command line. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function run(
  cmd: string[],
  cwd = ROOT,
  env?: Record<string, string | undefined>,
): Promise<number> {
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    ...(env ? { env } : {}),
  });
  return await p.exited;
}

/** import (only when gen/ is absent) + cook + a headless run per tape. */
async function preparePakAndTrace(): Promise<number> {
  if (!(await Bun.file(`${ROOT}dist/voxelmon/gen/maps.json`).exists())) {
    const rc = await run(["bun", "tools/voxel.ts", "import"]);
    if (rc !== 0) return rc;
  }
  // Every verdict re-cooks: a stale pak is the one failure that looks like
  // an engine bug (the tools/mon.ts lesson).
  const cook = await run(["bun", "voxelmon/cook/cli.ts"]);
  if (cook !== 0) return cook;
  for (const tape of TAPES) {
    const rc = await run([
      "bun",
      "voxelmon/game/sim/cli.ts",
      "--tape",
      `voxelmon/tapes/${tape}.tape`,
      "--out",
      trace(tape),
      "--seed",
      STORY_SEED,
    ]);
    if (rc !== 0) return rc;
  }
  return 0;
}

/** Import when needed, then always recook the ROM-derived runtime pak. */
async function preparePak(): Promise<number> {
  if (!(await Bun.file(`${ROOT}dist/voxelmon/gen/maps.json`).exists())) {
    const rc = await run(["bun", "tools/voxel.ts", "import"]);
    if (rc !== 0) return rc;
  }
  return await run(["bun", "voxelmon/cook/cli.ts"]);
}

async function rasterize(tape: string, tier: string, extra: string[]): Promise<number> {
  return await run(
    [
      "cargo",
      "run",
      "--release",
      "-q",
      "-p",
      "pocketvoxel-sim",
      "--",
      PAK,
      "--trace",
      trace(tape),
      "--quality",
      tier,
      ...extra,
    ],
    ROOT,
  );
}

const GAME_JS = "dist/voxelmon/game.js";
const EBOOT_DIR = "crates/pocketvoxel-psp";

/** Bundle the QuickJS guest (voxelmon/game/psp-main.ts). iife/browser:
 * no module system, no Bun/node — the graph is transport-clean by design. */
async function bundleGuest(): Promise<number> {
  return await run([
    "bun",
    "build",
    "voxelmon/game/psp-main.ts",
    "--outfile",
    GAME_JS,
    "--format=iife",
    "--target=browser",
    "--minify-syntax",
  ]);
}

/**
 * Build the EBOOT via the pinned toolchain (the tools/mon.ts recipe), then
 * re-pack the PBP with MEMSIZE=1 — cargo-psp's Psp.toml has no field for
 * it, and without the flag a PSP only grants the 24 MB user partition the
 * 21 MB pak + QuickJS heap cannot share (PPSSPP honors MEMSIZE from the
 * PBP's PARAM.SFO; headless runs as a slim). Copies the pak next to the
 * EBOOT (host0:/voxelmon.vxpak — PPSSPP maps the EBOOT's own directory).
 */
async function buildEboot(cargoArgs: string[]): Promise<number> {
  let toolchain: ReturnType<typeof resolvePspBuildToolchain>;
  try {
    toolchain = resolvePspBuildToolchain();
  } catch (error) {
    console.error(String((error as Error).message ?? error));
    return 1;
  }
  const sdk = toolchain.sdk.path;
  const llvm = toolchain.llvmBin;
  const ebootDir = `${ROOT}${EBOOT_DIR}`;
  const sourceRoot = ROOT.replace(/\/$/, "");
  const sourceHome = process.env.HOME ?? ROOT;
  const pathRemaps = [
    `--remap-path-prefix=${sourceHome}=/source/home`,
    `--remap-path-prefix=${sourceRoot}=/source/pocket-voxel`,
  ];
  const cPathRemap = [
    `-ffile-prefix-map=${sourceHome}=/source/home`,
    `-fmacro-prefix-map=${sourceHome}=/source/home`,
    `-ffile-prefix-map=${sourceRoot}=/source/pocket-voxel`,
    `-fmacro-prefix-map=${sourceRoot}=/source/pocket-voxel`,
  ].join(" ");

  const env: Record<string, string | undefined> = {
    ...toolchain.environment,
    // newlib (QuickJS needs -lc) and rust-psp both define memcpy/_exit/…
    // with identical semantics; whichever the linker sees first wins.
    RUSTFLAGS: [
      process.env.RUSTFLAGS ?? "",
      ...pathRemaps,
      "-A linker-messages -C link-arg=--allow-multiple-definition",
    ]
      .filter(Boolean)
      .join(" "),
    CRATE_CC_NO_DEFAULTS: "1",
    TARGET_CC: "clang",
    TARGET_AR: `${llvm}/llvm-ar`,
    TARGET_CFLAGS:
      `-target mipsel-sony-psp -mcpu=mips2 -msingle-float -mlittle-endian -mno-abicalls ` +
      `-fno-pic -G0 -mno-check-zero-division -fno-stack-protector ` +
      `-I${sdk}/psp/include -I${sdk}/psp/sdk/include ${cPathRemap}`,
    AR_mipsel_sony_psp: `${llvm}/llvm-ar`,
    RANLIB_mipsel_sony_psp: `${llvm}/llvm-ranlib`,
    RUST_PSP_TARGET: `${ROOT}vendor/pocketjs/hosts/psp/targets/mipsel-sony-psp.json`,
    RUST_PSP_ABORT_ONLY: "1",
    // opt-level 0 is unusably slow on a 333 MHz console, even in dev.
    CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "3",
    // The bundled guest, baked by pocketvoxel-psp/build.rs.
    VOXELMON_JS: `${ROOT}${GAME_JS}`,
    // Capture-build inputs (read under --features capture; set
    // unconditionally so a stale value cannot linger in the fingerprint).
    VOXEL_CAP_INPUT: process.env.VOXEL_CAP_INPUT ?? "",
    VOXEL_CAP_MARKS: process.env.VOXEL_CAP_MARKS ?? "",
    // pocketjs-psp's build.rs runs as a dependency; pin its knobs inert.
    POCKETJS_CAPTURE_INPUT: "",
    POCKETJS_TRACE: "",
    POCKETJS_CAP_START: "",
    POCKETJS_CAP_N: "",
    POCKETJS_ARENA_BYTES: process.env.POCKETJS_ARENA_BYTES ?? "",
    POCKETJS_BENCH_DUMP_FRAMES: "",
  };

  console.log("voxel psp: cargo psp");
  const rc = await run(
    [toolchain.rustup, "run", toolchain.manifest.rust.toolchain, "cargo", "psp", ...cargoArgs],
    ebootDir,
    env,
  );
  if (rc !== 0) return rc;

  const profile = cargoArgs.includes("--release") ? "release" : "debug";
  const outDir = `${ebootDir}/target/mipsel-sony-psp/${profile}`;
  // Some cargo-psp layouts name the PBP after the bin; normalize.
  const named = `${outDir}/pocketvoxel-psp.EBOOT.PBP`;
  if (existsSync(named) && !existsSync(`${outDir}/EBOOT.PBP`)) {
    await Bun.write(`${outDir}/EBOOT.PBP`, Bun.file(named));
  }
  const prx = `${outDir}/pocketvoxel-psp.prx`;
  if (!existsSync(`${outDir}/EBOOT.PBP`) || !existsSync(prx)) {
    console.error(`voxel psp: no EBOOT.PBP/prx under ${outDir}`);
    return 1;
  }

  // MEMSIZE=1 re-pack (see docstring). The pinned mksfo whitelists SFO keys
  // and rejects MEMSIZE, so the SFO is written here (same layout, same
  // defaults, plus the one dword); pack-pbp comes from the pinned cargo-psp
  // tool cache already on toolchain.environment's PATH.
  const sfo = `${outDir}/PARAM.SFO`;
  await Bun.write(
    sfo,
    buildSfo([
      ["BOOTABLE", 1],
      ["CATEGORY", "MG"],
      ["DISC_ID", "PVXL00001"],
      ["DISC_VERSION", "1.00"],
      ["MEMSIZE", 1], // full PSP-2000 memory: the 21 MB pak needs it
      ["PARENTAL_LEVEL", 1],
      ["PSP_SYSTEM_VER", "1.00"],
      ["REGION", 0x8000],
      ["TITLE", "VOXELMON"],
    ]),
  );
  // The XMB cover art rides through this repack too — passing NULL for the
  // icon slots (as the first version did) silently dropped what cargo-psp
  // had just packed, leaving a blank tile on the console.
  const asset = (name: string) => {
    const p = `${ebootDir}/assets/${name}`;
    return existsSync(p) ? p : "NULL";
  };
  const packRc = await run(
    [
      "pack-pbp",
      `${outDir}/EBOOT.PBP`,
      sfo,
      asset("ICON0.png"),
      "NULL", // ICON1.PMF (animated icon)
      "NULL", // PIC0.PNG
      asset("PIC1.png"),
      "NULL", // SND0.AT3
      prx,
      "NULL",
    ],
    outDir,
    env,
  );
  if (packRc !== 0) return packRc;

  // The pak rides next to the EBOOT (never include_bytes! — 21 MB).
  await Bun.write(`${outDir}/voxelmon.vxpak`, Bun.file(`${ROOT}${PAK}`));
  console.log(`voxel psp: ${outDir}/EBOOT.PBP`);
  return 0;
}

const VPK_DIR = "crates/pocketvoxel-vita";

/**
 * Build the VPK. Unlike the PSP path there is no MEMSIZE repack and no
 * separate pak deployment: the pak rides INSIDE the VPK (`app0:` at
 * runtime), so installing the one file in VitaShell is the whole install.
 *
 * The pinned nightly comes from the vendored Vita host's own
 * `rust-toolchain.toml` — one source for the toolchain both this VPK and
 * PocketJS's build against, so they cannot drift into two nightlies.
 */
async function buildVpk(cargoArgs: string[], tier: string): Promise<number> {
  const home = process.env.HOME ?? "";
  const sourceRoot = ROOT.replace(/\/$/, "");
  const sourceHome = home || sourceRoot;
  const vitasdk = process.env.VITASDK || `${home}/vitasdk`;
  if (!existsSync(`${vitasdk}/bin/arm-vita-eabi-gcc`)) {
    console.error(`voxel vita: incomplete VitaSDK at ${vitasdk} (set VITASDK)`);
    return 1;
  }
  const rustup = Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) {
    console.error("voxel vita: rustup not found (expected ~/.cargo/bin/rustup)");
    return 1;
  }
  const toolchainFile = `${ROOT}vendor/pocketjs/hosts/vita/rust-toolchain.toml`;
  const channel = readFileSync(toolchainFile, "utf8").match(
    /channel\s*=\s*"([^"]+)"/,
  )?.[1];
  if (!channel) {
    console.error(`voxel vita: no toolchain channel in ${toolchainFile}`);
    return 1;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    // cargo-vita probes `rustc` from PATH even when cargo itself was launched
    // through `rustup run`; keep the shim ahead of any Homebrew stable Rust,
    // and expose the VitaSDK tools without requiring shell dotfiles.
    PATH: `${vitasdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
    VITASDK: vitasdk,
    RUSTFLAGS: [
      process.env.RUSTFLAGS ?? "",
      `--remap-path-prefix=${sourceHome}=/source/home`,
      `--remap-path-prefix=${sourceRoot}=/source/pocket-voxel`,
    ].filter(Boolean).join(" "),
    TARGET_CC: "arm-vita-eabi-gcc",
    CC_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-gcc",
    TARGET_CXX: "arm-vita-eabi-g++",
    CXX_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-g++",
    TARGET_AR: "arm-vita-eabi-ar",
    AR_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-ar",
    CFLAGS_armv7_sony_vita_newlibeabihf: [
      `-ffile-prefix-map=${sourceHome}=/source/home`,
      `-fmacro-prefix-map=${sourceHome}=/source/home`,
      `-ffile-prefix-map=${sourceRoot}=/source/pocket-voxel`,
      `-fmacro-prefix-map=${sourceRoot}=/source/pocket-voxel`,
    ].join(" "),
    // The bundled guest and the rung, baked by pocketvoxel-vita/build.rs.
    VOXELMON_JS: `${ROOT}${GAME_JS}`,
    VOXELMON_TIER: tier,
  };

  console.log(`voxel vita: cargo vita build vpk (tier=${tier})`);
  const rc = await run(
    [rustup, "run", channel, "cargo", "vita", "build", "vpk", ...cargoArgs],
    `${ROOT}${VPK_DIR}`,
    env,
  );
  if (rc !== 0) return rc;

  const profile = cargoArgs.includes("--release") || cargoArgs.includes("-r")
    ? "release"
    : "debug";
  const outDir = `${ROOT}${VPK_DIR}/target/armv7-sony-vita-newlibeabihf/${profile}`;
  const eboot = `${outDir}/pocketvoxel-vita.self`;
  const sfo = `${outDir}/pocketvoxel-vita.sfo`;
  if (!existsSync(eboot) || !existsSync(sfo)) {
    console.error(`voxel vita: no .self/.sfo under ${outDir}`);
    return 1;
  }

  // The pak is a VPK asset, not an embedded array: `packageVitaVpk` overlays
  // an application tree onto the framework's LiveArea defaults, so staging
  // is one hard link (a 32 MB copy per build would dominate the build).
  const staged = `${ROOT}dist/voxelmon/vita-assets`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  const pakSource = `${ROOT}${PAK}`;
  if (!existsSync(pakSource)) {
    console.error(`voxel vita: no pak at ${pakSource}`);
    return 1;
  }
  try {
    linkSync(pakSource, `${staged}/voxelmon.vxpak`);
  } catch {
    await Bun.write(`${staged}/voxelmon.vxpak`, Bun.file(pakSource));
  }

  const vpk = `${ROOT}dist/voxelmon/voxelmon.vpk`;
  await packageVitaVpk({
    tool: `${vitasdk}/bin/vita-pack-vpk`,
    sfo,
    eboot,
    output: vpk,
    applicationAssets: staged,
  });
  console.log(`voxel vita: ${vpk}`);
  console.log(
    "voxel vita: copy it to the Vita over VitaShell (SELECT starts USB/FTP), " +
      "press X on the file, confirm the install prompt.",
  );
  return 0;
}

const CARDPUTER_TARGET = "aarch64-unknown-linux-gnu.2.36";
const CARDPUTER_TARGET_DIR = "aarch64-unknown-linux-gnu";

/** Build and optionally install the native Cardputer Zero host. */
async function buildCardputer(install: boolean): Promise<number> {
  const home = process.env.HOME ?? "";
  const rustupCargo = `${home}/.cargo/bin/cargo`;
  if (!home || !existsSync(rustupCargo)) {
    console.error("voxel cardputer: rustup cargo not found under ~/.cargo/bin");
    return 1;
  }
  if (!Bun.which("cargo-zigbuild") && !existsSync(`${home}/.cargo/bin/cargo-zigbuild`)) {
    console.error("voxel cardputer: cargo-zigbuild is required (cargo install cargo-zigbuild)");
    return 1;
  }
  const env = {
    ...process.env,
    // Keep rustup's cargo/rustc shims ahead of Homebrew Rust. The target
    // stdlib belongs to the rustup toolchain (`rustup target add ...`).
    PATH: `${home}/.cargo/bin:${process.env.PATH ?? ""}`,
  };
  console.log(`voxel cardputer: cargo zigbuild --target ${CARDPUTER_TARGET}`);
  const built = await run(
    [
      rustupCargo,
      "+stable",
      "zigbuild",
      "-p",
      "pocketvoxel-cardputer",
      "--release",
      "--target",
      CARDPUTER_TARGET,
    ],
    ROOT,
    env,
  );
  if (built !== 0) return built;

  const source = `${ROOT}target/${CARDPUTER_TARGET_DIR}/release/pocketvoxel-cardputer`;
  if (!existsSync(source)) {
    console.error(`voxel cardputer: no binary at ${source}`);
    return 1;
  }
  const out = `${ROOT}dist/cardputer`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(source, `${out}/pocketvoxel-cardputer`);
  chmodSync(`${out}/pocketvoxel-cardputer`, 0o755);
  copyFileSync(`${ROOT}${GAME_JS}`, `${out}/game.js`);
  copyFileSync(`${ROOT}${PAK}`, `${out}/voxelmon.vxpak`);
  copyFileSync(
    `${ROOT}crates/pocketvoxel-cardputer/assets/pocket-voxel.desktop`,
    `${out}/pocket-voxel.desktop`,
  );
  copyFileSync(
    `${ROOT}crates/pocketvoxel-cardputer/assets/pocket-voxel.png`,
    `${out}/pocket-voxel.png`,
  );
  console.log(`voxel cardputer: ${out}`);
  if (!install) return 0;

  const adb = Bun.which("adb");
  if (!adb) {
    console.error("voxel cardputer: adb not found");
    return 1;
  }
  const probe = Bun.spawnSync(
    [
      adb,
      "shell",
      "cat /sys/class/graphics/fb0/virtual_size; cat /sys/class/graphics/fb0/bits_per_pixel; uname -m",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const identity = probe.stdout.toString().trim().split(/\s+/);
  if (probe.exitCode !== 0 || identity.join(" ") !== "320,170 16 aarch64") {
    console.error(
      `voxel cardputer: connected target is not the 320x170 RGB565 aarch64 device (${identity.join(" ") || "no response"})`,
    );
    return 1;
  }
  const remote = "/tmp/pocket-voxel-install";
  let rc = await run([adb, "shell", `rm -rf ${remote} && mkdir -p ${remote}`]);
  if (rc !== 0) return rc;
  rc = await run([adb, "push", `${out}/.`, `${remote}/`]);
  if (rc !== 0) return rc;
  rc = await run([
    adb,
    "shell",
    [
      "install -d -m 755 /usr/share/pocket-voxel",
      `install -m 755 ${remote}/pocketvoxel-cardputer /usr/share/pocket-voxel/pocketvoxel-cardputer`,
      `install -m 644 ${remote}/game.js /usr/share/pocket-voxel/game.js`,
      `install -m 644 ${remote}/voxelmon.vxpak /usr/share/pocket-voxel/voxelmon.vxpak`,
      `install -m 644 ${remote}/pocket-voxel.desktop /usr/share/APPLaunch/applications/pocket-voxel.desktop`,
      `install -m 644 ${remote}/pocket-voxel.png /usr/share/APPLaunch/share/images/pocket-voxel.png`,
      "runuser -u pi -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart APPLaunch.service",
      `rm -rf ${remote}`,
    ].join(" && "),
  ]);
  if (rc !== 0) return rc;
  console.log("voxel cardputer: installed; Pocket Voxel is available in APPLaunch");
  return 0;
}

/**
 * A PARAM.SFO: the exact layout cargo-psp's mksfo writes (20-byte header,
 * 16-byte index entries, key blob, 4-aligned value blob), keys pre-sorted
 * by the caller. Strings are NUL-terminated utf8 (type 2), numbers are
 * dwords (type 4).
 */
function buildSfo(entries: [string, string | number][]): Uint8Array {
  const enc = new TextEncoder();
  const index = new Uint8Array(entries.length * 16);
  const keys: number[] = [];
  const values: number[] = [];
  for (const [i, [key, value]] of entries.entries()) {
    const keyOffset = keys.length;
    keys.push(...enc.encode(key), 0);
    const dataOffset = values.length;
    let type: number;
    let valSize: number;
    let totalSize: number;
    if (typeof value === "number") {
      type = 4;
      valSize = 4;
      totalSize = 4;
      values.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    } else {
      type = 2;
      const bytes = enc.encode(value);
      valSize = bytes.length + 1;
      totalSize = (valSize + 3) & ~3;
      values.push(...bytes);
      for (let p = bytes.length; p < totalSize; p++) values.push(0);
    }
    const view = new DataView(index.buffer, i * 16, 16);
    view.setUint16(0, keyOffset, true);
    view.setUint8(2, 4); // alignment
    view.setUint8(3, type);
    view.setUint32(4, valSize, true);
    view.setUint32(8, totalSize, true);
    view.setUint32(12, dataOffset, true);
  }
  const keyStart = 20 + index.length;
  const valStart = (keyStart + keys.length + 3) & ~3;
  const out = new Uint8Array(valStart + values.length);
  const head = new DataView(out.buffer, 0, 20);
  head.setUint32(0, 0x46535000, true); // "\0PSF"
  head.setUint32(4, 0x00000101, true);
  head.setUint32(8, keyStart, true);
  head.setUint32(12, valStart, true);
  head.setUint32(16, entries.length, true);
  out.set(index, 20);
  out.set(Uint8Array.from(keys), keyStart);
  out.set(Uint8Array.from(values), valStart);
  return out;
}

/**
 * Replay every tape at one rung and compare against that rung's committed
 * hashes. `max` is the ladder's regression anchor: those hashes were recorded
 * before the ladder existed, so a mismatch there says the top rung stopped
 * being the identity — the message says so, because the wrong fix is
 * obvious and cheap and the right one is not.
 */
async function assertGoldens(tier: "shipped" | "max"): Promise<number> {
  const quality = tier === "max" ? MAX_TIER : SHIPPED_TIER;
  let bad = 0;
  for (const tape of TAPES) {
    const path = goldens(tape, tier);
    if (!(await Bun.file(`${ROOT}${path}`).exists())) {
      console.error(`voxel check: no goldens at ${path} — run: bun tools/voxel.ts record`);
      return 1;
    }
    const rc = await rasterize(tape, quality, ["--hashes", path, "--assert"]);
    if (rc !== 0) {
      bad = rc;
      console.error(
        tier === "max"
          ? `voxel check: ${tape} does not match ${path} at the ${quality} tier — the ladder's TOP RUNG IS NO LONGER THE IDENTITY. Fix the dials, never re-record this file.`
          : `voxel check: ${tape} does not match ${path} at the ${quality} tier`,
      );
    }
  }
  return bad;
}

async function launchPpsspp(profile: string): Promise<number> {
  const eboot = `${ROOT}${EBOOT_DIR}/target/mipsel-sony-psp/${profile}/EBOOT.PBP`;
  if (!existsSync(eboot)) {
    console.error(`voxel run: no EBOOT at ${eboot}`);
    return 1;
  }
  return await run(["open", "-a", "PPSSPPSDL", eboot]);
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "psp" || command === "run") {
    const cargoArgs = process.argv.slice(3);
    const prep = await preparePakAndTrace();
    if (prep !== 0) return prep;
    const bundle = await bundleGuest();
    if (bundle !== 0) return bundle;
    const built = await buildEboot(cargoArgs);
    if (built !== 0) return built;
    if (command === "run") {
      return await launchPpsspp(cargoArgs.includes("--release") ? "release" : "debug");
    }
    return 0;
  }
  if (command === "vita") {
    const tier = arg("tier") ?? "vita";
    const cargoArgs = process.argv
      .slice(3)
      .filter((a, i, all) => a !== "--tier" && all[i - 1] !== "--tier");
    const prep = await preparePakAndTrace();
    if (prep !== 0) return prep;
    const bundle = await bundleGuest();
    if (bundle !== 0) return bundle;
    return await buildVpk(cargoArgs, tier);
  }
  if (command === "cardputer") {
    const unexpected = process.argv.slice(3).filter((value) => value !== "--install");
    if (unexpected.length > 0) {
      console.error(`voxel cardputer: unknown arguments ${unexpected.join(" ")}`);
      return 1;
    }
    const prep = await preparePak();
    if (prep !== 0) return prep;
    const bundle = await bundleGuest();
    if (bundle !== 0) return bundle;
    return await buildCardputer(process.argv.includes("--install"));
  }
  if (command === "wav") {
    return await run(["bun", "voxelmon/game/audio/wav.ts", ...process.argv.slice(3)]);
  }
  if (command === "cook") {
    return await run(["bun", "voxelmon/cook/cli.ts", ...process.argv.slice(3)]);
  }
  if (command === "sim") {
    return await run([
      "bun",
      "voxelmon/game/sim/cli.ts",
      "--tape",
      "voxelmon/tapes/story.tape",
      "--out",
      trace("story"),
      "--seed",
      STORY_SEED,
      ...process.argv.slice(3),
    ]);
  }
  if (command === "check" || command === "record" || command === "shots") {
    const prep = await preparePakAndTrace();
    if (prep !== 0) return prep;
    if (command === "shots") {
      // Shots are the reading material for a rung's visual verdict, so they
      // are written per rung: `--tier <name>` picks one, default both.
      const only = arg("tier");
      for (const tier of only ? [only] : [SHIPPED_TIER, MAX_TIER]) {
        for (const tape of TAPES) {
          const rc = await rasterize(tape, tier, [
            "--shots",
            `dist/voxelmon/shots-${tape}-${tier}`,
          ]);
          if (rc !== 0) return rc;
        }
      }
      return 0;
    }
    if (command === "record") {
      for (const tape of TAPES) {
        const rc = await rasterize(tape, SHIPPED_TIER, [
          "--hashes",
          goldens(tape, "shipped"),
        ]);
        if (rc !== 0) return rc;
        console.log(`voxel record: wrote ${goldens(tape, "shipped")} (${SHIPPED_TIER} tier)`);
      }
      // The identity goldens are never rewritten, only re-proved.
      return await assertGoldens("max");
    }
    const shipped = await assertGoldens("shipped");
    const max = await assertGoldens("max");
    return shipped || max;
  }
  const env = resolveEnv();
  if (command === "import") {
    const reason = missingInputReason(env);
    if (reason) {
      console.error(`voxel import: skipped — ${reason}`);
      return 1;
    }
    try {
      await runImport(env);
    } catch (error) {
      console.error(`voxel import: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
    return 0;
  }
  if (command === "parity") {
    return await runParity(env);
  }
  console.error(`voxel: unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

process.exit(await main());
