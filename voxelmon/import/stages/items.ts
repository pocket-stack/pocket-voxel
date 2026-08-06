// Port of gen1recomp RomExtractor.lua nybbles + extractItems (lines 794-859).

import type { Ctx } from "../ctx.ts";
import { Rom } from "../rom.ts";

/** gen1recomp RomExtractor.lua:794 — nybble-unpack, high nybble first. */
export function nybbles(raw: number[], count: number): number[] {
  const out: number[] = [];
  for (const value of raw) {
    out.push(value >> 4, value & 0x0f);
  }
  while (out.length > count) out.pop();
  return out;
}

export function extractItems(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const order = manifest.items;
  const charmap = manifest.charmap;
  const names = ctx.symbol("ItemNames");
  const prices = ctx.symbol("ItemPrices");
  const keyFlags = ctx.symbol("KeyItemFlags");
  const tmPrices = ctx.symbol("TechnicalMachinePrices");

  const decodedNames: string[] = [];
  {
    let address = names.address;
    for (let i = 0; i < order.length; i++) {
      const [value, consumed] = rom.readString(names.bank, address, charmap, 0x50, 32);
      decodedNames.push(value);
      address += consumed;
    }
  }
  const numItems = manifest.numItems;
  const flags = rom.bytes(keyFlags.bank, keyFlags.address, Math.floor((numItems + 7) / 8));

  const out: Record<string, unknown> = {};
  for (let i = 0; i < order.length; i++) {
    const itemId = order[i];
    const index = i + 1;
    const entry: Record<string, unknown> = {
      id: itemId,
      index,
      name: decodedNames[i],
      price: Rom.bcd(rom.bytes(prices.bank, prices.address + i * 3, 3)),
      source: `ROM:ItemNames[${index}]`,
    };
    // gen1recomp RomExtractor.lua:829 — key-item flags apply only to
    // index <= numItems (83); bits are LSB-first within each byte.
    if (index <= numItems && ((flags[Math.floor(i / 8)] >> (i % 8)) & 1) !== 0) {
      entry.keyItem = true;
    }
    out[itemId] = entry;
  }

  for (let n = 0; n < manifest.hms.length; n++) {
    const move = manifest.hms[n];
    const number = n + 1;
    const itemId = `HM_${move}`;
    out[itemId] = {
      id: itemId,
      name: `HM${String(number).padStart(2, "0")}`,
      price: 0,
      machine: { kind: "HM", number, move },
      source: "ROM metadata manifest (HM mapping)",
    };
  }
  // gen1recomp RomExtractor.lua:844 — TM prices are nybble-packed
  // high-first; price = nybble * 1000.
  const packed = rom.bytes(
    tmPrices.bank,
    tmPrices.address,
    Math.floor((manifest.tms.length + 1) / 2),
  );
  const pricesByTm = nybbles(packed, manifest.tms.length);
  for (let n = 0; n < manifest.tms.length; n++) {
    const move = manifest.tms[n];
    const number = n + 1;
    const itemId = `TM_${move}`;
    out[itemId] = {
      id: itemId,
      name: `TM${String(number).padStart(2, "0")}`,
      price: pricesByTm[n] * 1000,
      machine: { kind: "TM", number, move },
      source: `ROM:TechnicalMachinePrices[${number}]`,
    };
  }
  return out;
}
