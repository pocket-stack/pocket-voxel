// Sound programs — a port of gen1recomp `RomExtractor.lua:2065-2114`
// extractAudio.
//
// The ROM's music, sound effects and cries are channel programs living in a
// handful of banks; the extractor copies those banks out whole
// (`programs.bin`) and writes the manifest's audio block back out beside
// them (`audio.json`), resolving the one table that needs ROM bytes: the cry
// modifiers, three bytes per species at `cryData`.
//
// The banks are content, so like every other imported byte they land under
// dist/ and are never committed (docs/VOXEL.md §1).

import type { Ctx } from "../ctx.ts";
import type { ProgramHeaderSpec } from "../manifest.ts";

const BANK_SIZE = 0x4000;

/** RomExtractor.lua:2071 — Red/Blue's three sound banks. Yellow adds $20. */
export const DEFAULT_PROGRAM_BANKS = [2, 8, 31];

export interface CryRecord {
  header: ProgramHeaderSpec;
  pitch: number;
  length: number;
}

export interface AudioOut {
  json: Record<string, unknown>;
  /** The concatenated bank windows, in `bankOrder`. */
  programs: Uint8Array;
}

/** RomExtractor.lua:2101-2107 — MISSINGNO/UNUSED rows are read but dropped. */
function isRealSpecies(id: string): boolean {
  return !id.startsWith("MISSINGNO") && !id.startsWith("UNUSED");
}

export function extractAudio(ctx: Ctx): AudioOut {
  const audio = ctx.manifest.audio;
  const bankOrder = audio.programBanks ?? DEFAULT_PROGRAM_BANKS;

  // :2072-2077 — each bank is its whole 0x4000 window, concatenated in order.
  const programs = new Uint8Array(bankOrder.length * BANK_SIZE);
  bankOrder.forEach((bank, index) => {
    programs.set(Uint8Array.from(ctx.rom.bytes(bank, BANK_SIZE, BANK_SIZE)), index * BANK_SIZE);
  });

  // :2096-2107 — the cry table is indexed by INTERNAL species index (the
  // constants' speciesOrder), three bytes each: header id, pitch, length.
  const cries: Record<string, CryRecord> = {};
  const cryData = audio.cryData;
  ctx.manifest.constants.speciesOrder.forEach((species, index) => {
    const row = ctx.rom.bytes(cryData.bank, cryData.address + index * 3, 3);
    if (!isRealSpecies(species)) return;
    cries[species] = {
      header: audio.cryHeaders[String(row[0])],
      pitch: row[1],
      length: row[2],
    };
  });

  // :2087-2113 — the manifest block, plus the fields the runtime reads.
  // `pikaCries` is Yellow-only (:2094) and has no Red counterpart.
  return {
    json: {
      ...audio,
      runtime: true,
      programFile: "programs.bin",
      bankOrder,
      songs: { ...audio.musicHeaders },
      sfx: audio.sfxHeaders,
      cries,
      source: "canonical Pokemon Red ROM sound programs",
    },
    programs,
  };
}
