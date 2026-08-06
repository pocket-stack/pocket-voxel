// Map-script execution. Ports gen1recomp src/script/ScriptRunner.lua's
// coroutine model as a resumable generator: scripts are lists of
// ["command", args...] rows; blocking commands park the generator and a
// completion callback resumes it (ScriptRunner.lua:93 new, :119 run,
// :233 update).
//
// Only the slice's verb set is ported from src/script/Commands.lua:
// show_text :81, ask :154, set_flag :168, give_item :220, warp :308,
// wait :316, move_player :330, emote :1014.

import type { VoxelmonData } from "../data.ts";
import * as Bag from "../rules/bag.ts";
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

// Commands.lua:70 show_text — textId is looked up in generated text (by
// label or via the map's TEXT_* pointers), literal-string fallback for
// hand-written rows. subs replaces dynamic {TOKEN}s.
function* show_text(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const textId = args[0] as string;
  const subs = args[1] as Record<string, string> | undefined;
  const w = ctx.world;
  let text = (w.data.text as Record<string, string> | undefined)?.[textId]
    ?? w.resolveText(textId)
    ?? textId;
  if (subs) {
    for (const [token, value] of Object.entries(subs)) {
      text = text.replace(new RegExp(`\\{${token}:?\\w*\\}`, "g"), value);
    }
  }
  const runner = ctx.runner;
  w.showText(text, () => runner.resume());
  yield;
}

// Commands.lua:154 ask — show text, then a YES/NO box over the still-visible
// text; result lands in ctx.lastCheck.
function* ask(ctx: ScriptContext, ...args: unknown[]): Generator<void, void> {
  const textId = args[0] as string;
  const w = ctx.world;
  const text = (w.data.text as Record<string, string> | undefined)?.[textId]
    ?? w.resolveText(textId)
    ?? textId;
  const runner = ctx.runner;
  w.showChoice(text, (yes) => {
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
    w.showText((gotText as string | undefined) ?? `{PLAYER} got\n${name}!`, () =>
      runner.resume(),
    );
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

const VERBS: Record<string, Verb> = {
  show_text,
  ask,
  set_flag,
  give_item,
  warp,
  wait,
  move_player,
  emote,
};

export class ScriptRunner {
  private co: Generator<void, void> | null = null;
  waitingFrames: number | null = null;
  ctx: ScriptContext | null = null;
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

  // ScriptRunner.lua:143 exec — a command list with jump targets returned
  // as row numbers (1-based like the Lua) or Infinity for halt.
  private *exec(script: ScriptRow[], ctx: ScriptContext): Generator<void, void> {
    let pc = 1;
    while (pc <= script.length) {
      const row = script[pc - 1];
      const name = row[0];
      const fn = VERBS[name];
      if (!fn) {
        // v1 skip: old content degrades instead of dying (ScriptRunner.lua:157)
        pc += 1;
        continue;
      }
      const jump = yield* fn(ctx, ...row.slice(1));
      if (typeof jump === "number") {
        pc = jump;
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
    const r = co.next();
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
