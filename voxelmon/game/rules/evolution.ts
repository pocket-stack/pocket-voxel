// Evolution check logic. Ports the rule half of gen1recomp
// src/pokemon/Evolution.lua (engine/pokemon/evos_moves.asm semantics): level
// evolutions trigger after battles once the level is reached, stone
// evolutions on item use, trade evolutions when a link trade completes.
//
// Ported: METHODS, pendingFor, pendingLevelEvo, apply (the stat/HP-delta/dex
// mutation). Not ported (UI/flow, per the check-logic-only scope): evolve,
// learnEvolutionMoves, request, checkParty, the Runtime hooks and the
// registry seam. The learn-on-evolve rule those flows call lives in
// experience.ts movesLearnedAt (entry.level == level exactly — a mon
// evolving at a learnset level gains that move, one level later does not).

import type { EvolutionEntry, SpeciesDef, VoxelmonData } from "../data.ts";
import { calc, type DVs, type StatExp } from "./stats.ts";

/** The trigger shapes METHODS dispatch on (Evolution.lua:7-10). */
export interface EvoTrigger {
  kind: "levelup" | "item" | "trade" | "manual" | (string & {});
  item?: string;
}

export interface EvoMon {
  species: string;
  level: number;
  hp: number;
  dvs: DVs;
  statExp?: StatExp;
  stats: { hp: number };
}

export interface EvolutionMethod {
  check(mon: EvoMon, evo: EvolutionEntry, trigger: EvoTrigger): boolean;
  consumesItem?: boolean;
}

/**
 * Evolution.lua:22-46 METHODS — the three vanilla methods. The Lua check
 * signature is (game, mon, evo, trigger); none of the vanilla predicates
 * read game, so the port drops it.
 */
export const METHODS: Record<string, EvolutionMethod> = {
  LEVEL: {
    check: (mon, evo, trigger) => trigger.kind === "levelup" && mon.level >= (evo.level ?? 0),
  },
  ITEM: {
    check: (_mon, evo, trigger) => trigger.kind === "item" && trigger.item === evo.item,
    consumesItem: true,
  },
  TRADE: {
    check: (_mon, _evo, trigger) => trigger.kind === "trade",
  },
};

/**
 * Evolution.lua:57-77 pendingFor — single dispatch point over the merged
 * methods (data.evolution_methods, vanilla fallback): returns
 * [species, evo] for the first matching evolutions[] row, or null. The
 * Runtime evolution.check hook wrapper is not ported.
 */
export function pendingFor(
  data: VoxelmonData,
  mon: EvoMon,
  trigger?: EvoTrigger,
): [string, EvolutionEntry] | null {
  const trig = trigger ?? { kind: "manual" };
  const def = data.pokemon[mon.species];
  const methods = (data.evolution_methods as Record<string, EvolutionMethod> | undefined) ?? METHODS;
  for (const evo of def.evolutions ?? []) {
    const method = methods[evo.method];
    if (method?.check && method.check(mon, evo, trig)) {
      return [evo.species, evo];
    }
  }
  return null;
}

/**
 * Evolution.lua:82-90 pendingLevelEvo — frozen v1 shim: a hookless LEVEL
 * check over a plain data table. Returns the target species or null.
 */
export function pendingLevelEvo(data: VoxelmonData, mon: EvoMon): string | null {
  const def = data.pokemon[mon.species];
  for (const evo of def.evolutions) {
    if (evo.method === "LEVEL" && mon.level >= (evo.level ?? 0)) {
      return evo.species;
    }
  }
  return null;
}

export interface Pokedex {
  seen: Record<string, boolean>;
  owned: Record<string, boolean>;
}

/**
 * Evolution.lua:94-109 apply — mutate the mon into the new species: stats
 * recalculated for the new base stats, current HP keeps the same HP LOST
 * (hp = newMax - lost, min 1), dex seen+owned flagged. The
 * pokemon.evolved Runtime emit is not ported.
 */
export function apply(
  data: VoxelmonData,
  mon: EvoMon,
  newSpecies: string,
  pokedex?: Pokedex,
): void {
  const newDef: SpeciesDef | undefined = data.pokemon[newSpecies];
  if (!newDef) throw new Error(`evolve into unknown species ${newSpecies}`);
  const hpLost = mon.stats.hp - mon.hp;
  mon.species = newSpecies;
  mon.stats = calc(newDef, mon.level, mon.dvs, mon.statExp);
  mon.hp = Math.max(1, mon.stats.hp - hpLost);
  if (pokedex) {
    pokedex.seen[newSpecies] = true;
    pokedex.owned[newSpecies] = true;
  }
}
