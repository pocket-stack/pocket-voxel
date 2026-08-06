// Port of gen1recomp RomExtractor.lua animationFlags + extractMoves
// (lines 522-589).

import { check, hexId } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";

/**
 * gen1recomp RomExtractor.lua:522 — scan each move's attack animation for
 * screen-shake ($FB) and flash ($F8/$FE) commands; 2-byte special-effect
 * rows start at $D8, everything below is a 3-byte subanimation row.
 */
function animationFlags(ctx: Ctx, count: number): [boolean, boolean][] {
  const { rom } = ctx;
  const pointerTable = ctx.symbol("AttackAnimationPointers");
  const flags: [boolean, boolean][] = [];
  for (let index = 0; index < count; index++) {
    let address = rom.word(pointerTable.bank, pointerTable.address + index * 2);
    let shake = false;
    let flash = false;
    let ended = false;
    for (let i = 0; i < 256; i++) {
      const first = rom.byte(pointerTable.bank, address);
      if (first === 0xff) {
        ended = true;
        break;
      }
      if (first >= 0xd8) {
        shake = shake || first === 0xfb;
        flash = flash || first === 0xf8 || first === 0xfe;
        address += 2;
      } else {
        address += 3;
      }
    }
    check(ended, `unterminated move animation ${index + 1}`);
    flags.push([shake, flash]);
  }
  return flags;
}

export function extractMoves(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest } = ctx;
  const order = manifest.constants.moveOrder;
  const typesById = ctx.typesById();
  const effects = manifest.moveEffects;
  const charmap = manifest.charmap;
  const moves = ctx.symbol("Moves");
  const names = ctx.symbol("MoveNames");
  const sounds = ctx.symbol("MoveSoundTable");
  const flags = animationFlags(ctx, order.length);

  const decodedNames: string[] = [];
  {
    let address = names.address;
    for (let i = 0; i < order.length; i++) {
      const [value, consumed] = rom.readString(names.bank, address, charmap, 0x50, 32);
      decodedNames.push(value);
      address += consumed;
    }
  }

  const out: Record<string, unknown> = {};
  for (let i = 0; i < order.length; i++) {
    const moveId = order[i];
    const index = i + 1;
    const row = rom.bytes(moves.bank, moves.address + i * 6, 6);
    // gen1recomp RomExtractor.lua:567 — the animation id byte must equal the
    // move index.
    check(row[0] === index, "Moves row stores wrong animation id");
    const effect = effects[row[1]] ?? hexId("EFFECT", row[1]);
    const typeName = typesById[row[3]] ?? hexId("TYPE", row[3]);
    const [soundId, pitch, tempo] = rom.bytes(sounds.bank, sounds.address + i * 3, 3);
    const animation: Record<string, unknown> = {
      sound: manifest.sfxKeys[String(soundId)] ?? hexId("SFX", soundId),
      pitch,
      tempo,
    };
    if (flags[i][0]) animation.shake = true;
    if (flags[i][1]) animation.flash = true;
    out[moveId] = {
      id: moveId,
      index,
      name: decodedNames[i],
      source: `ROM:Moves[${index}]`,
      effect,
      power: row[2],
      type: typeName,
      // gen1recomp RomExtractor.lua:583 — accuracy = round(raw*100/255).
      accuracy: Math.floor((row[4] * 100) / 255 + 0.5),
      pp: row[5],
      anim: animation,
    };
  }
  return out;
}
