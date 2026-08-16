// Browser-safe ROM importer. The caller supplies bytes and the non-ROM
// manifest; all decoded content remains in memory and no filesystem API is
// reachable from this module's dependency graph.

import type { GenData } from "../cook/data.ts";
import { Ctx, check } from "./ctx.ts";
import { RED_ROM_BYTES, RED_SHA1 } from "./constants.ts";
import { GfxBin } from "./gfx.ts";
import type { Manifest } from "./manifest.ts";
import { Rom } from "./rom.ts";
import { extractAudio } from "./stages/audio.ts";
import { extractEncounters } from "./stages/encounters.ts";
import { extractField } from "./stages/field.ts";
import { extractFont } from "./stages/font.ts";
import { extractItems } from "./stages/items.ts";
import { extractMaps } from "./stages/maps.ts";
import { extractMoves } from "./stages/moves.ts";
import { extractPalettes } from "./stages/palettes.ts";
import { extractPokemon } from "./stages/pokemon.ts";
import { extractSprites } from "./stages/sprites.ts";
import { extractText } from "./stages/text.ts";
import { extractTilesets } from "./stages/tilesets.ts";
import { extractTrainers } from "./stages/trainers.ts";
import { extractTypeChart } from "./stages/type-chart.ts";

export interface ImportProgress {
  phase: "verify" | "extract";
  completed: number;
  total: number;
  label: string;
  elapsedMs: number;
}

export type ImportProgressHook = (progress: ImportProgress) => void;

export interface ImportedContent {
  gen: GenData;
  /** Compact UTF-8 JSON, byte-identical to gen/audio.json. */
  audioJson: Uint8Array;
  /** Concatenated ROM program-bank windows. */
  audioPrograms: Uint8Array;
}

const encoder = new TextEncoder();

/** Portable SHA-1 identity check. SHA-1 is an input identifier here, not a
 * security primitive; Web Crypto provides the same implementation in Bun and
 * browsers. */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable; cannot verify the ROM SHA-1");
  // Own an ArrayBuffer so TypeScript and Web Crypto never see a
  // SharedArrayBuffer-backed view. The ROM is only 1 MiB and hashing already
  // requires reading it in full.
  const digest = new Uint8Array(await subtle.digest("SHA-1", new Uint8Array(data)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Decode a canonical Red ROM entirely in memory. The SHA-1 gate completes
 * before the Ctx or any extraction stage is created. */
export async function importRedRom(
  romData: Uint8Array,
  manifest: Manifest,
  onProgress?: ImportProgressHook,
): Promise<ImportedContent> {
  let started = performance.now();
  onProgress?.({ phase: "verify", completed: 0, total: 1, label: "sha1", elapsedMs: 0 });
  check(
    romData.byteLength === RED_ROM_BYTES,
    `ROM size mismatch: got ${romData.byteLength} bytes, need ${RED_ROM_BYTES}`,
  );
  const digest = await sha1Hex(romData);
  check(digest === RED_SHA1, `ROM SHA-1 mismatch: got ${digest}, need Red ${RED_SHA1}`);
  check(
    manifest.romSha1 === RED_SHA1,
    `manifest is not for Red (romSha1 ${manifest.romSha1}); Red-only for now`,
  );
  onProgress?.({
    phase: "verify",
    completed: 1,
    total: 1,
    label: "sha1",
    elapsedMs: performance.now() - started,
  });

  const ctx = new Ctx(new Rom(romData), manifest, new GfxBin());
  const total = 16;
  let completed = 0;
  const stage = <T>(label: string, run: () => T): T => {
    started = performance.now();
    const value = run();
    completed += 1;
    onProgress?.({
      phase: "extract",
      completed,
      total,
      label,
      elapsedMs: performance.now() - started,
    });
    return value;
  };

  const constants = stage("constants", () => manifest.constants);
  const tilesets = stage("tilesets", () => extractTilesets(ctx));
  const maps = stage("maps", () => extractMaps(ctx));
  const font = stage("font", () => extractFont(ctx));
  const sprites = stage("sprites", () => extractSprites(ctx));
  const moves = stage("moves", () => extractMoves(ctx));
  const items = stage("items", () => extractItems(ctx));
  const typeChart = stage("type_chart", () => extractTypeChart(ctx));
  const palettes = stage("palettes", () => extractPalettes(ctx));
  const pokemon = stage("pokemon", () => extractPokemon(ctx));
  const trainers = stage("trainers", () => extractTrainers(ctx));
  const encounters = stage("encounters", () => extractEncounters(ctx));
  const text = stage("text", () => extractText(ctx));
  const field = stage("field", () => extractField(ctx));
  const audio = stage("audio", () => extractAudio(ctx));
  const gfx = stage("gfx", () => ({ directory: ctx.gfx.directory, bytes: ctx.gfx.bytes() }));

  return {
    gen: {
      maps: maps as GenData["maps"],
      tilesets: tilesets as GenData["tilesets"],
      palettes: palettes as unknown as GenData["palettes"],
      sprites: sprites as GenData["sprites"],
      gfx: gfx.directory,
      gfxBin: gfx.bytes,
      font: font as unknown as GenData["font"],
      constants,
      encounters,
      moves,
      pokemon: pokemon as GenData["pokemon"],
      items,
      typeChart,
      trainers,
      text: text.texts,
      textPointers: text.pointers,
      trainerHeaders: text.trainerHeaders,
      field,
    },
    audioJson: encoder.encode(JSON.stringify(audio.json)),
    audioPrograms: audio.programs,
  };
}
