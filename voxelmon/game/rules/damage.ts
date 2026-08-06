// Gen 1 damage calculation. Ports gen1recomp src/battle/Damage.lua, itself
// ported from pokered engine/battle/core.asm (GetDamage / CriticalHitTest /
// AdjustDamageForMoveType / RandomizeDamage), plus the two rulesets
// (src/battle/rulesets/gen1_faithful.lua, modern_clean.lua) as data.
//
// Structural changes only: the type chart arrives as a parameter instead of
// TypeChart module state, compute's two Lua return values become a tuple,
// and the Runtime mod hooks are gone (no mod layer in this port). Every
// floor, cap and quirk is verbatim.

import type { MoveDef, SpeciesDef, StatBlock } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import { applyStage } from "./stats.ts";
import { recordFor, type StatusRecord } from "./status.ts";
import type { TypeChart } from "./typechart.ts";

// ---------------------------------------------------------------------------
// Rulesets (rulesets/gen1_faithful.lua, rulesets/modern_clean.lua, verbatim)
// ---------------------------------------------------------------------------

export interface Ruleset {
  name?: string;
  /** rand(0..255) < floor(acc*255/100): a 100% move still misses on 255. */
  oneIn256Miss?: boolean;
  /** Crits use base speed (not current speed)... */
  critUsesBaseSpeed?: boolean;
  /** ...and ignore stat stages. */
  critIgnoresStages?: boolean;
  /** Damage random factor r in [randMin, randMax], damage = damage*r/255. */
  randMin: number;
  randMax: number;
  /** Focus Energy famously QUARTERS the crit rate instead of x4. */
  focusEnergyBug?: boolean;
  /** Wild/trainer enemies never spend PP (pokered DecrementPP is player-only). */
  enemyUnlimitedPP?: boolean;
  /** Gen 1 Hyper Beam: no recharge when the target faints. */
  hyperBeamSkipRechargeOnKO?: boolean;
  /** Gen 1: poison/burn/leech seed tick right after each side's move. */
  residualAfterMove?: boolean;
}

/** rulesets/gen1_faithful.lua — the default: Gen 1 with the famous quirks. */
export const GEN1_FAITHFUL: Ruleset = {
  name: "gen1_faithful",
  oneIn256Miss: true,
  critUsesBaseSpeed: true,
  critIgnoresStages: true,
  randMin: 217,
  randMax: 255,
  focusEnergyBug: true,
  enemyUnlimitedPP: true,
  hyperBeamSkipRechargeOnKO: true,
  residualAfterMove: true,
};

/** rulesets/modern_clean.lua — same formulas, notorious quirks removed. */
export const MODERN_CLEAN: Ruleset = {
  name: "modern_clean",
  oneIn256Miss: false,
  critUsesBaseSpeed: true,
  critIgnoresStages: false,
  randMin: 217,
  randMax: 255,
  focusEnergyBug: false,
  enemyUnlimitedPP: false,
  hyperBeamSkipRechargeOnKO: false,
  residualAfterMove: false,
};

// ---------------------------------------------------------------------------
// Battlers
// ---------------------------------------------------------------------------

export type BattleStat = "attack" | "defense" | "speed" | "special";
export type StageKey = BattleStat | "accuracy" | "evasion";

export interface BadgeBoost {
  badge: string;
  stat: BattleStat;
  num?: number;
  den?: number;
}

/**
 * Damage.lua:4-7 — battlers carry curStats/curTypes (Transform/Conversion
 * can override the species values) plus volatile flags; battlers built by
 * the battle engine also carry merged badgeBoosts/statuses rows, and
 * hand-built ones fall back to the vanilla tables.
 */
export interface Battler {
  mon: { level: number; status?: string | null; stats: StatBlock };
  /** The species record (critRoll reads baseStats.speed under Gen 1 rules). */
  def: SpeciesDef;
  curStats: StatBlock;
  curTypes: string[];
  stages?: Partial<Record<StageKey, number>>;
  badges?: Record<string, boolean>;
  badgeBoosts?: BadgeBoost[];
  statuses?: Record<string, StatusRecord>;
  focusEnergy?: boolean;
  xAccuracy?: boolean;
  hazeStatReset?: boolean;
  reflect?: boolean;
  lightScreen?: boolean;
}

/** The move fields compute reads; MoveDef satisfies this. */
export type DamageMove = Pick<MoveDef, "id" | "type" | "power"> &
  Partial<Pick<MoveDef, "accuracy" | "category" | "highCrit">>;

/**
 * Damage.lua:20-22 HIGH_CRIT — moves with a boosted critical-hit rate
 * (CriticalHitTest checks these move ids explicitly). The move-record
 * highCrit field wins; this list covers pre-existing imported caches.
 */
const HIGH_CRIT = new Set(["KARATE_CHOP", "RAZOR_LEAF", "CRABHAMMER", "SLASH"]);

/**
 * Damage.lua:27-32 BADGE_BOOSTS — ApplyBadgeStatBoosts
 * (engine/battle/core.asm): x9/8 per badge on the named battle stat.
 */
export const BADGE_BOOSTS: BadgeBoost[] = [
  { badge: "BOULDERBADGE", stat: "attack", num: 9, den: 8 },
  { badge: "THUNDERBADGE", stat: "defense", num: 9, den: 8 },
  { badge: "SOULBADGE", stat: "speed", num: 9, den: 8 },
  { badge: "VOLCANOBADGE", stat: "special", num: 9, den: 8 },
];

/** Damage.lua:35-42 badgeBoost — the boost a battler's badge set applies. */
function badgeBoost(battler: Battler, stat: BattleStat): BadgeBoost | undefined {
  const badges = battler.badges;
  if (!badges) return undefined;
  for (const row of battler.badgeBoosts ?? BADGE_BOOSTS) {
    if (row.stat === stat && badges[row.badge]) return row;
  }
  return undefined;
}

/** Damage.lua:45-47 statusRecord. */
function statusRecord(battler: Battler): StatusRecord | undefined {
  return recordFor(battler.statuses, battler.mon.status);
}

/**
 * Damage.lua:57-84 critRoll — CriticalHitTest's shift chain exactly (each
 * left shift caps at 255): b = speed/2, then x2 (or /2 with Focus Energy's
 * famous right-shift bug — srl instead of sla), then x4 for high-crit moves
 * or /2 for normal ones. Net rates: normal = speed/512, high-crit =
 * speed*4/256 (capped), Focus Energy bug = 1/4 the usual. critUsesBaseSpeed
 * (default true, the Gen 1 rule) reads the species base speed.
 */
export function critRoll(
  ruleset: Ruleset,
  attacker: Battler,
  moveId: string | undefined,
  rng: Rng,
  highCrit?: boolean,
): boolean {
  const shl = (x: number): number => Math.min(255, x * 2);
  const speed =
    ruleset.critUsesBaseSpeed === false
      ? applyStage(attacker.curStats.speed, attacker.stages?.speed ?? 0)
      : attacker.def.baseStats.speed;
  let b = Math.floor(speed / 2);
  if (attacker.focusEnergy) {
    b = ruleset.focusEnergyBug ? Math.floor(b / 2) : shl(shl(shl(b)));
  } else {
    b = shl(b);
  }
  const high = highCrit ?? (moveId !== undefined && HIGH_CRIT.has(moveId));
  b = high ? shl(shl(b)) : Math.floor(b / 2);
  return rng.byte() < b;
}

/**
 * Damage.lua:89-106 accuracyRoll — rand(0..255) < floor(accuracy*255/100)
 * adjusted by accuracy/evasion stages (CalcHitChance scales by each stage as
 * two separate ratio multiplications, clamping each result). With
 * oneIn256Miss a max-accuracy move still misses on 255. X ACCURACY sets
 * USING_X_ACCURACY: the move simply never misses (MoveHitTest returns before
 * any accuracy math, 1/256 included).
 */
export function accuracyRoll(
  ruleset: Ruleset,
  move: DamageMove,
  attacker: Battler,
  defender: Battler,
  rng: Rng,
): boolean {
  if (attacker.xAccuracy) return true;
  const accuracy = move.accuracy ?? 100;
  let acc = Math.floor((accuracy * 255) / 100);
  acc = Math.min(255, applyStage(acc, attacker.stages?.accuracy ?? 0));
  acc = Math.min(255, applyStage(acc, -(defender.stages?.evasion ?? 0)));
  if (
    !ruleset.oneIn256Miss &&
    accuracy >= 100 &&
    (attacker.stages?.accuracy ?? 0) >= (defender.stages?.evasion ?? 0)
  ) {
    return true;
  }
  return rng.byte() < acc;
}

const warnedTypes = new Set<string>();

/**
 * Damage.lua:112-124 categoryOf — Gen 1 splits physical from special by
 * TYPE: the move's own category field wins, then the merged type record's,
 * then physical (with one warning per unknown type).
 */
function categoryOf(move: DamageMove, chart: TypeChart): string {
  let category: string | undefined = move.category ?? chart.category(move.type);
  if (category === undefined) {
    if (move.type != null && !warnedTypes.has(move.type)) {
      warnedTypes.add(move.type);
      console.warn(`move type ${move.type} has no category; treated as physical`);
    }
    category = "physical";
  }
  return category;
}

/** Damage.lua:126-128 isSpecial. */
export function isSpecial(chart: TypeChart, moveType: string): boolean {
  return chart.category(moveType) === "special";
}

export interface DamageOpts {
  rng?: Rng;
  forceCrit?: boolean;
  /** Explosion/Selfdestruct halve defense. */
  explode?: boolean;
  /** Confusion self-hit: no STAB/type/random factor. */
  typeless?: boolean;
  /**
   * Battler whose Reflect/Light Screen apply when it isn't the defender —
   * the self-hit reads the opponent's screens.
   */
  screens?: Battler | null;
}

export interface DamageInfo {
  crit: boolean;
  /** x10 combined type multiplier (0 = immune). */
  typeMult: number;
  /** A 0.25x hit that floored to zero: flagged missed, never a minimum 1. */
  missed?: boolean;
}

/**
 * Damage.lua:136-257 compute — returns [damage, { crit, typeMult, missed? }]
 * (the Lua's two return values as a tuple). The rng is consumed exactly as
 * the Lua consumes it: one crit roll (unless forceCrit is set) and one
 * random-factor roll rng(randMin, randMax) when d > 1 and not typeless.
 */
export function compute(
  ruleset: Ruleset,
  chart: TypeChart,
  attacker: Battler,
  defender: Battler,
  move: DamageMove,
  opts: DamageOpts = {},
): [number, DamageInfo] {
  // the Lua falls back to love.math.random; this port has no ambient rng, so
  // a roll reached without an injected one is a caller bug
  const needRng = (): Rng => {
    if (!opts.rng) throw new Error("Damage.compute rolled with no opts.rng injected");
    return opts.rng;
  };
  if (move.power === 0 || move.category === "status") {
    return [0, { crit: false, typeMult: 10 }];
  }

  const crit =
    opts.forceCrit ?? critRoll(ruleset, attacker, move.id, needRng(), move.highCrit);

  const special = categoryOf(move, chart) === "special";
  const atkStat: BattleStat = special ? "special" : "attack";
  const defStat: BattleStat = special ? "special" : "defense";

  let atk: number;
  let dfn: number;
  if (crit && ruleset.critIgnoresStages) {
    atk = attacker.curStats[atkStat];
    dfn = defender.curStats[defStat];
  } else {
    atk = applyStage(attacker.curStats[atkStat], attacker.stages?.[atkStat] ?? 0);
    dfn = applyStage(defender.curStats[defStat], defender.stages?.[defStat] ?? 0);
    // badge boosts (x9/8), engine/battle/core.asm ApplyBadgeStatBoosts:
    // Boulder -> attack, Thunder -> defense, Soul -> speed (TurnOrder),
    // Volcano -> special (Damage.lua:168-178)
    const atkBoost = badgeBoost(attacker, atkStat);
    if (atkBoost) {
      atk = Math.floor((atk * (atkBoost.num ?? 9)) / (atkBoost.den ?? 8));
    }
    const defBoost = badgeBoost(defender, defStat);
    if (defBoost) {
      dfn = Math.floor((dfn * (defBoost.num ?? 9)) / (defBoost.den ?? 8));
    }
    // burn halves physical attack (applied as part of the stat in Gen 1;
    // the status record's statPenalty names the stat it cuts).
    // hazeStatReset suppresses it: Haze (haze.asm ResetStats) copied the
    // unmodified attack over the burn-halved battle stat (Damage.lua:179-188)
    const penalty = statusRecord(attacker)?.statPenalty;
    if (penalty && penalty.stat === atkStat && !attacker.hazeStatReset) {
      atk = Math.max(1, Math.floor(atk / penalty.div));
    }
    // screens double the effective defense (crits bypass them). The
    // confusion self-hit is the quirk case: HandleSelfConfusionDamage swaps
    // the user's own defense in but leaves the screen check reading the
    // OPPONENT's battle status, so the typeless path takes the screen flags
    // from opts.screens (the opponent), never the user (Damage.lua:189-202)
    if (!crit) {
      let screens = opts.screens;
      if (screens === undefined && !opts.typeless) screens = defender;
      if (screens) {
        if (special && screens.lightScreen) dfn = dfn * 2;
        if (!special && screens.reflect) dfn = dfn * 2;
      }
    }
  }
  // GetDamageVars .scaleStats: when either stat no longer fits a byte, BOTH
  // are quartered (losing low bits), each bumped to at least 1
  // (Damage.lua:206-209)
  if (atk > 255 || dfn > 255) {
    atk = Math.max(1, Math.floor(atk / 4));
    dfn = Math.max(1, Math.floor(dfn / 4));
  }
  if (opts.explode) {
    dfn = Math.max(1, Math.floor(dfn / 2));
  }

  let level = attacker.mon.level;
  if (crit) level = level * 2;

  // Damage.lua:217-219 — the core formula
  let d = Math.floor(Math.floor((2 * level) / 5) + 2);
  d = Math.floor(Math.floor((d * move.power * atk) / Math.max(1, dfn)) / 50);
  d = Math.min(d, 997) + 2;

  let mult = 10;
  if (!opts.typeless) {
    // STAB (Damage.lua:224-231)
    const stab = attacker.curTypes.includes(move.type);
    if (stab) {
      d = Math.floor((d * 3) / 2);
    }
    // type effectiveness: each TypeEffects row is applied to the running
    // damage separately with its own floor (0.5*0.5 lands on
    // floor(floor(d/2)/2), not d*0.25) (Damage.lua:233-247)
    mult = chart.effectiveness(move.type, defender.curTypes);
    if (mult === 0) {
      return [0, { crit: false, typeMult: 0 }];
    }
    for (const m of chart.rows(move.type, defender.curTypes)) {
      d = Math.floor((d * m) / 10);
    }
    if (d === 0) {
      // a 2-3 damage hit at 0.25x floors to zero: the original flags the
      // move as missed rather than dealing a minimum 1
      return [0, { crit: false, typeMult: mult, missed: true }];
    }
  }

  // random factor; the typeless confusion self-hit skips RandomizeDamage
  // along with AdjustDamageForMoveType (HandleSelfConfusionDamage calls
  // CalculateDamage directly), so it is fully deterministic
  // (Damage.lua:249-255)
  if (d > 1 && !opts.typeless) {
    const r = randRange(needRng(), ruleset.randMin, ruleset.randMax);
    d = Math.floor((d * r) / 255);
  }
  return [Math.max(d, 1), { crit, typeMult: mult }];
}
