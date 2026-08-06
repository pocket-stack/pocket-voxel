// Port of gen1recomp RomExtractor.lua extractField (lines 1733-2063),
// reduced to the Pocket Voxel gfx set (SCHEMA.md): emotes, fx/shadow,
// fx/cut_tree. The title/intro/slots/trade/townmap art the Lua also rips is
// presentation the voxel runtime replaces outright.
//
// field.json matches the parity reference exactly: manifest.field plus the
// source line. The Lua extractor additionally attaches tradeArt paths
// (RomExtractor.lua:2058); tools/build_rom_data.py — which built the
// reference — does not, and Pocket Voxel never plays the trade cinematic
// (link play is out of scope, docs/VOXEL.md §10), so tradeArt is left out.

import { check } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode1bpp, decode2bpp } from "../gfx.ts";

// gen1recomp RomExtractor.lua:1902 — bubble name -> tile symbol; Red ships
// the three shared bubbles.
const EMOTE_SYMBOLS: Record<string, string> = {
  EXCLAMATION_BUBBLE: "ShockEmote",
  QUESTION_BUBBLE: "QuestionEmote",
  SMILE_BUBBLE: "HappyEmote",
  SKULL_BUBBLE: "SkullEmote",
  HEART_BUBBLE: "HeartEmote",
  BOLT_BUBBLE: "BoltEmote",
  ZZZ_BUBBLE: "ZzzEmote",
  FISH_BUBBLE: "FishEmote",
};

export function extractField(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest, gfx } = ctx;

  // emotes.png: one 16x16 color-0-transparent bubble per manifest entry.
  const bubbleDefs = manifest.field.emotionBubbles?.bubbles ?? [];
  let emoteLabels = bubbleDefs.map((b) => EMOTE_SYMBOLS[b.name]);
  if (emoteLabels.length === 0) emoteLabels = ["ShockEmote", "QuestionEmote", "HappyEmote"];
  const emotes = new GfxImage(emoteLabels.length * 16, 16);
  emoteLabels.forEach((label, i) => {
    const symbol = ctx.symbol(label);
    blit(emotes, decode2bpp(rom.bytes(symbol.bank, symbol.address, 64), 16, 16, true), i * 16, 0);
  });
  gfx.add("emotes", emotes);

  const shadow = ctx.symbol("LedgeHoppingShadow");
  gfx.add("fx/shadow", decode1bpp(rom.bytes(shadow.bank, shadow.address, 8), 8, 8, true));

  // gen1recomp RomExtractor.lua:2028-2032 — the in-battle HUD sheets the UI
  // atlas overlays onto the $62-$78 font area (src/render/HudTiles.lua):
  // HP bar segments, <LV>/<HP> glyphs, and the three HUD line pages.
  const hpBar = ctx.symbol("HpBarAndStatusGraphics");
  gfx.add(
    "battle/font_battle_extra",
    decode2bpp(rom.bytes(hpBar.bank, hpBar.address, (120 * 16) / 4), 120, 16, true),
  );
  for (const n of [1, 2, 3] as const) {
    const hud = ctx.symbol(`BattleHudTiles${n}`);
    gfx.add(
      `battle/battle_hud_${n}`,
      decode1bpp(rom.bytes(hud.bank, hud.address, 24), 24, 8, true),
    );
  }

  // gen1recomp RomExtractor.lua:1992 — the cuttable tree is Overworld_GFX
  // tiles $2d/$2e/$3d/$3e out of the OVERWORLD tileset's own graphics blob,
  // not a named symbol.
  const overworldIndex = manifest.constants.tilesetOrder.indexOf("OVERWORLD");
  check(overworldIndex >= 0, "OVERWORLD tileset not found in tilesetOrder");
  const tilesetHeaders = ctx.symbol("Tilesets");
  const rowAddress = tilesetHeaders.address + overworldIndex * 12;
  const gfxBank = rom.byte(tilesetHeaders.bank, rowAddress);
  const gfxPointer = rom.word(tilesetHeaders.bank, rowAddress + 3);
  const cutTree = new GfxImage(16, 16);
  for (const [tileIndex, dx, dy] of [
    [0x2d, 0, 0],
    [0x2e, 8, 0],
    [0x3d, 0, 8],
    [0x3e, 8, 8],
  ] as const) {
    const tile = decode2bpp(rom.bytes(gfxBank, gfxPointer + tileIndex * 16, 16), 8, 8, true);
    blit(cutTree, tile, dx, dy);
  }
  gfx.add("fx/cut_tree", cutTree);

  // gen1recomp RomExtractor.lua:2053 — the dataset is the manifest field
  // block verbatim (trashCans.adjacent keys are already the numeric-string
  // form JSON keeps) plus the source line.
  const data = structuredClone(manifest.field) as Record<string, unknown>;
  data.source = "canonical Pokemon Red ROM + bundled port metadata";
  return data;
}
