// The move-effect execution surface. Ports gen1recomp
// src/battle/EffectRegistry.lua (makeCtx :37, runDamaging :99) and the
// subset of src/battle/MoveEffects.lua reachable from the v1 slice's wild
// movesets (Route 1 / Route 22 / Route 2 species at L2-8 plus a starter's
// early kit — see EFFECTS below). Every other effect id degrades exactly
// the way the reference degrades an UNREGISTERED effect: a damaging move
// falls through to plain damage with a one-shot warning
// (MoveEffects.warnUnknown, MoveEffects.lua:788-793) and a status move
// prints "But, it failed!" (BattleState.lua performMove :3535-3540).

import type { MoveDef, VoxelmonData } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import type { DamageInfo, DamageMove, Ruleset } from "../rules/damage.ts";
import { recordFor } from "../rules/status.ts";
import type { TypeChart } from "../rules/typechart.ts";
import { displayName, type WildBattler } from "./battler.ts";
import { MOVE_STATUS_OR_MISS, CRIT_OHKO_TEXT } from "../rules/timing.ts";

/** Handler message list; `failed` marks a failure whose text is bespoke
 * (MoveEffects.lua SUBSTITUTE_EFFECT comment, #644). */
export type EffectMsgs = string[] & { failed?: boolean };

/** The stage callbacks of a merged move_effects record
 * (EffectRegistry.lua's record contract). */
export interface EffectRecord {
  kind: "primary" | "secondary" | "full";
  accuracyChecked?: boolean;
  run?: (ctx: EffectCtx) => EffectMsgs;
  neverMiss?: boolean;
  explode?: boolean;
  announceAnim?: boolean;
  gate?: (ctx: EffectCtx) => [boolean, string?];
  hitCount?: (ctx: EffectCtx) => number;
  beforeAccuracy?: (ctx: EffectCtx) => void;
  chooseDamage?: (ctx: EffectCtx) => [number | null, (DamageInfo & { ohko?: boolean }) | string | undefined];
  onMiss?: (ctx: EffectCtx, reason: "invulnerable" | "accuracy" | "immune" | "floored") => void;
  afterDamage?: (ctx: EffectCtx, totalDealt: number) => void;
  charge?: { invulnerable?: boolean; anim?: string; enemyAnim?: string };
  perform?: (ctx: EffectCtx) => void;
  callsMove?: (ctx: EffectCtx) => string | null;
}

/** What the pipeline needs from the battle (BattleState methods). */
export interface EffectBattle {
  data: VoxelmonData;
  rng: Rng;
  ruleset: Ruleset;
  chart: TypeChart;
  /** wDamage — shared by both sides, read by Counter (EffectRegistry.lua:203). */
  lastDamage: number;
  moveAnimRow: AnimRowRef | null;
  sayNext(text: string): void;
  waitNext(frames: number): void;
  drainNext(battler?: WildBattler, stopAt?: number): void;
  cancelMoveAnim(): void;
  /** Insert an anim/hit row after the current queue item; returns the row so
   * the pipeline can attach `hit` (EffectRegistry.lua:225-246). */
  insertHitRow(anim: string | null, isPlayer: boolean): AnimRowRef;
  applyDamage(target: WildBattler, dmg: number): number;
  onFaint(battler: WildBattler): void;
  accuracyRoll(move: DamageMove, user: WildBattler, target: WildBattler): boolean;
  computeDamage(
    user: WildBattler,
    target: WildBattler,
    move: DamageMove,
    opts: { rng: Rng; explode?: boolean },
  ): [number, DamageInfo];
  inflictStatus(
    target: WildBattler,
    status: string,
    opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
  ): string[];
}

export interface AnimRowRef {
  hit?: HitFx;
}

export interface HitFx {
  sfx: string;
  animType: number;
}

export interface EffectCtx {
  battle: EffectBattle;
  data: VoxelmonData;
  rng: Rng;
  ruleset: Ruleset;
  user: WildBattler;
  target: WildBattler;
  move: MoveDef;
  moveInst: { id: string; pp: number; struggle?: boolean };
  isCalled: boolean;
  rawDamage?: number;
  totalDealt?: number;
  brokeSub?: boolean;
  hits?: number;
  say(text: string): void;
  damage(who: WildBattler, amount: number): number;
  changeStage(who: WildBattler, stat: StageStat, delta: number, fromEnemy: boolean): EffectMsgs;
}

type StageStat = "attack" | "defense" | "speed" | "special" | "accuracy" | "evasion";

// data/battle/stat_mod_names.asm StatModTextStrings (MoveEffects.lua:33-37)
const STAT_LABEL: Record<StageStat, string> = {
  attack: "ATTACK",
  defense: "DEFENSE",
  speed: "SPEED",
  special: "SPECIAL",
  accuracy: "ACCURACY",
  evasion: "EVADE",
};

/**
 * MoveEffects.lua:43-72 changeStage — the MIST/substitute guard, the -6..6
 * clamp with "Nothing happened!" on saturation, the hazeStatReset drop
 * (effects.asm:505-506 re-bakes burn/para penalties after any stage change),
 * and the rose/fell text family.
 */
export function changeStage(
  battle: EffectBattle,
  who: WildBattler,
  stat: StageStat,
  delta: number,
  fromEnemy: boolean,
): EffectMsgs {
  if (fromEnemy && (who.substituteHP !== undefined || who.mist)) {
    if (who.mist) return [`${displayName(who)} is\nprotected by MIST!`];
    return ["But, it failed!"];
  }
  const cur = who.stages[stat] ?? 0;
  const next = Math.max(-6, Math.min(6, cur + delta));
  if (next === cur) return ["Nothing happened!"];
  who.stages[stat] = next;
  who.hazeStatReset = undefined;
  const label = STAT_LABEL[stat];
  if (delta >= 2) return [`${displayName(who)}'s\n${label}\ngreatly rose!`];
  if (delta === 1) return [`${displayName(who)}'s\n${label} rose!`];
  if (delta === -1) return [`${displayName(who)}'s\n${label} fell!`];
  return [`${displayName(who)}'s\n${label}\ngreatly fell!`];
}

/**
 * src/battle/StatusRegistry.lua:22-57 inflict — the shared immunity rules
 * (substitute blocks poison + every secondary; secondary same-type block)
 * then the record's canInflict/onInflict off rules/status RECORDS.
 */
export function inflictStatus(
  battle: EffectBattle,
  target: WildBattler,
  status: string,
  opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
): string[] {
  if (target.mon.status) return [];
  if (target.substituteHP !== undefined && (opts.secondary || status === "PSN")) {
    return [];
  }
  // FreezeBurnParalyzeEffect: a secondary status never lands when the move's
  // type matches either of the target's types (StatusRegistry.lua:31-37)
  if (opts.secondary && status !== "PSN") {
    for (const t of target.curTypes ?? []) {
      if (opts.moveType === t) return [];
    }
  }
  const record = recordFor(target.statuses, status) ?? recordFor(undefined, status);
  if (record?.canInflict && !record.canInflict(target, { moveType: opts.moveType })) {
    return [];
  }
  target.mon.status = status;
  const display = displayName(target);
  if (record?.onInflict) {
    return record.onInflict(target, { toxic: opts.toxic }, display, battle.rng);
  }
  return [`${display}\nwas afflicted\nby ${record?.label ?? status}!`];
}

// ---------------------------------------------------------------------------
// The ported handler subset. Reachable moves (dist/voxelmon/gen movesets,
// Route 1/2/22 wilds L2-5 + starters L2-8, listed in the battle port report):
//   GUST/TACKLE/QUICK_ATTACK/HORN_ATTACK/SCRATCH/PECK -> NO_ADDITIONAL_EFFECT
//   GROWL  -> ATTACK_DOWN1_EFFECT      TAIL_WHIP/LEER -> DEFENSE_DOWN1_EFFECT
//   SAND_ATTACK -> ACCURACY_DOWN1_EFFECT
//   LEECH_SEED (BULBASAUR L7) -> LEECH_SEED_EFFECT
//   BUBBLE (SQUIRTLE L8) -> SPEED_DOWN_SIDE_EFFECT
//   EMBER (CHARMANDER L9, one level past the window but one level-up away)
//          -> BURN_SIDE_EFFECT1
//   STRUGGLE (the no-PP fallback) -> RECOIL_EFFECT
// Everything else: NOT REGISTERED — degrades via the reference's own
// unknown-effect fallbacks (see module header).
// ---------------------------------------------------------------------------

function statDown(stat: StageStat, delta: number): EffectRecord["run"] {
  // MoveEffects.lua:80-84 statDown
  return (ctx) => ctx.changeStage(ctx.target, stat, -delta, true);
}

function statDownSide(stat: StageStat): EffectRecord["run"] {
  // MoveEffects.lua:133-141 statDownSide — 33 percent + 1 (85/256); the
  // side-effect branch never runs MoveHitTest so it pierces MIST
  return (ctx) => {
    if (ctx.target.substituteHP !== undefined) return [];
    if (ctx.battle.rng.byte() >= 85) return [];
    return ctx.changeStage(ctx.target, stat, -1, false);
  };
}

function statusSide(status: string, chance: number): EffectRecord["run"] {
  // MoveEffects.lua:116-131 statusSide — CheckDefrost first, then the
  // rand(0..255) < chance gate, then the registry inflict
  return (ctx) => {
    if (ctx.move.type === "FIRE" && ctx.target.mon.status === "FRZ") {
      ctx.target.mon.status = null;
      return [`Fire defrosted\n${displayName(ctx.target)}!`];
    }
    if (ctx.battle.rng.byte() >= chance) return [];
    return inflictStatus(ctx.battle, ctx.target, status, {
      moveType: ctx.move.type,
      secondary: true,
      source: ctx.move.id,
    }) as EffectMsgs;
  };
}

export const EFFECTS: Record<string, EffectRecord> = {
  // MoveEffects.lua:480
  NO_ADDITIONAL_EFFECT: { kind: "full" },

  // MoveEffects.lua:175-179 via statDown; ACC_CHECKED (MoveEffects.lua:403-409)
  ATTACK_DOWN1_EFFECT: { kind: "primary", accuracyChecked: true, run: statDown("attack", 1) },
  DEFENSE_DOWN1_EFFECT: { kind: "primary", accuracyChecked: true, run: statDown("defense", 1) },
  ACCURACY_DOWN1_EFFECT: { kind: "primary", accuracyChecked: true, run: statDown("accuracy", 1) },

  // MoveEffects.lua:189-199 — leech_seed.asm has no substitute check;
  // fails on an already-seeded or GRASS-type target
  LEECH_SEED_EFFECT: {
    kind: "primary",
    accuracyChecked: true,
    run: (ctx) => {
      if (ctx.target.leechSeeded) return ["But, it failed!"];
      for (const t of ctx.target.curTypes) {
        if (t === "GRASS") return ["But, it failed!"];
      }
      ctx.target.leechSeeded = true;
      return [`${displayName(ctx.target)}\nwas seeded!`];
    },
  },

  // MoveEffects.lua:376 (statDownSide) / :365 (statusSide BRN 26)
  SPEED_DOWN_SIDE_EFFECT: { kind: "secondary", run: statDownSide("speed") },
  BURN_SIDE_EFFECT1: { kind: "secondary", run: statusSide("BRN", 26) },

  // MoveEffects.lua:530-539 RECOIL_EFFECT — recoil.asm reads the RAW
  // computed wDamage, div 2 for Struggle, div 4 otherwise
  RECOIL_EFFECT: {
    kind: "full",
    afterDamage: (ctx) => {
      const recoil = Math.max(
        1,
        Math.floor((ctx.rawDamage ?? 0) / (ctx.moveInst.struggle ? 2 : 4)),
      );
      ctx.say(`${displayName(ctx.user)}'s\nhit with recoil!`);
      ctx.battle.applyDamage(ctx.user, recoil);
    },
  },
};

// The rest of MoveEffects.lua (primary :165-358, secondary :364-392,
// full :479-731 — sleep/poison/confusion/multi-hit/charge/trapping/thrash/
// bide/OHKO/drain/explode/hyper-beam/pay-day/swift/rage/teleport/metronome/
// mirror-move/mimic/transform/substitute/haze/screens/rest/...) is
// UNPORTED in v1: none of it is reachable from the slice's movesets, and an
// unregistered id takes the reference's own unknown-effect path.

const warned = new Set<string>();

/** MoveEffects.lua:786-793 warnUnknown. */
export function warnUnknown(effect: string): void {
  if (!warned.has(effect)) {
    warned.add(effect);
    console.warn(`move effect ${effect} not implemented; treated as plain damage`);
  }
}

export function effectRecord(effect: string | undefined): EffectRecord | undefined {
  return effect === undefined ? undefined : EFFECTS[effect];
}

/** EffectRegistry.lua:37-80 makeCtx. */
export function makeCtx(
  battle: EffectBattle,
  user: WildBattler,
  target: WildBattler,
  move: MoveDef,
  moveInst: { id: string; pp: number; struggle?: boolean },
  isCalled: boolean,
): EffectCtx {
  return {
    battle,
    data: battle.data,
    rng: battle.rng,
    ruleset: battle.ruleset,
    user,
    target,
    move,
    moveInst,
    isCalled,
    say: (text) => battle.sayNext(text),
    damage: (who, amount) => {
      const dealt = battle.applyDamage(who, amount);
      if (who.mon.hp <= 0) battle.onFaint(who);
      return dealt;
    },
    changeStage: (who, stat, delta, fromEnemy) =>
      changeStage(battle, who, stat, delta, fromEnemy),
  };
}

/**
 * EffectRegistry.lua:24-27 missBeat — a registered miss (accuracy, type
 * immunity, floored 0.25x damage, invulnerable target) pays the
 * `ld c, 30 / call DelayFrames` hold (core.asm:3155-3158/:5588) unless the
 * effect explodes.
 */
function missBeat(battle: EffectBattle, record: EffectRecord | undefined): void {
  if (record?.explode) return;
  battle.waitNext(MOVE_STATUS_OR_MISS);
}

/** EffectRegistry.lua:84-93 hitCount. */
function hitCount(ctx: EffectCtx, record: EffectRecord | undefined): number {
  if (record?.hitCount) return record.hitCount(ctx) || 1;
  const dist = (ctx.move as MoveDef & { multiHit?: number | number[] }).multiHit;
  if (dist === undefined) return 1;
  if (typeof dist === "number") return dist;
  const r = randRange(ctx.rng, 0, dist.length - 1);
  return dist[r];
}

/**
 * EffectRegistry.lua:99-316 runDamaging — the staged damaging pipeline:
 * invulnerability -> gate -> hit count -> pre-accuracy -> accuracy ->
 * damage choice -> hits (crit/effectiveness text per strike) -> multi-hit
 * tally -> after-damage -> secondary run -> faint checks. Check order and
 * rng consumption are the original's.
 */
export function runDamaging(
  battle: EffectBattle,
  ctx: EffectCtx,
  record: EffectRecord | undefined,
): void {
  const { user, target, move, moveInst } = ctx;
  const neverMiss = record?.neverMiss;

  if (target.invulnerable && !neverMiss) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s\nattack missed!`);
    record?.onMiss?.(ctx, "invulnerable");
    return;
  }

  if (record?.gate) {
    const [ok, failMsg] = record.gate(ctx);
    if (!ok) {
      battle.cancelMoveAnim();
      if (failMsg) battle.sayNext(failMsg);
      return;
    }
  }

  const hitsWanted = hitCount(ctx, record);

  record?.beforeAccuracy?.(ctx);

  if (!neverMiss) {
    if (!battle.accuracyRoll(move, user, target)) {
      if (!record?.explode) battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s\nattack missed!`);
      record?.onMiss?.(ctx, "accuracy");
      user.trappingTurns = undefined;
      return;
    }
  }

  // damage per hit (EffectRegistry.lua:148-203); COUNTER is unreachable in
  // v1's move set but the branch is self-contained, so it rides along
  let dmg: number;
  let info: DamageInfo & { ohko?: boolean };
  if (move.id === "COUNTER") {
    const lastId = target.lastMove;
    const lm = lastId && lastId !== "COUNTER" ? battle.data.moves[lastId] : undefined;
    let counterable = false;
    if (lm && (lm.power ?? 0) > 0) {
      counterable = lm.type === "NORMAL" || lm.type === "FIGHTING";
    }
    if (!counterable || battle.lastDamage === 0) {
      battle.cancelMoveAnim();
      missBeat(battle, record);
      battle.sayNext(`${displayName(user)}'s\nattack missed!`);
      return;
    }
    dmg = Math.min(65535, battle.lastDamage * 2);
    info = { crit: false, typeMult: 10 };
  } else if (record?.chooseDamage) {
    const [chosen, extra] = record.chooseDamage(ctx);
    if (chosen === null || chosen === undefined) {
      battle.cancelMoveAnim();
      if (typeof extra === "string") battle.sayNext(extra);
      return;
    }
    dmg = chosen;
    info = typeof extra === "object" && extra ? extra : { crit: false, typeMult: 10 };
  } else {
    [dmg, info] = battle.computeDamage(user, target, move, {
      rng: battle.rng,
      explode: record?.explode || undefined,
    });
  }

  if (info.typeMult === 0) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`It doesn't affect\n${displayName(target)}!`);
    record?.onMiss?.(ctx, "immune");
    return;
  }
  if (info.missed) {
    if (!record?.explode) battle.cancelMoveAnim();
    missBeat(battle, record);
    battle.sayNext(`${displayName(user)}'s\nattack missed!`);
    record?.onMiss?.(ctx, "floored");
    return;
  }
  battle.lastDamage = dmg;

  const hitSfx =
    info.typeMult > 10 ? "Super_Effective" : info.typeMult < 10 ? "Not_Very_Effective" : "Damage";
  // GetPlayerAnimationType / GetEnemyAnimationType (core.asm:3159/:5555):
  // 4/1 for a damaging move with no added effect, 5/2 once it has one
  const added = move.effect !== undefined && move.effect !== "NO_ADDITIONAL_EFFECT";
  const hitFx: HitFx = {
    sfx: hitSfx,
    animType: user.isPlayer ? (added ? 5 : 4) : added ? 2 : 1,
  };

  let totalDealt = 0;
  let landed = 0;
  let brokeSub = false;
  for (let h = 1; h <= hitsWanted; h++) {
    if (target.mon.hp <= 0) break;
    // hit 1 reuses the announcement-time moveAnimRow; later hits queue
    // fresh anim rows (EffectRegistry.lua:227-241)
    const hitRow =
      h === 1
        ? (battle.moveAnimRow ?? battle.insertHitRow(null, user.isPlayer))
        : battle.insertHitRow(move.id, user.isPlayer);
    const hadSub = target.substituteHP !== undefined;
    const dealt = battle.applyDamage(target, dmg);
    totalDealt += dealt;
    landed = h;
    if (dealt > 0) hitRow.hit = hitFx;
    if (info.crit) battle.sayNext("Critical hit!");
    if (info.ohko) battle.sayNext("One-hit KO!");
    // PrintCriticalOHKOText's closing `ld c, 20 / jp DelayFrames` is paid on
    // EVERY landed hit (core.asm:3812-3814; EffectRegistry.lua:253-259)
    battle.waitNext(CRIT_OHKO_TEXT);
    if (info.typeMult > 10) {
      battle.sayNext("It's super\neffective!");
    } else if (info.typeMult < 10) {
      battle.sayNext("It's not very\neffective...");
    }
    if (hadSub && target.substituteHP === undefined) {
      brokeSub = true;
      break;
    }
  }
  const hits = landed > 0 ? landed : hitsWanted;
  if (hits > 1) {
    battle.sayNext(
      user.isPlayer ? `Hit the enemy\n${hits} times!` : `Hit ${hits} times!`,
    );
  }

  ctx.rawDamage = dmg;
  ctx.totalDealt = totalDealt;
  ctx.brokeSub = brokeSub;
  ctx.hits = hits;
  if (record?.afterDamage) {
    record.afterDamage(ctx, totalDealt);
  } else if (moveInst.struggle) {
    // struggle recoils even when its effect id resolves to no record
    // (EffectRegistry.lua:292-297)
    const recoil = Math.max(1, Math.floor(dmg / 2));
    battle.sayNext(`${displayName(user)}'s\nhit with recoil!`);
    battle.applyDamage(user, recoil);
  }

  if (record?.run && record.kind !== "primary" && target.mon.hp > 0 && totalDealt > 0) {
    for (const m of record.run(ctx)) battle.sayNext(m);
  }
  if (record === undefined && move.effect) {
    warnUnknown(move.effect);
  }

  if (target.mon.hp <= 0) battle.onFaint(target);
  if (user.mon.hp <= 0) battle.onFaint(user);
}
