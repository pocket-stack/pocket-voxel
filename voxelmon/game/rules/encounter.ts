// Wild encounters from generated encounter tables. Ports gen1recomp
// src/world/Encounter.lua: on each step into a grass/water cell, a battle
// starts when rand(0..255) < map encounter rate; the slot is picked with the
// original probability buckets.
//
// The Lua caches the bucket table through Encounter.load(data); this port
// threads it as a parameter with the vanilla constant as default (same
// stale-cache fallback FieldDefaults.constant resolves to).

import type { EncounterDef, EncounterSlot } from "../data.ts";
import type { Rng } from "../rng.ts";

/**
 * Cumulative slot thresholds out of 256 (pokered
 * engine/battle/wild_encounters.asm), via gen1recomp
 * src/world/FieldDefaults.lua:210 CONSTANTS.encounterBuckets. An encounter
 * def may carry its own `buckets` of any length, as long as the last entry
 * is 256 and there are as many slots as buckets.
 */
export const ENCOUNTER_BUCKETS: readonly number[] = [
  51, 102, 141, 166, 191, 216, 229, 242, 253, 256,
];

/**
 * Encounter.lua:22-39 roll — two rand(0..255) rolls: the rate gate, then
 * the 256-bucket slot pick. A bucket with no matching slot yields no
 * encounter (nil in the Lua).
 */
export function roll(
  encounterDef: EncounterDef | null | undefined,
  rng: Rng,
  buckets: readonly number[] = ENCOUNTER_BUCKETS,
): EncounterSlot | null {
  if (!encounterDef) return null;
  const grass = encounterDef.grass;
  if (!grass || grass.rate === 0) return null;
  if (rng.byte() >= grass.rate) return null;
  const pick = rng.byte();
  const thresholds = grass.buckets ?? buckets;
  for (let i = 0; i < thresholds.length; i++) {
    if (pick < thresholds[i]) {
      const slot = grass.slots[i];
      if (slot) {
        return { species: slot.species, level: slot.level };
      }
      return null;
    }
  }
  return null;
}
