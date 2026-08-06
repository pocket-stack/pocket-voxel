// Gen 1 stat calculation. Ports gen1recomp src/pokemon/Stats.lua (the
// executable spec); every formula cites the Lua it ports, which itself cites
// pokered (home/move_mon.asm CalcStat):
//   stat = floor(((base + DV) * 2 + floor(ceil(sqrt(statExp)) / 4)) * level / 100) + 5
//   HP adds level + 10 instead of 5.
// All arithmetic is integer-exact for in-range inputs: ceil(sqrt(n)) for
// n <= 65535 is exact under IEEE sqrt in both Lua and JS, everything else is
// integer add/mul/floor-div inside double precision.

import type { SpeciesDef, StatBlock } from "../data.ts";
import type { Rng } from "../rng.ts";

/** Stats.lua:8 — the Gen 1 stat order (also the stat-exp share order). */
export const STAT_ORDER = ["hp", "attack", "defense", "speed", "special"] as const;
export type StatKey = (typeof STAT_ORDER)[number];

export type DVs = Partial<Record<StatKey, number>>;
export type StatExp = Partial<Record<StatKey, number>>;

/**
 * Stats.lua:11-22 randomDVs — four rand(0..15) rolls in attack, defense,
 * speed, special order; the HP DV is the low bit of each, packed 8/4/2/1.
 */
export function randomDVs(rng: Rng): Record<StatKey, number> {
  const attack = rng.int(16);
  const defense = rng.int(16);
  const speed = rng.int(16);
  const special = rng.int(16);
  const hp = (attack % 2) * 8 + (defense % 2) * 4 + (speed % 2) * 2 + (special % 2);
  return { hp, attack, defense, speed, special };
}

/**
 * Stats.lua:24-33 calcOne — CalcStat .statExpLoop finds the smallest b with
 * b*b >= statExp (a ceiling sqrt), capped at 255, and quarters it.
 */
export function calcOne(
  base: number,
  dv: number,
  statExp: number | undefined,
  level: number,
  isHP: boolean,
): number {
  const ev = Math.floor(Math.min(255, Math.ceil(Math.sqrt(statExp ?? 0))) / 4);
  const v = Math.floor(((base + dv) * 2 + ev) * level / 100);
  return isHP ? v + level + 10 : v + 5;
}

/** Stats.lua:35-43 calc — one calcOne per stat in STAT_ORDER. */
export function calc(
  speciesDef: SpeciesDef,
  level: number,
  dvs: DVs,
  statExp?: StatExp,
): StatBlock {
  const exp = statExp ?? {};
  const out = {} as StatBlock;
  for (const key of STAT_ORDER) {
    out[key] = calcOne(speciesDef.baseStats[key], dvs[key] ?? 0, exp[key], level, key === "hp");
  }
  return out;
}

/** The mutable mon fields ensure/derivation touches (box_struct prefix). */
export interface EnsurableMon {
  level?: number;
  dvs?: DVs;
  statExp?: StatExp;
  stats?: StatBlock;
  hp?: number;
}

/**
 * Stats.lua:57-65 ensure — a box_struct is a byte-for-byte prefix of
 * party_struct that stops before MON_LEVEL/MON_STATS (macros/ram.asm), so a
 * mon decoded out of a save arrives with no stat block; the original derives
 * one on the status screen (engine/pokemon/status_screen.asm:66-76) and on
 * box->party moves (engine/pokemon/add_mon.asm _MoveMon tail). Stored HP is
 * kept but clamped to the recalculated max. A mon that already has stats is
 * returned untouched.
 */
export function ensure<M extends EnsurableMon>(speciesDef: SpeciesDef | undefined, mon: M): M {
  if (typeof mon !== "object" || mon === null || typeof mon.stats === "object") return mon;
  if (typeof speciesDef !== "object" || speciesDef === null) return mon;
  if (typeof speciesDef.baseStats !== "object") return mon;
  mon.stats = calc(speciesDef, mon.level ?? 1, mon.dvs ?? {}, mon.statExp);
  const hp = typeof mon.hp === "number" ? mon.hp : mon.stats.hp;
  mon.hp = Math.max(0, Math.min(hp, mon.stats.hp));
  return mon;
}

/**
 * Stats.lua:69-74 STAGE_MULT — battle stat stage multipliers
 * (pokered data/battle/stat_modifiers.asm): stages -6..+6 as N/D pairs
 * 25/100 .. 400/100.
 */
export const STAGE_MULT: Record<number, readonly [number, number]> = {
  [-6]: [25, 100],
  [-5]: [28, 100],
  [-4]: [33, 100],
  [-3]: [40, 100],
  [-2]: [50, 100],
  [-1]: [66, 100],
  [0]: [100, 100],
  [1]: [150, 100],
  [2]: [200, 100],
  [3]: [250, 100],
  [4]: [300, 100],
  [5]: [350, 100],
  [6]: [400, 100],
};

/** Stats.lua:76-80 applyStage — floor(value*N/D), clamped to 1..999. */
export function applyStage(value: number, stage?: number): number {
  const m = STAGE_MULT[Math.max(-6, Math.min(6, stage ?? 0))];
  const v = Math.floor((value * m[0]) / m[1]);
  return Math.max(1, Math.min(999, v));
}

/**
 * Stats.lua:85-96 isShiny — the Gen 2 shiny formula applied to Gen 1 DVs
 * (the RBY "virtual shiny"): Def/Spd/Spc DV == 10 and Atk DV in the
 * even-high set {2,3,6,7,10,11,14,15}.
 */
const SHINY_ATK = new Set([2, 3, 6, 7, 10, 11, 14, 15]);

export function isShiny(dvs: DVs | undefined): boolean {
  if (typeof dvs !== "object" || dvs === null) return false;
  return (
    (dvs.defense ?? 0) === 10 &&
    (dvs.speed ?? 0) === 10 &&
    (dvs.special ?? 0) === 10 &&
    SHINY_ATK.has(dvs.attack ?? 0)
  );
}
