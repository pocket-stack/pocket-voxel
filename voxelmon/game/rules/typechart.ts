// Gen 1 type effectiveness. Ports gen1recomp src/battle/TypeChart.lua.
//
// The one deliberate structural change: the Lua keeps chart state at module
// level behind TypeChart.load(data); here createTypeChart(data) returns a
// value the callers thread through (Damage takes it as a parameter), so the
// guest holds no module-global dataset state. Every lookup and every floor
// is otherwise verbatim.

import type { TypeChartData, TypeRecord } from "../data.ts";

/**
 * TypeChart.lua:75-91 TYPES — Gen 1 splits physical from special by TYPE,
 * not by move: the seven types from FIRE up are special
 * (engine/battle/effect_commands.asm compares the type id against SPECIAL).
 */
export const TYPES: Record<string, TypeRecord> = {
  NORMAL: { name: "NORMAL", category: "physical" },
  FIGHTING: { name: "FIGHTING", category: "physical" },
  FLYING: { name: "FLYING", category: "physical" },
  POISON: { name: "POISON", category: "physical" },
  GROUND: { name: "GROUND", category: "physical" },
  ROCK: { name: "ROCK", category: "physical" },
  BUG: { name: "BUG", category: "physical" },
  GHOST: { name: "GHOST", category: "physical" },
  FIRE: { name: "FIRE", category: "special" },
  WATER: { name: "WATER", category: "special" },
  GRASS: { name: "GRASS", category: "special" },
  ELECTRIC: { name: "ELECTRIC", category: "special" },
  PSYCHIC_TYPE: { name: "PSYCHIC", category: "special" },
  ICE: { name: "ICE", category: "special" },
  DRAGON: { name: "DRAGON", category: "special" },
};

export interface TypeChart {
  /** TypeChart.lua:23-26 — merged type record's category, vanilla fallback. */
  category(typeId: string | undefined): "physical" | "special" | undefined;
  /** TypeChart.lua:30-33 — display name; mod types render name over raw id. */
  displayName(typeId: string): string;
  /**
   * TypeChart.lua:39-53 rows — the x10 multiplier of every TypeEffects row
   * that applies, in ROM order. AdjustDamageForMoveType applies each row to
   * the running damage separately (one application per row even when both
   * defender types match it), so callers must floor after every row.
   */
  rows(moveType: string, defenderTypes: readonly string[]): number[];
  /**
   * TypeChart.lua:57-69 effectiveness — combined x10 multiplier, one
   * floor(mult * m / 10) per defender type; neutral (10) when undeclared.
   */
  effectiveness(moveType: string, defenderTypes: readonly string[]): number;
}

/** TypeChart.lua:11-19 load — index matchups by [attacker][defender]. */
export function createTypeChart(data?: TypeChartData): TypeChart {
  const matchups = data?.matchups ?? [];
  const index = new Map<string, Map<string, number>>();
  for (const m of matchups) {
    let row = index.get(m.attacker);
    if (!row) {
      row = new Map();
      index.set(m.attacker, row);
    }
    row.set(m.defender, m.multiplier);
  }
  const types = data?.types;

  const record = (typeId: string | undefined): TypeRecord | undefined =>
    typeId === undefined ? undefined : (types?.[typeId] ?? TYPES[typeId]);

  return {
    category(typeId) {
      return record(typeId)?.category;
    },
    displayName(typeId) {
      return record(typeId)?.name ?? typeId;
    },
    rows(moveType, defenderTypes) {
      const out: number[] = [];
      for (const m of matchups) {
        if (m.attacker !== moveType) continue;
        for (const dt of defenderTypes) {
          if (m.defender === dt) {
            out.push(m.multiplier);
            break;
          }
        }
      }
      return out;
    },
    effectiveness(moveType, defenderTypes) {
      let mult = 10;
      const row = index.get(moveType);
      if (!row) return mult;
      for (const dt of defenderTypes) {
        const m = row.get(dt);
        if (m !== undefined) {
          mult = Math.floor((mult * m) / 10);
        }
      }
      return mult;
    },
  };
}
