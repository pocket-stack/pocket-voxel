// tools/voxel-3ds.ts — build Pocket Voxel for the Nintendo 3DS.
//
//   bun tools/voxel-3ds.ts                  the playable .3dsx
//   bun tools/voxel-3ds.ts --capture        the deterministic e2e binary
//   bun tools/voxel-3ds.ts --arena-mib 8 --texture-mib 16
//
// The toolchain spans two environments, exactly as the PocketJS 3DS host's
// does. The Rust half compiles on macOS: armv6k-nintendo-3ds is a built-in
// rustc target, so -Z build-std works host-side with no devkitARM present.
// The C half compiles inside the devkitpro/devkitarm container, which owns
// arm-none-eabi-gcc, libctru, citro3d, picasso, smdhtool and 3dsxtool. Both
// halves see this repository through one bind mount at /repo.
//
//   1. bun build            -> dist/voxelmon/game.js          (the guest)
//   2. cargo build          -> crates/pocketvoxel-3ds/target/…/
//                              libpocketvoxel_3ds.a            (macOS)
//   3. QuickJS              -> dist/3ds/quickjs/libquickjs.a   (container, cached)
//   4. hosts/3ds/Makefile   -> dist/3ds/voxelmon.3dsx          (container)
//
// dist/ is git-ignored, which is where every ROM-derived byte stays: the pak,
// the guest bundle and the .3dsx all live there and none of them ever
// commits.
//
// ---------------------------------------------------------------------------
// The contract with hosts/3ds/Makefile
// ---------------------------------------------------------------------------
// The Makefile runs in the container with CWD /repo/hosts/3ds and receives
// every path as a container path. The variables it reads are listed at the top
// of that file; this command is their only writer.
//
// The capture window travels INSIDE the binary. `--capture` extracts the tape
// and the mark ticks from a recorded .vtrace — every `t <tick> <buttons>`
// transition becomes one threshold entry, every `m <name>` line contributes
// its tick — the same derivation tests/e2e/voxel-ppsspp.ts performs for the
// PSP EBOOT, so both consoles replay one recorded run.

import { $ } from "bun";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const repository = new URL("..", import.meta.url).pathname; // pocket-voxel/
const hostDirectory = `${repository}hosts/3ds/`;
const picaIncludeDirectory = `${repository}crates/pocketvoxel-pica/include/`;
/** The app crate: the pak, the Scene, the VOX_OP table and draw::build. */
const appCrateDirectory = `${repository}crates/pocketvoxel-3ds/`;

const RUST_TARGET = "armv6k-nintendo-3ds";
/** Produced by the `pocketvoxel-3ds` staticlib crate. */
const APP_STATIC_LIBRARY = "libpocketvoxel_3ds.a";
const CONTAINER_IMAGE = "devkitpro/devkitarm:latest";
const CONTAINER_REPOSITORY = "/repo";

/** The guest entry. It needs only `globalThis.voxel`, so the PSP's entry file
 * is this console's too — one bundle, both hosts. */
const GUEST_ENTRY = "voxelmon/game/psp-main.ts";
const GUEST_BUNDLE = "dist/voxelmon/game.js";
const PAK = "dist/voxelmon/voxelmon.vxpak";
const DEFAULT_TRACE = "dist/voxelmon/trace/story.vtrace";

// The QuickJS revision crates/pocketvoxel-psp/Cargo.toml pins, unpacked by
// cargo into the git checkout cache. libquickjs-sys's build.rs is bypassed: it
// would need the `cc` crate to find a 3DS-capable compiler on macOS, and there
// is none.
const QUICKJS_CHECKOUT =
  ".cargo/git/checkouts/quickjs-rs-1bf011a924d415f9/ba5bdd0/libquickjs-sys/embed/quickjs";
const QUICKJS_SOURCES = [
  "quickjs.c",
  "cutils.c",
  "libregexp.c",
  "libunicode.c",
  "dtoa.c",
] as const;
const QUICKJS_HEADERS = [
  "cutils.h",
  "dtoa.h",
  "libregexp-opcode.h",
  "libregexp.h",
  "libunicode-table.h",
  "libunicode.h",
  "list.h",
  "quickjs-atom.h",
  "quickjs-opcode.h",
  "quickjs.h",
] as const;

/** The devkitARM ABI, published by the toolchain itself in 3dsvars.sh. */
const ARM_ARCHITECTURE_FLAGS = [
  "-march=armv6k",
  "-mtune=mpcore",
  "-mfloat-abi=hard",
  "-mtp=soft",
  "-mword-relocations",
  "-ffunction-sections",
  "-fdata-sections",
];

// Verified to build a 1.3 MB libquickjs.a exporting 181 JS_* symbols.
// JS_NO_NAN_BOXING matches libquickjs-sys's own Vita treatment (16-byte
// JSValue on 32-bit ARM). __TM_GMTOFF is how newlib gates struct tm's
// tm_gmtoff, which js_date_getTimezoneOffset reads on every target that is
// neither __PSP__ nor __vita__ — and those two macros are why malloc.h has to
// be force-included here rather than by quickjs.c itself. devkitARM ships GCC
// 16, which promoted incompatible pointer types to errors; this is the same
// source that builds for the PSP.
const QUICKJS_COMPILE_FLAGS = [
  ...ARM_ARCHITECTURE_FLAGS,
  "-O2",
  "-D__3DS__",
  "-DCONFIG_VERSION='\"pocketvoxel3ds\"'",
  "-D_GNU_SOURCE",
  "-DJS_NO_NAN_BOXING",
  "-D__TM_GMTOFF=tm_gmtoff",
  "-include",
  "malloc.h",
  "-fno-strict-aliasing",
  "-funsigned-char",
  "-Wno-incompatible-pointer-types",
  "-Wno-implicit-function-declaration",
  "-I.",
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface VoxelThreeDsArguments {
  readonly capture: boolean;
  readonly skipBundle: boolean;
  readonly tracePath: string;
  readonly packageDir: string;
  /** Memory knobs, forwarded to the Makefile as -D values. */
  readonly arenaMib: number;
  readonly arenaBanks: number;
  readonly textureMib: number;
  readonly heapMib: number;
  readonly linearMib: number;
  /** Everything unrecognized, forwarded to cargo. */
  readonly cargoArgs: readonly string[];
}

const USAGE =
  "usage: bun tools/voxel-3ds.ts [--capture] [--trace <path>] [--skip-bundle] " +
  "[--package-outdir <dir>] [--arena-mib N] [--banks N] [--texture-mib N] " +
  "[--heap-mib N] [--linear-mib N] [cargo args…]";

function numberFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`voxel 3ds: --${name} needs a non-negative number`);
  }
  return value;
}

function stringFlag(
  argv: readonly string[],
  name: string,
  fallback: string,
): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export function parseVoxelThreeDsArguments(
  argv: readonly string[],
): VoxelThreeDsArguments {
  const valued = new Set([
    "trace",
    "package-outdir",
    "arena-mib",
    "banks",
    "texture-mib",
    "heap-mib",
    "linear-mib",
  ]);
  const cargoArgs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--capture" || a === "--skip-bundle") continue;
    if (a.startsWith("--") && valued.has(a.slice(2))) {
      i += 1;
      continue;
    }
    cargoArgs.push(a);
  }
  return {
    capture: argv.includes("--capture"),
    skipBundle: argv.includes("--skip-bundle"),
    tracePath: resolvePath(repository, stringFlag(argv, "trace", DEFAULT_TRACE)),
    packageDir: resolvePath(
      repository,
      stringFlag(argv, "package-outdir", "dist/3ds"),
    ),
    // Zero means "the value the crate's own header defines" for the arena pair
    // (12 MiB in two 6 MiB banks, what pocketvoxel-pica was budgeted against)
    // and "libctru's automatic split" for the heap pair. They are knobs
    // because the console revision and the launcher decide how much memory
    // there is to divide, and the answer is a measurement.
    arenaMib: numberFlag(argv, "arena-mib", Number(process.env.PV3DS_HOST_ARENA_MIB ?? 0)),
    arenaBanks: numberFlag(argv, "banks", Number(process.env.PV3DS_HOST_ARENA_BANKS ?? 0)),
    textureMib: numberFlag(argv, "texture-mib", Number(process.env.PV3DS_HOST_TEXTURE_MIB ?? 14)),
    heapMib: numberFlag(argv, "heap-mib", Number(process.env.PV3DS_HOST_HEAP_MIB ?? 0)),
    linearMib: numberFlag(argv, "linear-mib", Number(process.env.PV3DS_HOST_LINEAR_MIB ?? 0)),
    cargoArgs,
  };
}

// ---------------------------------------------------------------------------
// Container plumbing
// ---------------------------------------------------------------------------

interface Mount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/** Translate a macOS path into the container path it is mounted at. Longest
 * mount wins so a nested output directory maps through its own mount. */
export function containerPathFor(hostPath: string, mounts: readonly Mount[]): string {
  const absolute = resolvePath(hostPath);
  const candidates = [...mounts].sort(
    (a, b) => resolvePath(b.hostPath).length - resolvePath(a.hostPath).length,
  );
  for (const mount of candidates) {
    const base = resolvePath(mount.hostPath);
    if (absolute === base) return mount.containerPath;
    if (absolute.startsWith(`${base}/`)) {
      return `${mount.containerPath}${absolute.slice(base.length)}`;
    }
  }
  throw new Error(
    `voxel 3ds: ${absolute} is outside every container mount ` +
      `(${mounts.map((mount) => resolvePath(mount.hostPath)).join(", ")})`,
  );
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(
  command: string,
  args: readonly string[],
  cwd = repository,
): Promise<CommandResult> {
  const child = Bun.spawn({ cmd: [command, ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** Preamble every container script needs: the tools are not on PATH. */
const CONTAINER_PREAMBLE = [
  "set -euo pipefail",
  'export DEVKITPRO="${DEVKITPRO:-/opt/devkitpro}"',
  'export DEVKITARM="${DEVKITARM:-/opt/devkitpro/devkitARM}"',
  'export PATH="$DEVKITARM/bin:$DEVKITPRO/tools/bin:$PATH"',
].join("\n");

async function runContainer(
  script: string,
  mounts: readonly Mount[],
  workingDirectory: string,
  environment: Readonly<Record<string, string>>,
  label: string,
): Promise<void> {
  const args = ["run", "--rm", "--network=none"];
  for (const mount of mounts) {
    args.push("-v", `${resolvePath(mount.hostPath)}:${mount.containerPath}`);
  }
  args.push("-w", workingDirectory);
  for (const [key, value] of Object.entries(environment)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(CONTAINER_IMAGE, "bash", "-c", `${CONTAINER_PREAMBLE}\n${script}`);
  const child = Bun.spawn({
    cmd: ["docker", ...args],
    cwd: repository,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`voxel 3ds: ${label} failed in ${CONTAINER_IMAGE} (${exitCode})`);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflightContainer(): Promise<string> {
  if (!Bun.which("docker")) {
    throw new Error(
      "voxel 3ds: docker was not found on PATH. The 3DS C toolchain " +
        "(arm-none-eabi-gcc, libctru, citro3d, picasso, 3dsxtool) only exists " +
        "in a container; install Docker Desktop and start it.",
    );
  }
  const daemon = await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      "voxel 3ds: the Docker daemon is not responding — start Docker Desktop and retry.\n" +
        (daemon.stderr.trim() || daemon.stdout.trim()),
    );
  }
  const image = await capture("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    CONTAINER_IMAGE,
  ]);
  if (image.exitCode !== 0) {
    throw new Error(
      `voxel 3ds: the ${CONTAINER_IMAGE} image is not present locally. Run:\n` +
        `  docker pull ${CONTAINER_IMAGE}`,
    );
  }
  return image.stdout.trim();
}

/**
 * The toolchain the app crate builds with. -Z build-std needs a nightly with
 * rust-src, because core and alloc are not shipped precompiled for this
 * target.
 */
async function preflightRust(): Promise<{ rustup: string; toolchain: string }> {
  const rustup = Bun.which("rustup") ?? `${homedir()}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) {
    throw new Error(
      "voxel 3ds: rustup not found (expected ~/.cargo/bin/rustup). Install Rust from https://rustup.rs.",
    );
  }
  let toolchain = "nightly";
  if (existsSync(`${appCrateDirectory}rust-toolchain.toml`)) {
    const active = await capture(rustup, ["show", "active-toolchain"], appCrateDirectory);
    const named = active.stdout.trim().split(/\s+/)[0];
    if (active.exitCode === 0 && named) toolchain = named;
  }
  const rustc = await capture(rustup, ["run", toolchain, "rustc", "--version"]);
  if (rustc.exitCode !== 0) {
    throw new Error(
      `voxel 3ds: the ${toolchain} toolchain is not installed. Run:\n` +
        `  rustup toolchain install ${toolchain}`,
    );
  }
  const components = await capture(rustup, [
    "component",
    "list",
    "--toolchain",
    toolchain,
    "--installed",
  ]);
  if (!components.stdout.split(/\r?\n/).some((line) => line.startsWith("rust-src"))) {
    throw new Error(
      `voxel 3ds: rust-src is required to build core/alloc for ${RUST_TARGET}. Run:\n` +
        `  rustup component add rust-src --toolchain ${toolchain}`,
    );
  }
  return { rustup, toolchain };
}

// ---------------------------------------------------------------------------
// QuickJS
// ---------------------------------------------------------------------------

function quickJsSourceDirectory(): string {
  const pinned = join(homedir(), QUICKJS_CHECKOUT);
  if (existsSync(join(pinned, "quickjs.c"))) return pinned;
  throw new Error(
    `voxel 3ds: the pinned QuickJS sources are absent at ${pinned}. ` +
      "They arrive with the PSP EBOOT's dependencies — run `cargo fetch` in " +
      "crates/pocketvoxel-psp/ and retry.",
  );
}

/**
 * Compile QuickJS for the 3DS in the container and cache the archive. The
 * stamp covers the sources, the flag set and the container image, so a new
 * devkitARM release or an edited flag rebuilds and nothing else does.
 */
export async function ensureQuickJs(
  cacheDirectory: string,
  imageId: string,
  mounts: readonly Mount[],
): Promise<void> {
  const sources = quickJsSourceDirectory();
  const files = [...QUICKJS_SOURCES, ...QUICKJS_HEADERS];
  const digest = createHash("sha256");
  digest.update(imageId);
  digest.update(QUICKJS_COMPILE_FLAGS.join(" "));
  for (const name of files) {
    const path = join(sources, name);
    if (!existsSync(path)) {
      throw new Error(`voxel 3ds: QuickJS source ${name} is missing from ${sources}`);
    }
    digest.update(name);
    digest.update(readFileSync(path));
  }
  const stamp = digest.digest("hex");
  const stampPath = join(cacheDirectory, ".stamp");
  const archive = join(cacheDirectory, "libquickjs.a");
  if (
    existsSync(archive) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp
  ) {
    console.log(`voxel 3ds: QuickJS cached (${archive})`);
    return;
  }

  mkdirSync(cacheDirectory, { recursive: true });
  for (const name of files) copyFileSync(join(sources, name), join(cacheDirectory, name));
  const objects = QUICKJS_SOURCES.map((name) => name.replace(/\.c$/, ".o"));
  const script = [
    "rm -f *.o libquickjs.a",
    `for src in ${QUICKJS_SOURCES.join(" ")}; do`,
    '  echo "cc $src"',
    `  arm-none-eabi-gcc ${QUICKJS_COMPILE_FLAGS.join(" ")} -c "$src" -o "\${src%.c}.o"`,
    "done",
    // D: deterministic archive (zeroed mtime/uid/gid), so the cache stamp and
    // the archive agree run to run.
    `arm-none-eabi-ar rcsD libquickjs.a ${objects.join(" ")}`,
  ].join("\n");
  console.log("voxel 3ds: compiling QuickJS for armv6k-nintendo-3ds …");
  await runContainer(script, mounts, containerPathFor(cacheDirectory, mounts), {}, "QuickJS compile");
  if (!existsSync(archive)) {
    throw new Error(`voxel 3ds: QuickJS compile did not produce ${archive}`);
  }
  writeFileSync(stampPath, `${stamp}\n`);
}

// ---------------------------------------------------------------------------
// The capture tape
// ---------------------------------------------------------------------------

export interface CaptureTape {
  /** "tick:mask,tick:mask" — every button transition, replayed as the last
   * threshold at or before the current tick. */
  readonly input: string;
  /** "tick,tick,…" ascending — the checkpoint ticks, one per `m` line. */
  readonly marks: string;
  readonly markCount: number;
}

/**
 * Derive the console run from a recorded trace, exactly as
 * tests/e2e/voxel-ppsspp.ts derives the PSP EBOOT's.
 *
 * A mark belongs to the tick block it follows, and frame N of the run renders
 * the state after tick N's ops plus Scene::tick — the same state the sim
 * hashes at that mark — so dumping frame N at each mark tick reproduces the
 * rasterizer's checkpoint frames on either console.
 */
export function tapeFromTrace(text: string): CaptureTape {
  const transitions: string[] = [];
  const marks: number[] = [];
  let tick = -1;
  let lastMask = -1;
  for (const line of text.split("\n")) {
    if (line.startsWith("t ")) {
      const [, at, mask] = line.split(" ");
      tick = Number(at);
      const value = Number(mask);
      if (value !== lastMask) {
        transitions.push(`${tick}:${value}`);
        lastMask = value;
      }
    } else if (line.startsWith("m ")) {
      marks.push(tick);
    }
  }
  return { input: transitions.join(","), marks: marks.join(","), markCount: marks.length };
}

function resolveCaptureTape(tracePath: string): CaptureTape {
  // An explicit environment pair wins, so the e2e driver can drive this
  // command with a tape it derived itself.
  const input = process.env.VOXEL_CAP_INPUT;
  const marks = process.env.VOXEL_CAP_MARKS;
  if (input !== undefined && marks !== undefined) {
    return { input, marks, markCount: marks.split(",").filter(Boolean).length };
  }
  if (!existsSync(tracePath)) {
    throw new Error(
      `voxel 3ds: --capture needs a recorded trace and ${tracePath} is absent. Run:\n` +
        "  bun tools/voxel.ts sim\n" +
        "or pass VOXEL_CAP_INPUT and VOXEL_CAP_MARKS directly.",
    );
  }
  const tape = tapeFromTrace(readFileSync(tracePath, "utf8"));
  if (tape.markCount === 0) {
    throw new Error(`voxel 3ds: ${tracePath} has no marks`);
  }
  return tape;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function buildVoxel3ds(argv: readonly string[]): Promise<string> {
  const args = parseVoxelThreeDsArguments(argv);
  if (!existsSync(hostDirectory)) {
    throw new Error(`voxel 3ds: the host is absent at ${hostDirectory}`);
  }
  if (!existsSync(appCrateDirectory)) {
    throw new Error(
      `voxel 3ds: the app crate is absent at ${appCrateDirectory}. It owns the ` +
        "pak, the Scene, the VOX_OP table and draw::build, and publishes them over " +
        "the C ABI in crates/pocketvoxel-3ds/include/pocketvoxel_3ds.h.",
    );
  }
  // libctru only takes its automatic heap split when NEITHER size is
  // overridden, so a lone override leaves the other heap at zero bytes and the
  // app dies before main(). Refuse the half-set pair at build time rather than
  // shipping a binary that cannot boot.
  if ((args.heapMib === 0) !== (args.linearMib === 0)) {
    throw new Error(
      "voxel 3ds: --heap-mib and --linear-mib are set together or not at all. " +
        "libctru's automatic split needs both to be zero; overriding one leaves " +
        "the other heap at zero bytes.",
    );
  }

  const imageId = await preflightContainer();
  const { rustup, toolchain } = await preflightRust();

  const tape = args.capture
    ? resolveCaptureTape(args.tracePath)
    : { input: "", marks: "", markCount: 0 };
  if (args.capture) {
    console.log(
      `voxel 3ds: tape ${tape.input.split(",").filter(Boolean).length} transitions, ` +
        `${tape.markCount} marks`,
    );
  }

  // 1. the guest bundle. iife/browser: no module system, no Bun and no node in
  // the import graph — the same bundle the PSP EBOOT evaluates.
  const guestBundle = join(repository, GUEST_BUNDLE);
  if (!args.skipBundle) {
    console.log(`voxel 3ds: bun build ${GUEST_ENTRY}`);
    mkdirSync(resolvePath(guestBundle, ".."), { recursive: true });
    await $`bun build ${GUEST_ENTRY} --outfile ${GUEST_BUNDLE} --format=iife --target=browser --minify-syntax`
      .cwd(repository);
  }
  const pak = join(repository, PAK);
  for (const artifact of [guestBundle, pak]) {
    if (!existsSync(artifact)) {
      throw new Error(
        `voxel 3ds: ${artifact} is absent. The cooked pak and the guest bundle are ` +
          "ROM-derived and git-ignored; produce them with `bun tools/voxel.ts cook`.",
      );
    }
  }

  // 2. the Rust staticlib, on macOS. The crate's own .cargo/config.toml
  // carries the target and the build-std flags — cargo discovers it by walking
  // up from the working directory — so the whole cross build is one plain
  // command run inside the crate.
  console.log(`voxel 3ds: cargo build --release (${RUST_TARGET}, ${toolchain})`);
  await $`${rustup} run ${toolchain} cargo build --release --locked ${args.cargoArgs}`
    .cwd(appCrateDirectory);
  const releaseDirectory = `${appCrateDirectory}target/${RUST_TARGET}/release`;
  const appLibrary = join(releaseDirectory, APP_STATIC_LIBRARY);
  if (!existsSync(appLibrary)) {
    const found = existsSync(releaseDirectory)
      ? readdirSync(releaseDirectory).filter((name) => name.endsWith(".a"))
      : [];
    throw new Error(
      `voxel 3ds: ${APP_STATIC_LIBRARY} is absent from ${releaseDirectory}` +
        (found.length > 0 ? ` (found ${found.join(", ")})` : "") +
        " — crates/pocketvoxel-3ds must be a staticlib crate named pocketvoxel-3ds",
    );
  }

  // 3-4. everything that needs devkitARM
  const distributionRoot = `${repository}dist/3ds`;
  const quickJsDirectory = join(distributionRoot, "quickjs");
  const buildDirectory = join(distributionRoot, args.capture ? "build-capture" : "build");
  mkdirSync(buildDirectory, { recursive: true });
  mkdirSync(args.packageDir, { recursive: true });

  const mounts: Mount[] = [{ hostPath: repository, containerPath: CONTAINER_REPOSITORY }];
  await ensureQuickJs(quickJsDirectory, imageId, mounts);

  // The capture binary is its own file: a run must never be able to compare a
  // playable build's frames, or a driver's frames against a hand build.
  const output = join(args.packageDir, args.capture ? "voxelmon-capture.3dsx" : "voxelmon.3dsx");
  const makeEnvironment: Record<string, string> = {
    PV3DS_APP_LIB: containerPathFor(appLibrary, mounts),
    PV3DS_APP_INCLUDE: containerPathFor(`${appCrateDirectory}include`, mounts),
    PV3DS_PICA_INCLUDE: containerPathFor(picaIncludeDirectory, mounts),
    PV3DS_QUICKJS_DIR: containerPathFor(quickJsDirectory, mounts),
    PV3DS_GAME_JS: containerPathFor(guestBundle, mounts),
    PV3DS_PAK: containerPathFor(pak, mounts),
    PV3DS_BUILD_DIR: containerPathFor(buildDirectory, mounts),
    PV3DS_OUT_3DSX: containerPathFor(output, mounts),
    PV3DS_SMDH_TITLE: "Pocket Voxel",
    PV3DS_SMDH_AUTHOR: "pocket-voxel",
    PV3DS_SMDH_DESC: "The voxel diorama on the PICA200",
    PV3DS_HOST_ARENA_MIB: String(args.arenaMib),
    PV3DS_HOST_ARENA_BANKS: String(args.arenaBanks),
    PV3DS_HOST_TEXTURE_MIB: String(args.textureMib),
    PV3DS_HOST_HEAP_MIB: String(args.heapMib),
    PV3DS_HOST_LINEAR_MIB: String(args.linearMib),
    PV3DS_CAPTURE: args.capture ? "1" : "",
    // Always explicit, never inherited: an unset variable would let a previous
    // run's tape linger in the object cache behind unchanged source mtimes,
    // and the Makefile's CFLAGS stamp can only notice a value it is given.
    PV3DS_CAPTURE_INPUT: tape.input,
    PV3DS_CAPTURE_MARKS: tape.marks,
  };

  console.log(`voxel 3ds: make (${CONTAINER_IMAGE}${args.capture ? ", capture" : ""})`);
  await runContainer(
    `make -j${availableParallelism()}`,
    mounts,
    containerPathFor(hostDirectory, mounts),
    makeEnvironment,
    "hosts/3ds/Makefile",
  );
  if (!existsSync(output)) {
    throw new Error(`voxel 3ds: the container build did not produce ${output}`);
  }
  console.log(`output: ${output}`);
  return output;
}

if (import.meta.main) {
  try {
    if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
      console.log(USAGE);
      process.exit(0);
    }
    await buildVoxel3ds(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
