// Pocket Voxel importer invariants (docs/VOXEL.md §7.1). These assert Red
// ground truths against dist/voxelmon/gen/ — the POCKET3D_TEST_MAPS
// convention: when the ROM-derived dataset (or its inputs) is absent the
// suite skips with a printed reason; CI never sees ROM bytes.
//
// Pinned values cross-read from gen1recomp tests/content_red/facts.lua and
// data/generated/ (the parity reference).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { missingInputReason, resolveEnv } from "../voxelmon/import/env.ts";

const env = resolveEnv();
const genReady = existsSync(join(env.genDir, "pokemon.json"));
const reason = genReady
  ? null
  : (missingInputReason(env) ??
    `dist/voxelmon/gen missing — run \`bun tools/voxel.ts import\` first`);
if (reason) console.log(`voxel-import: skipping — ${reason}`);

const json = async (name: string): Promise<any> =>
  await Bun.file(join(env.genDir, `${name}.json`)).json();

describe.skipIf(!genReady)("voxel importer dataset", () => {
  test("pokemon: 151 species, starters and Pikachu pinned", async () => {
    const pokemon = await json("pokemon");
    expect(Object.keys(pokemon).length).toBe(151);
    expect(pokemon.PIKACHU).toBeDefined();
    expect(pokemon.PIKACHU.dex).toBe(25);
    expect(pokemon.PIKACHU.baseStats).toEqual({
      hp: 35,
      attack: 55,
      defense: 30,
      speed: 90,
      special: 50,
    });
    // facts.lua starters — dex numbers + types
    expect(pokemon.BULBASAUR.dex).toBe(1);
    expect(pokemon.BULBASAUR.types).toEqual(["GRASS", "POISON"]);
    expect(pokemon.CHARMANDER.dex).toBe(4);
    expect(pokemon.CHARMANDER.types).toEqual(["FIRE"]);
    expect(pokemon.SQUIRTLE.dex).toBe(7);
    expect(pokemon.SQUIRTLE.types).toEqual(["WATER"]);
    // Red keeps Mew outside BaseStats (MewBaseStats symbol) — dex 151
    expect(pokemon.MEW.dex).toBe(151);
  });

  test("maps: PALLET_TOWN 10x9 with the facts.lua sign and door warp", async () => {
    const maps = await json("maps");
    const pallet = maps.PALLET_TOWN;
    expect(pallet.width).toBe(10);
    expect(pallet.height).toBe(9);
    expect(pallet.blocks.length).toBe(90);
    expect(pallet.connections.north.map).toBe("ROUTE_1");
    expect(pallet.connections.south.map).toBe("ROUTE_21");
    // facts.lua pallet.oakSign / doorWarp
    expect(pallet.signs).toContainEqual({ x: 13, y: 13, text: "TEXT_PALLETTOWN_OAKSLAB_SIGN" });
    expect(pallet.warps[0]).toEqual({ x: 5, y: 5, destMap: "REDS_HOUSE_1F", destWarp: 1 });
    // facts.lua map dimensions (cells = 2x blocks)
    expect([maps.VIRIDIAN_CITY.width, maps.VIRIDIAN_CITY.height]).toEqual([20, 18]);
    expect([maps.OAKS_LAB.width, maps.OAKS_LAB.height]).toEqual([5, 6]);
  });

  test("field: the bedroom PC keeps its ROM hidden-event coordinate and facing", async () => {
    const field = await json("field");
    expect(field.hiddenExtras.pcTiles.REDS_HOUSE_2F).toEqual([
      { x: 0, y: 1, facing: "up" },
    ]);
  });

  test("tilesets: OVERWORLD walkable list and grass tile", async () => {
    const tilesets = await json("tilesets");
    const overworld = tilesets.OVERWORLD;
    expect(overworld.walkable.length).toBeGreaterThan(0);
    expect(overworld.walkable).toContain(0);
    expect(overworld.grassTile).toBe(82);
    expect(overworld.blocks.length).toBe(128);
    expect(overworld.blocks[0].length).toBe(16);
    expect(overworld.animation).toBe("TILEANIM_WATER_FLOWER");
  });

  test("moves: 165 moves, POUND pinned", async () => {
    const moves = await json("moves");
    expect(Object.keys(moves).length).toBe(165);
    expect(moves.POUND.power).toBe(40);
    expect(moves.POUND.accuracy).toBe(100);
    expect(moves.POUND.pp).toBe(35);
    expect(moves.POUND.type).toBe("NORMAL");
    expect(moves.POUND.effect).toBe("NO_ADDITIONAL_EFFECT");
  });

  test("type chart: multipliers are the raw x10 bytes", async () => {
    const chart = await json("type_chart");
    // TypeEffects stores only non-neutral matchups; every stored byte is the
    // x10 value (0 immune, 5 not-very, 20 super) — never 0.5/2 floats.
    for (const matchup of chart.matchups) {
      expect([0, 5, 20]).toContain(matchup.multiplier);
    }
    expect(chart.matchups).toContainEqual({ attacker: "WATER", defender: "FIRE", multiplier: 20 });
    expect(chart.matchups).toContainEqual({ attacker: "NORMAL", defender: "GHOST", multiplier: 0 });
    expect(chart.names.length).toBe(16);
  });

  test("items: key items, TM pricing, the facts.lua HM set", async () => {
    const items = await json("items");
    expect(items.BICYCLE.keyItem).toBe(true);
    expect(items.TM_MEGA_PUNCH.price).toBe(3000);
    expect(items.TM_MEGA_PUNCH.machine).toEqual({ kind: "TM", number: 1, move: "MEGA_PUNCH" });
    for (const hm of ["CUT", "FLY", "SURF", "STRENGTH", "FLASH"]) {
      expect(items[`HM_${hm}`].machine.kind).toBe("HM");
    }
  });

  test("encounters: ROUTE_1 grass table; Pallet Town has none", async () => {
    const encounters = await json("encounters");
    expect(encounters.ROUTE_1.grass.rate).toBe(25);
    expect(encounters.ROUTE_1.grass.slots.length).toBe(10);
    expect(encounters.ROUTE_1.grass.slots[0]).toEqual({ level: 3, species: "PIDGEY" });
    expect("PALLET_TOWN" in encounters).toBe(false);
  });

  test("trainers: OPP_CHIEF carries the manifest override party", async () => {
    const trainers = await json("trainers");
    expect(trainers.OPP_CHIEF.parties.length).toBe(1);
    expect(trainers.OPP_CHIEF.parties[0].length).toBe(5);
    expect(trainers.OPP_CHIEF.parties[0][0]).toEqual({ level: 41, species: "MACHOKE" });
  });

  test("sprites + font: walker sheets and glyph bases", async () => {
    const sprites = await json("sprites");
    expect(sprites.SPRITE_RED.walker).toBe(true);
    expect(sprites.SPRITE_RED.frames).toBe(6);
    expect(sprites.SPRITE_RED_BIKE.walker).toBe(true);
    const font = await json("font");
    expect(font.mainBase).toBe(0x80);
    expect(font.extraBase).toBe(0x60);
    expect(font.glyphsPerRow).toBe(16);
  });

  test("text: decoded dialogue matches known strings", async () => {
    const text = await json("text");
    expect(text._AbraDexEntry).toContain("TELEPORT");
    const headers = await json("trainer_headers");
    // dense-from-1 header tables become arrays (SCHEMA.md normalization)
    expect(Array.isArray(headers.AgathasRoom)).toBe(true);
  });

  test("gfx.bin: directory covers the blob, indexed pixels only", async () => {
    const gfx = await json("gfx");
    const bin = new Uint8Array(await Bun.file(join(env.genDir, "gfx.bin")).arrayBuffer());
    let extent = 0;
    for (const entry of Object.values<any>(gfx)) {
      extent = Math.max(extent, entry.off + entry.w * entry.h);
    }
    expect(extent).toBe(bin.length);
    expect(gfx["tilesets/overworld"]).toMatchObject({ w: 128, h: 48 });
    expect(gfx["fonts/font"]).toMatchObject({ w: 128, h: 64 });
    expect(gfx["sprites/red"]).toMatchObject({ w: 16, h: 96, walker: true });
    // PIKACHU frontSize is 5 tiles -> 40x40 px
    expect(gfx["battle/front/pikachu"]).toMatchObject({ w: 40, h: 40 });
    // 1 byte/px: 0..3 GB shade or 0xff transparent, nothing else
    for (const value of bin) {
      if (value > 3 && value !== 0xff) {
        throw new Error(`gfx.bin holds non-indexed byte ${value}`);
      }
    }
  });
});
