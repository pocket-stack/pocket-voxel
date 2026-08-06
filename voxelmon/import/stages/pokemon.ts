// Port of gen1recomp RomExtractor.lua decodeEvolutionsAndMoves + dexEntry +
// extractPokemon (lines 1020-1232). Pics land in gfx.bin (battle/front/*,
// battle/back/*, plus the redb/oldmanb player back pics); the trainer-card
// and pokeball sheets the Lua also rips are not part of the Pocket Voxel
// gfx set (SCHEMA.md list) and are skipped.

import { check, hex2, hex4, hexId } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { decode2bpp, matteColor0 } from "../gfx.ts";
import { decompressPic } from "../rom.ts";

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/**
 * gen1recomp RomExtractor.lua:104 — read to the end of the $4000-$7FFF
 * window (a legal over-read past the bank boundary; the decompressor stops
 * early), decompress, decode, matte the border whites transparent.
 * Returns the pic width in tiles.
 */
export function writeCompressedPic(ctx: Ctx, label: string, gfxKey: string): number {
  const symbol = ctx.symbol(label);
  const compressed = ctx.rom.bytes(symbol.bank, symbol.address, 0x8000 - symbol.address);
  const [raw, width] = decompressPic(compressed);
  ctx.gfx.add(gfxKey, matteColor0(decode2bpp(raw, width * 8, width * 8)));
  return width;
}

/** gen1recomp RomExtractor.lua:1020 — EvosMoves is INTERNAL-species-indexed. */
function decodeEvolutionsAndMoves(ctx: Ctx, index: number): [unknown[], unknown[]] {
  const { rom } = ctx;
  const pointerTable = ctx.symbol("EvosMovesPointerTable");
  let address = rom.word(pointerTable.bank, pointerTable.address + (index - 1) * 2);
  const evolutions: unknown[] = [];
  while (true) {
    const method = rom.byte(pointerTable.bank, address);
    address += 1;
    if (method === 0) break;
    if (method === 1) {
      const row = rom.bytes(pointerTable.bank, address, 2);
      address += 2;
      evolutions.push({ method: "LEVEL", level: row[0], species: ctx.species(row[1]) });
    } else if (method === 2) {
      const row = rom.bytes(pointerTable.bank, address, 3);
      address += 3;
      evolutions.push({
        method: "ITEM",
        item: ctx.item(row[0]),
        level: row[1],
        species: ctx.species(row[2]),
      });
    } else if (method === 3) {
      const row = rom.bytes(pointerTable.bank, address, 2);
      address += 2;
      evolutions.push({ method: "TRADE", level: row[0], species: ctx.species(row[1]) });
    } else {
      throw new Error(`unknown evolution method ${method} for species index ${index}`);
    }
  }

  const learnset: unknown[] = [];
  while (true) {
    const level = rom.byte(pointerTable.bank, address);
    address += 1;
    if (level === 0) break;
    const move = rom.byte(pointerTable.bank, address);
    address += 1;
    learnset.push({ level, move: ctx.move(move) });
  }
  return [evolutions, learnset];
}

/** gen1recomp RomExtractor.lua:1066 — PokedexEntryPointers is DEX-indexed. */
function dexEntry(ctx: Ctx, index: number, species: string): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const pointerTable = ctx.symbol("PokedexEntryPointers");
  let address = rom.word(pointerTable.bank, pointerTable.address + (index - 1) * 2);
  const [kind, consumed] = rom.readString(pointerTable.bank, address, manifest.charmap, 0x50, 32);
  address += consumed;
  const heightFt = rom.byte(pointerTable.bank, address);
  const heightIn = rom.byte(pointerTable.bank, address + 1);
  const weight = rom.word(pointerTable.bank, address + 2);
  address += 4;
  check(rom.byte(pointerTable.bank, address) === 0x17, `dex entry ${index} has no TX_FAR command`);
  const textAddress = rom.word(pointerTable.bank, address + 1);
  const textBank = rom.byte(pointerTable.bank, address + 3);
  const textLabel =
    manifest.dexEntryLabels[species] ?? `_DexEntry_${hex2(textBank)}_${hex4(textAddress)}`;
  return { kind, heightFt, heightIn, weight, text: textLabel };
}

export function extractPokemon(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest, gfx } = ctx;
  const speciesOrder = manifest.constants.speciesOrder;
  const dexBySpecies: Record<string, number> = {};
  manifest.dexOrder.forEach((species, i) => {
    dexBySpecies[species] = i + 1;
  });
  const typeById = ctx.typesById();
  const names = ctx.symbol("MonsterNames");
  const baseStats = ctx.symbol("BaseStats");
  // gen1recomp RomExtractor.lua:1099 — Red/Blue keep Mew outside BaseStats.
  const mewStats = manifest.symbols["MewBaseStats"] ? ctx.symbol("MewBaseStats") : undefined;
  const decodedNames: string[] = [];
  for (let i = 0; i < speciesOrder.length; i++) {
    decodedNames.push(
      rom.decodeText(rom.bytes(names.bank, names.address + i * 10, 10), manifest.charmap),
    );
  }

  const out: Record<string, unknown> = {};
  for (let i = 0; i < speciesOrder.length; i++) {
    const species = speciesOrder[i];
    const index = i + 1;
    // gen1recomp RomExtractor.lua:1112 — skip the placeholder species ids.
    if (
      species.startsWith("MISSINGNO") ||
      species.startsWith("UNUSED") ||
      species.startsWith("FOSSIL_") ||
      species.startsWith("MON_GHOST")
    ) {
      continue;
    }
    const dex = dexBySpecies[species];
    check(dex, `missing dex number for ${species}`);
    // gen1recomp RomExtractor.lua:1119 — BaseStats is DEX-indexed; Mew's
    // row comes from the MewBaseStats symbol instead.
    const row =
      species === "MEW" && mewStats
        ? rom.bytes(mewStats.bank, mewStats.address, 28)
        : rom.bytes(baseStats.bank, baseStats.address + (dex - 1) * 28, 28);
    check(row[0] === dex, `${species}: base stats dex mismatch`);

    const level1Moves: string[] = [];
    for (let position = 15; position <= 18; position++) {
      if (row[position] !== 0) level1Moves.push(ctx.move(row[position])!);
    }
    const tmhm: string[] = [];
    for (let mi = 0; mi < manifest.tmhmMoves.length; mi++) {
      const byte = row[20 + Math.floor(mi / 8)];
      if (((byte >> (mi % 8)) & 1) !== 0) tmhm.push(manifest.tmhmMoves[mi]);
    }
    const [evolutions, learnset] = decodeEvolutionsAndMoves(ctx, index);
    const asset = manifest.pokemonAssets[species];
    const front = asset.front;
    const back = asset.back;
    if (front && !gfx.has(`battle/front/${front}`)) {
      const size = writeCompressedPic(ctx, asset.frontLabel!, `battle/front/${front}`);
      // gen1recomp RomExtractor.lua:1147 — the pic's own width must equal
      // the BaseStats sprite-size nybble.
      check(size === Math.floor(row[10] / 16), `${species}: front picture size mismatch`);
    }
    if (back && !gfx.has(`battle/back/${back}`)) {
      writeCompressedPic(ctx, asset.backLabel!, `battle/back/${back}`);
    }
    const speciesTypes = uniqueStrings([
      typeById[row[6]] ?? hexId("TYPE", row[6]),
      typeById[row[7]] ?? hexId("TYPE", row[7]),
    ]);
    out[species] = {
      id: species,
      index,
      dex,
      name: decodedNames[i],
      source: `ROM:BaseStats[${dex}]`,
      types: speciesTypes,
      baseStats: { hp: row[1], attack: row[2], defense: row[3], speed: row[4], special: row[5] },
      catchRate: row[8],
      baseExp: row[9],
      level1Moves,
      growthRate: manifest.growthRates[row[19]],
      tmhm,
      learnset,
      evolutions,
      spriteFront: front ? `assets/generated/battle/front/${front}.png` : undefined,
      spriteBack: back ? `assets/generated/battle/back/${back}.png` : undefined,
      frontSize: Math.floor(row[10] / 16),
      dexEntry: dexEntry(ctx, index, species),
    };
  }

  // gen1recomp RomExtractor.lua:1185 — the non-species battle pics.
  for (const [label, name] of [
    ["FossilAerodactylPic", "fossilaerodactyl"],
    ["FossilKabutopsPic", "fossilkabutops"],
    ["GhostPic", "ghost"],
  ] as const) {
    writeCompressedPic(ctx, label, `battle/front/${name}`);
  }
  for (const [label, name] of [
    ["RedPicBack", "redb"],
    ["OldManPicBack", "oldmanb"],
  ] as const) {
    writeCompressedPic(ctx, label, `battle/${name}`);
  }
  return out;
}
