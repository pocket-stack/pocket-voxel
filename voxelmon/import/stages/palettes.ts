// Port of gen1recomp RomExtractor.lua extractPalettes (lines 895-937).
// Red carries no CGBBasePalettes; that Yellow branch is not ported.

import type { Ctx } from "../ctx.ts";

export function extractPalettes(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const order = manifest.paletteOrder;
  const paletteTable = ctx.symbol("SuperPalettes");
  const scale5 = (value: number): number => Math.floor((value * 255) / 31 + 0.5);

  const palettes: Record<string, number[][]> = {};
  for (let index = 0; index < order.length; index++) {
    const colors: number[][] = [];
    for (let color = 0; color < 4; color++) {
      const value = rom.word(paletteTable.bank, paletteTable.address + index * 8 + color * 2);
      colors.push([
        scale5(value & 0x1f),
        scale5((value >> 5) & 0x1f),
        scale5((value >> 10) & 0x1f),
      ]);
    }
    palettes[order[index]] = colors;
  }

  // gen1recomp RomExtractor.lua:920 — MonsterPalettes reads at
  // address + index with a 1-BASED index: the table's entry 0 is the
  // deliberately skipped dex-0 slot.
  const monsterTable = ctx.symbol("MonsterPalettes");
  const monsterPalettes: Record<string, string> = {};
  for (let i = 0; i < manifest.dexOrder.length; i++) {
    const paletteId = rom.byte(monsterTable.bank, monsterTable.address + (i + 1));
    monsterPalettes[manifest.dexOrder[i]] = order[paletteId];
  }
  return {
    source: "ROM:SuperPalettes + MonsterPalettes",
    palettes,
    order,
    pokemon: monsterPalettes,
  };
}
