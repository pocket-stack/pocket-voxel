// Shared importer context + tiny assertion helper (docs/VOXEL.md §5).

import type { GfxBin } from "./gfx.ts";
import type { Manifest } from "./manifest.ts";
import type { Rom } from "./rom.ts";

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

export function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

/** gen1recomp RomExtractor.lua:49 — the `<PREFIX>_%02X` fallback id form. */
export function hexId(prefix: string, value: number): string {
  return `${prefix}_${hex2(value)}`;
}

export interface RomSymbol {
  bank: number;
  address: number;
  name: string;
}

export class Ctx {
  constructor(
    readonly rom: Rom,
    readonly manifest: Manifest,
    readonly gfx: GfxBin,
  ) {}

  /** gen1recomp RomExtractor.lua:63 — a missing symbol is a hard error. */
  symbol(name: string): RomSymbol {
    const location = this.manifest.symbols[name];
    check(location, `required symbol is missing: ${name}`);
    return { bank: location[0], address: location[1], name };
  }

  /** gen1recomp RomExtractor.lua:89 — read bytes until `terminator`. */
  readTerminated(bank: number, address: number, terminator: number, limit = 256): number[] {
    const out: number[] = [];
    for (let offset = 0; offset < limit; offset++) {
      const value = this.rom.byte(bank, address + offset);
      if (value === terminator) return out;
      out.push(value);
    }
    throw new Error(`unterminated byte list at ${hex2(bank)}:${hex4(address)}`);
  }

  /** gen1recomp RomExtractor.lua:993 — species id or SPECIES_XX fallback. */
  species(value: number): string {
    const order = this.manifest.constants.speciesOrder;
    if (value < 1 || value > order.length) return hexId("SPECIES", value);
    return order[value - 1];
  }

  /** gen1recomp RomExtractor.lua:999 — item id or ITEM_XX fallback. */
  item(value: number): string {
    const order = this.manifest.items;
    if (value < 1 || value > order.length) return hexId("ITEM", value);
    return order[value - 1];
  }

  /** gen1recomp RomExtractor.lua:1005 — move id; 0 means "no move" (omitted). */
  move(value: number): string | undefined {
    if (value === 0) return undefined;
    const order = this.manifest.constants.moveOrder;
    if (value < 1 || value > order.length) return hexId("MOVE", value);
    return order[value - 1];
  }

  typesById(): Record<number, string> {
    const result: Record<number, string> = {};
    for (const [name, value] of Object.entries(this.manifest.constants.types)) {
      result[value] = name;
    }
    return result;
  }
}
