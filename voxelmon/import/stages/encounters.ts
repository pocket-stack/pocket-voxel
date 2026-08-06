// Port of gen1recomp RomExtractor.lua wildTable + extractEncounters
// (lines 1350-1400).

import { hex2, hex4 } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";

interface WildTable {
  rate: number;
  slots: { level: number; species: string }[];
}

/**
 * gen1recomp RomExtractor.lua:1350 — a rate byte, then exactly 10
 * (level, species) slots only when the rate is nonzero; grass first, then
 * water, back to back.
 */
function wildTable(ctx: Ctx, bank: number, address: number): [WildTable, WildTable] {
  const { rom } = ctx;
  const read = (): WildTable => {
    const rate = rom.byte(bank, address);
    address += 1;
    const table: WildTable = { rate, slots: [] };
    if (rate !== 0) {
      for (let i = 0; i < 10; i++) {
        const row = rom.bytes(bank, address, 2);
        address += 2;
        table.slots.push({ level: row[0], species: ctx.species(row[1]) });
      }
    }
    return table;
  };
  return [read(), read()];
}

export function extractEncounters(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const maps = manifest.constants.mapOrder;
  const pointers = ctx.symbol("WildDataPointers");
  const nothing = ctx.symbol("NothingWildMons");
  const out: Record<string, unknown> = {};
  for (let index = 0; index < maps.length; index++) {
    const address = rom.word(pointers.bank, pointers.address + index * 2);
    // gen1recomp RomExtractor.lua:1387 — maps whose pointer equals the
    // NothingWildMons symbol have no encounter entry at all.
    if (address === nothing.address) continue;
    const [grass, water] = wildTable(ctx, pointers.bank, address);
    const entry: Record<string, unknown> = {
      source: `ROM:${hex2(pointers.bank)}:${hex4(address)}`,
    };
    if (grass.rate !== 0 || grass.slots.length > 0) entry.grass = grass;
    if (water.rate !== 0 || water.slots.length > 0) entry.water = water;
    out[maps[index]] = entry;
  }
  return out;
}
