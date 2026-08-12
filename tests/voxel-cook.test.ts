// tests/voxel-cook.test.ts — the voxelizer/cooker under test.
//
// Skips (with a printed reason) when dist/voxelmon/gen/ is absent — the
// POCKET3D_TEST_MAPS convention: everything here derives from the player's
// ROM and CI never sees it. When gen/ is present: the pak loads through the
// real Rust reader (`pocketvoxel-sim --validate`), two cooks are
// byte-identical, every cooked map has chunks and vertices, the CMAP covers
// A-Z a-z 0-9, and the UI page carries the font at its charmap codes.
//
// The RED++ color tests need the gen1recomp checkout too ($VOXELMON_G1R),
// and the ORACLE test needs `luajit` — it runs the reference's own
// `PaletteFX.worldGroupAt`/`worldGroupColors` and compares colour for
// colour. Each skips with its own printed reason.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPalettes,
  buildTerrainPage,
  buildUiPage,
  paletteBase,
} from "../voxelmon/cook/atlas.ts";
import { cook, DEFAULT_MAPS } from "../voxelmon/cook/cli.ts";
import {
  gen1recompDir,
  GEN_DIR,
  genMissingReason,
  loadGen,
  loadRedpp,
} from "../voxelmon/cook/data-node.ts";
import { PX_CLEAR } from "../voxelmon/cook/data.ts";
import { buildCharmap, buildMapPalette } from "../voxelmon/cook/gamedata.ts";
import {
  cullHidden,
  DOWN_CULL_Y,
  FACE,
  PULLED,
  type Quad,
} from "../voxelmon/cook/geom.ts";
import { Redpp, ROOF_GROUP } from "../voxelmon/cook/redpp.ts";
import {
  CAM_FOCAL,
  MESH_KIND,
  MESH_KINDS,
  PITCH_RUNGS,
  RIG,
  RIG_DOLLY,
  VXPK_CHUNK_RECORD_SIZE,
  VXPK_META_FLAG_TREE_LOD,
  VXPK_TAG,
  WORLD_VIEW_H,
} from "../contracts/spec/voxel-spec.ts";

/** A 1x1 axis-aligned quad at (x, y, z) — corner set only; facing is stated. */
const box = (x: number, y: number, z: number): [number, number, number][] => [
  [x, y, z],
  [x + 1, y, z],
  [x + 1, y, z + 1],
  [x, y, z + 1],
];

/** One chunk record, read back out of a written pak's CHNK section. */
interface ChunkRec {
  meshes: { vertBase: number; vertCount: number; indexCount: number }[];
}

/** META flags + every chunk record of a pak on disk (the reader's layout). */
function readPak(path: string): { flags: number; chunks: ChunkRec[] } {
  const bytes = readFileSync(path);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sections = new Map<number, number>();
  for (let i = 0; i < dv.getUint16(6, true); i++) {
    const e = 16 + i * 16;
    sections.set(dv.getUint32(e, true), dv.getUint32(e + 4, true));
  }
  const flags = dv.getUint32(sections.get(VXPK_TAG.meta)! + 32, true);
  const chnk = sections.get(VXPK_TAG.chunks)!;
  const mapCount = dv.getUint16(chnk, true);
  const total = dv.getUint32(chnk + 4, true);
  const first = chnk + 32 + mapCount * 12;
  const chunks: ChunkRec[] = [];
  for (let i = 0; i < total; i++) {
    const r = first + i * VXPK_CHUNK_RECORD_SIZE;
    const meshes = [];
    for (let k = 0; k < MESH_KINDS; k++) {
      // 20 = coords + AABB + the v6 bake-page word and its pad.
      const m = r + 20 + k * 12;
      meshes.push({
        vertBase: dv.getUint32(m, true),
        vertCount: dv.getUint16(m + 4, true),
        indexCount: dv.getUint16(m + 6, true),
      });
    }
    chunks.push({ meshes });
  }
  return { flags, chunks };
}

const root = join(import.meta.dir, "..");
const scratch = join(root, "dist/voxelmon");

const reason = genMissingReason();
if (reason) {
  console.error(`voxel-cook tests skipped — ${reason}`);
}

const packReason = existsSync(join(gen1recompDir(), "data/palettes_gbc.lua"))
  ? null
  : `RED++ color pack not found under ${gen1recompDir()} (set VOXELMON_G1R)`;
if (!reason && packReason) console.error(`voxel-cook color tests skipped — ${packReason}`);
const oracleReason = packReason ?? (Bun.which("luajit") ? null : "luajit is not installed");
if (!reason && !packReason && oracleReason) {
  console.error(`voxel-cook oracle test skipped — ${oracleReason}`);
}

describe.skipIf(reason !== null)("voxel cook", () => {
  const outA = join(scratch, "voxelmon.test-a.vxpak");
  const outB = join(scratch, "voxelmon.test-b.vxpak");
  let resultA: ReturnType<typeof cook>;

  test("cook produces a pak the Rust reader validates", () => {
    resultA = cook(DEFAULT_MAPS, outA);
    expect(resultA.pakBytes).toBeGreaterThan(0);

    // Smoke gate: the core's untrusted-byte reader accepts every section.
    const sim = join(root, "target/release/pocketvoxel-sim");
    const proc = Bun.spawnSync(
      Bun.file(sim).size > 0
        ? [sim, outA, "--validate"]
        : ["cargo", "run", "--release", "-p", "pocketvoxel-sim", "--", outA, "--validate"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("valid:");
  }, 240000);

  test("cook is deterministic: two cooks, identical bytes", () => {
    cook(DEFAULT_MAPS, outB);
    const a = readFileSync(outA);
    const b = readFileSync(outB);
    expect(a.equals(b)).toBe(true);
  }, 240000);

  // Tree LOD (docs/VOXEL.md §4a): the cook emits BOTH levels of detail and
  // the pak SAYS so, because that declaration is what lets a runtime asking
  // for a level this pak does not hold fall back instead of misrender.
  test("the pak carries both tree levels and declares them", () => {
    const { flags, chunks } = readPak(outA);
    expect(flags & VXPK_META_FLAG_TREE_LOD).toBe(VXPK_META_FLAG_TREE_LOD);
    const tris = (kind: number) =>
      chunks.reduce((n, c) => n + c.meshes[kind].indexCount / 3, 0);
    const hull = tris(MESH_KIND.treeHull);
    const boxes = tris(MESH_KIND.treeBox);
    expect(hull).toBeGreaterThan(0);
    expect(boxes).toBeGreaterThan(0);
    // The whole point of the rung: a carved hull is ~700 quads a cell and a
    // box is under ten, so the far level must be a rounding error beside it.
    expect(boxes * 10).toBeLessThan(hull);
  });

  // The near level of detail must draw the same triangles IN THE SAME ORDER
  // as the pre-LOD cook, which packed hulls inside the terrain mesh. Both
  // guarantees are structural: the hulls were a SUFFIX of each chunk's
  // terrain quads, so their vertices land immediately after that chunk's own
  // terrain vertices in the shared pool, and draw.rs pushes the pair back to
  // back. A chunk whose hull vertices moved anywhere else means the split
  // reordered geometry and *-max.hashes cannot hold.
  test("a chunk's carved hulls sit immediately after its own terrain", () => {
    const { chunks } = readPak(outA);
    let checked = 0;
    for (const c of chunks) {
      const terrain = c.meshes[MESH_KIND.terrain];
      const hull = c.meshes[MESH_KIND.treeHull];
      // An empty range is all-zero, so it names no place in the pool.
      if (hull.indexCount === 0 || terrain.indexCount === 0) continue;
      checked++;
      expect(hull.vertBase).toBe(terrain.vertBase + terrain.vertCount);
    }
    expect(checked).toBeGreaterThan(0);
  });

  // The ladder's predecessor still works, and still states what it is: a
  // cook with no carving at all carries neither tree mesh and declares no
  // levels, so every rung draws the boxes out of the terrain stream exactly
  // as it did before tree LOD existed.
  test("VOXEL_TREE_BOXES=1 cooks one level and declares none", () => {
    const out = join(scratch, "voxelmon.test-boxes.vxpak");
    const before = process.env.VOXEL_TREE_BOXES;
    process.env.VOXEL_TREE_BOXES = "1";
    try {
      cook(DEFAULT_MAPS, out);
    } finally {
      if (before === undefined) delete process.env.VOXEL_TREE_BOXES;
      else process.env.VOXEL_TREE_BOXES = before;
    }
    const { flags, chunks } = readPak(out);
    expect(flags & VXPK_META_FLAG_TREE_LOD).toBe(0);
    for (const c of chunks) {
      expect(c.meshes[MESH_KIND.treeHull].indexCount).toBe(0);
      expect(c.meshes[MESH_KIND.treeBox].indexCount).toBe(0);
    }
    // ...and it is still the cheap floor it was kept for. The margin is a
    // map-set property, not a constant: ROUTE_2 (added for the Viridian
    // north exit) is wall- and path-heavy, so carving saves proportionally
    // less there — 0.51 measured across the eight v1 maps, pinned under
    // 0.6 so a future map cannot quietly erase the floor.
    const terrain = chunks.reduce((n, c) => n + c.meshes[MESH_KIND.terrain].indexCount / 3, 0);
    const carved = readPak(outA).chunks.reduce(
      (n, c) => n + (c.meshes[MESH_KIND.terrain].indexCount + c.meshes[MESH_KIND.treeHull].indexCount) / 3,
      0,
    );
    expect(terrain).toBeLessThan(carved * 0.6);
  }, 240000);

  test("every cooked map has chunks and vertices", () => {
    expect(resultA.mapStats.length).toBe(DEFAULT_MAPS.length);
    for (const m of resultA.mapStats) {
      expect(m.chunks).toBeGreaterThan(0);
      expect(m.verts).toBeGreaterThan(0);
    }
  });

  // The hidden-face cull (docs/VOXEL.md §5, cook/geom.ts): -Y faces at or
  // below DOWN_CULL_Y are dropped because no camera's eye ever gets that low.
  // The threshold is only sound while that stays true, and the two numbers
  // that could silently break it live in the spec, not in the cooker.
  test("no camera this runtime builds has its eye below DOWN_CULL_Y", () => {
    // Field camera: eye.y = CAM_FOCAL * WORLD_VIEW_H * cos(pitch), lowest at
    // the last rung (the tween never leaves the [0, last] range).
    const dist = CAM_FOCAL * WORLD_VIEW_H;
    const field = dist * Math.cos((Math.max(...PITCH_RUNGS) * Math.PI) / 180);
    expect(field).toBeGreaterThan(DOWN_CULL_Y);

    // Battle rigs: eye.y = |offset| * dolly * sin(elevation), lowest at the
    // minimum dolly and zero pitch steer (steer only raises the eye).
    for (const r of Object.values(RIG)) {
      const flat = Math.hypot(r.side, r.back);
      const len = Math.hypot(flat, r.height);
      const lowest = len * (1 - RIG_DOLLY) * Math.sin(Math.atan2(r.height, flat));
      expect(lowest).toBeGreaterThan(DOWN_CULL_Y);
    }
  });

  test("the cull drops only -Y faces, and keepHidden puts them back", () => {
    const quads: Quad[] = [
      { c: box(0, 40, 0), shade: 1, f: FACE.down }, // above the floor: kept
      { c: box(0, 8, 0), shade: 1, f: FACE.down }, // below it: dropped
      { c: box(0, 8, 8), shade: 1, f: FACE.north }, // north is NOT hidden
      { c: box(8, 8, 0), shade: 1, f: FACE.up },
    ];
    expect(cullHidden(quads).map((q) => q.f)).toEqual([FACE.down, FACE.north, FACE.up]);
    expect(cullHidden(quads, false, true).length).toBe(quads.length);
    // Pulled streams (grass, flower) are exempt whatever they face.
    expect(cullHidden(quads, PULLED).length).toBe(quads.length);
  });

  test("VPAL: 4 kind defaults + the 37 SGB SuperPalettes, then the RED++ tail", () => {
    const gen = loadGen(GEN_DIR);
    expect(gen.palettes.order.length).toBe(37);
    const pals = buildPalettes(gen);
    // The PREFIX is the compatibility guarantee: draw::SGB_PAL_BASE is 4 and
    // gamedata's `mapPalette` indexes the SGB set, whatever the tail holds.
    expect(pals.length).toBe(4 + 37);
    expect(paletteBase(gen)).toBe(4 + 37);
    // The tail simply appends; nothing in front of it moves.
    const tail = [new Uint32Array(256).fill(0xff112233)];
    const grown = buildPalettes(gen, tail);
    expect(grown.length).toBe(4 + 37 + 1);
    for (let i = 0; i < pals.length; i++) expect(grown[i]).toEqual(pals[i]);
    expect(grown[4 + 37][0]).toBe(0xff112233);
    // An SGB palette maps its 4 colors (lightest first) onto shades 0..3
    // as ABGR, keeps PX_CLEAR transparent, and blacks out the rest.
    const pallet = pals[4 + gen.palettes.order.indexOf("PALLET")];
    for (let shade = 0; shade < 4; shade++) {
      const [r, g, b] = gen.palettes.palettes.PALLET[shade];
      expect(pallet[shade]).toBe(((0xff000000 | (b << 16) | (g << 8) | r) >>> 0));
    }
    expect(pallet[0xff]).toBe(0); // transparent
    expect(pallet[4]).toBe(0xff000000);
    // The GB grayscale defaults stay in front, one per ATLAS_KIND.
    expect(pals[0][0]).toBe(0xffffffff);
    expect(pals[3][3]).toBe(0xff000000);
  });

  test("mapPalette ports SetPal_Overworld (OverworldController.lua:603)", () => {
    const gen = loadGen(GEN_DIR);
    const mp = buildMapPalette(gen);
    const idx = (name: string) => gen.palettes.order.indexOf(name);
    // towns wear their signature palettes (FieldDefaults.lua:17-25 byMap)
    expect(mp.PALLET_TOWN).toBe(idx("PALLET"));
    expect(mp.VIRIDIAN_CITY).toBe(idx("VIRIDIAN"));
    expect(mp.CELADON_CITY).toBe(idx("CELADON"));
    // routes take PAL_ROUTE (byPrefix), not a town's palette
    expect(mp.ROUTE_1).toBe(idx("ROUTE"));
    // tileset cases (byTileset): Pokemon Tower + caves
    expect(mp.POKEMON_TOWER_1F).toBe(idx("GRAYMON"));
    expect(mp.MT_MOON_1F).toBe(idx("CAVE"));
    // interiors inherit their outdoor map (the wLastMap memory, static)
    expect(mp.REDS_HOUSE_1F).toBe(idx("PALLET"));
    expect(mp.REDS_HOUSE_2F).toBe(idx("PALLET"));
    expect(mp.OAKS_LAB).toBe(idx("PALLET"));
    expect(mp.VIRIDIAN_FOREST).toBe(idx("ROUTE")); // entered from Route 2
    // the Elite Four byMap quirks ride along
    expect(mp.LORELEIS_ROOM).toBe(idx("PALLET"));
    expect(mp.BRUNOS_ROOM).toBe(idx("CAVE"));
    // every imported map resolves to a real SGB index
    for (const id of Object.keys(gen.maps)) {
      expect(mp[id]).toBeGreaterThanOrEqual(0);
      expect(mp[id]).toBeLessThan(gen.palettes.order.length);
    }
  });

  test("CMAP covers A-Z a-z 0-9 and maps to GB codes", () => {
    const gen = loadGen(GEN_DIR);
    const glyphs = new Map(buildCharmap(gen));
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
      expect(glyphs.has(ch.charCodeAt(0))).toBe(true);
    }
    // ascending, no duplicates (the reader binary-searches)
    const codes = buildCharmap(gen).map(([c]) => c);
    for (let i = 1; i < codes.length; i++) expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    // 'A' sits at the charmap's mainBase code (0x80)
    expect(glyphs.get("A".charCodeAt(0))).toBe(0x80);
  });

  test("the UI page has the font at 0x80 and font_extra at 0x60", () => {
    const gen = loadGen(GEN_DIR);
    const page = buildUiPage(gen);
    expect(page.w).toBe(128);
    expect(page.h).toBe(128);
    const linear = page.frames[0];
    // tile 0 is fully transparent (UI cell unset)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(linear[y * 128 + x]).toBe(0xff);
    }
    const tileHasInk = (tile: number): boolean => {
      const tx = (tile % 16) * 8;
      const ty = Math.floor(tile / 16) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const b = linear[(ty + y) * 128 + tx + x];
          if (b !== 0xff && b !== 0) return true;
        }
      }
      return false;
    };
    // 'A' = 0x80 (mainBase), textbox border art lives in the extra bank
    expect(tileHasInk(0x80)).toBe(true);
    expect([0x60, 0x61, 0x62, 0x63, 0x79].some(tileHasInk)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RED++ / pokered-gbc per-tile color (cook/redpp.ts)
// ---------------------------------------------------------------------------

const abgr = (r: number, g: number, b: number): number =>
  ((0xff000000 | (b << 16) | (g << 8) | r) >>> 0);

describe.skipIf(reason !== null || packReason !== null)("voxel cook: RED++ color", () => {
  test("the dumped pack keeps its index bases (arrays shift, 0-keyed do not)", () => {
    // THE #1 silent-miscolor risk: lua-dump turns dense 1..n tables into
    // JSON arrays (every index shifts down by one) but 0-keyed tables into
    // objects with string keys. Getting this wrong recolors the whole world
    // by one group and never throws — so it is pinned here, not assumed.
    const pack = loadRedpp(GEN_DIR)!;
    expect(pack).not.toBeNull();
    const w = pack.world;
    // groupColors: dense 1..8 in Lua -> an ARRAY indexed directly by group.
    expect(Array.isArray(w.groupColors.OVERWORLD)).toBe(true);
    expect(w.groupColors.OVERWORLD.length).toBe(8);
    expect(w.groupColors.OVERWORLD[0].length).toBe(4);
    // tileGroups / spritePalettes / spriteAssignment / roofByMapIndex are
    // 0-keyed -> OBJECTS with string keys, no shift.
    expect(Array.isArray(w.tileGroups.OVERWORLD)).toBe(false);
    expect(Object.keys(w.tileGroups.OVERWORLD).length).toBe(96);
    expect(w.tileGroups.OVERWORLD["0"]).toBe(0);
    expect(Object.keys(w.spritePalettes).length).toBe(8);
    expect(Object.keys(w.spriteAssignment).length).toBe(72);
    expect(w.spriteAssignment["3"]).toBe("random");
    // Pallet Town is map index 0 and its roof is the white pair.
    expect(w.roofByMapIndex["0"]).toEqual([
      [255, 255, 255],
      [197, 197, 197],
    ]);
    expect(w.roofGroup.OVERWORLD).toBe(ROOF_GROUP);
    // The pack is pokered-gbc-derived, NOT ROM-derived: Red ships no CGB
    // code, so there is no CGBBasePalettes for it at all.
    expect(pack.source).toContain("pokered-gbc");
  });

  test("the terrain page bakes group*4+shade and leaves 0xff transparent", () => {
    const gen = loadGen(GEN_DIR);
    const redpp = new Redpp(loadRedpp(GEN_DIR)!);
    const tilesets = DEFAULT_MAPS.map((name) => gen.tilesets[gen.maps[name].tileset]);
    const plain = buildTerrainPage(gen, tilesets);
    const baked = buildTerrainPage(gen, tilesets, redpp);

    // Same shape: the bake changes texel VALUES, never dimensions, frame
    // count or texel count — that is what makes it free on the GE.
    expect(baked.page.w).toBe(plain.page.w);
    expect(baked.page.h).toBe(plain.page.h);
    expect(baked.page.frames.length).toBe(plain.page.frames.length);
    expect(baked.bakedSheets.size).toBeGreaterThan(0);

    const w = baked.page.w;
    for (const [name, tileset] of [
      ["PALLET_TOWN", "OVERWORLD"],
      ["REDS_HOUSE_1F", "REDS_HOUSE_1"],
      ["BLUES_HOUSE", "HOUSE"],
    ] as const) {
      const key = gen.tilesets[tileset].image
        .replace(/^assets\/generated\//, "")
        .replace(/\.png$/, "");
      expect(baked.bakedSheets.has(key)).toBe(true);
      const y0 = baked.baseY.get(key)!;
      const sheet = gen.gfx[key];
      const perRow = gen.tilesets[tileset].tilesPerRow || 16;
      const tiles = Math.floor(sheet.w / 8) * Math.floor(sheet.h / 8);
      let checked = 0;
      for (let tile = 0; tile < tiles; tile += 7) {
        const group = redpp.groupOf(tileset, null, tile)!;
        const tx = (tile % perRow) * 8;
        const ty = y0 + Math.floor(tile / perRow) * 8;
        for (let f = 0; f < baked.page.frames.length; f++) {
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
              const at = (ty + y) * w + tx + x;
              const before = plain.page.frames[f][at];
              const after = baked.page.frames[f][at];
              if (before === PX_CLEAR) {
                expect(after).toBe(PX_CLEAR); // the alpha-test cutout survives
              } else {
                expect(after).toBe(group * 4 + (before & 3));
                expect(after).toBeLessThan(32); // 8 groups x 4 shades
              }
              checked++;
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(name).toBeTruthy();
    }
  });

  test("the roof swap touches slots 1 and 2 of the ROOF group and nothing else", () => {
    // LoadTownPalette overwrites only W2_BgPaletteData + $32 — colors 1 and
    // 2 of the ROOF slot. Color 0 (sky through the gaps) and color 3
    // (outline black) keep the tileset's own OUTDOOR_ROOF base.
    const redpp = new Redpp(loadRedpp(GEN_DIR)!);
    const pallet = redpp.worldPalette("OVERWORLD", 0)!; // PALLET_TOWN, white
    const viridian = redpp.worldPalette("OVERWORLD", 1)!; // VIRIDIAN_CITY, green
    const route1 = redpp.worldPalette("OVERWORLD", 12)!; // ROUTE_1, white again

    const differing: number[] = [];
    for (let i = 0; i < 256; i++) if (pallet[i] !== viridian[i]) differing.push(i);
    expect(differing).toEqual([ROOF_GROUP * 4 + 1, ROOF_GROUP * 4 + 2]);
    expect(pallet[ROOF_GROUP * 4 + 1]).toBe(abgr(255, 255, 255));
    expect(pallet[ROOF_GROUP * 4 + 2]).toBe(abgr(197, 197, 197));
    expect(viridian[ROOF_GROUP * 4 + 1]).toBe(abgr(0, 239, 58));
    expect(viridian[ROOF_GROUP * 4 + 2]).toBe(abgr(0, 197, 58));
    // Route 1 wears Pallet's roof, so the two dedup into one CLUT.
    expect(Array.from(route1)).toEqual(Array.from(pallet));
    // The CLUT shape: PX_CLEAR transparent, everything past group 7 black.
    expect(pallet[PX_CLEAR]).toBe(0);
    expect(pallet[32]).toBe(0xff000000);
    // An indoor tileset has no roof entry, so its palette never varies.
    expect(Array.from(redpp.worldPalette("HOUSE", 39)!)).toEqual(
      Array.from(redpp.worldPalette("HOUSE", 0)!),
    );
  });

  test("OBJ palettes make GBC color 0 transparent (ColorOverworldSprite)", () => {
    const pack = loadRedpp(GEN_DIR)!;
    const redpp = new Redpp(pack);
    const pal = redpp.objPalette(0)!;
    expect(pal[0]).toBe(0); // shade 0 is alpha 0 unconditionally
    for (let s = 1; s < 4; s++) {
      const [r, g, b] = pack.world.spritePalettes["0"][s];
      expect(pal[s]).toBe(abgr(r, g, b));
    }
    expect(pal[PX_CLEAR]).toBe(0);
    // The ROM crosswalk: the player's sheet takes assignment[0]; the bike
    // loads outside SpriteSheetPointerTable and wears the same one.
    const player = pack.world.spriteAssignment["0"];
    expect(player).toBe(0); // the reference's SPR_PAL_RED
    expect(redpp.objGroupOf("ROM:SpriteSheetPointerTable[0]", "sprites/red")).toBe(player as number);
    expect(redpp.objGroupOf("ROM:RedBikeSprite", "sprites/red_bike")).toBe(player as number);
    // "random" resolves deterministically, and only ever to 0..3.
    const rnd = redpp.objGroupOf("ROM:SpriteSheetPointerTable[3]", "sprites/guard")!;
    expect(rnd).toBe(redpp.objGroupOf("ROM:SpriteSheetPointerTable[3]", "sprites/guard")!);
    expect(rnd).toBeGreaterThanOrEqual(0);
    expect(rnd).toBeLessThan(4);
  });

  test("VCOL: every map binds a world palette, sprite pages bind OBJ CLUTs", () => {
    const gen = loadGen(GEN_DIR);
    const result = cook(DEFAULT_MAPS, join(scratch, "voxelmon.test-color.vxpak"));
    expect(result.colour).not.toBeNull();
    // v1's 5 tilesets over 4 sheets collapse to 3 world CLUTs: OVERWORLD
    // white-roof (Pallet + Route 1), OVERWORLD green-roof (Viridian), and
    // the one indoor table REDS_HOUSE_1/2, HOUSE and DOJO all share.
    expect(result.colour!.world).toBe(3);
    expect(result.colour!.obj).toBeGreaterThan(0);
    expect(result.colour!.pic).toBeGreaterThan(0);
    expect(result.palettes).toBe(
      paletteBase(gen) + result.colour!.world + result.colour!.obj + result.colour!.pic,
    );
    expect(result.sections.some((s) => s.tag === "VCOL")).toBe(true);
  }, 240000);

  test.skipIf(oracleReason !== null)(
    "ORACLE: every tile's 4 colors match gen1recomp's own PaletteFX",
    () => {
      // The strong check: the reference's `worldGroupAt` + `worldGroupColors`
      // run for real under LuaJIT, and every tile of every cooked map is
      // compared colour for colour. This covers the group assignment, the
      // exception tables and the roof swap in one pass — a transcription
      // error cannot survive it.
      const gen = loadGen(GEN_DIR);
      const redpp = new Redpp(loadRedpp(GEN_DIR)!);
      const specs = DEFAULT_MAPS.map((name) => {
        const def = gen.maps[name];
        return `${name}:${def.tileset}:${def.index}`;
      });
      const proc = Bun.spawnSync([
        "luajit",
        join(root, "voxelmon/import/redpp-oracle.lua"),
        gen1recompDir(),
        ...specs,
      ]);
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      const oracle = JSON.parse(proc.stdout.toString()) as Record<
        string,
        { tileset: string; index: number; tiles: [number, number, number][][] }
      >;

      let compared = 0;
      for (const name of DEFAULT_MAPS) {
        const entry = oracle[name];
        expect(entry).toBeDefined();
        const pal = redpp.worldPalette(entry.tileset, entry.index)!;
        expect(pal).not.toBeNull();
        for (let tile = 0; tile < entry.tiles.length; tile++) {
          const group = redpp.groupOf(entry.tileset, name, tile)!;
          for (let shade = 0; shade < 4; shade++) {
            const [r, g, b] = entry.tiles[tile][shade];
            expect(
              pal[group * 4 + shade],
              `${name} tile ${tile} shade ${shade}`,
            ).toBe(abgr(r, g, b));
            compared++;
          }
        }
      }
      expect(compared).toBe(DEFAULT_MAPS.length * 96 * 4);
    },
    120000,
  );
});
