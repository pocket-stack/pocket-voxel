// Experience gain. Ports gen1recomp src/battle/Experience.lua, from pokered
// engine/battle/experience.asm:
//   exp = floor(baseExp * enemyLevel / 7) for a single participant
//   (trainer battles multiply by 1.5 in Gen 1)
// Stat experience: the defeated species' base stats are added to each
// participant's stat exp.
//
// Not ported: the Runtime exp.gain hook and pokemon.level_up emit (the mod
// layer); apply's math is otherwise verbatim.

import type { ConstantsData, SpeciesDef, StatBlock, VoxelmonData } from "../data.ts";
import { levelForExp } from "./growth.ts";
import { calc, STAT_ORDER, type DVs, type StatExp } from "./stats.ts";

/**
 * Experience.lua:14-47 gainFor — engine/battle/experience.asm order: baseExp
 * is divided by the participant count FIRST, then *level/7, then the traded
 * x1.5 (BoostExp) and finally the trainer x1.5.
 *
 * EXP.ALL (core.asm .halveExpDataLoop): the base values are halved,
 * GainExperience runs for the participants, then reruns for the whole party
 * — and because DivideExpDataByNumMonsGainingExp divides the base values IN
 * PLACE, the second pass inherits the participant division. Sequential
 * floor divisions equal one floor division by the product, so callers pass
 * numParticipants = 2*participants for the first pass and
 * 2*participants*partyCount for the whole-party pass.
 *
 * consts is data.constants; a constants.exp record can retune the divisor
 * and the traded/trainer multipliers, with the values above as defaults.
 */
export function gainFor(
  defeatedDef: SpeciesDef,
  level: number,
  isTrainer?: boolean,
  numParticipants?: number,
  traded?: boolean,
  consts?: ConstantsData,
): number {
  let divisor = 7;
  let tradedMult: number | undefined;
  let trainerMult: number | undefined;
  const tuning = consts?.exp;
  if (tuning) {
    divisor = tuning.divisor ?? divisor;
    tradedMult = tuning.tradedMult;
    trainerMult = tuning.trainerMult;
  }
  const base = Math.floor(defeatedDef.baseExp / Math.max(1, numParticipants ?? 1));
  let exp = Math.floor((base * level) / divisor);
  if (traded) {
    exp = Math.floor(exp * (tradedMult ?? 1.5));
  }
  if (isTrainer) {
    exp = Math.floor(exp * (trainerMult ?? 1.5));
  }
  return Math.max(1, exp);
}

/** The party-mon fields apply mutates. */
export interface ExpMon {
  species: string;
  level: number;
  exp: number;
  hp: number;
  dvs: DVs;
  statExp: StatExp;
  stats: StatBlock;
}

/**
 * Experience.lua:52-94 apply — applies exp/stat exp; returns
 * [levelsGained, rawExpDelta] (wExpAmountGained, printed by _ExpPointsText —
 * captured before the max-level cap, experience.asm:92-100). Stat exp is
 * divided among participants too (DivideExpDataByNumMonsGainingExp divides
 * wEnemyMonBaseStats). Each level-up recalculates stats and grows current HP
 * by the max-HP delta.
 */
export function apply(
  data: VoxelmonData,
  mon: ExpMon,
  defeatedDef: SpeciesDef,
  level: number,
  isTrainer?: boolean,
  numParticipants?: number,
  traded?: boolean,
): [number[], number] {
  const speciesDef = data.pokemon[mon.species];
  const statShare = Math.max(1, numParticipants ?? 1);
  for (const key of STAT_ORDER) {
    const gain = Math.floor(defeatedDef.baseStats[key] / statShare);
    mon.statExp[key] = Math.min(65535, (mon.statExp[key] ?? 0) + gain);
  }
  const consts = data.constants;
  const gained = gainFor(defeatedDef, level, isTrainer, numParticipants, traded, consts);
  mon.exp = mon.exp + gained;

  const cap = consts?.levelCap ?? 100;
  const levels: number[] = [];
  const newLevel = levelForExp(speciesDef.growthRate, mon.exp, cap, data.growth_rates);
  while (mon.level < Math.min(newLevel, cap)) {
    mon.level += 1;
    const old = mon.stats;
    mon.stats = calc(speciesDef, mon.level, mon.dvs, mon.statExp);
    mon.hp = Math.min(mon.stats.hp, mon.hp + (mon.stats.hp - old.hp));
    levels.push(mon.level);
  }
  return [levels, gained];
}

/**
 * Experience.lua:97-105 movesLearnedAt — moves learned when reaching exactly
 * `level` (entry.level == level, the exact Gen 1 rule; the <= level walk is
 * initial-moveset derivation, a different thing).
 */
export function movesLearnedAt(speciesDef: SpeciesDef, level: number): string[] {
  const out: string[] = [];
  for (const entry of speciesDef.learnset) {
    if (entry.level === level) {
      out.push(entry.move);
    }
  }
  return out;
}
