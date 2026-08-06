// Gen 1 catch algorithm. Ports gen1recomp src/battle/Catching.lua, from
// pokered engine/items/item_effects.asm (ItemUseBall).
//
// Rng call shapes: rng(0, randMax) -> rng.int(randMax + 1) and
// rng(0, 255) -> rng.byte() — roll-for-roll the Lua's consumption.

import type { Rng } from "../rng.ts";
import { recordFor, type StatusRecord } from "./status.ts";

/**
 * Catching.lua:8-23 BALLS — randMax is the ceiling of the catch roll,
 * hpFactor the X of the HP term, wobbleFactor the ballFactor2 divisor of the
 * wobble math. MASTER_BALL never rolls (autoCatch), so its factors are
 * unused. tossAnim picks the TossBallAnimation arc and flicker the
 * Master/Ultra OBJ-palette strobe (DoBallTossSpecialEffects).
 */
export interface BallDef {
  randMax: number;
  autoCatch?: boolean;
  hpFactor?: number;
  wobbleFactor?: number;
  tossAnim?: string;
  flicker?: boolean;
  /** A merged ball record's attempt fn supersedes the whole formula. */
  attempt?: (ctx: BallAttemptCtx) => [boolean, number];
}

export const BALLS: Record<string, BallDef> = {
  MASTER_BALL: { randMax: 0, autoCatch: true, tossAnim: "ULTRATOSS_ANIM", flicker: true },
  POKE_BALL: { randMax: 255, hpFactor: 12, wobbleFactor: 255, tossAnim: "TOSS_ANIM" },
  GREAT_BALL: { randMax: 200, hpFactor: 8, wobbleFactor: 200, tossAnim: "GREATTOSS_ANIM" },
  ULTRA_BALL: {
    randMax: 150,
    hpFactor: 12,
    wobbleFactor: 150,
    tossAnim: "ULTRATOSS_ANIM",
    flicker: true,
  },
  SAFARI_BALL: { randMax: 150, hpFactor: 12, wobbleFactor: 150, tossAnim: "ULTRATOSS_ANIM" },
};

/**
 * Catching.lua:28 — an unknown ball falls back to POKE_BALL's roll and the
 * 150 wobble divisor, which is what the old per-field `or` defaults
 * resolved to.
 */
const DEFAULT_BALL: BallDef = { randMax: 255, hpFactor: 12, wobbleFactor: 150 };

/** The target fields the formula reads. */
export interface CatchTargetMon {
  hp: number;
  status?: string | null;
  stats: { hp: number };
}

export interface CatchTargetDef {
  catchRate: number;
}

export interface BallAttemptCtx {
  ballDef: BallDef;
  targetMon: CatchTargetMon;
  targetDef: CatchTargetDef;
  rng: Rng;
  rateOverride?: number;
  battle?: unknown;
  vanillaAttempt(): [boolean, number];
}

export interface CatchOpts {
  ballDef?: BallDef;
  statuses?: Record<string, StatusRecord>;
  battle?: unknown;
}

/**
 * Catching.lua:41-81 stockAttempt — the stock ItemUseBall math. On failure
 * the ball wobbles per the original's shake calculation:
 * Y = rate*100/ballFactor2 (255/200/150), Z = X*Y/255 + status2 (5/10)
 * where X is the HP factor; Z<10: 0 shakes, <30: 1, <70: 2, else 3. (We use
 * the HP factor for X on both failure paths; the original reads a stale
 * quotient when the first roll fails.)
 */
export function stockAttempt(
  def: BallDef,
  targetMon: CatchTargetMon,
  targetDef: CatchTargetDef,
  rng: Rng,
  rateOverride?: number,
  statuses?: Record<string, StatusRecord>,
): [boolean, number] {
  if (def.autoCatch) return [true, 3];
  const randMax = def.randMax;
  const rate = rateOverride ?? targetDef.catchRate;

  // the status subtraction and the wobble bonus come off the merged status
  // record (SLP/FRZ 25 and +10, the rest 12 and +5)
  const s = targetMon.status;
  const record = recordFor(statuses, s);
  const statusBonus = record?.catchBonus ?? 0;

  // HP factor (X): the 255 cap applies only after BOTH divisions
  // (ItemUseBall keeps the intermediate in 16 bits); capping early collapses
  // the value (Catching.lua:53-58)
  const maxhp = targetMon.stats.hp;
  const hpQuarter = Math.max(1, Math.floor(targetMon.hp / 4));
  const factor = def.hpFactor ?? (DEFAULT_BALL.hpFactor as number);
  const f = Math.min(255, Math.floor(Math.floor((maxhp * 255) / factor) / hpQuarter));

  const shakes = (): number => {
    const ballFactor2 = def.wobbleFactor ?? (DEFAULT_BALL.wobbleFactor as number);
    const y = Math.floor((rate * 100) / ballFactor2);
    let z: number;
    if (y > 255) {
      z = 255;
    } else {
      z = Math.floor((f * y) / 255);
    }
    if (s != null) {
      z = z + (record?.shakeBonus ?? 5);
    }
    if (z < 10) return 0;
    if (z < 30) return 1;
    if (z < 70) return 2;
    return 3;
  };

  const r = rng.int(randMax + 1) - statusBonus;
  if (r < 0) return [true, 3];
  if (r > rate) return [false, shakes()];
  if (rng.byte() <= f) return [true, 3];
  return [false, shakes()];
}

/**
 * Catching.lua:89-106 attempt — returns [caught, shakes 0-3]. rateOverride
 * replaces the species catch rate (the Safari game's BAIT/ROCK-modified
 * wEnemyMonActualCatchRate). A ball record's attempt fn supersedes the whole
 * formula; its ctx.vanillaAttempt() runs the stock math with the ctx's
 * (possibly rewritten) rateOverride.
 */
export function attempt(
  ball: string,
  targetMon: CatchTargetMon,
  targetDef: CatchTargetDef,
  rng: Rng,
  rateOverride?: number,
  opts: CatchOpts = {},
): [boolean, number] {
  const def = opts.ballDef ?? BALLS[ball] ?? DEFAULT_BALL;
  const statuses = opts.statuses;
  if (def.attempt) {
    const ctx: BallAttemptCtx = {
      ballDef: def,
      targetMon,
      targetDef,
      rng,
      rateOverride,
      battle: opts.battle,
      vanillaAttempt() {
        return stockAttempt(def, targetMon, targetDef, rng, ctx.rateOverride, statuses);
      },
    };
    return def.attempt(ctx);
  }
  return stockAttempt(def, targetMon, targetDef, rng, rateOverride, statuses);
}
