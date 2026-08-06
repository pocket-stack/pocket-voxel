// Port of gen1recomp RomExtractor.lua extractTypeChart (lines 861-893).
// Multipliers stay the raw x10 bytes (0/5/10/20), never scaled to floats.

import { hexId } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";

export function extractTypeChart(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const typesById = ctx.typesById();
  const effects = ctx.symbol("TypeEffects");
  let address = effects.address;
  const matchups: unknown[] = [];
  while (rom.byte(effects.bank, address) !== 0xff) {
    const row = rom.bytes(effects.bank, address, 3);
    matchups.push({
      attacker: typesById[row[0]] ?? hexId("TYPE", row[0]),
      defender: typesById[row[1]] ?? hexId("TYPE", row[1]),
      multiplier: row[2],
    });
    address += 3;
  }
  // gen1recomp RomExtractor.lua:876 — names dedupe by bank:address (aliased
  // TypeNames labels count once).
  const names: string[] = [];
  const seen = new Set<string>();
  for (const label of manifest.typeNameLabels) {
    const symbol = ctx.symbol(label);
    const location = `${symbol.bank}:${symbol.address}`;
    if (!seen.has(location)) {
      seen.add(location);
      names.push(rom.readString(symbol.bank, symbol.address, manifest.charmap, 0x50, 16)[0]);
    }
  }
  return { source: "ROM:TypeEffects + TypeNames", matchups, names };
}
