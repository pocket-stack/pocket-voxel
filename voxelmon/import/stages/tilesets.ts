// Port of gen1recomp RomExtractor.lua extractTilesets (lines 123-227).

import { check } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { decode2bpp } from "../gfx.ts";

function sortedNums(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function unique(values: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function extractTilesets(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest, gfx } = ctx;
  const order = manifest.constants.tilesetOrder;
  const metadata = manifest.tilesets;
  const animations = manifest.tileAnimations;
  check(metadata.length === order.length, "tileset metadata count does not match constants");

  const headers = ctx.symbol("Tilesets");
  const warpPointers = ctx.symbol("WarpTileIDPointers");
  const doorPointers = ctx.symbol("DoorTileIDPointers");
  const doors: Record<number, number[]> = {};
  {
    let address = doorPointers.address;
    while (true) {
      const tilesetId = rom.byte(doorPointers.bank, address);
      if (tilesetId === 0xff) break;
      const pointer = rom.word(doorPointers.bank, address + 1);
      doors[tilesetId] = ctx.readTerminated(doorPointers.bank, pointer, 0);
      address += 3;
    }
  }

  const out: Record<string, unknown> = {};
  for (let index = 0; index < order.length; index++) {
    const constName = order[index];
    const spec = metadata[index];
    check(spec.id === constName, "tileset metadata is out of order");
    const rowAddress = headers.address + index * 12;
    const gfxBank = rom.byte(headers.bank, rowAddress);
    const blockPointer = rom.word(headers.bank, rowAddress + 1);
    const gfxPointer = rom.word(headers.bank, rowAddress + 3);
    const collisionPointer = rom.word(headers.bank, rowAddress + 5);
    const counters = rom.bytes(headers.bank, rowAddress + 7, 3);
    const grass = rom.byte(headers.bank, rowAddress + 10);
    const animationId = rom.byte(headers.bank, rowAddress + 11);
    check(animationId < animations.length, `${constName}: unknown tile animation`);

    const blocksRaw = rom.bytes(gfxBank, blockPointer, spec.blockCount * 16);
    const blocks: number[][] = [];
    for (let offset = 0; offset < blocksRaw.length; offset += 16) {
      blocks.push(blocksRaw.slice(offset, offset + 16));
    }
    // gen1recomp RomExtractor.lua:169 — collision bank rule: Red/Blue keep
    // collision lists in ROM0; pointers in $4000-$7FFF are banked (bank 1).
    const collBank = collisionPointer < 0x4000 ? 0 : 1;
    const walkable = sortedNums(ctx.readTerminated(collBank, collisionPointer, 0xff));
    const warpPointer = rom.word(warpPointers.bank, warpPointers.address + index * 2);
    const warpTiles = sortedNums(unique(ctx.readTerminated(warpPointers.bank, warpPointer, 0xff)));

    const base = spec.imageBase;
    const gfxKey = `tilesets/${base}`;
    if (!gfx.has(gfxKey)) {
      // gen1recomp RomExtractor.lua:180 — tileset gfx length is implicit:
      // blockPointer - gfxPointer, asserted 16-aligned and <= canvas,
      // zero-padded to the manifest canvas.
      const byteLength = (spec.imageWidth * spec.imageHeight) / 4;
      const storedLength = blockPointer - gfxPointer;
      check(
        storedLength >= 0 && storedLength <= byteLength && storedLength % 16 === 0,
        `${constName}: invalid stored tileset graphics length`,
      );
      const pixels = rom.bytes(gfxBank, gfxPointer, storedLength);
      while (pixels.length < byteLength) pixels.push(0);
      gfx.add(gfxKey, decode2bpp(pixels, spec.imageWidth, spec.imageHeight));
    }

    const counterTiles = counters.filter((value) => value !== 0xff);
    out[constName] = {
      id: constName,
      source: `ROM:Tilesets[${index}]`,
      image: `assets/generated/tilesets/${base}.png`,
      imageWidth: spec.imageWidth,
      imageHeight: spec.imageHeight,
      tilesPerRow: spec.imageWidth / 8,
      blocks,
      walkable,
      counterTiles,
      grassTile: grass !== 0xff ? grass : undefined,
      doorTiles: sortedNums(doors[index] ?? []),
      warpTiles,
      animation: animations[animationId],
    };
  }
  for (let number = 1; number <= 3; number++) {
    const symbol = ctx.symbol(`FlowerTile${number}`);
    gfx.add(`tilesets/flower${number}`, decode2bpp(rom.bytes(symbol.bank, symbol.address, 16), 8, 8));
  }
  const spinner = ctx.symbol("SpinnerArrowAnimTiles");
  gfx.add("tilesets/spinners", decode2bpp(rom.bytes(spinner.bank, spinner.address, 64), 32, 8));
  return out;
}
