// Render the chip synth to a RIFF/WAVE file so a human can listen to it.
//
//   bun tools/voxel.ts wav                       every map/battle theme
//   bun tools/voxel.ts wav Music_PalletTown      one song
//   bun tools/voxel.ts wav --cry PIDGEY          one cry
//   bun tools/voxel.ts wav --sfx Press_AB        one effect
//
// The synth is the CORE's, so this renders the way the game does: it resolves
// names to op arguments out of gen/audio.json, writes a one-tape `.vtrace`
// carrying exactly those ops, and replays it through `pocketvoxel-sim --wav`.
// What comes out is the same PCM a host would pump on device — not a second
// implementation of the synth that could drift from it.
//
// Writes dist/voxelmon/audio/*.wav (git-ignored with the rest of dist/) and
// prints each file's peak and RMS level, so "it renders" and "it is audible"
// stay two different claims. The shape matches contracts/spec/audio.ts's WAV
// contract exactly (PCM, 16-bit, stereo, a rate in AUDIO_RATES), which means
// the same bytes also load through framework/src/audio-api.ts decodeWav.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIO_MUSIC_FLAG,
  AUDIO_SFX_TEMPO,
  TICK_HZ,
  VOX_OP,
} from "../../../contracts/spec/voxel-spec.ts";
import { fromGenDir, type AudioBanks } from "./banks.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PAK = "dist/voxelmon/voxelmon.vxpak";

/** The op lines for one render: the engine table pins, then the program. */
function tape(banks: AudioBanks, program: number[], ticks: number): string {
  const lines = ["voxtrace 1", "t 0 0"];
  for (const pin of banks.pins()) {
    lines.push(
      pin.drum < 0
        ? `o ${VOX_OP.audioWaves} ${pin.engine} ${pin.bank} ${pin.address}`
        : `o ${VOX_OP.audioDrum} ${pin.engine} ${pin.drum} ${pin.bank} ${pin.address}`,
    );
  }
  lines.push(`o ${program.join(" ")}`);
  for (let t = 1; t < ticks; t++) lines.push(`t ${t} 0`);
  return lines.join("\n") + "\n";
}

interface Job {
  name: string;
  op: number[];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let rate = 44100;
  let seconds = 20;
  const cries: string[] = [];
  const sfx: string[] = [];
  const songs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rate" && args[i + 1]) rate = Number(args[++i]);
    else if (args[i] === "--seconds" && args[i + 1]) seconds = Number(args[++i]);
    else if (args[i] === "--cry" && args[i + 1]) cries.push(args[++i]);
    else if (args[i] === "--sfx" && args[i + 1]) sfx.push(args[++i]);
    else songs.push(args[i]);
  }

  const genDir = join(ROOT, "dist/voxelmon/gen");
  const banks = await fromGenDir(genDir);
  if (!banks) {
    console.error(`voxel wav: no audio dataset at ${genDir} — run \`bun tools/voxel.ts import\``);
    return 1;
  }
  if (!existsSync(join(ROOT, PAK))) {
    // The programs themselves live in the pak's AUDI section, which is what
    // the core reads; the manifest alone cannot be played.
    console.error(`voxel wav: no pak at ${PAK} — run \`bun tools/voxel.ts cook\``);
    return 1;
  }

  const jobs: Job[] = [];
  const addSong = (label: string) => {
    const ref = banks.song(label);
    if (!ref) {
      console.error(`  (no such song: ${label})`);
      return;
    }
    jobs.push({
      name: label,
      op: [VOX_OP.music, ref.bank, ref.address, ref.engine, AUDIO_MUSIC_FLAG.loop],
    });
  };

  if (songs.length === 0 && cries.length === 0 && sfx.length === 0) {
    // The default sweep: the themes this slice's maps actually reach, plus
    // the wild-battle pair and the two sounds the overworld plays.
    const m = banks.manifest;
    const defaults = new Set<string>();
    for (const map of ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY", "REDS_HOUSE_1F", "OAKS_LAB"]) {
      const song = m.mapSongs[map];
      if (song) defaults.add(song);
    }
    if (m.battle.wild) defaults.add(m.battle.wild);
    if (m.battle.wildWin) defaults.add(m.battle.wildWin);
    for (const label of defaults) addSong(label);
    sfx.push("Press_AB");
    cries.push("PIDGEY");
  } else {
    for (const label of songs) addSong(label);
  }

  for (const name of sfx) {
    const ref = banks.sfx(name);
    if (!ref) {
      console.error(`  (no such sfx: ${name})`);
      continue;
    }
    jobs.push({
      name: `sfx_${name}`,
      op: [VOX_OP.sfx, ref.bank, ref.address, ref.engine, 0, AUDIO_SFX_TEMPO, 0],
    });
  }
  for (const species of cries) {
    const cry = banks.cry(species);
    if (!cry) {
      console.error(`  (no such cry: ${species})`);
      continue;
    }
    jobs.push({
      name: `cry_${species}`,
      op: [VOX_OP.cry, cry.bank, cry.address, cry.engine, cry.pitch, cry.length],
    });
  }

  const outDir = join(ROOT, "dist/voxelmon/audio");
  mkdirSync(outDir, { recursive: true });
  const tracePath = join(outDir, "_wav.vtrace");
  const ticks = Math.max(1, Math.round(seconds * TICK_HZ));
  for (const job of jobs) {
    await Bun.write(tracePath, tape(banks, job.op, ticks));
    const out = join(outDir, `${job.name}.wav`);
    const proc = Bun.spawnSync(
      [
        "cargo",
        "run",
        "--release",
        "-q",
        "-p",
        "pocketvoxel-sim",
        "--",
        join(ROOT, PAK),
        "--trace",
        tracePath,
        "--wav",
        out,
        "--rate",
        String(rate),
      ],
      { cwd: ROOT, stderr: "inherit" },
    );
    if (proc.exitCode !== 0) {
      console.error(`voxel wav: sim failed for ${job.name}`);
      return 1;
    }
    // `wav <path> <frames> frames <rate> Hz peak <n> (<pct>%) rms <n> (<pct>%)`
    const line = proc.stdout.toString().trim().split("\n")[0] ?? "";
    const tail = line.split(/\s+/).slice(2).join(" ");
    console.log(`${job.name.padEnd(24)} ${tail}`);
  }
  console.log(`voxel wav: ${jobs.length} file(s) -> ${outDir} (${rate} Hz, stereo s16)`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
