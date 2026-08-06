// ROM-free stand-in dataset, ported value-for-value from gen1recomp
// tests/fixture_data/ (pokemon.lua, moves.lua, type_chart.lua,
// constants.lua, encounters.lua, maps.lua, tilesets.lua, items.lua,
// field.lua). Same field names as the generated modules, arrays 0-indexed
// per the SCHEMA.md normalization. Test-only: nothing shipped reads this.
//
// Not ported (nothing the rules tests read): battle_anims, font, sprites,
// text, text_pointers, trainer_headers, trainers.

import { fromObject, type MapDef, type VoxelmonData } from "../../../voxelmon/game/data.ts";

// tests/fixture_data/maps.lua:2-6 flat
const flat = (width: number, height: number, block: number): number[] =>
  new Array<number>(width * height).fill(block);

// tests/fixture_data/tilesets.lua:3-6 row
const row = (tile: number): number[] => new Array<number>(16).fill(tile);

const town: MapDef = {
  id: "FIX_TOWN",
  label: "FixTown",
  index: 1000,
  tileset: "FIX_OUT",
  width: 10,
  height: 9,
  blocks: flat(10, 9, 1),
  borderBlock: 0,
  connections: { north: { map: "FIX_ROUTE", offset: 0 } },
  warps: [{ x: 5, y: 5, destMap: "FIX_ROUTE", destWarp: 1 }],
  objects: [
    {
      index: 1,
      name: "FIXTOWN_GREETER",
      sprite: "SPRITE_FIX_NPC",
      movement: "STAY",
      range: "NONE",
      text: "TEXT_FIXTOWN_GREETER",
      x: 4,
      y: 4,
    },
  ],
  signs: [{ text: "TEXT_FIXTOWN_SIGN", x: 6, y: 6 }],
};

const route: MapDef = {
  id: "FIX_ROUTE",
  label: "FixRoute",
  index: 1001,
  tileset: "FIX_OUT",
  width: 10,
  height: 18,
  blocks: flat(10, 18, 2),
  borderBlock: 0,
  connections: { south: { map: "FIX_TOWN", offset: 0 } },
  warps: [{ x: 5, y: 1, destMap: "FIX_TOWN", destWarp: 1 }],
  objects: [
    {
      index: 1,
      name: "FIXROUTE_TRAINER",
      sprite: "SPRITE_FIX_NPC",
      movement: "STAY",
      range: "NONE",
      text: "TEXT_FIXROUTE_TRAINER",
      x: 5,
      y: 9,
    },
  ],
  signs: [],
};

/** Assemble a fresh dataset per call (fixture init.lua re-requires modules
 *  so one test's mutation never leaks into the next; structuredClone is the
 *  same isolation). */
export function fixtureData(): VoxelmonData {
  return fromObject(
    structuredClone({
      constants: {
        bagSize: 20,
        partyMax: 6,
        boxCount: 2,
        boxSize: 20,
        moveMax: 4,
        dexSize: 3,
        dexDigits: 3,
        levelCap: 100,
        coinCap: 9999,
        fallbackMove: "FIX_TACKLE",
        badges: [{ id: "FIX_BADGE_1" }, { id: "FIX_BADGE_2" }],
        hmMoves: ["FIX_CUT"],
      },
      pokemon: {
        FIXMON_A: {
          id: "FIXMON_A",
          index: 1,
          dex: 1,
          name: "FIXMON A",
          types: ["GRASS"],
          baseStats: { hp: 45, attack: 49, defense: 49, speed: 45, special: 65 },
          catchRate: 45,
          baseExp: 64,
          level1Moves: ["FIX_TACKLE"],
          growthRate: "MEDIUM_SLOW",
          tmhm: ["FIX_CUT"],
          learnset: [
            { level: 1, move: "FIX_TACKLE" },
            { level: 7, move: "FIX_EMBERISH" },
          ],
          evolutions: [{ method: "LEVEL", level: 16, species: "FIXMON_B" }],
        },
        FIXMON_B: {
          id: "FIXMON_B",
          index: 2,
          dex: 2,
          name: "FIXMON B",
          types: ["FIRE"],
          baseStats: { hp: 39, attack: 52, defense: 43, speed: 65, special: 60 },
          catchRate: 45,
          baseExp: 65,
          level1Moves: ["FIX_SCRATCH"],
          growthRate: "MEDIUM_SLOW",
          tmhm: [],
          learnset: [{ level: 1, move: "FIX_SCRATCH" }],
          evolutions: [],
        },
        FIXMON_C: {
          id: "FIXMON_C",
          index: 3,
          dex: 3,
          name: "FIXMON C",
          types: ["WATER"],
          baseStats: { hp: 44, attack: 48, defense: 65, speed: 43, special: 50 },
          catchRate: 45,
          baseExp: 66,
          level1Moves: ["FIX_TACKLE"],
          growthRate: "MEDIUM_SLOW",
          tmhm: ["FIX_CUT"],
          learnset: [{ level: 1, move: "FIX_TACKLE" }],
          evolutions: [],
        },
      },
      moves: {
        FIX_TACKLE: {
          id: "FIX_TACKLE",
          index: 1,
          name: "FIX TACKLE",
          type: "NORMAL",
          power: 40,
          accuracy: 100,
          pp: 35,
          effect: "NO_ADDITIONAL_EFFECT",
        },
        FIX_SCRATCH: {
          id: "FIX_SCRATCH",
          index: 2,
          name: "FIX SCRATCH",
          type: "NORMAL",
          power: 40,
          accuracy: 100,
          pp: 35,
          effect: "NO_ADDITIONAL_EFFECT",
        },
        FIX_EMBERISH: {
          id: "FIX_EMBERISH",
          index: 3,
          name: "FIX EMBER",
          type: "FIRE",
          power: 40,
          accuracy: 100,
          pp: 25,
          effect: "BURN_SIDE_EFFECT1",
        },
        FIX_CUT: {
          id: "FIX_CUT",
          index: 4,
          name: "FIX CUT",
          type: "NORMAL",
          power: 50,
          accuracy: 95,
          pp: 30,
          effect: "NO_ADDITIONAL_EFFECT",
        },
      },
      // the GRASS/FIRE/WATER triangle; type records come from the engine's
      // vanilla TYPES (typechart.ts), same as the Lua registration path
      type_chart: {
        matchups: [
          { attacker: "FIRE", defender: "GRASS", multiplier: 20 },
          { attacker: "GRASS", defender: "WATER", multiplier: 20 },
          { attacker: "WATER", defender: "FIRE", multiplier: 20 },
          { attacker: "FIRE", defender: "WATER", multiplier: 5 },
          { attacker: "WATER", defender: "GRASS", multiplier: 5 },
          { attacker: "GRASS", defender: "FIRE", multiplier: 5 },
        ],
      },
      encounters: {
        FIX_ROUTE: {
          grass: {
            rate: 25,
            slots: [
              { level: 3, species: "FIXMON_A" },
              { level: 4, species: "FIXMON_C" },
            ],
          },
        },
      },
      items: {
        FIX_POTION: { id: "FIX_POTION", index: 1, name: "FIX POTION", price: 300, tossable: true },
        FIX_BALL: { id: "FIX_BALL", index: 2, name: "FIX BALL", price: 200, ball: "POKE_BALL" },
        FIX_TM: {
          id: "FIX_TM",
          index: 3,
          name: "FIX TM01",
          price: 3000,
          machine: { kind: "TM", number: 1, move: "FIX_CUT" },
        },
        FIX_BADGE_1: { id: "FIX_BADGE_1", index: 4, name: "FIX BADGE 1", price: 0 },
        FIX_BADGE_2: { id: "FIX_BADGE_2", index: 5, name: "FIX BADGE 2", price: 0 },
      },
      maps: { FIX_TOWN: town, FIX_ROUTE: route },
      tilesets: {
        FIX_OUT: {
          id: "FIX_OUT",
          blocks: [row(0), row(1), row(2), row(3)],
          walkable: { "0": true, "1": true, "2": true },
          counterTiles: [],
          doorTiles: [],
          warpTiles: [3],
          grassTile: 2,
        },
      },
      field: {
        ledges: [],
        hiddenItems: [],
        flyOrder: ["FIX_TOWN"],
        townMap: {
          locations: {
            FIX_TOWN: { x: 4, y: 4, name: "FIX TOWN" },
            FIX_ROUTE: { x: 4, y: 3, name: "FIX ROUTE" },
          },
        },
        boot: {
          startMap: "FIX_TOWN",
          startX: 5,
          startY: 6,
          startFacing: "down",
          playerName: "FIX",
          rivalName: "RIV",
          startMoney: 3000,
          lastHeal: { map: "FIX_TOWN", x: 5, y: 6 },
        },
      },
    }),
  );
}
