// Map-script execution. Ports gen1recomp src/script/ScriptRunner.lua's
// coroutine model as a resumable generator: scripts are lists of
// ["command", args...] rows; blocking commands park the generator and a
// completion callback resumes it (ScriptRunner.lua:93 new, :119 run,
// :233 update).
//
// Only the slice's verb set is ported from src/script/Commands.lua:
// show_text :81, jump :143, ask :154, face_player :162, set_flag :168,
// check_flag :176, jump_if_true :205, jump_if_false :209, give_item :220,
// warp :308, wait :316, move_player :330, label :1005, emote :1014,
// play_once :533, heal_party :587, fade :1216.
//
// The set is exactly what the cooked maps' hand-ported scripts invoke
// (mapscripts.ts): everything upstream reaches for outside those scripts —
// object visibility, forced-walk cutscenes, trainer engagement, the naming
// screen, the dex rating — belongs to the rungs docs/VOXEL.md §10 defers.

import type { VoxelmonData } from "../data.ts";
import * as Bag from "../rules/bag.ts";
import { FADE_OUT_TO_WHITE } from "../rules/timing.ts";
import type { Dir } from "./collision.ts";
import type { NPC } from "./npc.ts";

export type ScriptRow = [string, ...unknown[]];

export interface ScriptSave {
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  player: { name: string; rival: string };
}

/** The services a command reaches — the overworld hands itself in. */
export interface ScriptWorld {
  data: VoxelmonData;
  save: ScriptSave;
  /** Push a dialogue box; onDone fires when it closes. */
  showText(text: string, onDone: () => void): void;
  /** Push a dialogue box with a YES/NO choice; choice(yes) fires instead. */
  showChoice(text: string, choice: (yes: boolean) => void): void;
  /** Resolve a TEXT_* constant through the current map's pointers. */
  resolveText(textId: string): string | null;
  startWarpTo(mapId: string, x: number, y: number, facing: Dir, onDone: () => void): void;
  scriptMove(entity: { moving: boolean }, dir: Dir, tiles: number, onDone?: () => void): void;
  player: { moving: boolean };
  setEmote(entity: unknown, bubble: number, frames: number, onDone: () => void): void;
  /** Pokemon.lua:90 heal, over the whole party. */
  healParty(): void;
  /** Music.lua:playOnce — a one-shot song; onDone fires when it ends. */
  playOnce(songId: string, onDone: () => void): void;
  /** The fade overlay's ramp (Commands.lua:1216); the port holds frames. */
  fade(dir: "in" | "out", frames: number, onDone: () => void): void;
  /** Turn an NPC to face the player (NPC.lua facePlayer). */
  facePlayer(npc: NPC): void;
}

export interface ScriptContext {
  world: ScriptWorld;
  runner: ScriptRunner;
  npc?: NPC;
  lastCheck?: boolean;
  onDone?: () => void;
}

// Commands.lua:1024 EMOTE_BUBBLES (data.field.emotionBubbles order; matches
// the spec's EMOTE shock/question/happy = 1/2/3)
const EMOTE_BUBBLES: Record<string, number> = { shock: 1, question: 2, happy: 3 };

type Verb = (ctx: ScriptContext, ...args: unknown[]) => Generator<void, string | number | void>;

// Commands.lua:70 show_text's lookup: a text label first, then the map's
// TEXT_* pointers, and a hand-written row's literal string last. subs
// replaces the dynamic {TOKEN}s the extracted line carries.
function scriptText(
  w: ScriptWorld,
  textId: string,
  subs?: Record<string, string>,
): string {
  let text =
    (w.data.text as Record<string, string> | undefined)?.[textId] ??
    w.resolveText(textId) ??
    textId;
  if (subs) {
    for (const [token, value] of Object.entries(subs)) {
      text = text.replace(new RegExp(`\\{${token}:?\\w*\\}`, "g"), value);
    }
  }
  return text;
}

// Commands.lua:70 show_text
function* show_text(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const text = scriptText(
    ctx.world,
    args[0] as string,
    args[1] as Record<string, string> | undefined,
  );
  ctx.world.showText(text, () => runner.resume());
  yield;
}

// Commands.lua:154 ask — show_text with opts.choice, so the YES/NO box pops
// over the still-visible text; the answer lands in ctx.lastCheck. It goes
// through show_text, so it takes the same subs.
function* ask(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  const text = scriptText(
    ctx.world,
    args[0] as string,
    args[1] as Record<string, string> | undefined,
  );
  ctx.world.showChoice(text, (yes) => {
    ctx.lastCheck = yes;
    runner.resume();
  });
  yield;
}

// Commands.lua:168 set_flag (Flags.set: save.flags keyed by pokered event
// constant names)
function* set_flag(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.world.save.flags[args[0] as string] = true;
}

// Commands.lua:220 give_item — adds to the bag and shows the "got item!"
// box; a full bag halts the script so later set_flag rows don't burn the
// gift (pokered's `jr nc, .bag_full`). The jingle (sound_get_item_1) is
// out of the slice's scope; the box waits on A/B like every other.
function* give_item(ctx: ScriptContext, ...args: unknown[]): Generator<void, number | void> {
  const itemId = args[0] as string;
  const count = (args[1] as number | undefined) ?? 1;
  const gotText = args[2] as string | false | undefined;
  const w = ctx.world;
  const runner = ctx.runner;
  if (!Bag.add(w.save, itemId, count, w.data)) {
    w.showText("You can't carry\nany more items!", () => runner.resume());
    yield;
    return Number.POSITIVE_INFINITY;
  }
  const def = w.data.items?.[itemId];
  const name = def?.name ?? itemId;
  if (gotText !== false) {
    // gotText picks the script's own received-text (a label or a literal);
    // pokered copies the item name into wStringBuffer first, so the extracted
    // line's {RAM:wStringBuffer} slot is where the name goes.
    const text =
      gotText === undefined
        ? `{PLAYER} got\n${name}!`
        : scriptText(w, gotText as string, { "RAM:wStringBuffer": name });
    w.showText(text, () => runner.resume());
    yield;
  }
}

// Commands.lua:308 warp
function* warp(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.startWarpTo(
    args[0] as string,
    args[1] as number,
    args[2] as number,
    args[3] as Dir,
    () => runner.resume(),
  );
  yield;
}

// Commands.lua:316 wait
function* wait(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.runner.waitingFrames = args[0] as number;
  yield;
}

// Commands.lua:330 move_player (walkEntity)
function* move_player(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.scriptMove(ctx.world.player, args[0] as Dir, (args[1] as number | undefined) ?? 1, () =>
    runner.resume(),
  );
  yield;
}

// Commands.lua:1014 emote — the emotion-bubble hold
// (engine/overworld/emotion_bubbles.asm); blocks frames (default 60, the
// trainer-sight hold). target "player", or nil for the talking NPC.
function* emote(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const targetArg = args[0] as string | undefined;
  const bubble = args[1] as string | number | undefined;
  const frames = (args[2] as number | undefined) ?? 60;
  const entity = targetArg === "player" ? ctx.world.player : ctx.npc;
  if (!entity) return;
  const runner = ctx.runner;
  const kind =
    typeof bubble === "number" ? bubble : EMOTE_BUBBLES[bubble ?? "shock"] ?? 1;
  ctx.world.setEmote(entity, kind, frames, () => runner.resume());
  yield;
}

// Commands.lua:143 jump — the runner resolves a number to a row and a string
// to a label ("end" halts).
function* jump(_ctx: ScriptContext, ...args: unknown[]): Generator<void, string | number> {
  return args[0] as string | number;
}

// Commands.lua:162 face_player
function* face_player(ctx: ScriptContext): Generator<void, void> {
  if (ctx.npc) ctx.world.facePlayer(ctx.npc);
}

// Commands.lua:176 check_flag (Flags.get: absent reads false)
function* check_flag(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  ctx.lastCheck = ctx.world.save.flags[args[0] as string] === true;
}

// Commands.lua:205 jump_if_true / :209 jump_if_false — no jump when the test
// fails, so the runner falls through to the next row.
function* jump_if_true(
  ctx: ScriptContext,
  ...args: unknown[]
): Generator<void, string | number | void> {
  if (ctx.lastCheck) return args[0] as string | number;
}

function* jump_if_false(
  ctx: ScriptContext,
  ...args: unknown[]
): Generator<void, string | number | void> {
  if (!ctx.lastCheck) return args[0] as string | number;
}

// Commands.lua:1005 label — a jump target, and nothing at runtime.
function* label(): Generator<void, void> {}

// Commands.lua:587 heal_party (Pokemon.heal: full HP, status cleared, PP
// restored) — the POKéMON CENTER heal Mom performs at home.
function* heal_party(ctx: ScriptContext): Generator<void, void> {
  ctx.world.healParty();
}

// Commands.lua:533 play_once — a one-shot song that BLOCKS until it ends
// (runner.waitingCheck on Music.oneShotPlaying).
function* play_once(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const runner = ctx.runner;
  ctx.world.playOnce(args[0] as string, () => runner.resume());
  yield;
}

// Commands.lua:1216 fade — the overlay ramp, out to the colour then back in.
// The voxel slice has no overlay op, so the ramp is the held frames the port
// spends on every other fade (game.ts WarpFadeState); the colour argument is
// carried for the citation and ignored.
function* fade(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const dir = args[0] === "in" ? "in" : "out";
  // parseFadeArgs (Commands.lua:1200): either order, the number is frames
  const frames =
    (typeof args[1] === "number" ? args[1] : typeof args[2] === "number" ? args[2] : undefined) ??
    FADE_OUT_TO_WHITE;
  const runner = ctx.runner;
  ctx.world.fade(dir, frames, () => runner.resume());
  yield;
}

const VERBS: Record<string, Verb> = {
  show_text,
  ask,
  jump,
  jump_if_true,
  jump_if_false,
  label,
  face_player,
  check_flag,
  set_flag,
  give_item,
  warp,
  wait,
  move_player,
  heal_party,
  play_once,
  fade,
  emote,
};

/** ScriptRunner.lua:26 scanLabels — first row wins, 1-based like the Lua. */
function scanLabels(script: ScriptRow[]): Map<string, number> {
  const labels = new Map<string, number>();
  script.forEach((row, i) => {
    if (row[0] === "label" && typeof row[1] === "string" && !labels.has(row[1])) {
      labels.set(row[1], i + 1);
    }
  });
  return labels;
}

export class ScriptRunner {
  private co: Generator<void, void> | null = null;
  waitingFrames: number | null = null;
  ctx: ScriptContext | null = null;
  private resuming = false;
  private world: ScriptWorld;

  constructor(world: ScriptWorld) {
    this.world = world;
  }

  // ScriptRunner.lua:101
  isRunning(): boolean {
    return this.co !== null;
  }

  // ScriptRunner.lua:119 run
  run(script: ScriptRow[], extra?: { npc?: NPC; onDone?: () => void }): void {
    if (this.isRunning()) throw new Error("script already running");
    const ctx: ScriptContext = { world: this.world, runner: this, ...extra };
    this.ctx = ctx;
    this.co = this.exec(script, ctx);
    this.resume();
  }

  // ScriptRunner.lua:143 exec — a command list whose verbs return a jump
  // target: a row number (1-based like the Lua), a label name, "end" to halt,
  // or nothing to fall through.
  private *exec(script: ScriptRow[], ctx: ScriptContext): Generator<void, void> {
    const labels = scanLabels(script);
    let pc = 1;
    while (pc <= script.length) {
      const row = script[pc - 1];
      const name = row[0];
      const fn = VERBS[name];
      if (!fn) {
        // v1 skip: old content degrades instead of dying, but never in
        // silence — ScriptRunner.lua:158 logs the row it dropped.
        console.warn(`script: unknown command '${name}' (skipped)`);
        pc += 1;
        continue;
      }
      const jump = yield* fn(ctx, ...row.slice(1));
      if (typeof jump === "number") {
        pc = jump;
      } else if (typeof jump === "string") {
        if (jump === "end") break;
        const target = labels.get(jump);
        if (target === undefined) throw new Error(`jump to missing label '${jump}' at row ${pc}`);
        pc = target;
      } else {
        pc += 1;
      }
    }
    const done = ctx.onDone;
    if (done) done();
  }

  // ScriptRunner.lua:197 resume — advance the parked generator; a finished
  // generator frees the runner.
  resume(): void {
    const co = this.co;
    if (!co) return;
    // ScriptRunner.lua:199-207: a completion callback can fire SYNCHRONOUSLY
    // from inside the running generator (a text box that closes on the tick
    // it opened, a warp whose destination is locked). Re-entering it would
    // throw and kill the script, so land the pending yield and continue on
    // the next update tick instead.
    if (this.resuming) {
      this.waitingFrames = 1;
      return;
    }
    this.resuming = true;
    let r: IteratorResult<void, void>;
    try {
      r = co.next();
    } finally {
      this.resuming = false;
    }
    if (r.done) {
      if (this.co === co) {
        this.co = null;
        this.waitingFrames = null;
      }
    }
  }

  // ScriptRunner.lua:233 update — frame waits re-resume every step.
  update(): void {
    if (this.isRunning() && this.waitingFrames !== null) {
      this.waitingFrames -= 1;
      if (this.waitingFrames <= 0) {
        this.waitingFrames = null;
        this.resume();
      }
    }
  }
}
