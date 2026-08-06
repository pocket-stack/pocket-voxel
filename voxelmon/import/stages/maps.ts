// Port of gen1recomp RomExtractor.lua extractMaps (lines 229-386).

import { check, hex2, hex4 } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";

const MOVEMENT_NAMES: Record<number, string> = { 0xfe: "WALK", 0xff: "STAY" };
const RANGE_NAMES: Record<number, string> = {
  0x00: "ANY_DIR",
  0x01: "UP_DOWN",
  0x02: "LEFT_RIGHT",
  0x10: "BOULDER_MOVEMENT_BYTE_2",
  0xd0: "DOWN",
  0xd1: "UP",
  0xd2: "LEFT",
  0xd3: "RIGHT",
  0xff: "NONE",
};
// gen1recomp RomExtractor.lua:243 — connection flag order: north 0x08,
// south 0x04, west 0x02, east 0x01; 11 bytes each, present only when set.
const DIRECTIONS: [string, number][] = [
  ["north", 0x08],
  ["south", 0x04],
  ["west", 0x02],
  ["east", 0x01],
];

export function extractMaps(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const mapOrder = manifest.constants.mapOrder;
  const dimensions = manifest.constants.maps;
  const metadata = manifest.maps;
  const tilesets = manifest.constants.tilesetOrder;
  const sprites = manifest.constants.spriteOrder;

  const signed = (value: number): number => (value >= 0x80 ? value - 0x100 : value);
  const mapId = (value: number): string => {
    if (value === 0xff) return "LAST_MAP";
    check(value < mapOrder.length, `unknown map id $${hex2(value)}`);
    return mapOrder[value];
  };

  const keys = Object.keys(metadata).sort();
  const out: Record<string, unknown> = {};
  for (const constName of keys) {
    const spec = metadata[constName];
    const dims = dimensions[constName];
    const label = spec.label;
    const header = ctx.symbol(`${label}_h`);
    let address = header.address;
    const tilesetId = rom.byte(header.bank, address);
    const height = rom.byte(header.bank, address + 1);
    const width = rom.byte(header.bank, address + 2);
    check(
      width === dims.width && height === dims.height,
      `${constName}: ROM dimensions do not match metadata`,
    );
    check(tilesetId < tilesets.length, `${constName}: unknown tileset id`);
    const blockPointer = rom.word(header.bank, address + 3);
    const connectionFlags = rom.byte(header.bank, address + 9);
    address += 10;

    const connections: Record<string, unknown> = {};
    for (const [direction, flag] of DIRECTIONS) {
      if ((connectionFlags & flag) !== 0) {
        const targetId = rom.byte(header.bank, address);
        // gen1recomp RomExtractor.lua:277 — N/S use the align byte at +8,
        // W/E at +7 (swapped vs intuition); align is signed and even;
        // offset = -align/2.
        const yOffset = signed(rom.byte(header.bank, address + 7));
        const xOffset = signed(rom.byte(header.bank, address + 8));
        const encoded = direction === "north" || direction === "south" ? xOffset : yOffset;
        check(encoded % 2 === 0, `${constName}: odd connection offset`);
        connections[direction] = { map: mapId(targetId), offset: -encoded / 2 };
        address += 11;
      }
    }
    check((connectionFlags & 0xf0) === 0, `${constName}: unknown connection flags`);
    const objectPointer = rom.word(header.bank, address);
    let objectAddress = objectPointer;
    const borderBlock = rom.byte(header.bank, objectAddress);
    objectAddress += 1;

    const warpCount = rom.byte(header.bank, objectAddress);
    objectAddress += 1;
    const warps: unknown[] = [];
    for (let i = 0; i < warpCount; i++) {
      const row = rom.bytes(header.bank, objectAddress, 4);
      // gen1recomp RomExtractor.lua:303 — destWarp stays the 1-based value
      // the Lua emitted; parity depends on value equality.
      warps.push({ x: row[1], y: row[0], destMap: mapId(row[3]), destWarp: row[2] + 1 });
      objectAddress += 4;
    }

    const signCount = rom.byte(header.bank, objectAddress);
    objectAddress += 1;
    check(signCount === spec.signTexts.length, `${constName}: sign count mismatch`);
    const signs: unknown[] = [];
    for (const signText of spec.signTexts) {
      const row = rom.bytes(header.bank, objectAddress, 3);
      signs.push({ x: row[1], y: row[0], text: signText });
      objectAddress += 3;
    }

    const objectCount = rom.byte(header.bank, objectAddress);
    objectAddress += 1;
    check(objectCount === spec.objects.length, `${constName}: object count mismatch`);
    const objects: unknown[] = [];
    for (let index = 0; index < spec.objects.length; index++) {
      const objectSpec = spec.objects[index];
      const row = rom.bytes(header.bank, objectAddress, 6);
      const [spriteId, y, x, movementId, rangeId, textId] = row;
      check(spriteId >= 1 && spriteId <= sprites.length, `${constName}: unknown object sprite`);
      check(
        MOVEMENT_NAMES[movementId] !== undefined && RANGE_NAMES[rangeId] !== undefined,
        `${constName}: unknown movement encoding`,
      );
      // gen1recomp RomExtractor.lua:331 — object coords are stored +4 (the
      // border); subtract on output.
      const object: Record<string, unknown> = {
        index: index + 1,
        x: x - 4,
        y: y - 4,
        sprite: sprites[spriteId - 1],
        movement: MOVEMENT_NAMES[movementId],
        range: RANGE_NAMES[rangeId],
        text: objectSpec.text,
      };
      objectAddress += 6;
      // gen1recomp RomExtractor.lua:339 — textId &0x80 -> +1 item byte;
      // &0x40 -> +2 trainer/pokemon bytes.
      if ((textId & 0x80) !== 0) {
        check(objectSpec.item, `${constName}: unexpected item payload`);
        object.item = objectSpec.item;
        objectAddress += 1;
      } else if ((textId & 0x40) !== 0) {
        const extra = rom.bytes(header.bank, objectAddress, 2);
        objectAddress += 2;
        if (objectSpec.trainerClass) {
          object.trainerClass = objectSpec.trainerClass;
          object.trainerParty =
            typeof objectSpec.trainerParty === "string" ? objectSpec.trainerParty : extra[1];
        } else if (objectSpec.pokemon) {
          object.pokemon = objectSpec.pokemon;
          object.level = extra[1];
        } else {
          throw new Error(`${constName}: unexpected trainer or Pokemon payload`);
        }
      } else {
        check(
          !objectSpec.item && !objectSpec.trainerClass && !objectSpec.pokemon,
          `${constName}: missing extra payload`,
        );
      }
      if (objectSpec.name !== undefined) object.name = objectSpec.name;
      if (objectSpec.hidden !== undefined) object.hidden = objectSpec.hidden;
      objects.push(object);
    }

    // gen1recomp RomExtractor.lua:365 — blockmap: blockLength bytes, then
    // PAD WITH borderBlock to width*height.
    const expectedBlocks = width * height;
    check(spec.blockLength <= expectedBlocks, `${constName}: block payload exceeds map dimensions`);
    const blocks = rom.bytes(header.bank, blockPointer, spec.blockLength);
    while (blocks.length < expectedBlocks) blocks.push(borderBlock);

    out[constName] = {
      id: constName,
      label,
      index: dims.index,
      source: `ROM:${hex2(header.bank)}:${hex4(header.address)}`,
      tileset: tilesets[tilesetId],
      width,
      height,
      blocks,
      borderBlock,
      connections,
      warps,
      signs,
      objects,
    };
  }
  return out;
}
