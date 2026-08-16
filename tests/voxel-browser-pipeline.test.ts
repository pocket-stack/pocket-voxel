// Browser-safe importer/cooker boundaries. ROM-derived expectations stay
// local: these tests skip under CI when the canonical ROM/generated baseline
// is absent, matching the rest of the voxel suites.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cookVoxelPak, DEFAULT_MAPS } from "../voxelmon/cook/core.ts";
import {
  GEN_DIR,
  loadGen,
  loadProfile,
  loadRedpp,
  ROOT,
} from "../voxelmon/cook/data-node.ts";
import { importRedRom, type ImportProgress } from "../voxelmon/import/core.ts";
import { missingInputReason, resolveEnv } from "../voxelmon/import/env.ts";
import type { Manifest } from "../voxelmon/import/manifest.ts";

const env = resolveEnv();
const inputReason = missingInputReason(env);
if (inputReason) console.log(`voxel-browser-pipeline: skipping ROM tests — ${inputReason}`);

async function inputs(): Promise<{ rom: Uint8Array; manifest: Manifest }> {
  return {
    rom: new Uint8Array(await Bun.file(env.romPath).arrayBuffer()),
    manifest: (await Bun.file(env.manifestPath).json()) as Manifest,
  };
}

describe("browser-safe ROM gate", () => {
  test("a wrong-size input is rejected before hashing or extraction without local fixtures", async () => {
    const progress: ImportProgress[] = [];
    await expect(
      importRedRom(new Uint8Array(16), {} as Manifest, (event) => progress.push(event)),
    ).rejects.toThrow("ROM size mismatch: got 16 bytes, need 1048576");
    expect(progress.some((event) => event.phase === "extract")).toBe(false);
    expect(progress).toEqual([
      { phase: "verify", completed: 0, total: 1, label: "sha1", elapsedMs: 0 },
    ]);
  });
});

describe.skipIf(inputReason !== null)("browser-safe ROM import", () => {
  test("a wrong ROM is rejected before the first extraction stage", async () => {
    const { rom, manifest } = await inputs();
    rom[0] ^= 1;
    const progress: ImportProgress[] = [];
    await expect(importRedRom(rom, manifest, (event) => progress.push(event))).rejects.toThrow(
      "ROM SHA-1 mismatch",
    );
    expect(progress.some((event) => event.phase === "extract")).toBe(false);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ phase: "verify", completed: 0, label: "sha1" });
  });

  const generatedReady = existsSync(join(GEN_DIR, "gfx.bin"));
  test.skipIf(!generatedReady)(
    "in-memory import is byte-identical to the generated Node dataset",
    async () => {
      const { rom, manifest } = await inputs();
      const progress: ImportProgress[] = [];
      const imported = await importRedRom(rom, manifest, (event) => progress.push(event));
      const json = new Map<string, unknown>([
        ["constants", imported.gen.constants],
        ["tilesets", imported.gen.tilesets],
        ["maps", imported.gen.maps],
        ["font", imported.gen.font],
        ["sprites", imported.gen.sprites],
        ["moves", imported.gen.moves],
        ["items", imported.gen.items],
        ["type_chart", imported.gen.typeChart],
        ["palettes", imported.gen.palettes],
        ["pokemon", imported.gen.pokemon],
        ["trainers", imported.gen.trainers],
        ["encounters", imported.gen.encounters],
        ["text", imported.gen.text],
        ["text_pointers", imported.gen.textPointers],
        ["trainer_headers", imported.gen.trainerHeaders],
        ["field", imported.gen.field],
        ["gfx", imported.gen.gfx],
      ]);
      for (const [name, value] of json) {
        const actual = Buffer.from(JSON.stringify(value));
        expect(actual.equals(readFileSync(join(GEN_DIR, `${name}.json`))), name).toBe(true);
      }
      expect(Buffer.from(imported.gen.gfxBin).equals(readFileSync(join(GEN_DIR, "gfx.bin")))).toBe(
        true,
      );
      expect(Buffer.from(imported.audioJson).equals(readFileSync(join(GEN_DIR, "audio.json")))).toBe(
        true,
      );
      expect(
        Buffer.from(imported.audioPrograms).equals(readFileSync(join(GEN_DIR, "programs.bin"))),
      ).toBe(true);
      expect(
        progress.filter((event) => event.phase === "extract").map((event) => event.label),
      ).toEqual([
        "constants",
        "tilesets",
        "maps",
        "font",
        "sprites",
        "moves",
        "items",
        "type_chart",
        "palettes",
        "pokemon",
        "trainers",
        "encounters",
        "text",
        "field",
        "audio",
        "gfx",
      ]);
    },
    30_000,
  );
});

const pakPath = join(ROOT, "dist/voxelmon/voxelmon.vxpak");
const gamePath = join(ROOT, "dist/voxelmon/gamedata.json");
const cookReady =
  existsSync(join(GEN_DIR, "maps.json")) && existsSync(pakPath) && existsSync(gamePath);
if (!cookReady) {
  console.log("voxel-browser-pipeline: skipping cook parity — generated baseline is absent");
}

describe.skipIf(!cookReady)("browser-safe cook", () => {
  test(
    "in-memory cook is byte-identical to the Node CLI baseline",
    () => {
      const profile = loadProfile();
      const redpp = loadRedpp(GEN_DIR);
      expect(profile).not.toBeNull();
      expect(redpp).not.toBeNull();
      const events: string[] = [];
      const result = cookVoxelPak(
        {
          gen: loadGen(GEN_DIR),
          profile,
          redpp,
          audioJson: new Uint8Array(readFileSync(join(GEN_DIR, "audio.json"))),
          audioPrograms: new Uint8Array(readFileSync(join(GEN_DIR, "programs.bin"))),
          mapNames: DEFAULT_MAPS,
        },
        (event) => events.push(`${event.phase}:${event.completed}/${event.total}:${event.label}`),
      );
      expect(Buffer.from(result.pak).equals(readFileSync(pakPath))).toBe(true);
      expect(Buffer.from(result.gameJson).equals(readFileSync(gamePath))).toBe(true);
      expect(events.filter((event) => event.startsWith("map:"))).toHaveLength(DEFAULT_MAPS.length);
      expect(events.filter((event) => event.startsWith("ground-bake:"))).toHaveLength(
        DEFAULT_MAPS.length,
      );
      expect(events.at(-1)).toBe("pack:1/1:vxpk");
    },
    240_000,
  );
});
