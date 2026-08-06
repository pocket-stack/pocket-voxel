// Headless tape runner:
//   bun voxelmon/game/sim/cli.ts --tape voxelmon/tapes/<name>.tape
//       --out dist/voxelmon/trace/<name>.vtrace [--seed N] [--gen DIR]
// Loads the imported dataset, runs the game one tick per tape-driven frame,
// writes the .vtrace (SCHEMA.md). Deterministic: same tape + seed ->
// byte-identical vtrace. Exits nonzero on a stalled walk or an unfinished
// tape (the watchdog prints the player position).

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { fromGenDir as loadAudioBanks } from "../audio/banks.ts";
import { loadRuntimeData } from "../data.ts";
import { VoxelmonGame } from "../game.ts";
import { RecorderHost } from "../host.ts";
import { parseTape, TapePlayer, TapeStallError } from "./tape.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const tapePath = arg("tape");
const outPath = arg("out");
const seed = Number(arg("seed") ?? "1");
const genDir = arg("gen") ?? "dist/voxelmon/gen";

if (!tapePath || !outPath) {
  console.error(
    "usage: bun voxelmon/game/sim/cli.ts --tape <file.tape> --out <file.vtrace> [--seed N]",
  );
  process.exit(2);
}

const tapeText = await Bun.file(tapePath).text();
const commands = parseTape(tapeText);
const data = await loadRuntimeData(genDir);

const host = new RecorderHost();
const game = new VoxelmonGame(data, host, seed);
// Same banks the pak's AUDIO section carries, over the gen/ transport — the
// headless run drives the identical policy path (and records the identical
// `audiodata` op). Bun mounts no audio module, so nothing is synthesized.
game.setAudio(await loadAudioBanks(genDir));
game.newGame();
const tape = new TapePlayer(commands);

// hard ceiling so a broken tape can never spin the process forever
const MAX_TICKS = 1_000_000;

try {
  while (!tape.done && game.tickIndex < MAX_TICKS) {
    const step = tape.next(game);
    for (const m of step.marks) host.mark(m);
    if (tape.done) break;
    game.tick(step.buttons);
    tape.observe(game);
  }
} catch (err) {
  if (err instanceof TapeStallError) {
    console.error(`STALL: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (!tape.done) {
  console.error(`tape did not finish within ${MAX_TICKS} ticks`);
  process.exit(1);
}

const marksInTape = commands.filter((c) => c.kind === "mark").length;
if (host.markCount !== marksInTape) {
  console.error(`reached ${host.markCount}/${marksInTape} marks`);
  process.exit(1);
}

const text = host.text();
await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, text);

console.log(
  `${outPath}: ${game.tickIndex} ticks, ${host.opCount} ops, ` +
    `${host.markCount} marks (${host.marks.join(", ")}), ${text.length} bytes, ` +
    `${game.overworld.encounterCount} encounter(s)` +
    (game.overworld.lastEncounter
      ? ` [${game.overworld.lastEncounter.species} L${game.overworld.lastEncounter.level}]`
      : ""),
);
