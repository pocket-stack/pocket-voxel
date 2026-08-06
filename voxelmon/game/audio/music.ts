// What plays where.
//
// A port of gen1recomp `src/core/Music.lua` (:233 play, :312 fadeOut, :339
// playMap, :357 playBattle, :370 playVictory, :407 restoreMap) and
// `src/core/Sound.lua` (:190 play, :307 playCry, :55 FANFARES) — the POLICY
// half of the reference's audio, and only that half.
//
// The synth itself is the core's (crates/.../audio.rs): this
// module resolves a name to the numbers an audio op carries and emits the
// op. Nothing here computes a sample, holds a buffer, or watches a clock.
// One op per state transition — a map entry, an encounter, a textbox
// advance — against a per-frame budget of tens of ops, which is noise.
//
// A host that mounts no PCM output runs the identical op stream and hears
// nothing: the core still interprets the programs only when a host pumps
// `Scene::render_audio` for frames.

import { AUDIO_MUSIC_FLAG, AUDIO_SFX_FLAG, AUDIO_SFX_TEMPO } from "../../../contracts/spec/voxel-spec.ts";
import type { AudioBanks } from "./banks.ts";
import type { VoxelHost } from "../host.ts";

/**
 * Sound.lua:55-64 FANFARES — effects whose headers claim the music's tone
 * channels, so the song pauses until they finish and resumes after
 * (Music.lua:102-115 duckForFanfare).
 */
const FANFARES: Record<string, true> = {
  Level_Up: true,
  Caught_Mon: true,
  Get_Item1: true,
  Get_Item2: true,
  Get_Key_Item: true,
  Pokedex_Rating: true,
  Dex_Page_Added: true,
  Pokeflute: true,
};

export class AudioDirector {
  private readonly banks: AudioBanks | null;
  private readonly host: VoxelHost | null;

  /** The playing song label, or null. Music.lua's `state.current`. */
  private current: string | null = null;
  /** The theme to come back to after a battle (`state.mapSong`, :341). */
  private mapSong: string | null = null;
  /** Labels whose program the manifest cannot resolve; never retried (:241). */
  private readonly failed = new Set<string>();

  constructor(banks: AudioBanks | null, host: VoxelHost | null = null) {
    this.banks = banks && banks.playable ? banks : null;
    this.host = host;
    // The engine tables are boot-time facts: pin them once, before anything
    // can name a drum or a wave instrument.
    if (this.banks && this.host) {
      for (const pin of this.banks.pins()) {
        if (pin.drum < 0) this.host.audioWaves(pin.engine, pin.bank, pin.address);
        else this.host.audioDrum(pin.engine, pin.drum, pin.bank, pin.address);
      }
    }
  }

  /** True when the manifest is loaded and there is a host to emit to. */
  get live(): boolean {
    return this.banks !== null && this.host !== null;
  }

  /** The song label currently playing (tests and the debug HUD read it). */
  get playing(): string | null {
    return this.current;
  }

  /**
   * Music.lua:339 playMap — the overworld theme for a map id. Re-entering a
   * map that shares its theme is a no-op (:239 dedupes on the label), which
   * is what keeps a house door from restarting the town song.
   *
   * The bike/surf overrides (:324-335 effectiveMapSong) are not ported: the
   * v1 slice has neither vehicle.
   */
  startMap(mapId: string): void {
    const song = this.banks?.mapSong(mapId) ?? null;
    this.mapSong = song;
    if (song) this.play(song);
  }

  /** Music.lua:357 playBattle — kind = "wild" | "trainer" | "gym" | "final". */
  playBattle(kind = "wild"): void {
    const label = this.banks?.battleSong(kind) ?? this.banks?.battleSong("wild");
    if (label) this.play(label);
  }

  /**
   * Music.lua:370 playVictory — the Defeated* theme, started the moment the
   * win is decided; each one ends in `sound_loop 0` so it loops until the
   * battle closes and `restore()` puts the map theme back.
   */
  playVictory(kind = "wild"): boolean {
    const label = this.banks?.battleSong(`${kind}Win`);
    if (!label || !this.banks?.song(label)) return false;
    this.play(label);
    return true;
  }

  /**
   * Music.lua:383 playOnce — a jingle, played over the map theme's slot.
   *
   * DEVIATION: the Lua arms `pendingRestore` and :403 oneShotPlaying holds
   * the caller until the jingle ends, at which point Music.update puts the
   * map theme back. This surface has no end-of-song query — that would be a
   * new op, i.e. a later rung — so the caller decides when to `restore()`.
   */
  playOnce(song: string): boolean {
    if (!this.banks?.song(song)) return false;
    this.play(song);
    return this.current === song;
  }

  /** Music.lua:407 restoreMap — back to the map theme after a battle. */
  restore(): void {
    this.current = null;
    if (this.mapSong) this.play(this.mapSong);
    else this.stopMusic();
  }

  /**
   * Music.lua:312-321 fadeOut — rAUDVOL steps 7 -> 0, one level every
   * `control` ticks, and the song stops at 0 (home/fade_audio.asm). The core
   * walks it on the tick clock.
   */
  fadeOut(control = 10): void {
    if (!this.banks) return;
    this.current = null;
    this.host?.musicFade(Math.max(1, control));
  }

  /** Music.lua:285 stop — drop the song. */
  stopMusic(): void {
    if (!this.banks) return;
    this.current = null;
    this.host?.musicStop();
  }

  /**
   * Sound.lua:190 play — a one-shot effect over the music. A fanfare
   * (Sound.lua:55) pauses the song for its duration (Music.lua:102-115);
   * the core owns that, the name -> flag decision is policy and lives here.
   */
  playSfx(name: string): void {
    const ref = this.banks?.sfx(name);
    if (!ref || !this.host) return;
    // ChipAudio.lua:414-420 — an SFX renders with the caller's pitch and
    // tempo modifiers; the plain form uses the defaults.
    this.host.sfx(
      ref.bank,
      ref.address,
      ref.engine,
      0,
      AUDIO_SFX_TEMPO,
      FANFARES[name] ? AUDIO_SFX_FLAG.duck : 0,
    );
  }

  /**
   * Sound.lua:307 playCry — the species cry, with its own frequency and
   * length modifiers from the ROM's cry table (ChipAudio.lua:425-432).
   */
  playCry(species: string): void {
    const cry = this.banks?.cry(species);
    if (!cry || !this.host) return;
    this.host.cry(cry.bank, cry.address, cry.engine, cry.pitch, cry.length);
  }

  /** Drop everything (a hard scene cut). */
  stop(): void {
    if (!this.banks) return;
    this.current = null;
    this.host?.musicStop();
  }

  /**
   * Music.lua:233 play — start a song, deduped on the label (:239). A label
   * the manifest cannot resolve is remembered and never retried (:243-248).
   */
  private play(label: string): void {
    if (label === this.current || this.failed.has(label)) return;
    const ref = this.banks?.song(label);
    if (!ref || !this.host) {
      this.failed.add(label);
      return;
    }
    this.host.music(ref.bank, ref.address, ref.engine, AUDIO_MUSIC_FLAG.loop);
    this.current = label;
  }
}
