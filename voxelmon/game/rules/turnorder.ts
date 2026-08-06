// Turn order. Ports gen1recomp src/battle/TurnOrder.lua, from pokered
// engine/battle/core.asm MainInBattleLoop: compare effective speed; ties are
// a coin flip. Move priority reads the move record's priority field; the id
// table below covers pre-existing imported caches (Gen 1 has only
// QUICK_ATTACK first and COUNTER last).

import type { Rng } from "../rng.ts";
import { BADGE_BOOSTS, type Battler, type DamageMove } from "./damage.ts";
import { applyStage } from "./stats.ts";
import { recordFor } from "./status.ts";

/**
 * TurnOrder.lua:12-36 effectiveSpeed — stages, then the SOULBADGE x9/8
 * (ApplyBadgeStatBoosts), then the paralysis quarter (the status record's
 * statPenalty), suppressed by hazeStatReset (haze.asm ResetStats copied the
 * unmodified speed over the quartered battle stat).
 */
export function effectiveSpeed(battler: Battler): number {
  let spd = applyStage(battler.curStats.speed, battler.stages?.speed ?? 0);
  const badges = battler.badges;
  if (badges) {
    for (const row of battler.badgeBoosts ?? BADGE_BOOSTS) {
      if (row.stat === "speed" && badges[row.badge]) {
        spd = Math.floor((spd * (row.num ?? 9)) / (row.den ?? 8));
        break;
      }
    }
  }
  const penalty = recordFor(battler.statuses, battler.mon.status)?.statPenalty;
  if (penalty && penalty.stat === "speed" && !battler.hazeStatReset) {
    spd = Math.max(1, Math.floor(spd / penalty.div));
  }
  return spd;
}

/** TurnOrder.lua:38 — the vanilla priority ids. */
const PRIORITY: Record<string, number> = { QUICK_ATTACK: 1, COUNTER: -1 };

/** TurnOrder.lua:40-44 priority. */
function priority(move: DamageMove | null | undefined): number {
  if (!move) return 0;
  const record = move as { priority?: number };
  if (record.priority !== undefined) return record.priority;
  return PRIORITY[move.id] ?? 0;
}

/**
 * TurnOrder.lua:50-59 firstMover — true when battler a moves before b.
 * invertTie flips the coin-flip result only: lockstep link battles share one
 * RNG stream, so the guest inverts the tie roll to agree with the host on
 * who moves first. The coin flip is rand(0..1) == 0 -> one rng.int(2) roll.
 */
export function firstMover(
  a: Battler,
  aMove: DamageMove | null | undefined,
  b: Battler,
  bMove: DamageMove | null | undefined,
  rng: Rng,
  invertTie?: boolean,
): boolean {
  const pa = priority(aMove);
  const pb = priority(bMove);
  if (pa !== pb) return pa > pb;
  const sa = effectiveSpeed(a);
  const sb = effectiveSpeed(b);
  if (sa !== sb) return sa > sb;
  let aFirst = rng.int(2) === 0;
  if (invertTie) aFirst = !aFirst;
  return aFirst;
}
