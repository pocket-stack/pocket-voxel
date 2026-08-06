// .tape parser + player (SCHEMA.md ".tape — intent tapes"): one command per
// line, `#` comments. Tapes describe INTENT, never frame counts — the
// Pocket Mon lesson. `walk` holds the direction until that many steps LAND
// and releases when landed + in_flight == target, so walks never overshoot;
// a turn-in-place is not a step (only actual cell-movement completions
// count, which the Player's monotonic landedCount carries — scripted steps
// like the door walk-out included, since the cell really moves).

import { VOX_BTN } from "../../../contracts/spec/voxel-spec.ts";
import type { VoxelmonGame } from "../game.ts";

export type TapeCommand =
  | { kind: "walk"; dir: "u" | "d" | "l" | "r"; cells: number; line: number }
  | { kind: "press"; btn: keyof typeof VOX_BTN; line: number }
  | { kind: "wait"; ticks: number; line: number }
  | { kind: "mark"; name: string; line: number };

const DIR_BTN: Record<string, keyof typeof VOX_BTN> = {
  u: "up",
  d: "down",
  l: "left",
  r: "right",
};

const PRESS_BTN: Record<string, keyof typeof VOX_BTN> = {
  a: "a",
  b: "b",
  start: "start",
  select: "select",
  u: "up",
  d: "down",
  l: "left",
  r: "right",
};

export function parseTape(text: string): TapeCommand[] {
  const out: TapeCommand[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") return;
    const parts = line.split(/\s+/);
    const lineNo = i + 1;
    switch (parts[0]) {
      case "walk": {
        const dir = parts[1] as "u" | "d" | "l" | "r";
        const cells = Number(parts[2]);
        if (!DIR_BTN[dir] || !Number.isInteger(cells) || cells < 1) {
          throw new Error(`tape line ${lineNo}: bad walk "${line}"`);
        }
        out.push({ kind: "walk", dir, cells, line: lineNo });
        break;
      }
      case "press": {
        const btn = PRESS_BTN[parts[1]];
        if (!btn) throw new Error(`tape line ${lineNo}: bad press "${line}"`);
        out.push({ kind: "press", btn, line: lineNo });
        break;
      }
      case "wait": {
        const ticks = Number(parts[1]);
        if (!Number.isInteger(ticks) || ticks < 1) {
          throw new Error(`tape line ${lineNo}: bad wait "${line}"`);
        }
        out.push({ kind: "wait", ticks, line: lineNo });
        break;
      }
      case "mark": {
        if (!parts[1]) throw new Error(`tape line ${lineNo}: mark needs a name`);
        out.push({ kind: "mark", name: parts[1], line: lineNo });
        break;
      }
      default:
        throw new Error(`tape line ${lineNo}: unknown command "${parts[0]}"`);
    }
  });
  return out;
}

/** A walk that makes no landed-step progress for this many ticks aborts. */
export const STALL_TICKS = 240;

export class TapeStallError extends Error {
  constructor(
    public tapeLine: number,
    public playerX: number,
    public playerY: number,
    public mapId: string,
  ) {
    super(
      `walk at tape line ${tapeLine} stalled for ${STALL_TICKS} ticks ` +
        `at ${mapId} (${playerX},${playerY})`,
    );
  }
}

interface WalkProgress {
  landedBase: number;
  stallTicks: number;
}

export class TapePlayer {
  private commands: TapeCommand[];
  private index = 0;
  private waitLeft = 0;
  private pressArmed = false;
  private walk: WalkProgress | null = null;
  done = false;

  constructor(commands: TapeCommand[]) {
    this.commands = commands;
  }

  /**
   * Buttons for the NEXT tick, plus any marks that execute at this
   * boundary (the sim renders/hashes marks against the state after the
   * previous tick). Call once before each game.tick.
   */
  next(game: VoxelmonGame): { buttons: number; marks: string[] } {
    const marks: string[] = [];
    for (;;) {
      const cmd = this.commands[this.index];
      if (!cmd) {
        this.done = true;
        return { buttons: 0, marks };
      }
      switch (cmd.kind) {
        case "mark":
          marks.push(cmd.name);
          this.index += 1;
          continue;
        case "wait": {
          if (this.waitLeft === 0) this.waitLeft = cmd.ticks;
          this.waitLeft -= 1;
          if (this.waitLeft === 0) this.index += 1;
          return { buttons: 0, marks };
        }
        case "press": {
          if (!this.pressArmed) {
            // tap: one tick down...
            this.pressArmed = true;
            return { buttons: VOX_BTN[cmd.btn], marks };
          }
          // ...then one explicit released tick, so back-to-back presses of
          // the same button still edge (a held bit never re-edges)
          this.pressArmed = false;
          this.index += 1;
          return { buttons: 0, marks };
        }
        case "walk": {
          const p = game.overworld.player;
          if (!this.walk) {
            this.walk = { landedBase: p.landedCount, stallTicks: 0 };
          }
          const landed = p.landedCount - this.walk.landedBase;
          if (landed >= cmd.cells) {
            this.walk = null;
            this.index += 1;
            continue;
          }
          // release when landed + in_flight == target — the committed step
          // lands on its own; holding through it would overshoot
          if (landed + (p.moving ? 1 : 0) >= cmd.cells) {
            return { buttons: 0, marks };
          }
          if (this.walk.stallTicks >= STALL_TICKS) {
            throw new TapeStallError(cmd.line, p.cellX, p.cellY, game.overworld.map.id);
          }
          return { buttons: VOX_BTN[DIR_BTN[cmd.dir]], marks };
        }
      }
    }
  }

  /** Call once after each game.tick: advances walk progress accounting. */
  observe(game: VoxelmonGame): void {
    const cmd = this.commands[this.index];
    if (!cmd || cmd.kind !== "walk" || !this.walk) return;
    const p = game.overworld.player;
    if (p.stepLanded) {
      this.walk.stallTicks = 0;
    } else {
      this.walk.stallTicks += 1;
    }
  }
}
