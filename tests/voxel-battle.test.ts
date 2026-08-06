// tests/voxel-battle.test.ts — the gen1recomp wild-battle port under test.
//
// Layer 1 (ROM-free, always runs): HP-bar tile math (the battle overlay
// codes) and the run-away formula against hand-checked cases.
//
// Layer 2 (gated, skips with a printed reason when dist/voxelmon/gen is
// absent): scripted wild battles driven roll-for-roll through seqRng with
// every number CROSS-CHECKED against the rules/ modules directly (the
// battle must apply what the rules compute — no drift), queue discipline,
// the classic battle-screen tile layout, and the battle.tape end-to-end
// determinism run.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { WildBattle, type BattleButton, type BattleInput, type BattleSave } from "../voxelmon/game/battle/battle.ts";
import { makeBattler } from "../voxelmon/game/battle/battler.ts";
import { newMon, type PartyMon } from "../voxelmon/game/battle/mon.ts";
import { search as arenaSearch } from "../voxelmon/game/battle/arena.ts";
import {
  HUD_BAR_EMPTY,
  HUD_BAR_FULL,
  HUD_BAR_LEFT,
  HUD_CAP_DOUBLE,
  HUD_CAP_NUB,
  HUD_HP_LABEL,
  HUD_LV,
  BattleUi,
  hpBarTiles,
} from "../voxelmon/game/battle/ui.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { encodeGlyphs } from "../voxelmon/game/ui/tiles.ts";
import type { VoxelHost } from "../voxelmon/game/host.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import { attempt as catchAttempt } from "../voxelmon/game/rules/catching.ts";
import { compute as damageCompute, GEN1_FAITHFUL } from "../voxelmon/game/rules/damage.ts";
import { gainFor } from "../voxelmon/game/rules/experience.ts";
import { hpBarPixels } from "../voxelmon/game/rules/timing.ts";
import { createTypeChart } from "../voxelmon/game/rules/typechart.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { parseTape, TapePlayer } from "../voxelmon/game/sim/tape.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log(
    "[voxel-battle] dist/voxelmon/gen absent (run `bun tools/voxel.ts import`) — ROM-gated suites skipped",
  );
}
const data: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

// ---------------------------------------------------------------------------
// drive harness
// ---------------------------------------------------------------------------

class FakeInput implements BattleInput {
  private down = new Set<BattleButton>();
  private edges = new Set<BattleButton>();
  press(btn: BattleButton): void {
    this.edges.add(btn);
    this.down.add(btn);
  }
  clear(): void {
    this.edges.clear();
    this.down.clear();
  }
  isDown(btn: BattleButton): boolean {
    return this.down.has(btn);
  }
  wasPressed(btn: BattleButton): boolean {
    return this.edges.has(btn);
  }
}

function tick(b: WildBattle, input: FakeInput, presses: BattleButton[] = []): void {
  input.clear();
  for (const p of presses) input.press(p);
  b.update(input);
}

/** Mash A through every prompt/hold until the queue idles into a menu or
 * the battle finishes. */
function settle(b: WildBattle, input: FakeInput, maxTicks = 8000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (b.finished || b.phase !== "messages") return;
    tick(b, input, ["a"]);
  }
  throw new Error("battle did not settle");
}

function makeSave(party: PartyMon[], inventory: Record<string, number> = {}): BattleSave {
  return { party, inventory, player: { name: "RED", rival: "BLUE" } };
}

interface BattleOpts {
  playerMon?: PartyMon;
  inventory?: Record<string, number>;
  species?: string;
  level?: number;
  /** The full seqRng roll script; the FIRST FOUR rolls are the enemy's DVs
   * (Stats.randomDVs order: attack, defense, speed, special). */
  rolls: number[];
}

function makeBattle(opts: BattleOpts): { b: WildBattle; input: FakeInput; save: BattleSave } {
  const playerMon = opts.playerMon ?? newMon(data!, "SQUIRTLE", 5);
  const save = makeSave([playerMon], opts.inventory ?? {});
  const b = new WildBattle(
    data!,
    save,
    seqRng(...opts.rolls),
    opts.species ?? "PIDGEY",
    opts.level ?? 3,
  );
  b.enter();
  const input = new FakeInput();
  settle(b, input); // through the intro to the action menu
  return { b, input, save };
}

/** FIGHT with move slot 1 from the action menu, then settle the exchange. */
function fightOnce(b: WildBattle, input: FakeInput): void {
  expect(b.phase).toBe("menu");
  expect(b.menuIndex).toBe(1); // cursor rests on FIGHT
  tick(b, input, ["a"]);
  expect(b.phase).toBe("moveSelect");
  tick(b, input, ["a"]); // slot 1
  expect(b.phase).toBe("messages");
  settle(b, input);
}

// ---------------------------------------------------------------------------
// Layer 1 — HP bar tile math (HudTiles.drawHPBar + Timing.hpBarPixels)
// ---------------------------------------------------------------------------

describe("hp bar tiles", () => {
  test("full bar: six $6B segments and the side cap", () => {
    expect(hpBarTiles(19, 19, true)).toEqual([
      HUD_HP_LABEL,
      HUD_BAR_LEFT,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_CAP_DOUBLE, // wHPBarType 1: the $6D double-bar cap (player side)
    ]);
    expect(hpBarTiles(15, 15, false)[8]).toBe(HUD_CAP_NUB); // enemy $6C nub
  });

  test("empty bar: six $63 empties", () => {
    const tiles = hpBarTiles(0, 19, false);
    expect(tiles.slice(2, 8)).toEqual(new Array(6).fill(HUD_BAR_EMPTY));
  });

  test("a nonzero HP always shows a one-pixel sliver (hp_bar.asm:42-45)", () => {
    expect(hpBarPixels(1, 100)).toBe(1);
    const tiles = hpBarTiles(1, 100, false);
    expect(tiles[2]).toBe(HUD_BAR_EMPTY + 1);
    expect(tiles.slice(3, 8)).toEqual(new Array(5).fill(HUD_BAR_EMPTY));
  });

  test("fractional fill matches the 48ths pixel math", () => {
    // 10/19 HP: floor(10*48/19) = 25 px = 3 full tiles + a 1px partial
    expect(hpBarPixels(10, 19)).toBe(25);
    const tiles = hpBarTiles(10, 19, true);
    expect(tiles.slice(2, 8)).toEqual([
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_EMPTY + 1,
      HUD_BAR_EMPTY,
      HUD_BAR_EMPTY,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — scripted battles, roll-for-roll
// ---------------------------------------------------------------------------

// canonical roll values: 200 = no crit for base speeds under 100ish,
// 38 -> randRange(217,255) = 255 -> damage * 255/255 (the max roll)
const NO_CRIT = 200;
const MAX_RAND = 38;

describe("scripted wild battle", () => {
  test.skipIf(!hasGen)("damage lands exactly as rules/damage computes it", () => {
    // SQUIRTLE L5 (zero DVs, spd 9) vs PIDGEY L3 (zero DVs, spd 8):
    // player moves first with no tie roll. Rolls: 4 DVs, enemy move pick,
    // then acc/crit/rand for each side.
    const { b, input } = makeBattle({
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    const chart = createTypeChart(data!.type_chart);
    const pMax = b.player.mon.stats.hp;
    const eMax = b.enemy.mon.stats.hp;

    fightOnce(b, input);

    // the same numbers straight out of rules/damage with the same rolls
    const atk = makeBattler(data!, newMon(data!, "SQUIRTLE", 5), true);
    const dfn = makeBattler(data!, newMon(data!, "PIDGEY", 3), false);
    const [tackle] = damageCompute(GEN1_FAITHFUL, chart, atk, dfn, data!.moves.TACKLE, {
      rng: seqRng(NO_CRIT, MAX_RAND),
    });
    const [gust] = damageCompute(GEN1_FAITHFUL, chart, dfn, atk, data!.moves.GUST, {
      rng: seqRng(NO_CRIT, MAX_RAND),
    });
    expect(tackle).toBeGreaterThan(0);
    expect(gust).toBeGreaterThan(0);
    expect(b.enemy.mon.hp).toBe(eMax - tackle);
    expect(b.player.mon.hp).toBe(pMax - gust);
  });

  test.skipIf(!hasGen)(
    "queue discipline: the two-move exchange messages in reference order",
    () => {
      const { b, input } = makeBattle({
        rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
      });
      fightOnce(b, input);
      expect(b.messageLog).toEqual([
        "Wild PIDGEY\nappeared!",
        "Go! SQUIRTLE!",
        "SQUIRTLE\nused TACKLE!",
        "Enemy PIDGEY\nused GUST!",
      ]);
      expect(b.phase).toBe("menu"); // the turn handed the menu back
      expect(b.result).toBeNull();
    },
  );

  test.skipIf(!hasGen)("speed tie: the coin flip decides who moves first", () => {
    // enemy speed DV 15 makes PIDGEY L3 spd 9 == SQUIRTLE L5 spd 9.
    // firstMover consumes ONE tie roll: 1 -> enemy first, 0 -> player first
    // (TurnOrder.lua:50-59).
    const enemyFirst = makeBattle({
      rolls: [0, 0, 15, 0, 0, /* tie */ 1, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(enemyFirst.b, enemyFirst.input);
    expect(enemyFirst.b.messageLog.slice(2)).toEqual([
      "Enemy PIDGEY\nused GUST!",
      "SQUIRTLE\nused TACKLE!",
    ]);

    const playerFirst = makeBattle({
      rolls: [0, 0, 15, 0, 0, /* tie */ 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(playerFirst.b, playerFirst.input);
    expect(playerFirst.b.messageLog.slice(2)).toEqual([
      "SQUIRTLE\nused TACKLE!",
      "Enemy PIDGEY\nused GUST!",
    ]);
  });

  test.skipIf(!hasGen)("faint -> exp -> level-up, numbers from rules/experience", () => {
    // SQUIRTLE at L5 with exp 160: PIDGEY L3's gain crosses the L6
    // MEDIUM_SLOW threshold (179) exactly once
    const playerMon = newMon(data!, "SQUIRTLE", 5);
    playerMon.exp = 160;
    const { b, input } = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND],
    });
    b.enemy.mon.hp = 1;
    b.enemy.shownHP = 1;
    fightOnce(b, input);

    const gained = gainFor(data!.pokemon.PIDGEY, 3);
    expect(gained).toBe(Math.floor((data!.pokemon.PIDGEY.baseExp * 3) / 7));
    expect(b.finished).toBe("win");
    expect(playerMon.exp).toBe(160 + gained);
    expect(playerMon.level).toBe(6);
    expect(b.messageLog).toContain("Enemy PIDGEY\nfainted!");
    expect(b.messageLog).toContain(`SQUIRTLE gained\n${gained} EXP. Points!`);
    expect(b.messageLog).toContain("SQUIRTLE grew\nto level 6!");
    // stat exp: the defeated species' base stats were added
    expect(playerMon.statExp.attack).toBe(data!.pokemon.PIDGEY.baseStats.attack);
  });

  test.skipIf(!hasGen)("level-up learns the exact-level move (BUBBLE at L8)", () => {
    const playerMon = newMon(data!, "SQUIRTLE", 7);
    playerMon.exp = 300; // L8 at 314; PIDGEY L3 pays 23
    const { b, input } = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND],
    });
    b.enemy.mon.hp = 1;
    b.enemy.shownHP = 1;
    fightOnce(b, input);
    expect(playerMon.level).toBe(8);
    expect(b.messageLog).toContain("SQUIRTLE learned\nBUBBLE!");
    expect(playerMon.moves.map((m) => m.id)).toContain("BUBBLE");
  });

  test.skipIf(!hasGen)("catch success: shakes and the party join from rules/catching", () => {
    const { b, input, save } = makeBattle({
      inventory: { POKE_BALL: 2 },
      // DVs, then the ball's int(256) and byte rolls
      rolls: [0, 0, 0, 0, 100, 50],
    });
    // cross-check the exact rolls through rules/catching first
    const probe = newMon(data!, "PIDGEY", 3);
    const [caught, shakes] = catchAttempt(
      "POKE_BALL",
      probe,
      data!.pokemon.PIDGEY,
      seqRng(100, 50),
    );
    expect([caught, shakes]).toEqual([true, 3]);

    tick(b, input, ["down"]); // FIGHT -> ITEM
    expect(b.menuIndex).toBe(3);
    tick(b, input, ["a"]);
    expect(b.phase).toBe("item");
    tick(b, input, ["a"]); // throw POKE BALL
    settle(b, input);
    expect(b.finished).toBe("caught");
    expect(b.messageLog).toContain("All right!\nPIDGEY was\ncaught!");
    expect(save.party.length).toBe(2);
    expect(save.party[1].species).toBe("PIDGEY");
    expect(save.inventory.POKE_BALL).toBe(1);
  });

  test.skipIf(!hasGen)("catch failure: the wobble count picks the miss text", () => {
    const { b, input, save } = makeBattle({
      inventory: { POKE_BALL: 1 },
      // ball int + byte (fails), then the enemy's free move
      rolls: [0, 0, 0, 0, 100, 200, 0, 0, NO_CRIT, MAX_RAND],
    });
    const probe = newMon(data!, "PIDGEY", 3);
    const [caught, shakes] = catchAttempt(
      "POKE_BALL",
      probe,
      data!.pokemon.PIDGEY,
      seqRng(100, 200),
    );
    expect([caught, shakes]).toEqual([false, 2]);

    tick(b, input, ["down"]);
    tick(b, input, ["a"]);
    tick(b, input, ["a"]);
    settle(b, input);
    // ItemUseBallText03 for two wobbles, then the foe's free move
    expect(b.messageLog).toContain("Aww! It appeared\nto be caught!");
    expect(b.messageLog).toContain("Enemy PIDGEY\nused GUST!");
    expect(b.result).toBeNull();
    expect(b.phase).toBe("menu");
    expect(save.party.length).toBe(1);
  });

  test.skipIf(!hasGen)("paralysis: the 63/256 roll blocks the move", () => {
    const playerMon = newMon(data!, "SQUIRTLE", 5);
    playerMon.status = "PAR";
    // PAR quarters speed (9 -> 2): the enemy moves first, no tie roll.
    // Rolls: DVs, pick, enemy acc/crit/rand, then the player's PAR byte.
    const blocked = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, /* PAR */ 10],
    });
    fightOnce(blocked.b, blocked.input);
    expect(blocked.b.messageLog).toContain("SQUIRTLE's\nfully paralyzed!");
    expect(blocked.b.messageLog).not.toContain("SQUIRTLE\nused TACKLE!");

    const free = makeBattle({
      playerMon: (() => {
        const m = newMon(data!, "SQUIRTLE", 5);
        m.status = "PAR";
        return m;
      })(),
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, /* PAR */ 100, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(free.b, free.input);
    expect(free.b.messageLog).toContain("SQUIRTLE\nused TACKLE!");
  });

  test.skipIf(!hasGen)("run-away formula (TryRunningFromBattle)", () => {
    const mk = (...rolls: number[]) => {
      const b = new WildBattle(
        data!,
        makeSave([newMon(data!, "SQUIRTLE", 5)]),
        seqRng(0, 0, 0, 0, ...rolls),
        "PIDGEY",
        3,
      );
      return b;
    };
    // faster or equal: escapes with no roll
    expect(mk().runRoll(10, 10)).toBe(true);
    expect(mk().runRoll(50, 10)).toBe(true);
    // b = floor(eSpd/4) = 10, x = floor(pSpd*32/b) = 32: escape on <= 32
    expect(mk(32).runRoll(10, 40)).toBe(true);
    expect(mk(33).runRoll(10, 40)).toBe(false);
    // +30 per PREVIOUS attempt
    const b2 = mk(33, 62);
    expect(b2.runRoll(10, 40)).toBe(false);
    expect(b2.runRoll(10, 40)).toBe(true); // x = 32 + 30 = 62
    // a zero divisor auto-escapes
    expect(mk().runRoll(1, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the battle screen tile layout
// ---------------------------------------------------------------------------

interface CapturedOp {
  op: string;
  args: (number | string)[];
}

class CaptureHost implements VoxelHost {
  ops: CapturedOp[] = [];
  private rec(op: string, ...args: (number | string)[]): void {
    this.ops.push({ op, args });
  }
  gamedata(): ArrayBuffer | null {
    return null;
  }
  audiodata(): ArrayBuffer | null {
    return null;
  }
  stats(): ArrayBuffer | null {
    return null;
  }
  reset(): void {}
  mapShow(...a: number[]): void {
    this.rec("mapShow", ...a);
  }
  mapHide(...a: number[]): void {
    this.rec("mapHide", ...a);
  }
  cam(...a: number[]): void {
    this.rec("cam", ...a);
  }
  pitch(...a: number[]): void {
    this.rec("pitch", ...a);
  }
  tint(...a: number[]): void {
    this.rec("tint", ...a);
  }
  stamp(...a: number[]): void {
    this.rec("stamp", ...a);
  }
  palette(...a: number[]): void {
    this.rec("palette", ...a);
  }
  ent(...a: number[]): void {
    this.rec("ent", ...a);
  }
  entHide(...a: number[]): void {
    this.rec("entHide", ...a);
  }
  emote(...a: number[]): void {
    this.rec("emote", ...a);
  }
  uiTile(x: number, y: number, tile: number): void {
    this.rec("uiTile", x, y, tile);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    this.rec("uiFill", x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void {
    this.rec("uiText", x, y, str);
  }
  uiReveal(n: number): void {
    this.rec("uiReveal", n);
  }
  uiClear(): void {
    this.rec("uiClear");
  }
  arena(...a: number[]): void {
    this.rec("arena", ...a);
  }
  card(...a: number[]): void {
    this.rec("card", ...a);
  }
  cardHide(...a: number[]): void {
    this.rec("cardHide", ...a);
  }
  battleCam(...a: number[]): void {
    this.rec("battleCam", ...a);
  }
  music(): void {}
  musicStop(): void {}
  musicFade(): void {}
  sfx(): void {}
  cry(): void {}
  audioWaves(): void {}
  audioDrum(): void {}
  arenaEnd(): void {
    this.rec("arenaEnd");
  }
  frameDone(): void {}

  tile(x: number, y: number): number | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i];
      if (o.op === "uiTile" && o.args[0] === x && o.args[1] === y) return o.args[2] as number;
    }
    return undefined;
  }
  text(x: number, y: number): string | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i];
      if (o.op === "uiText" && o.args[0] === x && o.args[1] === y) return o.args[2] as string;
    }
    return undefined;
  }

  /**
   * Static chrome labels land in the grid as glyph tiles (uiText is the one
   * typewriter run): read back the run starting at (x, y) and compare it to
   * a string via its glyph encoding.
   */
  tiles(x: number, y: number, n: number): number[] {
    const grid = new Map<string, number>();
    for (const o of this.ops) {
      if (o.op === "uiTile") grid.set(`${o.args[0]},${o.args[1]}`, o.args[2] as number);
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(grid.get(`${x + i},${y}`) ?? 0);
    return out;
  }
}

describe("battle screen layout", () => {
  test.skipIf(!hasGen)("the action menu matches the pinned geometry", () => {
    const { b } = makeBattle({
      rolls: [0, 0, 0, 0, 0],
    });
    expect(b.phase).toBe("menu");
    const host = new CaptureHost();
    const ui = new BattleUi();
    ui.emit(host, b);
    // BATTLE_MENU_TEMPLATE: box (8,12) 12x6, labels from (10,14),
    // <PK><MN> at (16,14)+(17,14), '▶' at column 9 row 14
    expect(host.tiles(10, 14, 5)).toEqual(encodeGlyphs("FIGHT"));
    expect(host.tiles(10, 16, 4)).toEqual(encodeGlyphs("ITEM"));
    expect(host.tiles(16, 16, 3)).toEqual(encodeGlyphs("RUN"));
    expect(host.tile(16, 14)).toBe(0xe1);
    expect(host.tile(17, 14)).toBe(0xe2);
    expect(host.tile(9, 14)).toBe(0xed);
    // the menu box corners (drawBox at (8,12) 12x6)
    expect(host.tile(8, 12)).toBe(0x79);
    expect(host.tile(19, 12)).toBe(0x7b);
    expect(host.tile(8, 17)).toBe(0x7d);
    expect(host.tile(19, 17)).toBe(0x7e);
    // enemy HUD: name row 0 col 1, <LV> at (4,1), bar row 2 with the $6C
    // nub at (10,2); player HUD: name (10,7), digits (11,10), $6D at (18,9)
    expect(host.tiles(1, 0, 6)).toEqual(encodeGlyphs("PIDGEY"));
    expect(host.tile(4, 1)).toBe(HUD_LV);
    expect(host.tile(2, 2)).toBe(HUD_HP_LABEL);
    expect(host.tile(3, 2)).toBe(HUD_BAR_LEFT);
    expect(host.tile(10, 2)).toBe(HUD_CAP_NUB);
    expect(host.tiles(10, 7, 8)).toEqual(encodeGlyphs("SQUIRTLE"));
    expect(host.tile(18, 9)).toBe(HUD_CAP_DOUBLE);
    const p = b.player.mon;
    expect(host.tiles(11, 10, 7)).toEqual(
      encodeGlyphs(`${String(p.hp).padStart(3)}/${String(p.stats.hp).padStart(3)}`),
    );
  });

  test.skipIf(!hasGen)("the move menu shows names, cursor and TYPE/PP", () => {
    const { b, input } = makeBattle({ rolls: [0, 0, 0, 0, 0] });
    tick(b, input, ["a"]); // FIGHT
    expect(b.phase).toBe("moveSelect");
    const host = new CaptureHost();
    const ui = new BattleUi();
    ui.emit(host, b);
    // MoveSelectionMenu: names at column 6 from row 13, cursor column 5
    expect(host.tiles(6, 13, 6)).toEqual(encodeGlyphs("TACKLE"));
    expect(host.tiles(6, 14, 9)).toEqual(encodeGlyphs("TAIL WHIP"));
    expect(host.tile(5, 13)).toBe(0xed);
    // PrintMenuItem: TYPE/ at (1,9), the type at (2,10), PP at (5,11)
    expect(host.tiles(1, 9, 5)).toEqual(encodeGlyphs("TYPE/"));
    expect(host.tiles(2, 10, 6)).toEqual(encodeGlyphs("NORMAL"));
    expect(host.tiles(5, 11, 5)).toEqual(encodeGlyphs("35/35"));
    // the border-merge cells (#240)
    expect(host.tile(4, 12)).toBe(0x7a);
    expect(host.tile(10, 12)).toBe(0x7e);
  });

  test.skipIf(!hasGen)("the wide arena stages on open ground near the player", () => {
    // ROUTE_1 has bare ground all along the path; the search must return a
    // wide 3x6 footprint whose cells all pass openCell
    const game = new VoxelmonGame(data!, new RecorderHost(), 1);
    game.newGame();
    game.overworld.setMap("ROUTE_1", 10, 20, "down");
    const arena = arenaSearch(game.overworld.map, 10, 20, false);
    expect(arena).not.toBeNull();
    expect(arena!.shape).toBe(0); // wide
    expect(arena!.enemyCell).toEqual([arena!.x + 1, arena!.y + 1]);
    expect(arena!.playerCell).toEqual([arena!.x + 1, arena!.y + 4]);
    // the two mons stand three cells apart down the middle column
    expect(arena!.playerCell[1] - arena!.enemyCell[1]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — battle.tape end to end
// ---------------------------------------------------------------------------

const BATTLE_SEED = 17;

async function runBattleTapeInProcess(): Promise<RecorderHost> {
  const host = new RecorderHost();
  const game = new VoxelmonGame(data!, host, BATTLE_SEED);
  game.newGame();
  const tapeText = await Bun.file(join(root, "voxelmon/tapes/battle.tape")).text();
  const tape = new TapePlayer(parseTape(tapeText));
  while (!tape.done && game.tickIndex < 100_000) {
    const step = tape.next(game);
    for (const m of step.marks) host.mark(m);
    if (tape.done) break;
    game.tick(step.buttons);
    tape.observe(game);
  }
  expect(tape.done).toBe(true);
  return host;
}

describe("battle tape", () => {
  test.skipIf(!hasGen)(
    "reaches its marks, fights and escapes, byte-deterministic x2",
    async () => {
      const a = await runBattleTapeInProcess();
      const b = await runBattleTapeInProcess();
      expect(a.marks).toEqual(["grass-edge", "battle-intro", "post-fight", "escaped"]);
      expect(a.text()).toBe(b.text());
      const trace = a.text();
      // the staging crossed the boundary: arena + battleCam up, arenaEnd down
      expect(trace).toMatch(/\no 70 \d+ \d+ \d+ \d+ \d+\n/);
      expect(trace).toContain("\no 73 0 0 256\n");
      expect(trace).toContain("\no 74\n");
      // FIGHT and RUN both happened on the battle screen
      expect(trace).toContain('s 52 1 14 "Wild PIDGEY"');
      expect(trace).toContain('s 52 1 16 "used TACKLE!"');
      expect(trace).toContain('s 52 1 14 "Got away safely!"');
    },
    60_000,
  );
});
