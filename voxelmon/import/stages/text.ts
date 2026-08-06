// Port of gen1recomp RomExtractor.lua textGlyph + decodeTextCommands +
// extractText (lines 1402-1478). Produces three datasets: text,
// text_pointers, trainer_headers.

import { check, hex2 } from "../ctx.ts";
import type { Ctx, RomSymbol } from "../ctx.ts";
import { numericKeyed } from "../writer.ts";

// gen1recomp RomExtractor.lua:1402 — glyph overrides applied before the
// charmap; charmap glyphs shaped <X> rewrite to {X}.
const TEXT_GLYPH_OVERRIDES: Record<number, string> = {
  0x4b: "{_CONT}",
  0x4c: "{SCROLL}",
  0x6d: "{COLON}",
  0xf0: "¥",
};

function textGlyph(ctx: Ctx, value: number): string {
  const override = TEXT_GLYPH_OVERRIDES[value];
  if (override !== undefined) return override;
  const glyph = ctx.manifest.charmap[String(value)] ?? `{BYTE:${hex2(value)}}`;
  if (glyph.startsWith("<") && glyph.endsWith(">")) {
    return `{${glyph.slice(1, -1)}}`;
  }
  return glyph;
}

/**
 * gen1recomp RomExtractor.lua:1417 — the text-command VM: 0x50 ends the
 * stream; a 0x00 literal run also HARD-ends the whole stream on
 * 0x57/0x58/0x5F; 0x01 consumes 2 extra bytes, 0x02 and 0x09 consume 3;
 * dynamic substitutions come from the manifest, asserted in order and fully
 * consumed.
 */
function decodeTextCommands(
  ctx: Ctx,
  symbol: RomSymbol,
  substitutions: [number, string][],
): string {
  const { rom } = ctx;
  let address = symbol.address;
  let pending = 0;
  const out: string[] = [];
  for (let i = 0; i < 4096; i++) {
    const command = rom.byte(symbol.bank, address);
    address += 1;
    if (command === 0x50) {
      check(pending >= substitutions.length, `${symbol.name}: unused dynamic text substitutions`);
      return out.join("");
    } else if (command === 0) {
      while (true) {
        const value = rom.byte(symbol.bank, address);
        address += 1;
        if (value === 0x50) break;
        if (value === 0x57 || value === 0x58 || value === 0x5f) {
          check(
            pending >= substitutions.length,
            `${symbol.name}: unused dynamic text substitutions`,
          );
          return out.join("");
        }
        out.push(textGlyph(ctx, value));
      }
    } else if (command === 1 || command === 2 || command === 9) {
      const expected = substitutions[pending];
      check(expected, `${symbol.name}: missing dynamic text substitution`);
      check(command === expected[0], `${symbol.name}: dynamic text command mismatch`);
      out.push(expected[1]);
      pending += 1;
      address += command === 1 ? 2 : 3;
    } else {
      throw new Error(`${symbol.name}: unsupported text command $${hex2(command)}`);
    }
  }
  throw new Error(`${symbol.name}: text command stream is too long`);
}

export interface TextDatasets {
  texts: Record<string, string>;
  pointers: unknown;
  trainerHeaders: Record<string, unknown>;
}

export function extractText(ctx: Ctx): TextDatasets {
  const metadata = ctx.manifest.text;
  const texts: Record<string, string> = {};
  for (const label of metadata.labels) {
    texts[label] = decodeTextCommands(ctx, ctx.symbol(label), metadata.dynamic[label] ?? []);
  }
  // gen1recomp RomExtractor.lua:1466 — per-map trainer-header keys convert
  // to numbers; dense-from-1 maps become arrays (writer.numericKeyed).
  const trainerHeaders: Record<string, unknown> = {};
  for (const [mapLabel, headers] of Object.entries(metadata.trainerHeaders)) {
    trainerHeaders[mapLabel] = numericKeyed(headers);
  }
  return { texts, pointers: metadata.pointers, trainerHeaders };
}
