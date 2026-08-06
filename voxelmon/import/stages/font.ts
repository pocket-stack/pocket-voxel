// Port of gen1recomp RomExtractor.lua extractFont (lines 388-438).

import type { Ctx } from "../ctx.ts";
import { GfxImage, TRANSPARENT, blit, decode1bpp, decode2bpp } from "../gfx.ts";

/** shade >= 2 (the Lua's r < 0.5 test) becomes black; the rest transparent. */
function darkToBlack(shaded: GfxImage): GfxImage {
  const out = new GfxImage(shaded.w, shaded.h, TRANSPARENT);
  for (let i = 0; i < shaded.px.length; i++) {
    const shade = shaded.px[i];
    out.px[i] = shade !== TRANSPARENT && shade >= 2 ? 3 : TRANSPARENT;
  }
  return out;
}

export function extractFont(ctx: Ctx): Record<string, unknown> {
  const { rom, gfx } = ctx;
  // FontGraphics is 1bpp, 128 glyph tiles laid 16 per row (128x64).
  const mainSymbol = ctx.symbol("FontGraphics");
  const raw = rom.bytes(mainSymbol.bank, mainSymbol.address, 128 * 8);
  gfx.add("fonts/font", decode1bpp(raw, 128, 64, true));

  const extraSymbol = ctx.symbol("TextBoxGraphics");
  const extra = darkToBlack(
    decode2bpp(rom.bytes(extraSymbol.bank, extraSymbol.address, 32 * 16), 128, 16),
  );
  // gen1recomp RomExtractor.lua:418 — PokedexTileGraphics overwrites the
  // first 16x8 of the extra sheet.
  const pokedex = ctx.symbol("PokedexTileGraphics");
  const dex = darkToBlack(decode2bpp(rom.bytes(pokedex.bank, pokedex.address, 32), 16, 8));
  blit(extra, dex, 0, 0);
  gfx.add("fonts/font_extra", extra);

  return {
    source: "ROM:FontGraphics, TextBoxGraphics, PokedexTileGraphics",
    image: "assets/generated/fonts/font.png",
    imageExtra: "assets/generated/fonts/font_extra.png",
    mainBase: 0x80,
    extraBase: 0x60,
    glyphsPerRow: 16,
    charmap: ctx.manifest.fontCharmap,
  };
}
