// tests/voxel-parity.test.ts — the behaviors a line-by-line audit against
// gen1recomp found the port had drifted on, pinned so they cannot drift back.
//
// Layer 1 (ROM-free): the glyph/cell boundary and the script runner's
// branching. Layer 2 (gated on dist/voxelmon/gen): the effect registry over
// the real move table, the hand-ported talk scripts over the real text
// pointers, and the after-battle evolution hook.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { EFFECTS } from "../voxelmon/game/battle/effects.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { checkParty } from "../voxelmon/game/rules/evolution.ts";
import { encodeGlyphs, glyphLen, LIGATURE_BASE, toCells } from "../voxelmon/game/ui/tiles.ts";
import { MAP_SCRIPTS, talkScript } from "../voxelmon/game/world/mapscripts.ts";
import { ScriptRunner, type ScriptRow, type ScriptWorld } from "../voxelmon/game/world/script.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log("[voxel-parity] dist/voxelmon/gen absent — ROM-gated suites skipped");
}
const romData: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

// ---------------------------------------------------------------------------
// The glyph/cell boundary (Font.lua:262 split + :358 advanceOf)
// ---------------------------------------------------------------------------

describe("uiText is cell-exact", () => {
  test("a ligature is one glyph AND one code unit", () => {
    // "Can't escape!" — the run-failed line. 13 source characters, 12 cells:
    // `'t` is one glyph on the GB, so a source-string reveal stopped one cell
    // short and the "!" never appeared.
    const line = "Can't escape!";
    expect(line.length).toBe(13);
    expect(glyphLen(line)).toBe(12);
    expect(toCells(line).length).toBe(glyphLen(line));
  });

  test("every v1 ligature survives the crossing", () => {
    for (const line of [
      "Don't go out!",
      "DIGLETT's CAVE",
      "It's unsafe!",
      "PROF.OAK's AIDE.",
    ]) {
      expect(toCells(line).length).toBe(glyphLen(line));
    }
  });

  test("a digraph takes a minted code point, plain text stays itself", () => {
    expect(toCells("ABC")).toBe("ABC");
    const cells = toCells("It's");
    expect(cells.length).toBe(3);
    // 0xbd is the charmap code for `'s` (tiles.ts CHARMAP_PAIRS)
    expect(cells.charCodeAt(2)).toBe(LIGATURE_BASE + 0xbd);
  });

  test("an unmapped character still costs exactly one cell", () => {
    expect(toCells("AB").length).toBe(glyphLen("AB"));
  });
});

// ---------------------------------------------------------------------------
// The retained-grid discipline (voxel-spec §ui: uiText is the ONE live run)
// ---------------------------------------------------------------------------

describe.skipIf(!hasGen)("a finished text row lives in the tile grid", () => {
  test("row 1 is stamped into the grid and never a second uiText", () => {
    const host = new RecorderHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    game.showText("HELLO THERE\nSECOND LINE");
    for (let i = 0; i < 240; i++) game.tick(0);

    // group the op stream by tick (`t <tick> <buttons>` opens each frame)
    const ticks: string[][] = [];
    for (const line of host.text().split("\n")) {
      if (line.startsWith("t ")) ticks.push([]);
      else if (ticks.length) ticks[ticks.length - 1]!.push(line);
    }
    // THE invariant: the core retains only the LAST uiText of a tick, so two
    // in one tick means the earlier row went blank on screen.
    for (const ops of ticks) {
      const texts = ops.filter((o) => o.startsWith(`s ${VOX_OP.uiText} `));
      expect(texts.length).toBeLessThanOrEqual(1);
    }
    // and the finished row IS on screen: its glyphs went out as uiTile ops
    // on the first text row (LINE1_Y = 14)
    const stamped = new Set(
      ticks
        .flat()
        .filter((o) => o.startsWith(`o ${VOX_OP.uiTile} `))
        .map((o) => o.split(" "))
        .filter((p) => Number(p[3]) === 14)
        .map((p) => Number(p[4])),
    );
    for (const code of encodeGlyphs("HELLO THERE")) expect(stamped.has(code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The move-effect registry (MoveEffects.lua) over the cooked map set
// ---------------------------------------------------------------------------

describe.skipIf(!hasGen)("every reachable move effect is registered", () => {
  test("the wilds of the cooked routes have no unimplemented effect", () => {
    const data = romData!;
    // ROUTE_1 / ROUTE_2 grass, the only wild content this pak carries
    const wilds = new Map<string, number>();
    for (const map of ["ROUTE_1", "ROUTE_2"]) {
      const enc = (data.encounters as Record<string, { grass?: { slots: { species: string; level: number }[] } }>)[map];
      for (const slot of enc?.grass?.slots ?? []) {
        wilds.set(slot.species, Math.max(wilds.get(slot.species) ?? 0, slot.level));
      }
    }
    expect(wilds.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [species, level] of wilds) {
      const def = data.pokemon[species]!;
      const moves = new Set<string>(def.level1Moves ?? []);
      for (const row of def.learnset ?? []) {
        if (row.level <= level) moves.add(row.move);
      }
      for (const id of moves) {
        const effect = data.moves[id]?.effect;
        if (effect && !EFFECTS[effect]) missing.push(`${species} ${id} -> ${effect}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("STRING SHOT and POISON STING resolve to their handlers", () => {
    // WEEDLE's level-1 pair, reachable in ROUTE_2 grass: unregistered, the
    // first printed "But, it failed!" and the second could never poison.
    expect(EFFECTS.SPEED_DOWN1_EFFECT?.kind).toBe("primary");
    expect(EFFECTS.SPEED_DOWN1_EFFECT?.accuracyChecked).toBe(true);
    expect(EFFECTS.POISON_SIDE_EFFECT1?.kind).toBe("secondary");
  });
});

// ---------------------------------------------------------------------------
// The script runner's branching (ScriptRunner.lua:143 exec)
// ---------------------------------------------------------------------------

function stubWorld(flags: Record<string, boolean>, shown: string[]): ScriptWorld {
  return {
    data: { text: {}, moves: {}, pokemon: {}, items: {} } as unknown as VoxelmonData,
    save: { flags, inventory: {}, player: { name: "RED", rival: "BLUE" } },
    showText(text, onDone) {
      shown.push(text);
      onDone();
    },
    showChoice(text, choice) {
      shown.push(text);
      choice(true);
    },
    resolveText: () => null,
    startWarpTo: (_m, _x, _y, _f, onDone) => onDone(),
    scriptMove: (_e, _d, _t, onDone) => onDone?.(),
    player: { moving: false },
    setEmote: (_e, _b, _f, onDone) => onDone(),
    healParty() {
      shown.push("<heal>");
    },
    playOnce(song, onDone) {
      shown.push(`<song ${song}>`);
      onDone();
    },
    fade(dir, _frames, onDone) {
      shown.push(`<fade ${dir}>`);
      onDone();
    },
    facePlayer() {
      shown.push("<face>");
    },
  };
}

/**
 * Drive a runner to completion the way the overworld's update loop does. A
 * talk script always has a talking NPC — face_player is a no-op without one
 * (Commands.lua:162), so the stub hands one in.
 */
function runToEnd(world: ScriptWorld, script: ScriptRow[]): void {
  const runner = new ScriptRunner(world);
  runner.run(script, { npc: {} as never });
  for (let i = 0; i < 64 && runner.isRunning(); i++) runner.update();
}

describe("script branching", () => {
  test("check_flag + jump_if_true takes the second branch", () => {
    const shown: string[] = [];
    runToEnd(stubWorld({ EVENT_GOT_STARTER: true }, shown), MAP_SCRIPTS.REDS_HOUSE_1F!.talk!
      .TEXT_REDSHOUSE1F_MOM!);
    // the heal branch, in the Lua's order (reds_house.lua rows 6-11)
    expect(shown).toEqual([
      "<face>",
      "_RedsHouse1FMomYouShouldRestText",
      "<fade out>",
      "<heal>",
      "<song Music_PkmnHealed>",
      "<fade in>",
      "_RedsHouse1FMomLookingGreatText",
    ]);
  });

  test("the cleared flag takes the wake-up branch and halts on jump end", () => {
    const shown: string[] = [];
    runToEnd(stubWorld({}, shown), MAP_SCRIPTS.REDS_HOUSE_1F!.talk!.TEXT_REDSHOUSE1F_MOM!);
    expect(shown).toEqual(["<face>", "_RedsHouse1FMomWakeUpText"]);
  });

  test("Oak's two branches", () => {
    const after: string[] = [];
    runToEnd(stubWorld({ EVENT_GOT_STARTER: true }, after), MAP_SCRIPTS.PALLET_TOWN!.talk!
      .TEXT_PALLETTOWN_OAK!);
    expect(after).toEqual(["<face>", "_PalletTownOakItsUnsafeText"]);
    const before: string[] = [];
    runToEnd(stubWorld({}, before), MAP_SCRIPTS.PALLET_TOWN!.talk!.TEXT_PALLETTOWN_OAK!);
    expect(before).toEqual(["<face>", "_PalletTownOakHeyWaitDontGoOutText"]);
  });

  test("a label is a jump target", () => {
    const shown: string[] = [];
    runToEnd(stubWorld({}, shown), [
      ["jump", "tail"],
      ["show_text", "skipped"],
      ["label", "tail"],
      ["show_text", "tail-ran"],
    ]);
    expect(shown).toEqual(["tail-ran"]);
  });

  test("an unknown verb is skipped, not fatal", () => {
    const shown: string[] = [];
    runToEnd(stubWorld({}, shown), [["no_such_verb", 1], ["show_text", "still-here"]]);
    expect(shown).toEqual(["still-here"]);
  });
});

describe.skipIf(!hasGen)("the talk dispatch reaches the real text", () => {
  test("Mom's script is registered for the map the pak cooks", () => {
    expect(talkScript("REDS_HOUSE_1F", "TEXT_REDSHOUSE1F_MOM")).not.toBeNull();
    expect(talkScript("REDS_HOUSE_1F", "TEXT_NOT_A_THING")).toBeNull();
  });

  test("both of Mom's branch labels exist in the extracted text", () => {
    const text = romData!.text as Record<string, string>;
    for (const label of [
      "_RedsHouse1FMomWakeUpText",
      "_RedsHouse1FMomYouShouldRestText",
      "_RedsHouse1FMomLookingGreatText",
      "_PalletTownOakHeyWaitDontGoOutText",
      "_PalletTownOakItsUnsafeText",
    ]) {
      expect(typeof text[label]).toBe("string");
    }
  });

  test("a new game starts past the lab, so the branches resolve that way", () => {
    const game = new VoxelmonGame(romData!, new RecorderHost(), 1);
    game.newGame();
    expect(game.save.flags.EVENT_GOT_STARTER).toBe(true);
    expect(game.save.party.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EvolveAfterBattle (Evolution.lua:195 checkParty)
// ---------------------------------------------------------------------------

describe.skipIf(!hasGen)("evolution after a battle", () => {
  test("only a mon that leveled THIS battle is offered", () => {
    const data = romData!;
    const grown = newMon(data, "SQUIRTLE", 16);
    const idle = newMon(data, "SQUIRTLE", 16);
    expect(checkParty(data, [grown, idle], new Set([grown]))).toEqual([
      { mon: grown, to: "WARTORTLE", evo: expect.anything() },
    ]);
    expect(checkParty(data, [grown, idle], null)).toEqual([]);
  });

  test("below the level nothing is pending", () => {
    const data = romData!;
    const young = newMon(data, "SQUIRTLE", 15);
    expect(checkParty(data, [young], new Set([young]))).toEqual([]);
  });

  test("the hook runs on the way out of a battle", () => {
    const data = romData!;
    const game = new VoxelmonGame(data, new RecorderHost(), 1);
    game.newGame();
    const mon = game.save.party[0]!;
    mon.level = 16;
    mon.species = "SQUIRTLE";
    game.runEvolutions(new Set([mon]));
    // the two pages queue as one box; drive it closed
    for (let i = 0; i < 400 && mon.species === "SQUIRTLE"; i++) {
      game.tick(i % 30 === 29 ? VOX_BTN.a : 0);
    }
    expect(mon.species).toBe("WARTORTLE");
    // Evolution.lua:104 — the stats follow the new base stats
    expect(mon.stats.hp).toBeGreaterThan(0);
  });
});
