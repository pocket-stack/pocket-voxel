// Pokémon instances + party helpers for the battle port. Ports
// gen1recomp src/pokemon/Pokemon.lua (movesAtLevel :11, new :62, heal :92)
// and src/pokemon/Party.lua (MAX/add/firstHealthy) as pure functions over
// the imported dataset. A mon is a plain object so it serializes straight
// into the save, exactly like the Lua table.

import type { SpeciesDef, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { expForLevel } from "../rules/growth.ts";
import { calc, randomDVs, type DVs, type StatExp } from "../rules/stats.ts";
import type { StatBlock } from "../data.ts";

export interface MoveSlot {
  id: string;
  pp: number;
  ppUps?: number;
}

/** The party_struct slice the battle port reads/writes (Pokemon.lua:70-88). */
export interface PartyMon {
  species: string;
  level: number;
  exp: number;
  dvs: DVs;
  statExp: StatExp;
  stats: StatBlock;
  hp: number;
  /** Gen1 catch-rate byte, frozen at creation (Pokemon.lua:80-83). */
  catchRate: number;
  status: string | null; // "SLP"|"PSN"|"BRN"|"FRZ"|"PAR"
  moves: MoveSlot[];
  nickname?: string;
  traded?: boolean;
}

/**
 * Pokemon.lua:11-31 movesAtLevel — level-1 moves plus learnset entries at or
 * below the level, keeping the most recent four (learn_move.asm behavior).
 */
export function movesAtLevel(speciesDef: SpeciesDef, level: number): string[] {
  const moves: string[] = [];
  const add = (id: string) => {
    if (!moves.includes(id)) moves.push(id);
  };
  for (const m of speciesDef.level1Moves) add(m);
  for (const entry of speciesDef.learnset) {
    if (entry.level <= level) add(entry.move);
  }
  while (moves.length > 4) moves.shift();
  return moves;
}

/**
 * Pokemon.lua:62-88 new — DVs, calc'd stats, full HP, derived move list.
 * `dvs` injected (tests, the fixed-DV starter grant) or rolled off `rng` —
 * four rand(0..15) in attack/defense/speed/special order (Stats.randomDVs).
 */
export function newMon(
  data: VoxelmonData,
  species: string,
  level: number,
  rng?: Rng,
  dvs?: DVs,
): PartyMon {
  const def = data.pokemon[species];
  if (!def) throw new Error(`unknown species ${species}`);
  const rolled =
    dvs ?? (rng ? randomDVs(rng) : { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 });
  const stats = calc(def, level, rolled);
  const moves: MoveSlot[] = [];
  for (const id of movesAtLevel(def, level)) {
    moves.push({ id, pp: data.moves[id]?.pp ?? 0 });
  }
  return {
    species,
    level,
    exp: expForLevel(def.growthRate, level, data.growth_rates),
    dvs: rolled,
    statExp: { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 },
    stats,
    hp: stats.hp,
    catchRate: def.catchRate,
    status: null,
    moves,
  };
}

/**
 * Pokemon.lua:92-101 heal — Pokémon Center / blackout heal (HealParty):
 * full HP, status cleared, every move's PP back to base + the PP-Up bonus
 * (RestoreBonusPP adds maxPP/5 per PP UP).
 */
export function healMon(data: VoxelmonData, mon: PartyMon): void {
  mon.hp = mon.stats.hp;
  mon.status = null;
  for (const mv of mon.moves) {
    const def = data.moves[mv.id];
    if (def) mv.pp = def.pp + (mv.ppUps ?? 0) * Math.floor(def.pp / 5);
  }
}

/** Party.lua:5 — max 6, like the original. */
export const PARTY_MAX = 6;

/** Party.lua:7-13 add — false when full (the box system is v1-out). */
export function partyAdd(party: PartyMon[], mon: PartyMon): boolean {
  if (party.length >= PARTY_MAX) return false;
  party.push(mon);
  return true;
}

/** Party.lua:15-20 firstHealthy. */
export function firstHealthy(party: PartyMon[]): PartyMon | null {
  for (const mon of party) {
    if (mon.hp > 0) return mon;
  }
  return null;
}
