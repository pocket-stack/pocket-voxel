// Per-turn status / volatile condition handling (Gen 1 semantics). Ports
// gen1recomp src/battle/Status.lua as pure logic: the five persistent
// conditions as records, the beforeMove gauntlet, the residual sweep.
//
// Divergences from the Lua, all presentation-side: romText lookups are
// replaced by the Lua's own inline fallback templates (the port formats the
// same English strings; ROM text decoding is the importer's job), and the
// battle argument shrinks to the rng the handlers actually consume. Every
// numeric decision — sleep counters, the 63/256 paralysis gate, the 128/256
// confusion self-hit, the 1/16 residuals and the Toxic counter — is
// bit-identical.

import type { StatBlock } from "../data.ts";
import type { Rng } from "../rng.ts";

/** The battler fields the status gauntlet reads and mutates. */
export interface StatusMon {
  hp: number;
  status?: string | null;
  stats: StatBlock;
}

export interface StatusBattler {
  mon: StatusMon;
  /** HUD display name (BattleState splices the "Enemy " prefix, not us). */
  name: string;
  curTypes?: string[];
  /** Merged statuses table; absent falls back to RECORDS (Status.lua:4-6). */
  statuses?: Record<string, StatusRecord>;
  sleepTurns?: number;
  toxicCounter?: number;
  leechSeeded?: boolean;
  flinched?: boolean;
  skipMove?: boolean;
  boundTurns?: number;
  disabledTurns?: number;
  disabledSlot?: number;
  confusedTurns?: number;
}

export interface StatusRecord {
  id: string;
  label: string;
  hudLabel: string;
  /** Status.lua catch/wobble bonuses (Catching.attempt reads these). */
  catchBonus: number;
  shakeBonus: number;
  /** The burn/paralysis stat cut (Damage.compute, TurnOrder read this). */
  statPenalty?: { stat: "attack" | "speed"; div: number };
  beforeMovePriority?: number;
  /** Returns [canMove, messages, selfHit?] (Status.lua handler contract). */
  beforeMove?: (battler: StatusBattler, rng: Rng) => [boolean, string[], boolean?];
  residual?: (battler: StatusBattler) => string[];
  canInflict?: (target: StatusBattler, opts: { moveType?: string }) => boolean;
  onInflict?: (
    target: StatusBattler,
    opts: { toxic?: boolean },
    display: string,
    rng: Rng,
  ) => string[];
}

/** Minimal %s/%d formatter for the record templates (string.format subset). */
function fmt(template: string, ...args: (string | number)[]): string {
  let i = 0;
  return template.replace(/%[sd]/g, () => String(args[i++]));
}

/**
 * Status.lua:24 — statuses with beforeMovePriority above this run before the
 * engine's held/disable/confusion volatiles; at or below, after (sleep 40
 * and freeze 30 come first, paralysis 10 comes last, like the original
 * CheckPlayerStatusConditions order).
 */
const VOLATILE_PRIORITY = 20;

/** Status.lua:26-31 hasType. */
function hasType(battler: StatusBattler, wanted: string): boolean {
  return (battler.curTypes ?? []).includes(wanted);
}

/**
 * Status.lua:38-50 damageOverTime — shared PSN/BRN residual: 1/16 max HP,
 * multiplied (and advanced) by the Toxic counter (HandlePoisonBurnLeechSeed).
 */
function damageOverTime(template: string): (battler: StatusBattler) => string[] {
  return (battler) => {
    const mon = battler.mon;
    const base = Math.max(1, Math.floor(mon.stats.hp / 16));
    let dmg = base;
    if (battler.toxicCounter !== undefined) {
      dmg = base * battler.toxicCounter;
      battler.toxicCounter += 1;
    }
    mon.hp = Math.max(0, mon.hp - dmg);
    return [fmt(template, battler.name)];
  };
}

/**
 * Status.lua:62-149 RECORDS — the five persistent conditions. The beforeMove
 * gauntlet, the residual sweep, the inflict immunities, the catch/wobble
 * bonuses and the burn/paralysis stat cut all read these fields.
 */
export const RECORDS: Record<string, StatusRecord> = {
  SLP: {
    id: "SLP",
    label: "SLP",
    hudLabel: "SLP",
    catchBonus: 25,
    shakeBonus: 10,
    beforeMovePriority: 40,
    beforeMove(battler) {
      battler.sleepTurns = (battler.sleepTurns ?? 1) - 1;
      if (battler.sleepTurns <= 0) {
        battler.mon.status = null;
        // wakes, loses the turn (Status.lua:69-74)
        return [false, [fmt("%s\nwoke up!", battler.name)]];
      }
      return [false, [fmt("%s\nis fast asleep!", battler.name)]];
    },
    onInflict(target, _opts, display, rng) {
      // Status.lua:78-82 — sleepTurns = rand(1..7)
      target.sleepTurns = 1 + rng.int(7);
      return [fmt("%s\nfell asleep!", display)];
    },
  },
  FRZ: {
    id: "FRZ",
    label: "FRZ",
    hudLabel: "FRZ",
    catchBonus: 25,
    shakeBonus: 10,
    beforeMovePriority: 30,
    beforeMove(battler) {
      return [false, [fmt("%s\nis frozen solid!", battler.name)]];
    },
    canInflict: (target) => !hasType(target, "ICE"),
    onInflict(_target, _opts, display) {
      return [fmt("%s\nwas frozen solid!", display)];
    },
  },
  PSN: {
    id: "PSN",
    label: "PSN",
    hudLabel: "PSN",
    catchBonus: 12,
    shakeBonus: 5,
    residual: damageOverTime("%s's\nhurt by poison!"),
    canInflict: (target) => !hasType(target, "POISON"),
    onInflict(target, opts, display) {
      if (opts.toxic) {
        target.toxicCounter = 1;
        return [fmt("%s's\nbadly poisoned!", display)];
      }
      return [fmt("%s\nwas poisoned!", display)];
    },
  },
  BRN: {
    id: "BRN",
    label: "BRN",
    hudLabel: "BRN",
    catchBonus: 12,
    shakeBonus: 5,
    statPenalty: { stat: "attack", div: 2 },
    residual: damageOverTime("%s's\nhurt by the burn!"),
    canInflict: (target) => !hasType(target, "FIRE"),
    onInflict(_target, _opts, display) {
      return [fmt("%s\nwas burned!", display)];
    },
  },
  PAR: {
    id: "PAR",
    label: "PAR",
    hudLabel: "PAR",
    catchBonus: 12,
    shakeBonus: 5,
    statPenalty: { stat: "speed", div: 4 },
    beforeMovePriority: 10,
    beforeMove(battler, rng) {
      // Status.lua:131-137 — cp 25 percent / jr nc: fully paralyzed on
      // rand < 63 (63/256)
      if (rng.byte() < 63) {
        return [false, [fmt("%s's\nfully paralyzed!", battler.name)]];
      }
      return [true, []];
    },
    // ParalyzeEffect_: Electric-type moves can't paralyze Ground-types
    canInflict: (target, opts) => !(opts.moveType === "ELECTRIC" && hasType(target, "GROUND")),
    onInflict(_target, _opts, display) {
      return [fmt("%s's\nparalyzed! It may\nnot attack!", display)];
    },
  },
};

/**
 * Status.lua:158-161 recordFor — the merged view when a battle is on hand,
 * the vanilla records otherwise.
 */
export function recordFor(
  statuses: Record<string, StatusRecord> | undefined,
  id: string | null | undefined,
): StatusRecord | undefined {
  if (id == null) return undefined;
  return (statuses ?? RECORDS)[id];
}

export interface BeforeMoveResult {
  canMove: boolean;
  messages: string[];
  /** true -> hurt itself in confusion. */
  selfHit?: boolean;
}

/**
 * Status.lua:171-233 beforeMove — the gauntlet. The active status record's
 * beforeMove runs at its priority slot: above VOLATILE_PRIORITY before the
 * held/disable/confusion block (sleep, freeze), at or below after it
 * (paralysis) — the original's order.
 */
export function beforeMove(battler: StatusBattler, rng: Rng): BeforeMoveResult {
  const mon = battler.mon;
  // Haze curing this mon's sleep/freeze forfeits its pending move for the
  // turn, silently (haze.asm writes $ff/CANNOT_MOVE to the selected move;
  // ExecuteMove returns immediately without a message)
  if (battler.skipMove) {
    battler.skipMove = undefined;
    return { canMove: false, messages: [] };
  }
  if (battler.flinched) {
    battler.flinched = false;
    return { canMove: false, messages: [fmt("%s\nflinched!", battler.name)] };
  }
  const record = recordFor(battler.statuses, mon.status);
  let handler = record?.beforeMove;
  const priority = handler ? (record?.beforeMovePriority ?? 0) : 0;
  const msgs: string[] = [];
  const runStatus = (): [boolean, boolean | undefined] => {
    const [canMove, statusMsgs, selfHit] = handler!(battler, rng);
    msgs.push(...statusMsgs);
    return [canMove, selfHit];
  };
  if (handler && priority > VOLATILE_PRIORITY) {
    const [canMove, selfHit] = runStatus();
    if (!canMove || selfHit) return { canMove, messages: msgs, selfHit };
    handler = undefined;
  }
  if (battler.boundTurns !== undefined && battler.boundTurns > 0) {
    battler.boundTurns -= 1;
    msgs.push(fmt("%s\ncan't move!", battler.name));
    return { canMove: false, messages: msgs };
  }
  if (battler.disabledTurns !== undefined) {
    battler.disabledTurns -= 1;
    if (battler.disabledTurns <= 0) {
      battler.disabledTurns = undefined;
      battler.disabledSlot = undefined;
      msgs.push(fmt("%s's\ndisabled no more!", battler.name));
    }
  }
  if (battler.confusedTurns !== undefined) {
    battler.confusedTurns -= 1;
    if (battler.confusedTurns <= 0) {
      battler.confusedTurns = undefined;
      msgs.push(fmt("%s\nsnapped out of\nconfusion!", battler.name));
    } else {
      msgs.push(fmt("%s\nis confused!", battler.name));
      // Status.lua:222-225 — cp 50 percent + 1 / jr c: hurt itself on
      // rand >= 128... expressed as rand < 128 selecting the self-hit
      if (rng.byte() < 128) {
        return { canMove: false, messages: msgs, selfHit: true };
      }
    }
  }
  if (handler) {
    const [canMove, selfHit] = runStatus();
    if (!canMove || selfHit) return { canMove, messages: msgs, selfHit };
  }
  return { canMove: true, messages: msgs };
}

/**
 * Status.lua:237-266 residual — end-of-turn residual damage; opponent is
 * needed for Leech Seed. Returns messages.
 */
export function residual(battler: StatusBattler, opponent: StatusBattler): string[] {
  const msgs: string[] = [];
  const mon = battler.mon;
  // the Haze move-forfeit only covers the turn Haze was used; if this mon
  // had already moved, drop the flag before it leaks into next turn
  battler.skipMove = undefined;
  if (mon.hp <= 0) return msgs;
  const record = recordFor(battler.statuses, mon.status);
  if (record?.residual) {
    msgs.push(...record.residual(battler));
  }
  if (battler.leechSeeded && mon.hp > 0 && opponent.mon.hp > 0) {
    // the shared Toxic counter multiplies (and advances on) the seed drain
    // too — the Gen 1 Leech Seed glitch
    // (HandlePoisonBurnLeechSeed_DecreaseOwnHP)
    let dmg = Math.max(1, Math.floor(mon.stats.hp / 16));
    if (battler.toxicCounter !== undefined) {
      dmg = dmg * battler.toxicCounter;
      battler.toxicCounter += 1;
    }
    dmg = Math.min(dmg, mon.hp);
    mon.hp -= dmg;
    opponent.mon.hp = Math.min(opponent.mon.stats.hp, opponent.mon.hp + dmg);
    msgs.push(fmt("LEECH SEED saps\n%s!", battler.name));
  }
  return msgs;
}
