// Experience growth curves. Ports gen1recomp src/pokemon/Growth.lua, itself
// ported from pokered engine/pokemon/experience.asm (GrowthRateTable
// coefficients). Integer-exact: every curve is integer mul/floor-div within
// double precision for levels up to the cap.
//
// Not ported: Growth.registerInto (the mod-registry seam; the port has no
// registry). The optional `rates` parameter keeps the merged-record hook —
// a record's expForLevel wins over the vanilla curve, exactly as in the Lua.

import type { GrowthRateRecord } from "../data.ts";

/** Growth.lua:10-19 CURVES — the six vanilla curves. */
export const CURVES: Record<string, (n: number) => number> = {
  MEDIUM_FAST: (n) => n * n * n,
  SLIGHTLY_FAST: (n) => Math.floor((3 * n * n * n) / 4) + 10 * n * n - 30,
  SLIGHTLY_SLOW: (n) => Math.floor((3 * n * n * n) / 4) + 20 * n * n - 70,
  MEDIUM_SLOW: (n) => Math.floor((6 * n * n * n) / 5) - 15 * n * n + 100 * n - 140,
  FAST: (n) => Math.floor((4 * n * n * n) / 5),
  SLOW: (n) => Math.floor((5 * n * n * n) / 4),
};

const warned = new Set<string>();

/**
 * Growth.lua:27-41 expForLevel — a merged rates record wins; an unknown
 * curve name warns once and falls back to MEDIUM_FAST instead of
 * mis-leveling silently. Result is clamped to >= 0 (MEDIUM_SLOW goes
 * negative below level 4).
 */
export function expForLevel(
  growthRate: string,
  level: number,
  rates?: Record<string, GrowthRateRecord>,
): number {
  const record = rates?.[growthRate];
  if (record?.expForLevel) {
    return Math.max(0, record.expForLevel(level));
  }
  let curve = CURVES[growthRate];
  if (!curve) {
    if (growthRate != null && !warned.has(growthRate)) {
      warned.add(growthRate);
      console.warn(`unknown growth rate ${growthRate}; using MEDIUM_FAST`);
    }
    curve = CURVES.MEDIUM_FAST;
  }
  return Math.max(0, curve(level));
}

/**
 * Growth.lua:53-60 levelForExp — the inverse walk: highest level (capped)
 * whose threshold is <= exp.
 */
export function levelForExp(
  growthRate: string,
  exp: number,
  cap?: number,
  rates?: Record<string, GrowthRateRecord>,
): number {
  const top = cap ?? 100;
  let level = 1;
  while (level < top && expForLevel(growthRate, level + 1, rates) <= exp) {
    level += 1;
  }
  return level;
}
