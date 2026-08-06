// The audio MANIFEST: what the ROM's sound programs are called and where
// they live. Ports the loading half of gen1recomp `src/core/ChipSynth.lua`
// (:121-146 loadBanks) and the audio block `src/import/RomExtractor.lua`
// :2065-2114 writes.
//
// The guest owns names; the core owns bytes. Everything here resolves a
// NAME — a song label, an sfx name, a species — into the numbers the voxel
// surface's audio ops carry (contracts/spec/voxel-spec.ts §audio): a bank
// SLOT, a GB address, a sound-engine id, and the cry's two modifiers. The
// core parses no JSON and knows no name; the guest reads no sample.
//
// Two transports, one loader (the `data.ts` discipline):
//   Bun   `fromGenDir(dir)` reads dist/voxelmon/gen/audio.json
//   PSP   `fromSection(bytes)` takes the JSON half of the pak's AUDI section,
//         which the `audiodata` op hands over at boot (one cold read). The
//         PROGRAM half of that section never crosses: the core reads it in
//         place (pak.audio_programs).
//
// Nothing here touches Bun outside `fromGenDir`, so the module loads in
// QuickJS.

import {
  AUDIO_DRUMS,
  AUDIO_ENGINES,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
} from "../../../contracts/spec/voxel-spec.ts";

/** A song / sfx / cry / drum program: where its channel list starts. */
export interface ProgramHeader {
  bank: number;
  address: number;
  /** Sound-engine id 1..3; picks the wave + drum tables. */
  engine: number;
}

/** A cry: whose program to run, and the two modifiers applied to it. */
export interface CryDef {
  header: ProgramHeader;
  /** wFrequencyModifier — added to every tone register. */
  pitch: number;
  /** The cry's tempo byte; becomes the channel frame length. */
  length: number;
}

/** Where a sound engine's wave-instrument table lives. */
export interface WaveBankSpec {
  bank: number;
  address: number;
}

/** `gen/audio.json` — the manifest audio block plus the importer's tables. */
export interface AudioManifest {
  runtime: boolean;
  programFile: string;
  /** Bank numbers in the order programs.bin concatenates them. The INDEX in
   *  this list is the bank slot every audio op carries. */
  bankOrder: number[];
  songs: Record<string, ProgramHeader>;
  sfx: Record<string, ProgramHeader>;
  cries: Record<string, CryDef>;
  /** Map id -> song label (the overworld theme policy, Music.lua:339). */
  mapSongs: Record<string, string>;
  /** Role -> song label: wild/trainer/gym/final + the *Win victory jingles. */
  battle: Record<string, string>;
  /** Engine id -> the wave-instrument table's location. */
  waveBanks: Record<string, WaveBankSpec>;
  /** Engine id -> drum id -> its little noise program. */
  noiseHeaders: Record<string, Record<string, ProgramHeader>>;
  cryHeaders?: Record<string, ProgramHeader>;
  cryData?: { bank: number; address: number };
  source?: string;
}

/** The AUDI payload's two halves (contracts/spec/voxel-spec.ts §VXPK_TAG). */
export interface AudioSection {
  json: Uint8Array;
  programs: Uint8Array;
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  );
}

/**
 * Split an AUDI payload. Throws on a blob whose header disagrees with its
 * length — an unplayable asset is a build mistake, not a runtime condition
 * to limp through (the decodeWav rule, framework/src/audio-api.ts).
 */
export function readAudioSection(bytes: Uint8Array): AudioSection {
  if (bytes.length < VXPK_AUDIO_HEADER_SIZE) {
    throw new Error("audio: AUDI payload is shorter than its header");
  }
  const jsonLen = u32(bytes, 0);
  const programLen = u32(bytes, 4);
  const programsOff =
    Math.ceil((VXPK_AUDIO_HEADER_SIZE + jsonLen) / VXPK_ALIGN) * VXPK_ALIGN;
  if (programsOff + programLen > bytes.length) {
    throw new Error("audio: AUDI halves do not fit in the payload");
  }
  return {
    json: bytes.subarray(VXPK_AUDIO_HEADER_SIZE, VXPK_AUDIO_HEADER_SIZE + jsonLen),
    programs: bytes.subarray(programsOff, programsOff + programLen),
  };
}

/** UTF-8 decode without TextDecoder (absent in the QuickJS realm). */
function utf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/** A resolved program, in the numbers an audio op carries. */
export interface ProgramRef {
  /** Index of the ROM bank in `bankOrder` — the op's `bank` argument. */
  bank: number;
  address: number;
  engine: number;
}

/** One boot-time table pin (`audioWaves` / `audioDrum`). */
export interface Pin {
  engine: number;
  /** Drum id, or -1 for the wave-instrument table. */
  drum: number;
  bank: number;
  address: number;
}

/**
 * The manifest, with every lookup already reduced to op arguments.
 */
export class AudioBanks {
  readonly manifest: AudioManifest;
  /** ROM bank number -> bank slot (its index in bankOrder). */
  private readonly slots = new Map<number, number>();

  constructor(manifest: AudioManifest) {
    this.manifest = manifest;
    manifest.bankOrder.forEach((bank, index) => this.slots.set(bank, index));
  }

  /** True when the manifest actually names programs to play. */
  get playable(): boolean {
    return this.manifest.bankOrder.length > 0 && Object.keys(this.manifest.songs).length > 0;
  }

  /** A header's op arguments, or null when its bank is not in the pak. */
  ref(header: ProgramHeader | undefined): ProgramRef | null {
    if (!header) return null;
    const slot = this.slots.get(header.bank);
    if (slot === undefined) return null;
    return { bank: slot, address: header.address, engine: header.engine };
  }

  song(label: string | undefined): ProgramRef | null {
    return label ? this.ref(this.manifest.songs[label]) : null;
  }

  sfx(name: string): ProgramRef | null {
    return this.ref(this.manifest.sfx[name]);
  }

  cry(species: string): (ProgramRef & { pitch: number; length: number }) | null {
    const def = this.manifest.cries[species];
    const ref = def && this.ref(def.header);
    return ref ? { ...ref, pitch: def.pitch, length: def.length } : null;
  }

  /** Music.lua:339 playMap — the overworld theme label for a map id. */
  mapSong(mapId: string): string | undefined {
    return this.manifest.mapSongs[mapId];
  }

  /** Music.lua:357 playBattle / :370 playVictory — the role's song label. */
  battleSong(role: string): string | undefined {
    return this.manifest.battle[role];
  }

  /**
   * The boot-time table pins: every sound engine's wave-instrument table
   * (ChipSynth.lua:685) and every drum program (:645). The core holds these
   * as addresses and decodes them the first time a program that uses the
   * engine starts, so pinning is a few dozen ops once and nothing after.
   */
  pins(): Pin[] {
    const out: Pin[] = [];
    for (const [engine, spec] of Object.entries(this.manifest.waveBanks)) {
      const id = Number(engine);
      const slot = this.slots.get(spec.bank);
      if (!Number.isInteger(id) || id < 0 || id >= AUDIO_ENGINES) continue;
      if (slot === undefined) continue;
      out.push({ engine: id, drum: -1, bank: slot, address: spec.address });
    }
    for (const [engine, drums] of Object.entries(this.manifest.noiseHeaders)) {
      const id = Number(engine);
      if (!Number.isInteger(id) || id < 0 || id >= AUDIO_ENGINES) continue;
      for (const [drum, header] of Object.entries(drums)) {
        const drumId = Number(drum);
        const slot = this.slots.get(header.bank);
        if (!Number.isInteger(drumId) || drumId < 0 || drumId >= AUDIO_DRUMS) continue;
        if (slot === undefined) continue;
        out.push({ engine: id, drum: drumId, bank: slot, address: header.address });
      }
    }
    return out;
  }
}

/** Build from an already-parsed manifest (the test path). */
export function fromParts(manifest: AudioManifest): AudioBanks {
  return new AudioBanks(manifest);
}

/**
 * The device transport: the pak's AUDI section, exactly as the `audiodata`
 * op hands it over. Only the JSON half is read — the programs stay in the
 * pak, where the core reads them. Returns null for an absent or empty
 * section: the game then runs silent, which is a supported configuration,
 * not an error.
 */
export function fromSection(bytes: ArrayBuffer | Uint8Array | null | undefined): AudioBanks | null {
  if (!bytes) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length === 0) return null;
  const { json } = readAudioSection(view);
  if (json.length === 0) return null;
  return new AudioBanks(JSON.parse(utf8(json)) as AudioManifest);
}

/**
 * The Bun transport: dist/voxelmon/gen/audio.json, which the importer's audio
 * stage writes. Null when it is absent (a dataset imported before the audio
 * stage existed).
 */
export async function fromGenDir(dir: string): Promise<AudioBanks | null> {
  const manifestFile = Bun.file(`${dir}/audio.json`);
  if (!(await manifestFile.exists())) return null;
  return new AudioBanks((await manifestFile.json()) as AudioManifest);
}
