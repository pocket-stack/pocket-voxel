// tests/voxel-audio.test.ts — the chip synth, and the policy that drives it.
//
// The synth lives in the Rust core (crates/pocketvoxel-core
// /src/audio.rs), ported from gen1recomp `src/core/ChipSynth.lua`. That Lua
// is the spec, so it is also the ORACLE: layer 2 below runs the REFERENCE
// ChipSynth under luajit and the core through `pocketvoxel-sim --wav` over
// the same program, and requires the PCM to be SAMPLE-EXACT — not close, not
// within a tolerance. Both sides read the same ROM-decoded programs and the
// same manifest numbers, so there is nothing left for a tolerance to hide.
//
// Layer 1 (ROM-free, always runs): the AUDI section reader, the manifest's
// name -> op-argument resolution, and the audio policy (which song for which
// map, battle/victory switching, the textbox beep, cries) asserted on the op
// stream the guest emits.
//
// Layer 2 (gated, skips with a printed reason): needs luajit, the gen1recomp
// checkout (VOXELMON_G1R), the imported dataset and the cooked pak — the
// POCKET3D_TEST_MAPS convention. CI never sees any of it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AUDIO_MUSIC_FLAG,
  AUDIO_SFX_FLAG,
  AUDIO_SFX_TEMPO,
  VOX_OP,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
} from "../contracts/spec/voxel-spec.ts";
import {
  fromGenDir,
  fromParts,
  fromSection,
  readAudioSection,
  type AudioBanks,
  type AudioManifest,
} from "../voxelmon/game/audio/banks.ts";
import { AudioDirector } from "../voxelmon/game/audio/music.ts";
import type { VoxelHost } from "../voxelmon/game/host.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const pakPath = join(root, "dist/voxelmon/voxelmon.vxpak");
const scratch = join(root, "dist/voxelmon/audio");

// ---------------------------------------------------------------------------
// Layer 1: the AUDI section reader
// ---------------------------------------------------------------------------

/** Build an AUDI payload the way the cooker does (voxel-spec.ts §VXPK_TAG). */
function audiPayload(json: string, programs: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(json);
  const off = Math.ceil((VXPK_AUDIO_HEADER_SIZE + jsonBytes.length) / VXPK_ALIGN) * VXPK_ALIGN;
  const out = new Uint8Array(off + programs.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, jsonBytes.length, true);
  view.setUint32(4, programs.length, true);
  out.set(jsonBytes, VXPK_AUDIO_HEADER_SIZE);
  out.set(programs, off);
  return out;
}

describe("the AUDI section", () => {
  test("splits into its two halves at the aligned offset", () => {
    const programs = new Uint8Array([1, 2, 3, 4, 5]);
    const section = readAudioSection(audiPayload('{"a":1}', programs));
    expect(new TextDecoder().decode(section.json)).toBe('{"a":1}');
    expect([...section.programs]).toEqual([1, 2, 3, 4, 5]);
  });

  test("a header that disagrees with the payload is a build error, not a limp", () => {
    expect(() => readAudioSection(new Uint8Array(4))).toThrow();
    const payload = audiPayload('{"a":1}', new Uint8Array(8));
    expect(() => readAudioSection(payload.subarray(0, payload.length - 4))).toThrow();
  });

  test("an empty or absent section runs silent instead of failing", () => {
    expect(fromSection(null)).toBeNull();
    expect(fromSection(new Uint8Array(0))).toBeNull();
    expect(fromSection(audiPayload("", new Uint8Array(0)))).toBeNull();
  });

  test("the JSON half alone is what the guest needs — the programs stay in the pak", () => {
    const banks = fromSection(audiPayload(JSON.stringify(fixtureManifest()), new Uint8Array(0)));
    expect(banks).not.toBeNull();
    expect(banks!.playable).toBe(true);
    expect(banks!.song("Theme")).toEqual({ bank: 0, address: 0x4100, engine: 1 });
  });
});

// ---------------------------------------------------------------------------
// Layer 1: name -> op arguments
// ---------------------------------------------------------------------------

function fixtureManifest(): AudioManifest {
  return {
    runtime: true,
    programFile: "programs.bin",
    // Bank NUMBERS; an op carries their INDEX in this list.
    bankOrder: [2, 8],
    songs: {
      Theme: { bank: 2, address: 0x4100, engine: 1 },
      Battle: { bank: 8, address: 0x4200, engine: 2 },
      Victory: { bank: 8, address: 0x4300, engine: 2 },
      Elsewhere: { bank: 31, address: 0x4400, engine: 3 },
    },
    sfx: {
      Press_AB: { bank: 2, address: 0x4500, engine: 1 },
      Level_Up: { bank: 2, address: 0x4600, engine: 1 },
    },
    cries: {
      PIDGEY: { header: { bank: 2, address: 0x4700, engine: 1 }, pitch: 223, length: 4 },
    },
    mapSongs: { PALLET_TOWN: "Theme", REDS_HOUSE_1F: "Theme", ROUTE_1: "Missing" },
    battle: { wild: "Battle", wildWin: "Victory" },
    waveBanks: { "1": { bank: 2, address: 0x4300 }, "9": { bank: 2, address: 0x4300 } },
    noiseHeaders: {
      "1": {
        "1": { bank: 2, address: 0x4800, engine: 1 },
        "99": { bank: 2, address: 0, engine: 1 },
      },
      "2": { "1": { bank: 31, address: 0x4900, engine: 2 } },
    },
  };
}

describe("manifest resolution", () => {
  const banks = fromParts(fixtureManifest());

  test("a bank NUMBER becomes the bank SLOT the op carries", () => {
    expect(banks.song("Theme")).toEqual({ bank: 0, address: 0x4100, engine: 1 });
    expect(banks.song("Battle")).toEqual({ bank: 1, address: 0x4200, engine: 2 });
  });

  test("a program in a bank the pak does not carry resolves to nothing", () => {
    expect(banks.song("Elsewhere")).toBeNull();
    expect(banks.song("nope")).toBeNull();
  });

  test("a cry carries its two modifiers", () => {
    expect(banks.cry("PIDGEY")).toEqual({
      bank: 0,
      address: 0x4700,
      engine: 1,
      pitch: 223,
      length: 4,
    });
    expect(banks.cry("MISSINGNO")).toBeNull();
  });

  test("pins name every engine table, and skip what the core cannot hold", () => {
    // Engine 9 is past AUDIO_ENGINES, drum 99 past AUDIO_DRUMS, and engine
    // 2's drum lives in a bank this pak has no slot for.
    expect(banks.pins()).toEqual([
      { engine: 1, drum: -1, bank: 0, address: 0x4300 },
      { engine: 1, drum: 1, bank: 0, address: 0x4800 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Layer 1: the policy, on the op stream
// ---------------------------------------------------------------------------

type Emitted = [string, ...number[]];

/** A VoxelHost that records only the audio ops. */
function recorder(): { host: VoxelHost; ops: Emitted[] } {
  const ops: Emitted[] = [];
  const nop = () => {};
  const host = {
    gamedata: () => null,
    audiodata: () => null,
    stats: () => null,
    reset: nop,
    mapShow: nop,
    mapHide: nop,
    cam: nop,
    pitch: nop,
    tint: nop,
    stamp: nop,
    palette: nop,
    ent: nop,
    entHide: nop,
    emote: nop,
    uiTile: nop,
    uiFill: nop,
    uiText: nop,
    uiReveal: nop,
    uiClear: nop,
    arena: nop,
    card: nop,
    cardHide: nop,
    battleCam: nop,
    arenaEnd: nop,
    frameDone: nop,
    music: (...a: number[]) => ops.push(["music", ...a]),
    musicStop: () => ops.push(["musicStop"]),
    musicFade: (...a: number[]) => ops.push(["musicFade", ...a]),
    sfx: (...a: number[]) => ops.push(["sfx", ...a]),
    cry: (...a: number[]) => ops.push(["cry", ...a]),
    audioWaves: (...a: number[]) => ops.push(["audioWaves", ...a]),
    audioDrum: (...a: number[]) => ops.push(["audioDrum", ...a]),
  } as unknown as VoxelHost;
  return { host, ops };
}

function director(): { d: AudioDirector; ops: Emitted[] } {
  const { host, ops } = recorder();
  const d = new AudioDirector(fromParts(fixtureManifest()), host);
  ops.length = 0; // drop the boot pins; they have their own test
  return { d, ops };
}

describe("the audio policy", () => {
  test("boot pins the engine tables once, before anything can name one", () => {
    const { host, ops } = recorder();
    new AudioDirector(fromParts(fixtureManifest()), host);
    expect(ops).toEqual([
      ["audioWaves", 1, 0, 0x4300],
      ["audioDrum", 1, 1, 0, 0x4800],
    ]);
  });

  test("a map entry starts its theme, and the same theme does not restart", () => {
    const { d, ops } = director();
    d.startMap("PALLET_TOWN");
    expect(ops).toEqual([["music", 0, 0x4100, 1, AUDIO_MUSIC_FLAG.loop]]);
    // Music.lua:239 dedupes on the label: a house door must not restart the
    // town song.
    ops.length = 0;
    d.startMap("REDS_HOUSE_1F");
    expect(ops).toEqual([]);
    expect(d.playing).toBe("Theme");
  });

  test("a map whose theme the manifest cannot resolve is silent, once", () => {
    const { d, ops } = director();
    d.startMap("ROUTE_1");
    d.startMap("ROUTE_1");
    expect(ops).toEqual([]);
    expect(d.playing).toBeNull();
  });

  test("a battle takes the theme, the win takes the jingle, the close restores", () => {
    const { d, ops } = director();
    d.startMap("PALLET_TOWN");
    ops.length = 0;
    d.playBattle("wild");
    expect(ops).toEqual([["music", 1, 0x4200, 2, AUDIO_MUSIC_FLAG.loop]]);
    ops.length = 0;
    expect(d.playVictory("wild")).toBe(true);
    expect(ops).toEqual([["music", 1, 0x4300, 2, AUDIO_MUSIC_FLAG.loop]]);
    ops.length = 0;
    d.restore();
    expect(ops).toEqual([["music", 0, 0x4100, 1, AUDIO_MUSIC_FLAG.loop]]);
    expect(d.playing).toBe("Theme");
  });

  test("a victory with no jingle in the manifest stays on the battle theme", () => {
    const { d, ops } = director();
    expect(d.playVictory("trainer")).toBe(false);
    expect(ops).toEqual([]);
  });

  test("a textbox beep is a one-shot; a fanfare claims the music's channels", () => {
    const { d, ops } = director();
    d.playSfx("Press_AB");
    expect(ops).toEqual([["sfx", 0, 0x4500, 1, 0, AUDIO_SFX_TEMPO, 0]]);
    ops.length = 0;
    // Sound.lua:55 FANFARES — Level_Up pauses the song for its duration.
    d.playSfx("Level_Up");
    expect(ops).toEqual([["sfx", 0, 0x4600, 1, 0, AUDIO_SFX_TEMPO, AUDIO_SFX_FLAG.duck]]);
    ops.length = 0;
    d.playSfx("nope");
    expect(ops).toEqual([]);
  });

  test("a cry carries the ROM's own frequency and length modifiers", () => {
    const { d, ops } = director();
    d.playCry("PIDGEY");
    expect(ops).toEqual([["cry", 0, 0x4700, 1, 223, 4]]);
    ops.length = 0;
    d.playCry("MISSINGNO");
    expect(ops).toEqual([]);
  });

  test("stop and fade are the reference's two ways to end a song", () => {
    const { d, ops } = director();
    d.startMap("PALLET_TOWN");
    ops.length = 0;
    d.fadeOut(10);
    expect(ops).toEqual([["musicFade", 10]]);
    // The fade released the label, so re-entering the map starts it again.
    ops.length = 0;
    d.startMap("PALLET_TOWN");
    expect(ops).toEqual([["music", 0, 0x4100, 1, AUDIO_MUSIC_FLAG.loop]]);
    ops.length = 0;
    d.stopMusic();
    expect(ops).toEqual([["musicStop"]]);
  });

  test("no manifest is total silence: nothing resolves, nothing is emitted", () => {
    const { host, ops } = recorder();
    const d = new AudioDirector(null, host);
    d.startMap("PALLET_TOWN");
    d.playBattle("wild");
    d.playSfx("Press_AB");
    d.playCry("PIDGEY");
    d.stop();
    expect(ops).toEqual([]);
    expect(d.live).toBe(false);
  });

  test("no host is total silence too — the Bun recorder mounts one, tests need not", () => {
    const d = new AudioDirector(fromParts(fixtureManifest()), null);
    expect(() => {
      d.startMap("PALLET_TOWN");
      d.playSfx("Press_AB");
      d.playCry("PIDGEY");
      d.fadeOut();
    }).not.toThrow();
    expect(d.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the core synth against the REFERENCE ChipSynth (luajit)
// ---------------------------------------------------------------------------

const g1rRoot = process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
const luajit = Bun.which("luajit");
const simBin = join(root, "target/release/pocketvoxel-sim");
const hasOracle =
  luajit !== null &&
  existsSync(join(g1rRoot, "src/core/ChipSynth.lua")) &&
  existsSync(join(genDir, "audio.json")) &&
  existsSync(join(genDir, "programs.bin")) &&
  existsSync(pakPath);
if (!hasOracle) {
  console.log(
    "voxel-audio: the ChipSynth oracle SKIPPED — needs luajit, the gen1recomp checkout" +
      " (VOXELMON_G1R), dist/voxelmon/gen/{audio.json,programs.bin} and the cooked pak",
  );
}

/** Serialize a value as a Lua table literal (the oracle's params file). */
function luaLiteral(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `{${value.map(luaLiteral).join(",")}}`;
  const entries = Object.entries(value as Record<string, unknown>);
  return `{${entries.map(([k, v]) => `[${JSON.stringify(k)}]=${luaLiteral(v)}`).join(",")}}`;
}

let live: AudioBanks | null = null;
function banks(): AudioBanks {
  if (!live) throw new Error("the imported manifest is not loaded");
  return live;
}

/** Render one program through the REFERENCE Lua. Returns interleaved s16. */
function oracle(params: Record<string, unknown>): Int16Array {
  const manifest = banks().manifest;
  const paramFile = join(scratch, "oracle.params.lua");
  const pcmFile = join(scratch, "oracle.pcm");
  Bun.write(
    paramFile,
    `return ${luaLiteral({
      programFile: join(genDir, "programs.bin"),
      bankOrder: manifest.bankOrder,
      waveBanks: manifest.waveBanks,
      noiseHeaders: manifest.noiseHeaders,
      ...params,
    })}\n`,
  );
  const proc = Bun.spawnSync([
    luajit!,
    join(root, "tests/fixtures/voxelmon/oracle/chipsynth-oracle.lua"),
    g1rRoot,
    paramFile,
    pcmFile,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(`chipsynth-oracle failed: ${proc.stderr.toString()}`);
  }
  const bytes = readFileSync(pcmFile);
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

/** Render one program through the CORE, over the real op stream. */
function core(op: number[], ticks: number, rate = 44100): Int16Array {
  const lines = ["voxtrace 1", "t 0 0"];
  for (const pin of banks().pins()) {
    lines.push(
      pin.drum < 0
        ? `o ${VOX_OP.audioWaves} ${pin.engine} ${pin.bank} ${pin.address}`
        : `o ${VOX_OP.audioDrum} ${pin.engine} ${pin.drum} ${pin.bank} ${pin.address}`,
    );
  }
  lines.push(`o ${op.join(" ")}`);
  for (let t = 1; t < ticks; t++) lines.push(`t ${t} 0`);
  const tracePath = join(scratch, "oracle.vtrace");
  const wavPath = join(scratch, "oracle.wav");
  Bun.write(tracePath, lines.join("\n") + "\n");
  const argv = [pakPath, "--trace", tracePath, "--wav", wavPath, "--rate", String(rate)];
  const proc = Bun.spawnSync(
    existsSync(simBin)
      ? [simBin, ...argv]
      : ["cargo", "run", "--release", "-q", "-p", "pocketvoxel-sim", "--", ...argv],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`pocketvoxel-sim failed: ${proc.stderr.toString()}`);
  }
  // Past the 44-byte canonical WAV header.
  const bytes = readFileSync(wavPath);
  return new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length),
  );
}

function levels(pcm: Int16Array, upto: number): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < upto; i++) {
    const v = Math.abs(pcm[i]);
    if (v > peak) peak = v;
    sum += pcm[i] * pcm[i];
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, upto)) };
}

describe("the core synth against the reference ChipSynth", () => {
  const SECONDS = 5;
  const TICKS = SECONDS * 60;
  /** 44100 / 60 exactly, so a tick's frame count never wobbles. */
  const FRAMES = TICKS * 735;

  test.skipIf(!hasOracle)(
    "every shipped song, effect and cry renders the reference's own samples",
    async () => {
      mkdirSync(scratch, { recursive: true });
      live = await fromGenDir(genDir);
      const manifest = banks().manifest;

      interface Case {
        name: string;
        lua: Record<string, unknown>;
        op: number[];
        /** Music has to be loud; a menu beep is a menu beep. */
        minPeakPct: number;
      }
      const cases: Case[] = [];
      for (const label of ["Music_PalletTown", "Music_Routes1", "Music_WildBattle"]) {
        const ref = banks().song(label);
        expect(ref).not.toBeNull();
        cases.push({
          name: label,
          lua: { header: manifest.songs[label], mode: "music", frames: FRAMES, allowLoops: true },
          op: [VOX_OP.music, ref!.bank, ref!.address, ref!.engine, AUDIO_MUSIC_FLAG.loop],
          minPeakPct: 0.3,
        });
      }
      const sfx = banks().sfx("Press_AB");
      expect(sfx).not.toBeNull();
      cases.push({
        name: "sfx_Press_AB",
        lua: {
          header: manifest.sfx.Press_AB,
          mode: "effect",
          frames: FRAMES,
          frequencyOffset: 0,
          // ChipAudio.lua:418 — the plain form's `0x80 + tempo`.
          frameTicks: AUDIO_SFX_TEMPO + AUDIO_SFX_TEMPO,
        },
        op: [VOX_OP.sfx, sfx!.bank, sfx!.address, sfx!.engine, 0, AUDIO_SFX_TEMPO, 0],
        minPeakPct: 0.1,
      });
      const cry = banks().cry("PIDGEY");
      expect(cry).not.toBeNull();
      cases.push({
        name: "cry_PIDGEY",
        lua: {
          header: manifest.cries.PIDGEY.header,
          mode: "effect",
          frames: FRAMES,
          frequencyOffset: cry!.pitch,
          cryLength: cry!.length,
        },
        op: [VOX_OP.cry, cry!.bank, cry!.address, cry!.engine, cry!.pitch, cry!.length],
        minPeakPct: 0.3,
      });

      for (const c of cases) {
        const lua = oracle(c.lua);
        const rust = core(c.op, TICKS);
        // A one-shot ends when its program does; compare over what the
        // reference produced. The core renders silence past that, which is
        // what a ring wants and what the reference's fixed buffer never had
        // to answer.
        const n = Math.min(lua.length, rust.length);
        expect(n).toBeGreaterThan(4410 * 2);

        let diffs = 0;
        let first = -1;
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const d = Math.abs(lua[i] - rust[i]);
          if (d !== 0) {
            diffs += 1;
            if (first < 0) first = i;
            if (d > worst) worst = d;
          }
        }
        const l = levels(lua, n);
        const r = levels(rust, n);
        console.log(
          `  ${c.name.padEnd(18)} ${(n / 2).toString().padStart(7)} frames  ` +
            `lua peak ${l.peak} (${((l.peak / 32767) * 100).toFixed(1)}%) rms ${l.rms.toFixed(0)}  |  ` +
            `core peak ${r.peak} (${((r.peak / 32767) * 100).toFixed(1)}%) rms ${r.rms.toFixed(0)}  |  ` +
            `${diffs === 0 ? "SAMPLE-EXACT" : `${diffs} diffs from ${first}, worst ${worst}`}`,
        );

        expect({ track: c.name, diffs, first, worst }).toEqual({
          track: c.name,
          diffs: 0,
          first: -1,
          worst: 0,
        });
        // Sample-exact and silent would still be a bug: it has to be audible.
        expect(r.peak / 32767).toBeGreaterThan(c.minPeakPct);
        expect(r.peak).toBe(l.peak);
        expect(Math.round(r.rms)).toBe(Math.round(l.rms));
      }
    },
    600000,
  );

  test.skipIf(!hasOracle)(
    "the device's 11.025 kHz is the same music, deterministically",
    async () => {
      mkdirSync(scratch, { recursive: true });
      live = await fromGenDir(genDir);
      const manifest = banks().manifest;
      const ref = banks().song("Music_PalletTown")!;
      const op = [VOX_OP.music, ref.bank, ref.address, ref.engine, AUDIO_MUSIC_FLAG.loop];
      // The reference hardcodes 44100, so at any other rate what is under
      // test is the core's own determinism and that the level holds up.
      const a = core(op, 120, 11025);
      const b = core(op, 120, 11025);
      expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
      const low = levels(a, a.length);
      const full = oracle({
        header: manifest.songs.Music_PalletTown,
        mode: "music",
        frames: 120 * 735,
        allowLoops: true,
      });
      const high = levels(full, full.length);
      console.log(
        `  11025 Hz peak ${low.peak} rms ${low.rms.toFixed(0)}  |  ` +
          `44100 Hz peak ${high.peak} rms ${high.rms.toFixed(0)}`,
      );
      expect(low.peak / 32767).toBeGreaterThan(0.3);
      // Same music, a quarter of the samples: the RMS must not move much.
      expect(Math.abs(low.rms - high.rms) / high.rms).toBeLessThan(0.1);
    },
    600000,
  );
});
