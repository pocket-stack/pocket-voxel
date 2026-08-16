// tests/e2e/voxel-ppsspp.ts — the Pocket Voxel EBOOT under PPSSPPHeadless.
//
//   bun tests/e2e/voxel-ppsspp.ts
//
// One selected tape (story by default; VOXEL_E2E_TAPE overrides it) cashed
// in on the console: the SAME recorded run that produces frame hashes drives
// the capture EBOOT — the per-tick button stream and the mark ticks are
// extracted from that tape's vtrace and baked into the build,
// the run replays under PPSSPP's software renderer (the only byte-stable
// backend), and each mark's presented frame is dumped and compared against
// the sim rasterizer's PNG for the same mark.
//
// Asserts, per mark:
//   1. liveness — every mark produced a frame (boot, pak parse, QuickJS
//      eval, 2400 guest turns, and the GE pipeline all survived);
//   2. the frame is not flat (>= 8 distinct colors — a black screen or a
//      stuck clear can never pass);
//   3. GE/rasterizer agreement — `magick compare -metric AE -fuzz ${FUZZ}`
//      within AE_TOLERANCE (below). The two backends are separate
//      implementations of one draw list and CANNOT be byte-identical:
//      the GE rounds texture sampling, vertex-color modulation and alpha
//      blending differently, the GB UI layer's non-integer 272/144 scale
//      resolves tile seams per-vertex on the GE vs per-pixel in the
//      rasterizer (<= 1 px seams), and f32 matrix evaluation orders differ.
//      The tolerance documents the measured envelope and catches real
//      breakage (a missing pass, a stale texture bind, a depth-state leak
//      each move tens of thousands of pixels).
//
// Skips (exit 0, printed reason) when PPSSPPHeadless, the pinned PSP
// toolchain, ImageMagick, or the ROM-derived gen/ inputs are absent — the
// docs/VOXEL.md §1 rule: CI never sees ROM-derived bytes.
//
// PNGs and raw dumps stay local (dist/e2e-voxel + ~/.ppsspp/vox_cap);
// nothing ROM-derived is ever committed.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";

import { resolvePspBuildToolchain } from "../../tools/psp-toolchain.ts";

const root = new URL("../..", import.meta.url).pathname;
const tape = process.env.VOXEL_E2E_TAPE || "story";
if (!/^[a-z0-9-]+$/.test(tape)) throw new Error(`invalid VOXEL_E2E_TAPE ${JSON.stringify(tape)}`);
const outDir = `${root}dist/e2e-voxel${tape === "story" ? "" : `-${tape}`}`;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
// PPSSPPHeadless maps ms0: to ~/.ppsspp — dumps land in ~/.ppsspp/vox_cap.
// Contents persist across runs; always clean first.
const capDir = `${homedir()}/.ppsspp/vox_cap`;
const eboot = `${root}crates/pocketvoxel-psp/target/mipsel-sony-psp/release/EBOOT.PBP`;
const pak = `${root}dist/voxelmon/voxelmon.vxpak`;
const trace = `${root}dist/voxelmon/trace/${tape}.vtrace`;

// Measured 2026-08-05 (PPSSPP software renderer vs pocketvoxel-sim, story
// seed 17, 11 marks): AE at 2% fuzz ranged 639 (oaks-lab) .. 4867 (route-1)
// — indoor marks sit under 800, outdoor marks under 5000 (UI/tile seam
// rounding at the non-integer GB scale, GE vs raster texture-sampling and
// blend rounding, f32 matrix-order drift on chunk edges). The bound is
// ~2.5x the worst measured mark so environment drift cannot flake it while
// real breakage (a lost pass, a stale bind, a depth-state leak — each tens
// of thousands of pixels) still lands far above.
const FUZZ = "2%";
const AE_TOLERANCE = 12000; // of 130560 frame pixels (~9.2%)

function skip(reason: string): never {
  console.log(`voxel e2e: SKIP — ${reason}`);
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

// ---- skips ----------------------------------------------------------------

if (!existsSync(headless)) skip(`PPSSPPHeadless not found at ${headless} (set PPSSPP_HEADLESS)`);
if (!Bun.which("magick")) skip("ImageMagick `magick` not found (brew install imagemagick)");
try {
  resolvePspBuildToolchain();
} catch (error) {
  skip(`PSP toolchain unavailable: ${(error as Error).message}`);
}
if (!existsSync(`${root}dist/voxelmon/gen/maps.json`) && !process.env.VOXELMON_ROM) {
  skip("no dist/voxelmon/gen/ and no VOXELMON_ROM (ROM-derived inputs absent)");
}

// ---- 1. pak + selected trace ----------------------------------------------

console.log(`# cook + ${tape} trace ...`);
{
  if (!existsSync(`${root}dist/voxelmon/gen/maps.json`)) {
    const imp = await run(["bun", "tools/voxel.ts", "import"]);
    if (imp.code !== 0) skip("ROM import failed (see output above)");
  }
  const cook = await run(["bun", "voxelmon/cook/cli.ts"]);
  if (cook.code !== 0) process.exit(1);
  const sim = await run([
    "bun",
    "voxelmon/game/sim/cli.ts",
    "--tape",
    `voxelmon/tapes/${tape}.tape`,
    "--out",
    `dist/voxelmon/trace/${tape}.vtrace`,
    "--seed",
    "17",
  ]);
  if (sim.code !== 0) process.exit(1);
}

// ---- 2. derive the console run from the trace -----------------------------
// `t <tick> <buttons>` lines: every button transition becomes a threshold
// entry (last-at-or-before replay = the exact per-tick stream). `m <name>`
// lines: the mark belongs to the tick block it follows.

interface Mark {
  name: string;
  tick: number;
}

const transitions: string[] = [];
const marks: Mark[] = [];
{
  let tick = -1;
  let lastMask = -1;
  for (const line of readFileSync(trace, "utf8").split("\n")) {
    if (line.startsWith("t ")) {
      const [, t, mask] = line.split(" ");
      tick = Number(t);
      const m = Number(mask);
      if (m !== lastMask) {
        transitions.push(`${tick}:${m}`);
        lastMask = m;
      }
    } else if (line.startsWith("m ")) {
      marks.push({ name: line.slice(2).trim(), tick });
    }
  }
}
if (marks.length === 0) {
  console.error("voxel e2e: the trace has no marks");
  process.exit(1);
}
console.log(`  ${transitions.length} input transitions, ${marks.length} marks`);

// ---- 3. sim reference PNGs (regenerated, never committed) -----------------

console.log("# sim rasterizer reference shots ...");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(`${outDir}/sim`, { recursive: true });
{
  const sim = await run(
    [
      "cargo",
      "run",
      "--release",
      "-q",
      "-p",
      "pocketvoxel-sim",
      "--",
      pak,
      "--trace",
      trace,
      "--shots",
      `${outDir}/sim`,
    ],
    { cwd: root },
  );
  if (sim.code !== 0) process.exit(1);
}

// ---- 4. the capture EBOOT -------------------------------------------------

console.log("# build the capture EBOOT ...");
{
  const build = await run(["bun", "tools/voxel.ts", "psp", "--release", "--features", "capture"], {
    env: {
      ...process.env,
      VOXEL_CAP_INPUT: transitions.join(","),
      VOXEL_CAP_MARKS: marks.map((m) => m.tick).join(","),
    },
  });
  if (build.code !== 0) process.exit(1);
}

// ---- 5. PPSSPPHeadless (software renderer) --------------------------------

console.log("# PPSSPPHeadless (software renderer) ...");
rmSync(capDir, { recursive: true, force: true });
// Capture only renders marked frames (capture.rs: the software renderer can
// take seconds for a Route 1 frame) rather than every in-between frame. The
// story default is ~3200 guest turns; shorter focused tapes use the same
// capture path. The run is otherwise guest-speed, so this ceiling leaves
// generous headroom over the measured ~2-4 minutes for the story.
const timeout = Number(process.env.E2E_TIMEOUT || 1200);
const ppsspp = await run([headless, "--graphics=software", `--timeout=${timeout}`, eboot], {
  cwd: "/tmp",
  quiet: true,
});

const produced = existsSync(capDir)
  ? readdirSync(capDir).filter((f) => /^f\d{4}\.raw$/.test(f)).length
  : 0;
if (produced !== marks.length) {
  console.error(
    `FAIL: dumped ${produced}/${marks.length} marks within ${timeout}s.\n` +
      `PPSSPP output:\n${ppsspp.out}`,
  );
  process.exit(1);
}
console.log(`liveness: ${produced}/${marks.length} marks reached on the console`);

// ---- 6. per-mark verdicts -------------------------------------------------

let failed = false;
for (const [i, mark] of marks.entries()) {
  const raw = `${capDir}/f${String(i).padStart(4, "0")}.raw`;

  // Flat-frame guard: a frame that is one clear color records nothing.
  const buf = readFileSync(raw);
  const pixels = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const distinct = new Set<number>();
  outer: for (let y = 0; y < 272; y++) {
    for (let x = 0; x < 480; x++) {
      distinct.add(pixels[y * 512 + x]!);
      if (distinct.size >= 8) break outer;
    }
  }
  if (distinct.size < 8) {
    console.error(`  FAIL ${mark.name}: frame is flat (${distinct.size} colors)`);
    failed = true;
    continue;
  }

  // 512-stride RGBA top-down, crop to the visible 480x272.
  const png = `${outDir}/${mark.name}.png`;
  const conv = await run([
    "magick",
    "-size",
    "512x272",
    "-depth",
    "8",
    `RGBA:${raw}`,
    "-alpha",
    "off",
    "-crop",
    "480x272+0+0",
    "+repage",
    "-define",
    "png:exclude-chunks=date,time",
    `PNG24:${png}`,
  ]);
  if (conv.code !== 0) {
    failed = true;
    continue;
  }

  const simShot = `${outDir}/sim/${mark.name}.png`;
  if (!existsSync(simShot)) {
    console.error(`  FAIL ${mark.name}: sim shot missing (${simShot})`);
    failed = true;
    continue;
  }
  const diff = await run(
    ["magick", "compare", "-metric", "AE", "-fuzz", FUZZ, png, simShot, "null:"],
    { quiet: true },
  );
  const ae = Number(diff.out.trim().split(" ")[0]) || 0;
  if (ae > AE_TOLERANCE) {
    console.error(
      `  FAIL ${mark.name}: GE vs rasterizer AE ${ae} > ${AE_TOLERANCE} (fuzz ${FUZZ}); ` +
        `see ${png} vs ${simShot}`,
    );
    failed = true;
  } else {
    console.log(`  ok   ${mark.name} (AE ${ae}, fuzz ${FUZZ})`);
  }
}

if (failed) {
  console.error("\nvoxel e2e: FAILED");
  process.exit(1);
}
console.log(`\nvoxel e2e: all ${marks.length} marks live, non-flat, within AE ${AE_TOLERANCE}`);
