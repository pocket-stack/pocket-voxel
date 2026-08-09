// tests/e2e/voxel-3ds.ts — the Pocket Voxel .3dsx under Azahar (PICA200).
//
//   bun run e2e:3ds                 verdict against tests/goldens/voxel/story-3ds.hashes
//   UPDATE_3DS=1 bun run e2e:3ds    re-record that file (after eyeballing the PNGs)
//
// The 3DS sibling of tests/e2e/voxel-ppsspp.ts. The same recorded story tape
// drives the console, the same 11 marks are captured, and the same sim
// rasterizer is the oracle. What differs is the comparison, and §"the
// comparison" below is why.
//
// Asserts, per mark:
//   1. liveness — every mark produced a frame (boot, 32 MB pak parse, QuickJS
//      eval, the whole guest run and the PICA200 pipeline all survived);
//   2. structure — exact byte length, a live 226-row band, flat letterbox
//      bars pinning the crop, and native detail (no doubled 2x2 pixels);
//   3. determinism/regression — FNV-1a64 over the decoded frame equals the
//      committed 3DS golden, byte for byte;
//   4. the oracle gates — mean channel colour and coarse-grid structure agree
//      with the sim rasterizer's frame for the same mark.
//
// Skips (exit 0, printed reason) when Azahar, ImageMagick, the container
// toolchain or the ROM-derived pak/trace are absent — docs/VOXEL.md §1: CI
// never sees ROM-derived bytes. Emulator-bound and GUI-bound; keep it out of
// `bun test` and CI.
//
// PNGs, raw dumps and the .3dsx stay under git-ignored dist/. The only
// committed artifact is a file of hashes.
//
// ---------------------------------------------------------------------------
// The comparison — why this is not the PSP driver's pixel AE
// ---------------------------------------------------------------------------
//
// The pak's camera is 480x272 and pak::read hard-rejects any other META, so
// the 3DS renders that camera into the widest rectangle on its 400x240 top
// screen that keeps the aspect: a 400x226 viewport with 7 px of bar top and
// bottom (crates/pocketvoxel-pica/src/lib.rs const-asserts both numbers). The
// oracle rasterizes the same frustum at 480x272. Comparing them per pixel
// means resampling one side, and the resample injects error before a single
// backend difference is counted.
//
// Measured 2026-08-08 over all 11 story marks, comparing the 400x226 band
// against the oracle resized to 400x226 (90400 pixels), `magick compare
// -metric AE`:
//
//   fuzz   worst 3DS-vs-oracle   floor: the oracle against ITSELF,
//                                round-tripped   resized by another filter
//    2%          62118                49903              61215
//   10%          21066                 1649              15880
//   12%          16957                  568              11724
//
// The floor column is the oracle compared against itself after nothing but a
// trip through the comparison's own grid — no backend, no GPU, no second
// implementation, no difference of any kind to detect. At 2% fuzz (what
// tests/e2e/voxel-ppsspp.ts uses) that floor is 99% of the signal; at 12% it
// is still 69%. A tolerance drawn anywhere in that band would be measuring
// ImageMagick's filter choice, not the PICA200. An earlier measurement of
// ~16000 AE sits exactly there. So: no pixel-AE tolerance against a resampled
// oracle. It would not be a test.
//
// Capturing from an off-screen 480x272 target instead would remove the
// resample entirely and restore a real parity comparison. That needs the
// host's render target and capture path changed (hosts/3ds/src/main.c,
// crates/pocketvoxel-pica), which is not this file's to change; it is the
// follow-up that would buy parity rather than agreement.
//
// What this driver does instead is three separate claims:
//
// 1. REGRESSION AND DETERMINISM — 3DS vs 3DS, byte-exact. FNV-1a64 over the
//    decoded 400x240 RGBA of every mark, committed as hashes. Four full runs —
//    container rebuild included — produced identical hashes for all 11 marks,
//    so any change in the backend, the host, the guest, the pak or the tape
//    moves a hash. This proves the console is reproducible and that nothing in
//    the pipeline has moved since the golden was recorded. It proves NOTHING
//    about parity with the sim rasterizer: a golden is only as right as the
//    picture it was recorded from, which is why gates 2 and 3 also run in
//    UPDATE mode and a failure there refuses to record.
//
//    The hashes belong to graphics_api=0. A capture of the same sources taken
//    under Azahar's Vulkan renderer (graphics_api=2) differed on all 11 marks,
//    which is what the pinned fixture below exists for.
//
// 2. COLOUR — mean R, G and B of the 400x226 band against mean R, G and B of
//    the untouched 480x272 oracle. Neither side is resampled: both are area
//    averages of the same frustum at different sample rates, so this gate has
//    no resampling floor at all. Worst measured disagreement across the 11
//    marks was 1.41 of 255 (viridian, blue). An 8% error in one channel of the
//    day tint moves the same statistic by 7.4 to 14.9, so MEAN_TOLERANCE (3.0)
//    clears every measured mark by 2.1x while still catching any defect that
//    shifts a channel's frame average by more than ~1.2% of full scale —
//    a wrong palette, a missing modulate, a blend or alpha-test change.
//
// 3. STRUCTURE — both sides area-averaged (Box) from their own native size to
//    a common 100x56 grid, then `magick compare -metric AE -fuzz 6%`. Each
//    cell is ~4x4 screen pixels, coarse enough that per-pixel aliasing and
//    texture-filter differences average out and gross composition survives.
//    Measured across the marks: worst 759 of 5600 (route-1), worst resampling
//    floor 136 (the oracle routed through the 400x226 grid before averaging),
//    and the closest wrong-scene proxy — each mark's band against the NEXT
//    mark's oracle — 3571. COARSE_AE_TOLERANCE (1700) is 2.2x the worst
//    measured mark, 12.5x the worst floor and 2.1x below the nearest wrong
//    scene. Catching something subtler than "this is a different picture" is
//    gate 1's job, and gate 1 catches a single changed byte.

import { existsSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { tapeFromTrace } from "../../tools/voxel-3ds.ts";

const root = new URL("../..", import.meta.url).pathname;
const outDir = `${root}dist/e2e-voxel-3ds`;
const oracleDir = `${outDir}/oracle`;
const consoleLog = `${outDir}/azahar-console.log`;

// Azahar derives its whole user directory from $HOME on macOS and has no flag
// for any part of it — CITRA_USER_DIR is in the binary but is a no-op here. A
// fixture $HOME is the only way to give a run its own config and its own SD
// card, and the SD card matters: a shared one lets a previous run's frames
// satisfy the count check.
const fixtureHome = `${outDir}/home`;
const userDir = `${fixtureHome}/Library/Application Support/Azahar`;
const configPath = `${userDir}/config/qt-config.ini`;
/** hosts/3ds/src/main.c writes its capture into sdmc:/pocketvoxel-3ds. */
const capDir = `${userDir}/sdmc/pocketvoxel-3ds`;

const azaharApp = process.env.AZAHAR || "/Applications/Azahar.app";
const azaharBinary = `${azaharApp}/Contents/MacOS/azahar`;
const sourceConfig =
  process.env.AZAHAR_CONFIG ||
  `${homedir()}/Library/Application Support/Azahar/config/qt-config.ini`;
const sourceUserDir = sourceConfig.replace(/\/config\/[^/]+$/, "");

const tape = process.env.E2E_3DS_TAPE ?? "story";
const pak = `${root}dist/voxelmon/voxelmon.vxpak`;
const trace = `${root}dist/voxelmon/trace/${tape}.vtrace`;
/** The sim's own committed hashes, asserted so a gate failure means the 3DS moved. */
const oracleGolden = `${root}tests/goldens/voxel/${tape}.hashes`;
const golden = `${root}tests/goldens/voxel/${tape}-3ds.hashes`;
/** Set to run a .3dsx that is already built (the container build is skipped). */
const prebuilt = process.env.E2E_3DS_3DSX;
const capture3dsx = `${root}dist/3ds/voxelmon-capture.3dsx`;

const update = process.env.UPDATE_3DS === "1";
const TIMEOUT_MS = Number(process.env.E2E_3DS_TIMEOUT_MS ?? 300_000);
/** Azahar reaching the window server at all. A run that never gets this far
 *  has an emulator problem, not a guest problem. */
const LAUNCH_GRACE_MS = 30_000;

// The 3DS top screen in landscape, and the buffer the GX display transfer
// hands back: still in the screen's rotated orientation, 240 wide by 400 tall,
// column-major, each word byte-order A,B,G,R.
const W = 400;
const H = 240;
const FB_W = 240;
const RAW_BYTES = W * H * 4;
// The letterboxed viewport, const-asserted in crates/pocketvoxel-pica/src/lib.rs
// as VIEWPORT_Y == 7 and VIEWPORT_H == 226. Rows outside it carry the sky
// clear and nothing else, which the bar guard below checks rather than assumes.
const BAND_Y = 7;
const BAND_H = 226;

// The oracle gates. Both numbers are measurements; the header states what was
// measured, when, and what each one has to clear.
const MEAN_TOLERANCE = 3.0; // of 255 per channel; worst measured mark 1.41
const COARSE_GRID = "100x56"; // 5600 cells, each ~4x4 screen pixels
const COARSE_FUZZ = "6%";
const COARSE_AE_TOLERANCE = 1700; // of 5600; worst measured mark 759, floor 136

function skip(reason: string): never {
  console.log(`voxel 3ds e2e: SKIP — ${reason}`);
  process.exit(0);
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; quiet?: boolean } = {},
): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd ?? root,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (!opts.quiet && code !== 0) process.stderr.write(out + err);
  return { code, out: out + err };
}

function emulatorRunning(): boolean {
  return (
    Bun.spawnSync(["pgrep", "-f", azaharBinary], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  );
}

/** Azahar ignores SIGTERM, outlives its guest and does not stop when the app
 *  returns from main(), so the driver owns its lifetime on every path — before
 *  the fixture is rebuilt, around the run, and after the verdict. Two
 *  instances share one user directory and corrupt each other's capture. */
function killEmulator(): void {
  Bun.spawnSync(["pkill", "-9", "-f", azaharBinary], { stdout: "ignore", stderr: "ignore" });
}

// ---- skips ----------------------------------------------------------------

if (process.platform !== "darwin") {
  skip("the Azahar driver is macOS-only (it launches the emulator through LaunchServices)");
}
if (!existsSync(azaharBinary)) skip(`Azahar not found at ${azaharApp} (set AZAHAR)`);
if (!existsSync(sourceConfig)) {
  skip(`no Azahar config at ${sourceConfig} (launch Azahar once, or set AZAHAR_CONFIG)`);
}
for (const tool of ["open", "pgrep", "pkill"]) {
  if (!Bun.which(tool)) skip(`${tool} not found (needed to launch and to reap the emulator)`);
}
if (!Bun.which("magick")) skip("ImageMagick `magick` not found (brew install imagemagick)");
if (!prebuilt && !Bun.which("docker")) {
  skip("docker not found — the 3DS C toolchain only exists in devkitpro/devkitarm");
}
if (!existsSync(pak)) skip(`no cooked pak at ${pak} (ROM-derived; run \`bun run cook\`)`);
if (!existsSync(trace)) skip(`no recorded trace at ${trace} (run \`bun tools/voxel.ts sim\`)`);
if (!existsSync(oracleGolden)) skip(`no sim goldens at ${oracleGolden}`);

// ---- 1. the tape and its marks --------------------------------------------
// The tape the console replays is derived here and handed to the build, so the
// driver and the binary provably share one derivation. The names come from the
// same `m` lines and label the goldens and the oracle shots.

interface Mark {
  readonly name: string;
  readonly tick: number;
}

const traceText = readFileSync(trace, "utf8");
const capTape = tapeFromTrace(traceText);
const marks: Mark[] = [];
{
  let tick = -1;
  for (const line of traceText.split("\n")) {
    if (line.startsWith("t ")) tick = Number(line.split(" ")[1]);
    else if (line.startsWith("m ")) marks.push({ name: line.slice(2).trim(), tick });
  }
}
if (marks.length === 0) {
  console.error(`voxel 3ds e2e: ${trace} has no marks`);
  process.exit(1);
}
if (marks.length !== capTape.markCount) {
  console.error(
    `voxel 3ds e2e: ${marks.length} mark names but ${capTape.markCount} mark ticks — ` +
      "the driver and tools/voxel-3ds.ts disagree about the trace",
  );
  process.exit(1);
}
console.log(
  `# tape: ${capTape.input.split(",").filter(Boolean).length} input transitions, ${marks.length} marks`,
);

// ---- 2. the oracle --------------------------------------------------------
// Regenerated every run and asserted against the committed sim hashes: if the
// oracle itself has drifted this fails here, so a gate failure below can only
// mean the 3DS moved.

console.log("# sim rasterizer oracle shots ...");
// A run interrupted with ^C leaves an emulator holding the fixture that is
// about to be deleted, so reap before touching dist/.
killEmulator();
rmSync(outDir, { recursive: true, force: true });
mkdirSync(oracleDir, { recursive: true });
{
  const sim = await run([
    "cargo", "run", "--release", "-q", "-p", "pocketvoxel-sim", "--",
    pak, "--trace", trace, "--shots", oracleDir, "--hashes", oracleGolden, "--assert",
  ]);
  if (sim.code !== 0) {
    console.error(
      `voxel 3ds e2e: the oracle run failed — see above, or ${oracleGolden.replace(root, "")} ` +
        "no longer describes this pak and trace",
    );
    process.exit(1);
  }
}

// ---- 3. the capture .3dsx -------------------------------------------------

const rom = prebuilt ?? capture3dsx;
if (!prebuilt) {
  console.log("# build the capture .3dsx (devkitpro/devkitarm) ...");
  const build = await run(["bun", "tools/voxel-3ds.ts", "--capture"], {
    env: {
      ...process.env,
      VOXEL_CAP_INPUT: capTape.input,
      VOXEL_CAP_MARKS: capTape.marks,
    },
  });
  if (build.code !== 0) process.exit(1);
}
if (!existsSync(rom)) {
  console.error(`voxel 3ds e2e: no capture .3dsx at ${rom}`);
  process.exit(1);
}

// ---- 4. Azahar ------------------------------------------------------------

/** Clone the developer's settings, then pin the keys the capture depends on.
 *  Azahar ignores an override whose sibling `<key>\default=false` line is
 *  missing, so both lines are always written. */
function writeFixture(): void {
  mkdirSync(`${userDir}/config`, { recursive: true });
  mkdirSync(capDir, { recursive: true });
  // The emulated system files, so a fixture $HOME boots the way the
  // developer's install does. The SD card is deliberately not copied.
  for (const directory of ["nand", "sysdata"]) {
    if (existsSync(`${sourceUserDir}/${directory}`)) {
      cpSync(`${sourceUserDir}/${directory}`, `${userDir}/${directory}`, { recursive: true });
    }
  }

  let config = readFileSync(sourceConfig, "utf8");
  const set = (key: string, value: string): void => {
    const assignment = new RegExp(`^${key}=.*$`, "gm");
    if ((config.match(assignment)?.length ?? 0) !== 1) {
      throw new Error(`qt-config.ini does not carry exactly one ${key} key`);
    }
    config = config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
    config = new RegExp(`^${key}\\\\default=.*$`, "m").test(config)
      ? config.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), () => `${key}\\default=false`)
      : config.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}\n${key}\\default=false`);
  };
  // The software rasterizer: the backend that does not depend on the
  // developer's GPU driver, so a byte-exact golden belongs to it.
  set("graphics_api", "0");
  // The capture transfers the render target itself; an internal upscale
  // changes what comes back.
  set("resolution_factor", "1");
  set("use_vsync", "false");
  set("frame_limit", "1000");
  set("use_disk_shader_cache", "false");
  set("check_for_update_on_start", "false");
  writeFileSync(configPath, config);
}

async function runAzahar(): Promise<void> {
  const done = `${capDir}/done`;
  const error = `${capDir}/error.txt`;
  // Stale frames must never be able to satisfy the count check.
  rmSync(capDir, { recursive: true, force: true });
  mkdirSync(capDir, { recursive: true });
  killEmulator();

  // LaunchServices, not a direct exec: launching the binary does not advance
  // the guest — Azahar only runs when it is launched into the user's GUI
  // session. `--env` carries the fixture $HOME across the hand-off, which the
  // launched process does not otherwise inherit, and `-n` refuses to reuse an
  // instance that is already up.
  const launch = Bun.spawnSync(
    ["open", "-n", "-a", azaharApp, "--env", `HOME=${fixtureHome}`,
      "--stdout", consoleLog, "--stderr", consoleLog, "--args", rom],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (launch.exitCode !== 0) {
    throw new Error(`could not launch Azahar: ${launch.stderr.toString().trim()}`);
  }

  const started = Date.now();
  let seenRunning = false;
  try {
    while (Date.now() - started < TIMEOUT_MS) {
      // Four conditions, not one: the guest's failure path, the guest's
      // completion marker, the emulator dying, and the deadline.
      if (existsSync(error)) throw new Error(readFileSync(error, "utf8").trim());
      if (existsSync(done)) return;
      if (emulatorRunning()) seenRunning = true;
      else if (seenRunning) throw new Error("Azahar exited before the guest finished");
      else if (Date.now() - started > LAUNCH_GRACE_MS) throw new Error("Azahar never started");
      await Bun.sleep(100);
    }
    // Azahar's own log flushes on a clean exit only, and the SIGKILL below is
    // never one; the console stream redirected at launch is the diagnostic.
    throw new Error(
      `timed out after ${TIMEOUT_MS} ms without the guest's done marker ` +
        `(see ${consoleLog.replace(root, "")})`,
    );
  } finally {
    killEmulator();
  }
}

console.log("# Azahar (software renderer, per-run fixture $HOME) ...");
try {
  writeFixture();
} catch (error) {
  console.error(`voxel 3ds e2e: could not build the run fixture: ${(error as Error).message}`);
  process.exit(1);
}
try {
  await runAzahar();
} catch (error) {
  console.error(`voxel 3ds e2e: FAIL — ${(error as Error).message}`);
  process.exit(1);
}

const produced = existsSync(capDir)
  ? readdirSync(capDir).filter((f) => /^f\d{4}\.raw$/.test(f)).length
  : 0;
if (produced !== marks.length) {
  console.error(`voxel 3ds e2e: FAIL — dumped ${produced}/${marks.length} marks (see ${consoleLog})`);
  process.exit(1);
}
console.log(`liveness: ${produced}/${marks.length} marks reached on the console`);

// ---- 5. decode + structural guards ----------------------------------------

/** The transferred buffer keeps the screen's rotated orientation: 240 wide by
 *  400 tall, column-major, each word byte-order A,B,G,R. Decoding it as a
 *  plain 400x240 image mismatches every pixel while looking almost right. */
function decodeTopScreen(raw: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(RAW_BYTES);
  for (let x = 0; x < W; x += 1) {
    for (let y = 0; y < H; y += 1) {
      const source = (x * FB_W + (FB_W - 1 - y)) * 4;
      const destination = (y * W + x) * 4;
      rgba[destination] = raw[source + 3]!;
      rgba[destination + 1] = raw[source + 2]!;
      rgba[destination + 2] = raw[source + 1]!;
      rgba[destination + 3] = 255; // the target's own alpha is never presented
    }
  }
  return rgba;
}

/** The same function crates/pocketvoxel-sim/src/fnv.rs applies to its own
 *  frames, over the decoded RGBA, so both golden families read alike. */
function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i += 1) {
    hash = ((hash ^ BigInt(bytes[i]!)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

const packed = (rgba: Uint8Array, x: number, y: number): number => {
  const i = (y * W + x) * 4;
  return (rgba[i]! << 24) | (rgba[i + 1]! << 16) | (rgba[i + 2]! << 8) | rgba[i + 3]!;
};

/** The 7 px bars above and below the viewport carry the sky clear and nothing
 *  else. One colour across all 14 rows proves the letterbox is where
 *  VIEWPORT_Y/VIEWPORT_H say, and row BAND_Y+BAND_H-1 not being that colour
 *  pins the band's bottom edge — together they pin the crop the oracle gates
 *  compare. (The band's TOP row is legitimately the clear colour on marks
 *  whose sky starts there, so only the bottom edge can be checked.) */
function letterboxFault(rgba: Uint8Array): string | null {
  const clear = packed(rgba, 0, 0);
  for (const [from, to] of [[0, BAND_Y], [BAND_Y + BAND_H, H]] as const) {
    for (let y = from; y < to; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (packed(rgba, x, y) !== clear) {
          return `row ${y} is inside the letterbox bar but is not the clear colour`;
        }
      }
    }
  }
  for (let x = 0; x < W; x += 1) {
    if (packed(rgba, x, BAND_Y + BAND_H - 1) !== clear) return null;
  }
  return `row ${BAND_Y + BAND_H - 1} is the clear colour — the 400x${BAND_H} viewport has moved`;
}

/** A frame that is one clear colour records nothing. */
function distinctColours(rgba: Uint8Array, limit: number): number {
  const seen = new Set<number>();
  for (let y = BAND_Y; y < BAND_Y + BAND_H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      seen.add(packed(rgba, x, y));
      if (seen.size >= limit) return seen.size;
    }
  }
  return seen.size;
}

/** Prove the band is the screen's own resolution and not a half-size render
 *  with every pixel doubled (an ignored resolution_factor). */
function hasNativeDetail(rgba: Uint8Array): boolean {
  for (let y = BAND_Y; y + 1 < BAND_Y + BAND_H; y += 2) {
    for (let x = 0; x + 1 < W; x += 2) {
      const at = packed(rgba, x, y);
      if (packed(rgba, x + 1, y) !== at) return true;
      if (packed(rgba, x, y + 1) !== at) return true;
      if (packed(rgba, x + 1, y + 1) !== at) return true;
    }
  }
  return false;
}

// ---- 6. per-mark verdicts -------------------------------------------------

async function meanChannels(image: string): Promise<[number, number, number]> {
  const query = await run(
    ["magick", image, "-alpha", "off", "-format",
      "%[fx:mean.r*255] %[fx:mean.g*255] %[fx:mean.b*255]", "info:"],
    { quiet: true },
  );
  const values = query.out.trim().split(/\s+/).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`magick could not read ${image}: ${query.out.trim()}`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

async function coarseAe(a: string, b: string): Promise<number> {
  const diff = await run(
    ["magick", "compare", "-metric", "AE", "-fuzz", COARSE_FUZZ, a, b, "null:"],
    { quiet: true },
  );
  const value = Number(diff.out.trim().split(/\s+/)[0]);
  // `magick compare` exits nonzero when the images differ AND when it cannot
  // compare them at all; only the second prints something unparseable, and
  // reading that as 0 would turn a broken comparison into a pass.
  if (!Number.isFinite(value)) {
    throw new Error(`magick compare failed on ${a} vs ${b}: ${diff.out.trim()}`);
  }
  return value;
}

const recorded = new Map<string, string>();
if (!update) {
  if (!existsSync(golden)) {
    console.error(
      `voxel 3ds e2e: no golden at ${golden} — run UPDATE_3DS=1 bun run e2e:3ds after ` +
        `reviewing the PNGs in ${outDir.replace(root, "")}`,
    );
    process.exit(1);
  }
  for (const line of readFileSync(golden, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const [name, hash] = text.split(/\s+/);
    if (!name || !hash) {
      console.error(`voxel 3ds e2e: bad golden line: ${line}`);
      process.exit(1);
    }
    recorded.set(name, hash);
  }
}

let failed = false;
const fresh: string[] = [];

for (const [index, mark] of marks.entries()) {
  const label = mark.name;
  const rawPath = `${capDir}/f${String(index).padStart(4, "0")}.raw`;
  const framePath = `${outDir}/${label}.rgba`;
  const framePng = `${outDir}/${label}.png`;
  const bandPng = `${outDir}/${label}.band.png`;
  const bandCoarse = `${outDir}/${label}.coarse.png`;
  const oraclePng = `${oracleDir}/${label}.png`;
  const oracleCoarse = `${oracleDir}/${label}.coarse.png`;

  try {
    // Structural guards run before any comparison, and in UPDATE mode too: a
    // golden that is short, flat, upscaled or mis-cropped must never be
    // recorded.
    if (!existsSync(rawPath)) throw new Error("capture file missing");
    const raw = readFileSync(rawPath);
    if (raw.byteLength !== RAW_BYTES) {
      throw new Error(`expected ${RAW_BYTES} bytes (400x240 RGBA8), got ${raw.byteLength}`);
    }
    const rgba = decodeTopScreen(raw);
    const bars = letterboxFault(rgba);
    if (bars) throw new Error(bars);
    const colours = distinctColours(rgba, 8);
    if (colours < 8) throw new Error(`frame is flat (${colours} colours in the 400x${BAND_H} band)`);
    if (!hasNativeDetail(rgba)) throw new Error("band contains only duplicated 2x2 pixels");
    if (!existsSync(oraclePng)) throw new Error(`oracle shot missing (${oraclePng})`);

    // The full frame including the bars is what the console shows; the band is
    // what the oracle gates compare. Both are written for review.
    writeFileSync(framePath, rgba);
    const decode = await run([
      "magick", "-size", `${W}x${H}`, "-depth", "8", `RGBA:${framePath}`, "-alpha", "off",
      "-define", "png:exclude-chunks=date,time", `PNG24:${framePng}`,
    ]);
    if (decode.code !== 0) throw new Error("could not write the frame PNG");
    const crop = await run([
      "magick", framePng, "-crop", `${W}x${BAND_H}+0+${BAND_Y}`, "+repage",
      "-define", "png:exclude-chunks=date,time", `PNG24:${bandPng}`,
    ]);
    if (crop.code !== 0) throw new Error("could not write the band PNG");

    // Gate 1 — 3DS vs 3DS, byte-exact.
    const hash = fnv1a64(rgba);
    fresh.push(`${label} ${hash}`);
    if (!update) {
      const want = recorded.get(label);
      if (want === undefined) throw new Error(`no golden hash for this mark (computed ${hash})`);
      if (want !== hash) throw new Error(`hash ${hash}, golden ${want} (see ${framePng})`);
    }

    // Gate 2 — mean channel colour against the untouched 480x272 oracle.
    // Neither side is resampled.
    const [br, bg, bb] = await meanChannels(bandPng);
    const [or, og, ob] = await meanChannels(oraclePng);
    const delta = [br - or, bg - og, bb - ob];
    const worstChannel = Math.max(...delta.map(Math.abs));
    if (worstChannel > MEAN_TOLERANCE) {
      throw new Error(
        `mean colour differs from the oracle by ${worstChannel.toFixed(2)} of 255 ` +
          `(dR ${delta[0]!.toFixed(2)} dG ${delta[1]!.toFixed(2)} dB ${delta[2]!.toFixed(2)}), ` +
          `tolerance ${MEAN_TOLERANCE}`,
      );
    }

    // Gate 3 — coarse-grid structure. Both sides are area-averaged from their
    // own native size, so neither is privileged and the grid change costs both
    // the same.
    for (const [source, target] of [[bandPng, bandCoarse], [oraclePng, oracleCoarse]] as const) {
      const shrink = await run([
        "magick", source, "-alpha", "off", "-filter", "Box", "-resize", `${COARSE_GRID}!`,
        "-define", "png:exclude-chunks=date,time", `PNG24:${target}`,
      ]);
      if (shrink.code !== 0) throw new Error(`could not area-average ${source}`);
    }
    const ae = await coarseAe(bandCoarse, oracleCoarse);
    if (ae > COARSE_AE_TOLERANCE) {
      throw new Error(
        `coarse structure differs from the oracle: AE ${ae} > ${COARSE_AE_TOLERANCE} ` +
          `(${COARSE_GRID}, fuzz ${COARSE_FUZZ}); see ${framePng} vs ${oraclePng}`,
      );
    }

    console.log(
      `  ok   ${label.padEnd(15)} ${hash}  mean d${worstChannel.toFixed(2)}  coarse AE ${ae}`,
    );
  } catch (error) {
    console.error(`  FAIL ${label}: ${(error as Error).message}`);
    failed = true;
  }
}

killEmulator();

if (failed) {
  console.error("\nvoxel 3ds e2e: FAILED");
  process.exit(1);
}

if (update) {
  const version = Bun.spawnSync([azaharBinary, "--version"]).stdout.toString().trim();
  writeFileSync(
    golden,
    // Byte-exactness is only promised for the emulator build and renderer the
    // hashes were recorded with, so the file says which.
    `# FNV-1a64 over the decoded 400x240 RGBA of each ${tape} mark, captured from ` +
      `dist/3ds/voxelmon-capture.3dsx\n` +
      `# under ${version}, graphics_api=0 (software). Determinism and regression only — ` +
      `parity with the\n` +
      `# sim oracle is what tests/e2e/voxel-3ds.ts's mean and coarse-structure gates test.\n` +
      `${fresh.join("\n")}\n`,
  );
  console.log(`\nWROTE ${golden.replace(root, "")} (${fresh.length} marks, ${version})`);
} else {
  console.log(
    `\nvoxel 3ds e2e: all ${marks.length} marks live, byte-exact against the 3DS golden, ` +
      `and within mean ${MEAN_TOLERANCE}/255 and coarse AE ${COARSE_AE_TOLERANCE} of the oracle`,
  );
}
