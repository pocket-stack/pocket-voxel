// tests/voxel-rules.test.ts — the gen1recomp rules port under test.
//
// Layer 1 (ROM-free, always runs): the assertion semantics of the reference
// suite tests/engine/formulas.lua (growth inversion, stat properties, type
// chart, damage properties) against the ported fixture dataset, plus
// tests/engine/timing_parity.lua's constant pins, plus per-module quirk
// checks with hand-computed integers.
//
// Layer 2 (gated, skips with a printed reason): content_red/facts.lua ground
// truths against dist/voxelmon/gen/, and luajit micro-oracles that run the
// REFERENCE Lua over a fixed input matrix and compare line-for-line.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  fromGenDir,
  fromObject,
  REQUIRED_MODULES,
  type SpeciesDef,
  type VoxelmonData,
} from "../voxelmon/game/data.ts";
import { fixedRng, randRange, seededRng, seqRng, type Rng } from "../voxelmon/game/rng.ts";
import * as Bag from "../voxelmon/game/rules/bag.ts";
import * as Catching from "../voxelmon/game/rules/catching.ts";
import * as Damage from "../voxelmon/game/rules/damage.ts";
import * as Encounter from "../voxelmon/game/rules/encounter.ts";
import * as Evolution from "../voxelmon/game/rules/evolution.ts";
import * as Experience from "../voxelmon/game/rules/experience.ts";
import * as Growth from "../voxelmon/game/rules/growth.ts";
import * as Stats from "../voxelmon/game/rules/stats.ts";
import * as Status from "../voxelmon/game/rules/status.ts";
import * as Timing from "../voxelmon/game/rules/timing.ts";
import * as TurnOrder from "../voxelmon/game/rules/turnorder.ts";
import { createTypeChart, TYPES } from "../voxelmon/game/rules/typechart.ts";
import { fixtureData } from "./fixtures/voxelmon/fixture-data.ts";

const root = join(import.meta.dir, "..");

// a roll that must never happen
const poisonedRng: Rng = {
  int: () => {
    throw new Error("unexpected rng.int roll");
  },
  byte: () => {
    throw new Error("unexpected rng.byte roll");
  },
};

// The damage random factor is the Lua's rng(randMin, randMax) single call;
// randRange maps it to randMin + int(span), so a specific factor roll r is
// injected as int() -> r - 217 (gen1_faithful randMin).
const damageRoll = (r: number): Rng => ({ int: () => r - 217, byte: () => r });

// Fresh-mon derivation for the stat properties, a test-local stand-in for
// gen1recomp src/pokemon/Pokemon.lua:10-30 movesAtLevel (level-1 moves plus
// learnset entries at or below the level, deduped, keeping the most recent
// four) and :60-85 Pokemon.new.
function movesAtLevel(def: SpeciesDef, level: number): string[] {
  const moves: string[] = [];
  const add = (id: string): void => {
    if (!moves.includes(id)) moves.push(id);
  };
  for (const m of def.level1Moves) add(m);
  for (const entry of def.learnset) {
    if (entry.level <= level) add(entry.move);
  }
  while (moves.length > 4) moves.shift();
  return moves;
}

function freshMon(data: VoxelmonData, species: string, level: number, rng: Rng) {
  const def = data.pokemon[species];
  const dvs = Stats.randomDVs(rng);
  const stats = Stats.calc(def, level, dvs);
  return {
    species,
    level,
    exp: Growth.expForLevel(def.growthRate, level),
    dvs,
    statExp: { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 },
    stats,
    hp: stats.hp,
    status: null,
    moves: movesAtLevel(def, level),
  };
}

// a battler over real fixture stats (formulas.lua:132-135 battler())
function fixtureBattler(data: VoxelmonData, species: string, level: number): Damage.Battler {
  const def = data.pokemon[species];
  const stats = Stats.calc(def, level, {});
  return {
    mon: { level, stats, status: null },
    def,
    curStats: stats,
    curTypes: [...def.types],
    stages: {},
  };
}

// Hand-built battlers for the pinned damage cases (the oracle shape):
// an attacking battler carries `atk` in both attack and special, a defending
// one carries `dfn` in both defense and special, so physical and special
// moves read the same pinned number.
function atkBattler(
  level: number,
  atk: number,
  types: string[],
  over: Partial<Damage.Battler> = {},
): Damage.Battler {
  const stats = { hp: 999, attack: atk, defense: 10, speed: 10, special: atk };
  return {
    mon: { level, stats, status: null },
    def: data.pokemon.FIXMON_A,
    curStats: { ...stats },
    curTypes: types,
    stages: {},
    ...over,
  };
}

function defBattler(
  level: number,
  dfn: number,
  types: string[],
  over: Partial<Damage.Battler> = {},
): Damage.Battler {
  const stats = { hp: 999, attack: 10, defense: dfn, speed: 10, special: dfn };
  return {
    mon: { level, stats, status: null },
    def: data.pokemon.FIXMON_A,
    curStats: { ...stats },
    curTypes: types,
    stages: {},
    ...over,
  };
}

const data = fixtureData();
const chart = createTypeChart(data.type_chart);
const faithful = Damage.GEN1_FAITHFUL;

// ---------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------

describe("rng", () => {
  test("seededRng is deterministic and in range", () => {
    const a = seededRng(12345);
    const b = seededRng(12345);
    const rollsA: number[] = [];
    const rollsB: number[] = [];
    for (let i = 0; i < 100; i++) {
      const ia = a.int(16);
      const ib = b.int(16);
      rollsA.push(ia, a.byte());
      rollsB.push(ib, b.byte());
      expect(ia).toBeGreaterThanOrEqual(0);
      expect(ia).toBeLessThan(16);
    }
    expect(rollsA).toEqual(rollsB);
    expect(rollsA.some((v) => v !== rollsA[0])).toBe(true);
  });

  test("fixed and seq mirror the harness injectors", () => {
    expect(fixedRng(7).byte()).toBe(7);
    expect(fixedRng(7).int(2)).toBe(7);
    const s = seqRng(3, 9);
    expect([s.int(256), s.byte(), s.byte()]).toEqual([3, 9, 9]);
  });

  test("randRange is the Lua rng(min,max) shape", () => {
    expect(randRange(fixedRng(0), 217, 255)).toBe(217);
    expect(randRange(fixedRng(38), 217, 255)).toBe(255);
    const r = seededRng(7);
    for (let i = 0; i < 50; i++) {
      const v = randRange(r, 217, 255);
      expect(v).toBeGreaterThanOrEqual(217);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

// ---------------------------------------------------------------------------
// data loader
// ---------------------------------------------------------------------------

describe("data loader", () => {
  test("fromObject validates the required modules", () => {
    expect(() => fromObject({})).toThrow('missing required module "pokemon"');
    const { encounters: _dropped, ...rest } = fixtureData() as unknown as Record<string, unknown>;
    expect(() => fromObject(rest)).toThrow('missing required module "encounters"');
  });

  test("the fixture dataset loads and is isolated per call", () => {
    const one = fixtureData();
    expect(Object.keys(one.pokemon).sort()).toEqual(["FIXMON_A", "FIXMON_B", "FIXMON_C"]);
    one.pokemon.FIXMON_A.baseStats.hp = 1;
    expect(fixtureData().pokemon.FIXMON_A.baseStats.hp).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// growth curves (formulas.lua:30-58 semantics, over all six curves)
// ---------------------------------------------------------------------------

describe("growth curves", () => {
  const cap = data.constants.levelCap ?? 100;

  test("level 1 costs no exp for every dataset species (formulas.lua:37)", () => {
    // formulas.lua asserts this per species, so it covers the CURVES THE
    // DATASET USES; the raw curves at level 1 evaluate to 1/0/0/0/0/1
    // (verified against the reference under luajit)
    for (const id of Object.keys(data.pokemon)) {
      expect(Growth.expForLevel(data.pokemon[id].growthRate, 1)).toBe(0);
    }
    expect(Growth.expForLevel("MEDIUM_FAST", 1)).toBe(1);
    expect(Growth.expForLevel("SLOW", 1)).toBe(1);
    expect(Growth.expForLevel("FAST", 1)).toBe(0);
    expect(Growth.expForLevel("SLIGHTLY_FAST", 1)).toBe(0);
    expect(Growth.expForLevel("SLIGHTLY_SLOW", 1)).toBe(0);
  });

  for (const rate of Object.keys(Growth.CURVES)) {
    test(`${rate}: monotonic, invertible`, () => {
      let previous = -1;
      for (let level = 1; level <= cap; level++) {
        const need = Growth.expForLevel(rate, level);
        expect(need).toBeGreaterThanOrEqual(previous);
        previous = need;
      }
      // levelForExp is the inverse: standing exactly on a threshold reports
      // that level, one point short reports the one below
      const mid = Math.max(2, Math.floor(cap / 2));
      const atMid = Growth.expForLevel(rate, mid);
      expect(Growth.levelForExp(rate, atMid, cap)).toBe(mid);
      if (atMid > 0) {
        expect(Growth.levelForExp(rate, atMid - 1, cap)).toBeLessThan(mid);
      }
    });
  }

  test("pinned curve values (pokered GrowthRateTable)", () => {
    expect(Growth.expForLevel("MEDIUM_FAST", 100)).toBe(1000000);
    expect(Growth.expForLevel("MEDIUM_SLOW", 100)).toBe(1059860);
    expect(Growth.expForLevel("FAST", 100)).toBe(800000);
    expect(Growth.expForLevel("SLOW", 100)).toBe(1250000);
    expect(Growth.expForLevel("MEDIUM_SLOW", 5)).toBe(135);
  });

  test("an unknown curve falls back to MEDIUM_FAST", () => {
    expect(Growth.expForLevel("NO_SUCH_CURVE", 10)).toBe(1000);
  });

  test("a merged rates record wins over the vanilla curve", () => {
    expect(Growth.expForLevel("MEDIUM_FAST", 10, { MEDIUM_FAST: { expForLevel: () => 5 } })).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// stats (formulas.lua:62-80 semantics + Stats.lua unit pins)
// ---------------------------------------------------------------------------

describe("stats", () => {
  const cap = data.constants.levelCap ?? 100;
  const rng = seededRng(12345); // harness.lua T.SEED

  for (const id of Object.keys(data.pokemon).sort()) {
    test(`fresh-mon properties: ${id}`, () => {
      const low = freshMon(data, id, 5, rng);
      const high = freshMon(data, id, Math.min(50, cap), rng);
      expect(low.stats.hp).toBeGreaterThan(0);
      expect(low.hp).toBe(low.stats.hp);
      expect(low.moves.length).toBeGreaterThan(0);
      expect(low.moves.length).toBeLessThanOrEqual(data.constants.moveMax ?? 4);
      for (const stat of Stats.STAT_ORDER) {
        expect(high.stats[stat]).toBeGreaterThanOrEqual(low.stats[stat]);
      }
      expect(freshMon(data, id, cap, rng).level).toBe(cap);
    });
  }

  test("calc pins the CalcStat formula (zero DVs, level 5)", () => {
    // FIXMON_A shares BULBASAUR's base stats, so this matches the
    // content_red facts row byte-for-byte
    expect(Stats.calc(data.pokemon.FIXMON_A, 5, {})).toEqual({
      hp: 19,
      attack: 9,
      defense: 9,
      speed: 9,
      special: 11,
    });
  });

  test("the stat-exp term is a quartered ceiling sqrt capped at 255", () => {
    expect(Stats.calcOne(45, 0, 65535, 5, true)).toBe(22); // ceil(sqrt)=256 -> 255 -> 63
    expect(Stats.calcOne(45, 0, 0, 5, true)).toBe(19);
    expect(Stats.calcOne(45, 0, 26, 5, true)).toBe(19); // ceil(sqrt(26)) = 6 -> ev 1: floor(91*5/100)=4
  });

  test("randomDVs packs the HP DV from the low bits", () => {
    expect(Stats.randomDVs(seqRng(1, 2, 3, 4))).toEqual({
      attack: 1,
      defense: 2,
      speed: 3,
      special: 4,
      hp: 8 + 0 + 2 + 0,
    });
  });

  test("applyStage uses the stat_modifiers table with 1..999 clamps", () => {
    expect(Stats.applyStage(100, 0)).toBe(100);
    expect(Stats.applyStage(100, 2)).toBe(200);
    expect(Stats.applyStage(100, -1)).toBe(66);
    expect(Stats.applyStage(10, -6)).toBe(2);
    expect(Stats.applyStage(1, -6)).toBe(1); // floor(0.25) clamps up to 1
    expect(Stats.applyStage(999, 6)).toBe(999);
    expect(Stats.applyStage(100, 9)).toBe(400); // stage clamps to +6
  });

  test("ensure derives box-mon stats once and clamps stored HP", () => {
    const def = data.pokemon.FIXMON_A;
    const boxed: Parameters<typeof Stats.ensure>[1] = { level: 5, dvs: {}, hp: 999 };
    const ensured = Stats.ensure(def, boxed);
    expect(ensured.stats?.hp).toBe(19);
    expect(ensured.hp).toBe(19);
    const already = { level: 5, dvs: {}, hp: 3, stats: { hp: 7, attack: 1, defense: 1, speed: 1, special: 1 } };
    expect(Stats.ensure(def, already).stats?.hp).toBe(7);
  });

  test("isShiny is the Gen 2 formula over Gen 1 DVs", () => {
    expect(Stats.isShiny({ attack: 10, defense: 10, speed: 10, special: 10 })).toBe(true);
    expect(Stats.isShiny({ attack: 2, defense: 10, speed: 10, special: 10 })).toBe(true);
    expect(Stats.isShiny({ attack: 4, defense: 10, speed: 10, special: 10 })).toBe(false);
    expect(Stats.isShiny({ attack: 10, defense: 9, speed: 10, special: 10 })).toBe(false);
    expect(Stats.isShiny(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// type chart (formulas.lua:84-123 semantics)
// ---------------------------------------------------------------------------

describe("type chart", () => {
  test("every type declares a damage category and isSpecial agrees", () => {
    const typeIds = Object.keys(TYPES).sort();
    expect(typeIds.length).toBe(15);
    for (const id of typeIds) {
      const category = chart.category(id);
      expect(category === "physical" || category === "special").toBe(true);
      expect(Damage.isSpecial(chart, id)).toBe(category === "special");
    }
  });

  test("declared matchups apply; undeclared pairs are neutral", () => {
    for (const row of data.type_chart.matchups) {
      expect(chart.effectiveness(row.attacker, [row.defender])).toBe(row.multiplier);
    }
    expect(chart.effectiveness("FIRE", ["FIRE"])).toBe(10);
    expect(chart.effectiveness("NORMAL", ["GRASS"])).toBe(10);
  });

  test("dual matchups multiply per row (20 * 5 -> neutral)", () => {
    expect(chart.rows("FIRE", ["GRASS", "WATER"])).toEqual([20, 5]);
    expect(chart.effectiveness("FIRE", ["GRASS", "WATER"])).toBe(10);
  });

  test("rows come back in ROM order, one per matching row", () => {
    const ordered = createTypeChart({
      matchups: [
        { attacker: "X", defender: "A", multiplier: 5 },
        { attacker: "X", defender: "B", multiplier: 20 },
      ],
    });
    expect(ordered.rows("X", ["A", "B"])).toEqual([5, 20]);
    expect(ordered.rows("X", ["B", "A"])).toEqual([5, 20]);
  });
});

// ---------------------------------------------------------------------------
// damage (formulas.lua:127-162 semantics + Damage.lua quirk pins)
// ---------------------------------------------------------------------------

describe("damage", () => {
  test("roll bounds and crit dominance on fixture battlers", () => {
    const attacker = fixtureBattler(data, "FIXMON_A", 20);
    const defender = fixtureBattler(data, "FIXMON_C", 20);
    const move = data.moves.FIX_TACKLE;
    const [dealt] = Damage.compute(faithful, chart, attacker, defender, move, {
      rng: damageRoll(255),
      forceCrit: false,
    });
    expect(dealt).toBeGreaterThanOrEqual(1);
    const [minRoll] = Damage.compute(faithful, chart, attacker, defender, move, {
      rng: damageRoll(217),
      forceCrit: false,
    });
    expect(minRoll).toBeLessThanOrEqual(dealt);
    expect(minRoll).toBeGreaterThanOrEqual(1);
    const [crit] = Damage.compute(faithful, chart, attacker, defender, move, {
      rng: damageRoll(255),
      forceCrit: true,
    });
    expect(crit).toBeGreaterThanOrEqual(dealt);
  });

  test("a zero-power move deals nothing and reports neutral", () => {
    const attacker = fixtureBattler(data, "FIXMON_A", 20);
    const defender = fixtureBattler(data, "FIXMON_C", 20);
    const status = { id: "T_STATUS", power: 0, type: "NORMAL", category: "status" as const };
    expect(
      Damage.compute(faithful, chart, attacker, defender, status, { rng: poisonedRng }),
    ).toEqual([0, { crit: false, typeMult: 10 }]);
  });

  // pinned case family: level 20, power 40 FIRE (special) move, no STAB,
  // atk/dfn = the special stats. d0 = floor(2*20/5)+2 = 10.
  const fireMove = { id: "T_FIRE", type: "FIRE", power: 40, accuracy: 100 };

  test("core formula + type rows, max and min rolls", () => {
    const atk = atkBattler(20, 30, ["NORMAL"]);
    const dfnGrass = defBattler(20, 30, ["GRASS"]);
    // floor(floor(10*40*30/30)/50)=8 -> 10; x2 row -> 20
    expect(
      Damage.compute(faithful, chart, atk, dfnGrass, fireMove, { rng: damageRoll(255), forceCrit: false }),
    ).toEqual([20, { crit: false, typeMult: 20 }]);
    // floor(20*217/255) = 17
    expect(
      Damage.compute(faithful, chart, atk, dfnGrass, fireMove, { rng: damageRoll(217), forceCrit: false }),
    ).toEqual([17, { crit: false, typeMult: 20 }]);
    const dfnWater = defBattler(20, 30, ["WATER"]);
    expect(
      Damage.compute(faithful, chart, atk, dfnWater, fireMove, { rng: damageRoll(255), forceCrit: false }),
    ).toEqual([5, { crit: false, typeMult: 5 }]);
    const dfnDual = defBattler(20, 30, ["GRASS", "WATER"]);
    expect(
      Damage.compute(faithful, chart, atk, dfnDual, fireMove, { rng: damageRoll(255), forceCrit: false }),
    ).toEqual([10, { crit: false, typeMult: 10 }]);
  });

  test("STAB is floor(d*3/2) before the type rows", () => {
    const atk = atkBattler(20, 30, ["FIRE"]);
    const dfnGrass = defBattler(20, 30, ["GRASS"]);
    // 10 -> STAB 15 -> x2 row 30
    expect(
      Damage.compute(faithful, chart, atk, dfnGrass, fireMove, { rng: damageRoll(255), forceCrit: false }),
    ).toEqual([30, { crit: false, typeMult: 20 }]);
  });

  test("each type row floors the running damage in ROM order", () => {
    // rows [5, 20] on d=7: floor(7/2)=3 -> 6; a single x10 multiply (mult
    // 10) would keep 7 — the per-row floor is observable
    const orderedChart = createTypeChart({
      matchups: [
        { attacker: "X", defender: "A", multiplier: 5 },
        { attacker: "X", defender: "B", multiplier: 20 },
      ],
    });
    const atk = atkBattler(5, 17, ["NORMAL"]);
    const dfn = defBattler(5, 10, ["A", "B"]);
    const move = { id: "T_X", type: "X", power: 40, accuracy: 100 };
    const [dmg, info] = Damage.compute(faithful, orderedChart, atk, dfn, move, {
      rng: damageRoll(255),
      forceCrit: false,
    });
    expect([dmg, info.typeMult]).toEqual([6, 10]);
  });

  test("an immunity row zeroes the move", () => {
    const immuneChart = createTypeChart({
      matchups: [{ attacker: "FIRE", defender: "GRASS", multiplier: 0 }],
    });
    const atk = atkBattler(20, 30, ["NORMAL"]);
    const dfn = defBattler(20, 30, ["GRASS"]);
    expect(
      Damage.compute(faithful, immuneChart, atk, dfn, fireMove, { rng: poisonedRng, forceCrit: false }),
    ).toEqual([0, { crit: false, typeMult: 0 }]);
  });

  test("a 0.25x hit flooring to zero is a miss, not a minimum 1", () => {
    const quarterChart = createTypeChart({
      matchups: [
        { attacker: "X", defender: "A", multiplier: 5 },
        { attacker: "X", defender: "B", multiplier: 5 },
      ],
    });
    // pre-type d = 2: rows floor(2/2)=1 -> floor(1/2)=0 -> missed
    const atk = atkBattler(5, 10, ["NORMAL"]);
    const dfn = defBattler(5, 40, ["A", "B"]);
    const move = { id: "T_X", type: "X", power: 40, accuracy: 100 };
    expect(
      Damage.compute(faithful, quarterChart, atk, dfn, move, { rng: poisonedRng, forceCrit: false }),
    ).toEqual([0, { crit: false, typeMult: 2, missed: true }]);
  });

  // physical pinned family: level 20, power 40 NORMAL move, attacker
  // curTypes GRASS (no STAB), neutral chart rows. base atk 100 dfn 30:
  // floor(floor(10*40*100/30)/50) = 26 -> 28.
  const normalMove = { id: "T_NORMAL", type: "NORMAL", power: 40, accuracy: 100 };
  const physCase = (over: Partial<Damage.Battler>, defOver: Partial<Damage.Battler> = {}) =>
    Damage.compute(
      faithful,
      chart,
      atkBattler(20, 100, ["GRASS"], over),
      defBattler(20, 30, ["GRASS"], defOver),
      normalMove,
      { rng: damageRoll(255), forceCrit: false },
    )[0];

  test("badge boost multiplies the staged stat by 9/8", () => {
    expect(physCase({})).toBe(28);
    expect(physCase({ badges: { BOULDERBADGE: true } })).toBe(31); // atk 112
    expect(physCase({ badges: { THUNDERBADGE: true } })).toBe(28); // wrong badge
  });

  test("burn halves physical attack unless Haze reset it", () => {
    const burned: Partial<Damage.Battler> = { mon: { level: 20, status: "BRN", stats: { hp: 999, attack: 100, defense: 10, speed: 10, special: 100 } } };
    expect(physCase(burned)).toBe(15); // atk 50
    expect(physCase({ ...burned, hazeStatReset: true })).toBe(28);
  });

  test("screens double defense; crits bypass stages and screens", () => {
    expect(physCase({}, { reflect: true })).toBe(15); // dfn 60
    expect(physCase({}, { lightScreen: true })).toBe(28); // wrong screen for physical
    const [critDmg] = Damage.compute(
      faithful,
      chart,
      atkBattler(20, 100, ["GRASS"], { stages: { attack: 6 } }),
      defBattler(20, 30, ["GRASS"], { reflect: true, stages: { defense: 6 } }),
      normalMove,
      { rng: damageRoll(255), forceCrit: true },
    );
    // level doubles to 40: d0 = 18; floor(floor(18*40*100/30)/50) = 48 -> 50
    expect(critDmg).toBe(50);
  });

  test("stage boosts feed the scaleStats quartering (>255 quarters BOTH)", () => {
    const [dmg] = Damage.compute(
      faithful,
      chart,
      atkBattler(20, 100, ["GRASS"], { stages: { attack: 6 } }), // 400 -> quarter
      defBattler(20, 30, ["GRASS"]),
      normalMove,
      { rng: damageRoll(255), forceCrit: false },
    );
    // atk 400 -> 100, dfn 30 -> 7: floor(floor(10*40*100/7)/50) = 114 -> 116
    expect(dmg).toBe(116);
    const atkBig = atkBattler(20, 300, ["GRASS"]);
    const [dmg2] = Damage.compute(faithful, chart, atkBig, defBattler(20, 30, ["GRASS"]), normalMove, {
      rng: damageRoll(255),
      forceCrit: false,
    });
    // atk 300 -> 75, dfn 30 -> 7: floor(floor(10*40*75/7)/50) = 85 -> 87
    expect(dmg2).toBe(87);
  });

  test("explode halves defense after scaling", () => {
    const [dmg] = Damage.compute(
      faithful,
      chart,
      atkBattler(20, 100, ["GRASS"]),
      defBattler(20, 30, ["GRASS"]),
      normalMove,
      { rng: damageRoll(255), forceCrit: false, explode: true },
    );
    // dfn 15: floor(floor(10*40*100/15)/50) = 53 -> 55
    expect(dmg).toBe(55);
  });

  test("the typeless confusion self-hit is deterministic and reads the opponent's screens", () => {
    const atk = atkBattler(20, 100, ["GRASS"]);
    const noScreens = Damage.compute(faithful, chart, atk, defBattler(20, 30, ["GRASS"]), normalMove, {
      rng: poisonedRng,
      forceCrit: false,
      typeless: true,
    });
    expect(noScreens).toEqual([28, { crit: false, typeMult: 10 }]);
    const opponent = defBattler(20, 30, ["GRASS"], { reflect: true });
    const withScreens = Damage.compute(faithful, chart, atk, defBattler(20, 30, ["GRASS"]), normalMove, {
      rng: poisonedRng,
      forceCrit: false,
      typeless: true,
      screens: opponent,
    });
    expect(withScreens[0]).toBe(15);
  });

  test("damage is floored at 1 after the random factor", () => {
    const [dmg] = Damage.compute(
      faithful,
      chart,
      atkBattler(5, 10, ["GRASS"]),
      defBattler(5, 300, ["GRASS"]),
      normalMove,
      { rng: damageRoll(217), forceCrit: false },
    );
    expect(dmg).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// crit + accuracy rolls (Damage.lua:57-106)
// ---------------------------------------------------------------------------

describe("crit and accuracy rolls", () => {
  // FIXMON_B base speed 65: b = floor(65/2) = 32
  const attacker = (over: Partial<Damage.Battler> = {}) =>
    atkBattler(20, 30, ["FIRE"], { def: data.pokemon.FIXMON_B, ...over });

  test("normal crit threshold is base speed / 2, shifted", () => {
    // 32 -> shl 64 -> /2 = 32
    expect(Damage.critRoll(faithful, attacker(), "T_MOVE", fixedRng(31))).toBe(true);
    expect(Damage.critRoll(faithful, attacker(), "T_MOVE", fixedRng(32))).toBe(false);
  });

  test("high-crit moves shift twice more (cap 255)", () => {
    // 32 -> 64 -> 128 -> 255(cap)
    expect(Damage.critRoll(faithful, attacker(), "SLASH", fixedRng(254))).toBe(true);
    expect(Damage.critRoll(faithful, attacker(), "SLASH", fixedRng(255))).toBe(false);
    // the move-record highCrit field wins over the id list
    expect(Damage.critRoll(faithful, attacker(), "T_MOVE", fixedRng(254), true)).toBe(true);
  });

  test("Focus Energy: srl bug quarters, intended build octuples", () => {
    // bug: 32 -> /2 16 -> /2 8
    expect(Damage.critRoll(faithful, attacker({ focusEnergy: true }), "T_MOVE", fixedRng(7))).toBe(true);
    expect(Damage.critRoll(faithful, attacker({ focusEnergy: true }), "T_MOVE", fixedRng(8))).toBe(false);
    // intended: 32 -> shl^3 255(cap) -> /2 127
    expect(Damage.critRoll(Damage.MODERN_CLEAN, attacker({ focusEnergy: true }), "T_MOVE", fixedRng(126))).toBe(true);
    expect(Damage.critRoll(Damage.MODERN_CLEAN, attacker({ focusEnergy: true }), "T_MOVE", fixedRng(127))).toBe(false);
  });

  test("critUsesBaseSpeed=false reads the staged in-battle speed", () => {
    const ruleset = { ...faithful, critUsesBaseSpeed: false };
    const fast = attacker({ curStats: { hp: 999, attack: 30, defense: 30, speed: 200, special: 30 } });
    // 200 -> b=100 -> shl 200 -> /2 = 100
    expect(Damage.critRoll(ruleset, fast, "T_MOVE", fixedRng(99))).toBe(true);
    expect(Damage.critRoll(ruleset, fast, "T_MOVE", fixedRng(100))).toBe(false);
  });

  const move100 = { id: "T_MOVE", type: "NORMAL", power: 40, accuracy: 100 };

  test("gen1_faithful keeps the 1/256 miss", () => {
    expect(Damage.accuracyRoll(faithful, move100, attacker(), attacker(), fixedRng(254))).toBe(true);
    expect(Damage.accuracyRoll(faithful, move100, attacker(), attacker(), fixedRng(255))).toBe(false);
  });

  test("modern_clean removes the 1/256 miss at max accuracy", () => {
    expect(Damage.accuracyRoll(Damage.MODERN_CLEAN, move100, attacker(), attacker(), fixedRng(255))).toBe(true);
    // ...but stage disadvantage still rolls: applyStage(255,-1) = 168
    const lowered = attacker({ stages: { accuracy: -1 } });
    expect(Damage.accuracyRoll(Damage.MODERN_CLEAN, move100, lowered, attacker(), fixedRng(167))).toBe(true);
    expect(Damage.accuracyRoll(Damage.MODERN_CLEAN, move100, lowered, attacker(), fixedRng(168))).toBe(false);
  });

  test("evasion stages scale the hit chance separately", () => {
    const evasive = attacker({ stages: { evasion: 6 } });
    // applyStage(255, -6) = 63
    expect(Damage.accuracyRoll(faithful, move100, attacker(), evasive, fixedRng(62))).toBe(true);
    expect(Damage.accuracyRoll(faithful, move100, attacker(), evasive, fixedRng(63))).toBe(false);
  });

  test("X ACCURACY never misses", () => {
    expect(Damage.accuracyRoll(faithful, move100, attacker({ xAccuracy: true }), attacker(), poisonedRng)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// turn order (TurnOrder.lua)
// ---------------------------------------------------------------------------

describe("turn order", () => {
  const withSpeed = (speed: number, over: Partial<Damage.Battler> = {}) =>
    atkBattler(20, 30, ["NORMAL"], {
      curStats: { hp: 999, attack: 30, defense: 30, speed, special: 30 },
      ...over,
    });

  test("effectiveSpeed: stages, SOULBADGE 9/8, paralysis quarter, Haze lift", () => {
    expect(TurnOrder.effectiveSpeed(withSpeed(100))).toBe(100);
    expect(TurnOrder.effectiveSpeed(withSpeed(100, { stages: { speed: 2 } }))).toBe(200);
    expect(TurnOrder.effectiveSpeed(withSpeed(100, { badges: { SOULBADGE: true } }))).toBe(112);
    const par = withSpeed(100, { mon: { level: 20, status: "PAR", stats: { hp: 999, attack: 30, defense: 30, speed: 100, special: 30 } } });
    expect(TurnOrder.effectiveSpeed(par)).toBe(25);
    par.badges = { SOULBADGE: true };
    expect(TurnOrder.effectiveSpeed(par)).toBe(28); // floor(112/4)
    par.hazeStatReset = true;
    expect(TurnOrder.effectiveSpeed(par)).toBe(112);
  });

  const tackle = { id: "T_TACKLE", type: "NORMAL", power: 40 };
  const quick = { id: "QUICK_ATTACK", type: "NORMAL", power: 40 };
  const counter = { id: "COUNTER", type: "FIGHTING", power: 1 };

  test("priority outranks speed; the priority field wins over the id list", () => {
    expect(TurnOrder.firstMover(withSpeed(10), quick, withSpeed(100), tackle, poisonedRng)).toBe(true);
    expect(TurnOrder.firstMover(withSpeed(100), counter, withSpeed(10), tackle, poisonedRng)).toBe(false);
    const superQuick = { ...tackle, priority: 2 } as Damage.DamageMove;
    expect(TurnOrder.firstMover(withSpeed(10), superQuick, withSpeed(100), quick, poisonedRng)).toBe(true);
  });

  test("speed decides equal priority; ties are a coin flip, invertible", () => {
    expect(TurnOrder.firstMover(withSpeed(100), tackle, withSpeed(10), tackle, poisonedRng)).toBe(true);
    expect(TurnOrder.firstMover(withSpeed(50), tackle, withSpeed(50), tackle, fixedRng(0))).toBe(true);
    expect(TurnOrder.firstMover(withSpeed(50), tackle, withSpeed(50), tackle, fixedRng(1))).toBe(false);
    expect(TurnOrder.firstMover(withSpeed(50), tackle, withSpeed(50), tackle, fixedRng(0), true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// catching (Catching.lua)
// ---------------------------------------------------------------------------

describe("catching", () => {
  const target = (hp: number, maxhp: number, status: string | null = null) => ({
    hp,
    status,
    stats: { hp: maxhp },
  });
  const def45 = { catchRate: 45 };

  test("MASTER_BALL auto-catches without a roll", () => {
    expect(Catching.attempt("MASTER_BALL", target(21, 21), def45, poisonedRng)).toEqual([true, 3]);
  });

  test("a status bonus can push the first roll below zero (guaranteed)", () => {
    // SLP bonus 25: roll 10 -> r = -15 -> caught
    expect(Catching.attempt("POKE_BALL", target(21, 21, "SLP"), def45, seqRng(10))).toEqual([true, 3]);
  });

  test("first roll over the rate fails and wobbles from the HP factor", () => {
    // full-HP 21/21 POKE_BALL: f = floor(floor(21*255/12)/5) = 89
    // y = floor(4500/255) = 17, z = floor(89*17/255) = 5 -> 0 shakes
    expect(Catching.attempt("POKE_BALL", target(21, 21), def45, seqRng(100))).toEqual([false, 0]);
    // ULTRA divisor 150: y = 30, z = floor(89*30/255) = 10 -> 1 shake
    expect(Catching.attempt("ULTRA_BALL", target(21, 21), def45, seqRng(100, 0))).toEqual([false, 1]);
  });

  test("the second roll compares against the HP factor inclusively", () => {
    expect(Catching.attempt("POKE_BALL", target(21, 21), def45, seqRng(30, 89))).toEqual([true, 3]);
    expect(Catching.attempt("POKE_BALL", target(21, 21), def45, seqRng(30, 90))).toEqual([false, 0]);
  });

  test("rateOverride replaces the species rate (Safari BAIT/ROCK)", () => {
    // rate 3: roll 30 > 3 -> fail; y = floor(300/255) = 1, z = floor(89/255) = 0
    expect(Catching.attempt("POKE_BALL", target(21, 21), def45, seqRng(30), 3)).toEqual([false, 0]);
  });

  test("a merged ball record's attempt fn supersedes the stock math", () => {
    const ballDef: Catching.BallDef = {
      randMax: 255,
      attempt: (ctx) => {
        ctx.rateOverride = 255;
        return ctx.vanillaAttempt();
      },
    };
    // rewritten rate 255: roll 200 <= 255 -> second roll 0 <= f -> caught
    expect(
      Catching.attempt("POKE_BALL", target(21, 21), def45, seqRng(200, 0), undefined, { ballDef }),
    ).toEqual([true, 3]);
  });
});

// ---------------------------------------------------------------------------
// status (Status.lua)
// ---------------------------------------------------------------------------

describe("status", () => {
  const mk = (over: Partial<Status.StatusBattler> = {}): Status.StatusBattler => ({
    mon: { hp: 40, status: null, stats: { hp: 48, attack: 30, defense: 30, speed: 30, special: 30 } },
    name: "FIXMON",
    ...over,
  });

  test("sleep counts down, then wakes and still loses the turn", () => {
    const b = mk({ sleepTurns: 2 });
    b.mon.status = "SLP";
    let r = Status.beforeMove(b, poisonedRng);
    expect([r.canMove, b.sleepTurns, b.mon.status]).toEqual([false, 1, "SLP"]);
    expect(r.messages).toEqual(["FIXMON\nis fast asleep!"]);
    r = Status.beforeMove(b, poisonedRng);
    expect(r.canMove).toBe(false);
    expect(b.mon.status).toBeNull();
    expect(r.messages).toEqual(["FIXMON\nwoke up!"]);
  });

  test("freeze never moves; paralysis blocks on rand < 63", () => {
    const frozen = mk();
    frozen.mon.status = "FRZ";
    expect(Status.beforeMove(frozen, poisonedRng).canMove).toBe(false);
    const par = mk();
    par.mon.status = "PAR";
    expect(Status.beforeMove(par, fixedRng(62)).canMove).toBe(false);
    expect(Status.beforeMove(par, fixedRng(63)).canMove).toBe(true);
  });

  test("confusion self-hit on rand < 128, and it clears at zero turns", () => {
    const b = mk({ confusedTurns: 2 });
    const hit = Status.beforeMove(b, fixedRng(127));
    expect([hit.canMove, hit.selfHit, b.confusedTurns]).toEqual([false, true, 1]);
    const through = Status.beforeMove(mk({ confusedTurns: 2 }), fixedRng(128));
    expect([through.canMove, through.selfHit]).toEqual([true, undefined]);
    const over = mk({ confusedTurns: 1 });
    const done = Status.beforeMove(over, poisonedRng);
    expect([done.canMove, over.confusedTurns]).toEqual([true, undefined]);
    expect(done.messages).toEqual(["FIXMON\nsnapped out of\nconfusion!"]);
  });

  test("sleep outranks the volatiles; paralysis runs after them", () => {
    const sleeping = mk({ sleepTurns: 2, confusedTurns: 2 });
    sleeping.mon.status = "SLP";
    Status.beforeMove(sleeping, poisonedRng);
    expect(sleeping.confusedTurns).toBe(2); // untouched: sleep returned first
    const par = mk({ confusedTurns: 2 });
    par.mon.status = "PAR";
    const r = Status.beforeMove(par, seqRng(128, 62)); // confusion roll, then PAR roll
    expect(r.canMove).toBe(false);
    expect(r.messages).toEqual(["FIXMON\nis confused!", "FIXMON's\nfully paralyzed!"]);
  });

  test("flinch, bind, disable and the Haze skip consume their flags", () => {
    const flinched = mk({ flinched: true });
    const rf = Status.beforeMove(flinched, poisonedRng);
    expect([rf.canMove, flinched.flinched]).toEqual([false, false]);
    const bound = mk({ boundTurns: 1 });
    const rb = Status.beforeMove(bound, poisonedRng);
    expect([rb.canMove, bound.boundTurns]).toEqual([false, 0]);
    expect(rb.messages).toEqual(["FIXMON\ncan't move!"]);
    const disabled = mk({ disabledTurns: 1, disabledSlot: 2 });
    const rd = Status.beforeMove(disabled, poisonedRng);
    expect([rd.canMove, disabled.disabledTurns, disabled.disabledSlot]).toEqual([true, undefined, undefined]);
    expect(rd.messages).toEqual(["FIXMON's\ndisabled no more!"]);
    const skipped = mk({ skipMove: true });
    expect(Status.beforeMove(skipped, poisonedRng)).toEqual({ canMove: false, messages: [] });
    expect(skipped.skipMove).toBeUndefined();
  });

  test("poison residual is 1/16 max HP, multiplied by the Toxic counter", () => {
    const b = mk();
    b.mon.status = "PSN";
    Status.residual(b, mk());
    expect(b.mon.hp).toBe(37); // 40 - floor(48/16)
    const toxic = mk({ toxicCounter: 2 });
    toxic.mon.status = "PSN";
    Status.residual(toxic, mk());
    expect([toxic.mon.hp, toxic.toxicCounter]).toEqual([34, 3]); // 40 - 3*2
  });

  test("leech seed drains into the opponent and shares the Toxic counter", () => {
    const seeded = mk({ leechSeeded: true });
    const opp = mk();
    opp.mon.hp = 10;
    const msgs = Status.residual(seeded, opp);
    expect([seeded.mon.hp, opp.mon.hp]).toEqual([37, 13]);
    expect(msgs).toEqual(["LEECH SEED saps\nFIXMON!"]);
    // heal caps at the opponent's max
    const full = mk();
    Status.residual(mk({ leechSeeded: true }), full);
    expect(full.mon.hp).toBe(43); // 40 + 3, under max 48
  });

  test("inflict records: immunities and the sleep-turn roll", () => {
    expect(Status.RECORDS.FRZ.canInflict!(mk({ curTypes: ["ICE"] }), {})).toBe(false);
    expect(Status.RECORDS.PSN.canInflict!(mk({ curTypes: ["POISON"] }), {})).toBe(false);
    expect(Status.RECORDS.BRN.canInflict!(mk({ curTypes: ["FIRE"] }), {})).toBe(false);
    expect(Status.RECORDS.PAR.canInflict!(mk({ curTypes: ["GROUND"] }), { moveType: "ELECTRIC" })).toBe(false);
    expect(Status.RECORDS.PAR.canInflict!(mk({ curTypes: ["GROUND"] }), { moveType: "NORMAL" })).toBe(true);
    const b = mk();
    Status.RECORDS.SLP.onInflict!(b, {}, "FIXMON", fixedRng(3));
    expect(b.sleepTurns).toBe(4); // 1 + rng.int(7)
    const t = mk();
    Status.RECORDS.PSN.onInflict!(t, { toxic: true }, "FIXMON", poisonedRng);
    expect(t.toxicCounter).toBe(1);
  });

  test("catch bonuses ride the records (SLP/FRZ 25/+10, rest 12/+5)", () => {
    expect([Status.RECORDS.SLP.catchBonus, Status.RECORDS.SLP.shakeBonus]).toEqual([25, 10]);
    expect([Status.RECORDS.FRZ.catchBonus, Status.RECORDS.FRZ.shakeBonus]).toEqual([25, 10]);
    expect([Status.RECORDS.PAR.catchBonus, Status.RECORDS.PAR.shakeBonus]).toEqual([12, 5]);
    expect(Status.RECORDS.BRN.statPenalty).toEqual({ stat: "attack", div: 2 });
    expect(Status.RECORDS.PAR.statPenalty).toEqual({ stat: "speed", div: 4 });
  });
});

// ---------------------------------------------------------------------------
// encounters (Encounter.lua)
// ---------------------------------------------------------------------------

describe("encounters", () => {
  const def = data.encounters.FIX_ROUTE;

  test("the rate gate is rand(0..255) < rate", () => {
    expect(Encounter.roll(def, fixedRng(25))).toBeNull(); // rate 25: 25 >= 25
    expect(Encounter.roll(def, seqRng(24, 0))).toEqual({ species: "FIXMON_A", level: 3 });
  });

  test("the 256-bucket pick maps to slots; a missing slot is no encounter", () => {
    expect(Encounter.roll(def, seqRng(0, 50))).toEqual({ species: "FIXMON_A", level: 3 });
    expect(Encounter.roll(def, seqRng(0, 51))).toEqual({ species: "FIXMON_C", level: 4 });
    expect(Encounter.roll(def, seqRng(0, 150))).toBeNull(); // bucket 4, only 2 slots
  });

  test("a def-local buckets table wins; empty defs never roll", () => {
    const custom = {
      grass: { rate: 255, buckets: [128, 256], slots: [{ species: "A", level: 1 }, { species: "B", level: 2 }] },
    };
    expect(Encounter.roll(custom, seqRng(0, 128))).toEqual({ species: "B", level: 2 });
    expect(Encounter.roll(undefined, poisonedRng)).toBeNull();
    expect(Encounter.roll({ grass: { rate: 0, slots: [] } }, poisonedRng)).toBeNull();
    expect(Encounter.roll({}, poisonedRng)).toBeNull();
  });

  test("the vanilla buckets are the wild_encounters.asm thresholds", () => {
    expect(Encounter.ENCOUNTER_BUCKETS).toEqual([51, 102, 141, 166, 191, 216, 229, 242, 253, 256]);
  });
});

// ---------------------------------------------------------------------------
// experience (Experience.lua)
// ---------------------------------------------------------------------------

describe("experience", () => {
  const fixB = data.pokemon.FIXMON_B; // baseExp 65

  test("gainFor: participant division first, then level/7, then the 1.5s", () => {
    const fixA = data.pokemon.FIXMON_A; // baseExp 64
    expect(Experience.gainFor(fixA, 5)).toBe(45); // floor(64*5/7)
    expect(Experience.gainFor(fixA, 5, true)).toBe(67); // floor(45*1.5)
    expect(Experience.gainFor(fixA, 5, false, 1, true)).toBe(67);
    expect(Experience.gainFor(fixA, 5, true, 1, true)).toBe(100); // floor(67*1.5)
    expect(Experience.gainFor(fixA, 5, false, 2)).toBe(22); // floor(floor(64/2)*5/7)
    expect(Experience.gainFor({ ...fixA, baseExp: 1 }, 1, false, 8)).toBe(1); // min 1
  });

  test("a constants.exp record retunes the divisor and multipliers", () => {
    const consts = { exp: { divisor: 5, trainerMult: 2 } };
    expect(Experience.gainFor(fixB, 5, true, 1, false, consts)).toBe(130); // floor(65*5/5)*2
  });

  test("apply grants stat exp, exp, and walks the level curve", () => {
    const mon = freshMon(data, "FIXMON_A", 5, seededRng(1));
    mon.dvs = {} as typeof mon.dvs;
    mon.stats = Stats.calc(data.pokemon.FIXMON_A, 5, {});
    mon.hp = mon.stats.hp;
    mon.exp = Growth.expForLevel("MEDIUM_SLOW", 5); // 135
    const [levels, gained] = Experience.apply(data, mon, fixB, 20);
    expect(gained).toBe(185); // floor(65*20/7)
    expect(mon.exp).toBe(320);
    expect(levels).toEqual([6, 7, 8]); // MEDIUM_SLOW thresholds 179/236/314
    expect(mon.level).toBe(8);
    expect(mon.statExp.attack).toBe(52); // FIXMON_B base attack
    expect(mon.hp).toBe(mon.stats.hp); // stayed full through the level-ups
  });

  test("stat exp is shared by participants and capped at 65535", () => {
    const mon = freshMon(data, "FIXMON_A", 5, seededRng(1));
    mon.statExp = { hp: 65530, attack: 0, defense: 0, speed: 0, special: 0 };
    Experience.apply(data, mon, fixB, 5, false, 2);
    expect(mon.statExp.hp).toBe(65535); // 65530 + floor(39/2) caps
    expect(mon.statExp.attack).toBe(26); // floor(52/2)
  });

  test("movesLearnedAt is the exact-level rule", () => {
    const def = data.pokemon.FIXMON_A;
    expect(Experience.movesLearnedAt(def, 7)).toEqual(["FIX_EMBERISH"]);
    expect(Experience.movesLearnedAt(def, 8)).toEqual([]);
    expect(Experience.movesLearnedAt(def, 1)).toEqual(["FIX_TACKLE"]);
  });
});

// ---------------------------------------------------------------------------
// evolution (Evolution.lua check logic)
// ---------------------------------------------------------------------------

describe("evolution", () => {
  const monAt = (level: number) => {
    const stats = Stats.calc(data.pokemon.FIXMON_A, level, {});
    return { species: "FIXMON_A", level, hp: stats.hp, dvs: {}, statExp: {}, stats };
  };

  test("pendingLevelEvo fires at the threshold, not before", () => {
    expect(Evolution.pendingLevelEvo(data, monAt(15))).toBeNull();
    expect(Evolution.pendingLevelEvo(data, monAt(16))).toBe("FIXMON_B");
  });

  test("pendingFor dispatches by trigger kind", () => {
    expect(Evolution.pendingFor(data, monAt(16), { kind: "levelup" })?.[0]).toBe("FIXMON_B");
    expect(Evolution.pendingFor(data, monAt(16), { kind: "manual" })).toBeNull();
    expect(Evolution.pendingFor(data, monAt(15), { kind: "levelup" })).toBeNull();
  });

  test("ITEM matches the exact stone; TRADE matches any trade", () => {
    const modded = fixtureData();
    modded.pokemon.FIXMON_A.evolutions = [
      { method: "ITEM", item: "FIX_STONE", species: "FIXMON_C" },
      { method: "TRADE", species: "FIXMON_B" },
    ];
    const mon = monAt(10);
    expect(Evolution.pendingFor(modded, mon, { kind: "item", item: "FIX_STONE" })?.[0]).toBe("FIXMON_C");
    expect(Evolution.pendingFor(modded, mon, { kind: "item", item: "OTHER" })).toBeNull();
    expect(Evolution.pendingFor(modded, mon, { kind: "trade" })?.[0]).toBe("FIXMON_B");
    expect(Evolution.METHODS.ITEM.consumesItem).toBe(true);
  });

  test("apply keeps the HP lost, recalculates stats, stamps the dex", () => {
    const mon = monAt(16);
    // L16 zero-DV FIXMON_A: hp max 40; take 10 damage
    expect(mon.stats.hp).toBe(40);
    mon.hp = 30;
    const dex = { seen: {}, owned: {} };
    Evolution.apply(data, mon, "FIXMON_B", dex);
    expect(mon.species).toBe("FIXMON_B");
    expect(mon.stats.hp).toBe(38); // floor(39*2*16/100) + 26
    expect(mon.hp).toBe(28); // 38 - the 10 lost
    expect([dex.seen, dex.owned]).toEqual([{ FIXMON_B: true }, { FIXMON_B: true }]);
    expect(() => Evolution.apply(data, monAt(5), "NOBODY")).toThrow("unknown species");
  });
});

// ---------------------------------------------------------------------------
// bag (Bag.lua)
// ---------------------------------------------------------------------------

describe("bag", () => {
  test("capacity: vanilla 20, constants.bagSize override, floored", () => {
    expect(Bag.capacity()).toBe(20);
    expect(Bag.capacity(data)).toBe(20);
    expect(Bag.capacity({ constants: { bagSize: 5 } })).toBe(5);
    expect(Bag.capacity({ constants: { bagSize: 5.9 } })).toBe(5);
    expect(Bag.capacity({ constants: { bagSize: 0 } })).toBe(20);
  });

  test("badges occupy inventory but never bag slots", () => {
    expect(Bag.isBadge("FIX_BADGE_1")).toBe(true);
    expect(Bag.isBadge("FIX_POTION")).toBe(false);
    const save = { inventory: { FIX_POTION: 2, FIX_BADGE_1: 1 } };
    expect(Bag.slots(save)).toBe(1);
  });

  test("add enforces the slot cap and the 99 stack cap; badges bypass both", () => {
    const save: Bag.BagSave = { inventory: {} };
    for (let i = 0; i < 20; i++) expect(Bag.add(save, `ITEM_${i}`)).toBe(true);
    expect(Bag.add(save, "ITEM_20")).toBe(false); // full
    expect(Bag.add(save, "ITEM_0", 99)).toBe(false); // 1 + 99 > 99
    expect(Bag.add(save, "ITEM_0", 98)).toBe(true); // 1 + 98 = 99, at the cap
    expect(save.inventory.ITEM_0).toBe(99);
    expect(Bag.add(save, "FIX_BADGE_1")).toBe(true); // badge ignores the full bag
    expect(Bag.slots(save)).toBe(20);
  });

  test("order rebuilds sorted once, then tracks acquisition and removal", () => {
    const save: Bag.BagSave = { inventory: { B_ITEM: 1, A_ITEM: 1, FIX_BADGE_1: 1 } };
    expect(Bag.order(save)).toEqual(["A_ITEM", "B_ITEM"]); // legacy save: sorted
    Bag.add(save, "Z_ITEM");
    Bag.add(save, "C_ITEM");
    expect(Bag.order(save)).toEqual(["A_ITEM", "B_ITEM", "Z_ITEM", "C_ITEM"]);
    Bag.remove(save, "B_ITEM");
    expect(Bag.order(save)).toEqual(["A_ITEM", "Z_ITEM", "C_ITEM"]);
    Bag.remove(save, "Z_ITEM", 1);
    expect(save.inventory.Z_ITEM).toBeUndefined();
    // stale entries drop, direct inventory writes append
    save.inventory.NEW_ITEM = 1;
    expect(Bag.order(save)).toEqual(["A_ITEM", "C_ITEM", "NEW_ITEM"]);
  });
});

// ---------------------------------------------------------------------------
// timing (timing_parity.lua constants + closed forms)
// ---------------------------------------------------------------------------

describe("timing", () => {
  test("fade, text and menu constants match the asm citations", () => {
    expect(Timing.FADE_OUT_TO_BLACK).toBe(32); // fade.asm b=4 x 8
    expect(Timing.FADE_IN_FROM_BLACK).toBe(32);
    expect(Timing.FADE_OUT_TO_WHITE).toBe(24); // fade.asm b=3 x 8
    expect(Timing.FADE_IN_FROM_WHITE).toBe(24);
    expect(Timing.DELAY3).toBe(3);
    expect(Timing.TEXT_SCROLL_PAIR).toBe(10);
    expect(Timing.TEXT_CONT).toBe(13); // ProtectedDelay3 + two-line scroll
    expect(Timing.TEXT_PARAGRAPH).toBe(23); // ProtectedDelay3 + DelayFrames 20
    expect(Timing.TEXT_PAGE).toBe(23);
    expect(Timing.YES_NO_ANSWER).toBe(15);
    expect(Timing.WARP_FADE_OUT).toBe(32);
    expect(Timing.WARP_FADE_IN).toBe(0); // LoadGBPal restores in one write
    expect(Timing.SPECIAL_WARP_ENTRY).toBe(27);
    expect(Timing.FIELD_TELEPORT).toBe(63);
  });

  test("battle beats match the asm citations", () => {
    expect(Timing.BATTLE_SLIDE_IN_FRAMES).toBe(72); // 144 px at 2 px/frame
    expect(Timing.BLINK_MON).toBe(60); // 6 x (5+5)
    expect(Timing.FAINT_SLIDE).toBe(14); // 7 rows x 2
    expect(Timing.MOVE_STATUS_OR_MISS).toBe(30);
    expect(Timing.SHAKE_HORIZ_HEAVY).toBe(72);
    expect(Timing.FAINT_SLIDE_STEP).toBe(4);
  });

  test("hpBarPixels floors 48ths and clamps slivers to 1", () => {
    expect(Timing.hpBarPixels(150, 150)).toBe(48);
    expect(Timing.hpBarPixels(75, 150)).toBe(24);
    expect(Timing.hpBarPixels(0, 150)).toBe(0);
    expect(Timing.hpBarPixels(1, 150)).toBe(1);
  });

  test("a 150 HP drain costs D+2P+6 player-side, 2P+5 enemy-side", () => {
    expect(Timing.hpDrainFrames(150, 0, 150, true)).toBe(252);
    expect(Timing.hpDrainFrames(150, 0, 150, false)).toBe(101);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: ROM-gated content facts (content_red/facts.lua)
// ---------------------------------------------------------------------------

const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log(
    "voxel-rules: ROM-gated facts SKIPPED — dist/voxelmon/gen/ is absent or incomplete (run `bun tools/voxel.ts import`)",
  );
}
const romData = hasGen ? await fromGenDir(genDir) : null;

describe("content_red facts (ROM-gated)", () => {
  // facts.lua:44-51 — the starter trio's level-5 stats at zero DVs
  const starters: Record<string, { dex: number; types: string[]; statsAt5: Record<string, number> }> = {
    BULBASAUR: {
      dex: 1,
      types: ["GRASS", "POISON"],
      statsAt5: { hp: 19, attack: 9, defense: 9, speed: 9, special: 11 },
    },
    CHARMANDER: {
      dex: 4,
      types: ["FIRE"],
      statsAt5: { hp: 18, attack: 10, defense: 9, speed: 11, special: 10 },
    },
    SQUIRTLE: {
      dex: 7,
      types: ["WATER"],
      statsAt5: { hp: 19, attack: 9, defense: 11, speed: 9, special: 10 },
    },
  };

  for (const [id, facts] of Object.entries(starters)) {
    test.skipIf(!hasGen)(`starter ${id}: dex, types, level-5 zero-DV stats`, () => {
      const def = romData!.pokemon[id];
      expect(def.dex).toBe(facts.dex);
      expect(def.types).toEqual(facts.types);
      expect(Stats.calc(def, 5, {}) as unknown as Record<string, number>).toEqual(facts.statsAt5);
    });
  }

  test.skipIf(!hasGen)("dexSize 151 (facts.lua:21)", () => {
    const defs = Object.values(romData!.pokemon);
    expect(defs.length).toBe(151);
    expect(Math.max(...defs.map((d) => d.dex))).toBe(151);
  });

  test.skipIf(!hasGen)("typeCount 15 across the matchup table (facts.lua:22)", () => {
    const ids = new Set<string>();
    for (const row of romData!.type_chart.matchups) {
      ids.add(row.attacker);
      ids.add(row.defender);
    }
    for (const id of ids) expect(TYPES[id]).toBeDefined();
    expect(Object.keys(TYPES).length).toBe(15);
  });

  test.skipIf(!hasGen)("known matchups through the loaded chart", () => {
    const romChart = createTypeChart(romData!.type_chart);
    expect(romChart.effectiveness("WATER", ["FIRE"])).toBe(20);
    expect(romChart.effectiveness("FIRE", ["GRASS"])).toBe(20);
    expect(romChart.effectiveness("GROUND", ["FLYING"])).toBe(0);
    expect(romChart.effectiveness("FIRE", ["WATER"])).toBe(5);
  });

  test.skipIf(!hasGen)("every species rides one of the six vanilla curves", () => {
    for (const def of Object.values(romData!.pokemon)) {
      expect(Growth.CURVES[def.growthRate]).toBeDefined();
    }
    expect(Growth.expForLevel(romData!.pokemon.BULBASAUR.growthRate, 100)).toBe(1059860);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: luajit micro-oracles against the reference checkout
// ---------------------------------------------------------------------------

const g1rRoot = process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
const luajit = Bun.which("luajit");
const hasOracle = luajit !== null && existsSync(join(g1rRoot, "src/battle/Damage.lua"));
if (!hasOracle) {
  console.log(
    "voxel-rules: luajit oracles SKIPPED — luajit or the gen1recomp checkout (VOXELMON_G1R) is absent",
  );
}

function runOracle(script: string): string[] {
  const proc = Bun.spawnSync([luajit!, join(root, "tests/fixtures/voxelmon/oracle", script), g1rRoot]);
  if (proc.exitCode !== 0) {
    throw new Error(`${script} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim().split("\n");
}

describe("luajit oracles", () => {
  test.skipIf(!hasOracle)("damage matches the reference over the matrix", () => {
    const lines = runOracle("damage-oracle.lua");
    // KEEP IN LOCKSTEP with damage-oracle.lua
    const levels = [5, 20, 50, 100];
    const powers = [40, 90, 120];
    const statPairs: [number, number][] = [[30, 30], [120, 80], [300, 120], [45, 300]];
    const rolls = [217, 234, 255];
    const matchups: { moveType: string; defTypes: string[] }[] = [
      { moveType: "NORMAL", defTypes: ["GRASS"] },
      { moveType: "FIRE", defTypes: ["GRASS"] },
      { moveType: "FIRE", defTypes: ["WATER"] },
      { moveType: "FIRE", defTypes: ["GRASS", "WATER"] },
    ];
    const ours: string[] = [];
    for (const crit of [false, true]) {
      for (const mu of matchups) {
        for (const [a, d] of statPairs) {
          for (const power of powers) {
            for (const level of levels) {
              for (const roll of rolls) {
                const attacker = atkBattler(level, a, ["NORMAL"]);
                const defender = defBattler(level, d, mu.defTypes);
                const move = { id: "ORACLE_MOVE", type: mu.moveType, power, accuracy: 100 };
                const [dmg, info] = Damage.compute(faithful, chart, attacker, defender, move, {
                  rng: damageRoll(roll),
                  forceCrit: crit,
                });
                ours.push(`${dmg} ${info.typeMult} ${info.missed ? 1 : 0}`);
              }
            }
          }
        }
      }
    }
    expect(ours.length).toBe(lines.length);
    expect(ours.join("\n")).toBe(lines.join("\n"));
  });

  test.skipIf(!hasOracle)("catching matches the reference over the matrix", () => {
    const lines = runOracle("catch-oracle.lua");
    // KEEP IN LOCKSTEP with catch-oracle.lua
    const balls = ["MASTER_BALL", "POKE_BALL", "GREAT_BALL", "ULTRA_BALL"];
    const statuses = [null, "SLP", "PAR"];
    const hps: [number, number][] = [[21, 21], [5, 21], [1, 21], [150, 150], [40, 150]];
    const rates = [45, 200, 255];
    const rollPairs: [number, number][] = [[0, 0], [25, 255], [100, 0], [149, 120], [255, 255]];
    const ours: string[] = [];
    for (const ball of balls) {
      for (const st of statuses) {
        for (const [hp, maxhp] of hps) {
          for (const rate of rates) {
            for (const [r1, r2] of rollPairs) {
              const [caught, shakes] = Catching.attempt(
                ball,
                { hp, status: st, stats: { hp: maxhp } },
                { catchRate: rate },
                seqRng(r1, r2),
              );
              ours.push(`${caught ? 1 : 0} ${shakes}`);
            }
          }
        }
      }
    }
    expect(ours.length).toBe(lines.length);
    expect(ours.join("\n")).toBe(lines.join("\n"));
  });
});
