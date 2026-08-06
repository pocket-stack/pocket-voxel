// Port of gen1recomp RomExtractor.lua trainerParties + extractTrainers
// (lines 1234-1348). Trainer battle pics are not in the Pocket Voxel gfx
// set; the JSON keeps the manifest pic path so a later rung can decode them.

import { check, hex2, hex4 } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { Rom } from "../rom.ts";

/**
 * gen1recomp RomExtractor.lua:1234 — parties fill the [start, nextStart)
 * slice exactly; first byte 0xFF means per-mon (level, species) pairs,
 * anything else is a fixed level over a 0-terminated species list.
 */
function trainerParties(
  ctx: Ctx,
  bank: number,
  startAddress: number,
  endAddress: number,
): unknown[][] {
  const { rom } = ctx;
  const parties: unknown[][] = [];
  let address = startAddress;
  while (address < endAddress) {
    const first = rom.byte(bank, address);
    address += 1;
    const party: unknown[] = [];
    if (first === 0xff) {
      while (true) {
        const level = rom.byte(bank, address);
        address += 1;
        if (level === 0) break;
        const species = rom.byte(bank, address);
        address += 1;
        party.push({ level, species: ctx.species(species) });
      }
    } else {
      while (true) {
        const species = rom.byte(bank, address);
        address += 1;
        if (species === 0) break;
        party.push({ level: first, species: ctx.species(species) });
      }
    }
    parties.push(party);
  }
  check(address === endAddress, `trainer party data overran ${hex2(bank)}:${hex4(endAddress)}`);
  return parties;
}

export function extractTrainers(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const order = manifest.trainers;
  const names = ctx.symbol("TrainerNames");
  const pointers = ctx.symbol("TrainerDataPointers");
  const money = ctx.symbol("TrainerPicAndMoneyPointers");
  const choices = ctx.symbol("TrainerClassMoveChoiceModifications");

  const decodedNames: string[] = [];
  {
    let address = names.address;
    for (let i = 0; i < order.length; i++) {
      const [name, consumed] = rom.readString(names.bank, address, manifest.charmap, 0x50, 32);
      decodedNames.push(name);
      address += consumed;
    }
  }

  const aiMods: number[][] = [];
  {
    let address = choices.address;
    for (let i = 0; i < order.length; i++) {
      const mods: number[] = [];
      while (true) {
        const value = rom.byte(choices.bank, address);
        address += 1;
        if (value === 0) break;
        mods.push(value);
      }
      aiMods.push(mods);
    }
  }
  const partyStarts: number[] = [];
  for (let index = 0; index < order.length; index++) {
    partyStarts.push(rom.word(pointers.bank, pointers.address + index * 2));
  }
  // gen1recomp RomExtractor.lua:1300 — the last class's slice is bounded by
  // the TrainerAI symbol.
  const partyEnds = [...partyStarts.slice(1), ctx.symbol("TrainerAI").address];

  const out: Record<string, unknown> = {};
  for (let i = 0; i < order.length; i++) {
    const label = order[i];
    const index = i + 1;
    const trainerId = `OPP_${label}`;
    // gen1recomp RomExtractor.lua:1307 — 5-byte rows: 2-byte pic pointer,
    // then 3 BCD money bytes; baseMoney = floor(bcd/100).
    const rawMoney = rom.bytes(money.bank, money.address + i * 5 + 2, 3);
    const picture = manifest.trainerPics[i];
    let parties = trainerParties(ctx, pointers.bank, partyStarts[i], partyEnds[i]);
    // gen1recomp RomExtractor.lua:1317 — ChiefData is empty in the ROM (cut
    // content); the manifest carries a hand-authored party for it.
    if (parties.length === 0) {
      const override = manifest.trainerPartyOverrides?.[trainerId];
      if (override) parties = [structuredClone(override)];
    }
    out[trainerId] = {
      id: trainerId,
      index,
      name: decodedNames[i],
      source: "ROM:TrainerDataPointers",
      pic: picture ? picture.path : undefined,
      baseMoney: Math.floor(Rom.bcd(rawMoney) / 100),
      aiMods: aiMods[i],
      parties,
    };
  }
  return out;
}
