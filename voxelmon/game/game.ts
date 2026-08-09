// The Game shell: the state stack (overworld / textbox / stub-battle /
// warp-fade), the per-tick drive, and the boot that skips title/intro
// straight into the overworld like the reference test driver
// (tests/drivers/util.lua U.newGame ends standing in the bedroom;
// src/core/SaveData.lua:1345 newGame pins the spawn).
//
// One guest turn per host tick: tick(buttons) exactly once (docs/VOXEL.md
// §3). The tick is: input edges -> update the TOP state only (the Lua
// StateStack rule — everything beneath is frozen, which is also what makes
// the frame a script/box closes non-actionable for the world below) ->
// presentation emit -> frameDone.

import { fromSection, type AudioBanks } from "./audio/banks.ts";
import { AudioDirector } from "./audio/music.ts";
import { WildBattle } from "./battle/battle.ts";
import { healMon, newMon, type PartyMon } from "./battle/mon.ts";
import { computeStaging, type BattleStaging } from "./battle/staging.ts";
import { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { Input } from "./input.ts";
import { seededRng, type Rng } from "./rng.ts";
import { apply as applyEvolution, checkParty } from "./rules/evolution.ts";
import { movesLearnedAt } from "./rules/experience.ts";
import { MAP_ENTRY_AFTER_BATTLE, POST_BATTLE_RETURN, YES_NO_ANSWER } from "./rules/timing.ts";
import {
  PC_DEX_ROWS,
  PC_HOME_ROWS,
  PC_MAIL_ROWS,
  type PcDesktopPage,
  type PcDesktopSource,
  type PcPartyRow,
} from "./ui/pc-desktop.ts";
import {
  Scene,
  type BattleSceneView,
  type ChoiceSource,
  type Prof,
  type SceneView,
  type UiBoxSource,
} from "./scene.ts";
import { Overworld, type OverworldShell, type SaveSlice } from "./world/overworld.ts";
import { Textbox } from "./world/textbox.ts";

/** The full save: the overworld slice plus the party the battle port added. */
export interface GameSave extends SaveSlice {
  party: PartyMon[];
}

export interface GameState {
  readonly kind: string;
  update(): void;
}

class OverworldState implements GameState {
  readonly kind = "overworld";
  constructor(private ow: Overworld) {}
  update(): void {
    this.ow.update();
  }
}

interface MenuChoice {
  labels: readonly string[];
  choose(index: number): void;
}

class TextBoxState implements GameState, UiBoxSource {
  readonly kind = "textbox";
  readonly box: Textbox;
  private choicePushed = false;
  constructor(
    private game: VoxelmonGame,
    text: string,
    private onDone?: () => void,
    private choice?: MenuChoice,
  ) {
    this.box = new Textbox(text, {
      player: game.save.player.name,
      rival: game.save.player.rival,
    });
  }
  update(): void {
    // opts.choice (TextBox.lua:255): once the last page has typed out, the
    // YES/NO menu pops up over the still-visible text — before the box's
    // done-state can consume A as a close.
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice.labels, this.choice.choose));
      }
      return;
    }
    const wasWaiting = this.box.waiting;
    const wasDone = this.box.done;
    this.box.update(this.game.input);
    // TextBox.lua:269 and :284 — A/B both close a finished box and advance a
    // waiting one, and each plays the Press_AB beep.
    if ((wasDone && this.box.closed) || (wasWaiting && !this.box.waiting)) {
      this.game.audio.playSfx("Press_AB");
    }
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice.labels, this.choice.choose));
      }
      return;
    }
    if (this.box.closed) {
      this.game.pop();
      this.onDone?.();
    }
  }
}

class ChoiceState implements GameState, ChoiceSource {
  readonly kind = "choice";
  selected: number;
  /** The answer given, held on screen before it is handed back. */
  private pending: number | null = null;
  private holdFrames = 0;
  constructor(
    private game: VoxelmonGame,
    readonly labels: readonly string[],
    private cb: (index: number) => void,
    opts?: { defaultNo?: boolean; noSound?: boolean },
  ) {
    if (labels.length < 2 || labels.length > 4) {
      throw new Error("a choice needs two to four labels");
    }
    // ChoiceBox.lua:16 — some of the original's prompts open on NO
    this.selected = opts?.defaultNo ? labels.length - 1 : 0;
    this.noSound = opts?.noSound === true;
  }
  private readonly noSound: boolean;
  /** Compatibility name for the original YES/NO call sites. */
  get yes(): boolean {
    return this.selected === 0;
  }
  update(): void {
    const input = this.game.input;
    // ChoiceBox.lua:34-45: BOTH branches of DisplayTwoOptionMenu hold 15
    // frames with the menu still up before TwoOptionMenu_RestoreScreenTiles
    // hands control back (engine/menus/text_box.asm:322-323, :333-334).
    if (this.pending !== null) {
      this.holdFrames -= 1;
      if (this.holdFrames <= 0) {
        const selected = this.pending;
        this.pending = null;
        this.game.pop(); // this choice
        this.game.pop(); // the text box under it (ChoiceBox pops both)
        this.cb(selected);
      }
      return;
    }
    if (input.wasPressed("up")) {
      this.selected = (this.selected + this.labels.length - 1) % this.labels.length;
    } else if (input.wasPressed("down")) {
      this.selected = (this.selected + 1) % this.labels.length;
    } else if (input.wasPressed("a")) {
      // HandleMenuInput_ (home/window.asm): SFX_PRESS_AB on A and B alike
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:53
      this.pending = this.selected;
      this.holdFrames = YES_NO_ANSWER;
    } else if (input.wasPressed("b")) {
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:59
      // .choseSecondMenuItem writes wCurrentMenuItem = 1 BEFORE the hold, so
      // the cursor visibly snaps to NO for those 15 frames
      this.selected = this.labels.length - 1;
      this.pending = this.selected;
      this.holdFrames = YES_NO_ANSWER;
    }
  }
}

/**
 * The local bedroom computer. It is a real stack state: while it is topmost,
 * the overworld underneath receives no input. Rendering is delegated through
 * PcDesktopSource, so the controller knows nothing about PSP/Vita drawing.
 */
class PcDesktopState implements GameState, PcDesktopSource {
  readonly kind = "pc-desktop";
  revision = 0;
  page: PcDesktopPage = "home";
  selected = 0;
  status = "4 OBJECTS";
  readonly trainerName: string;
  boxNumber = 1;
  readonly readMail = [false, false, false];
  readonly party: readonly PcPartyRow[];

  constructor(private game: VoxelmonGame) {
    this.trainerName = game.save.player.name;
    this.party = game.save.party.map((mon) => ({
      name: mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species,
      level: mon.level,
      hp: mon.hp,
      maxHp: mon.stats.hp,
    }));
  }

  update(): void {
    const input = this.game.input;
    if (input.wasPressed("start")) {
      this.close();
      return;
    }
    if (input.wasPressed("b")) {
      this.game.audio.playSfx("Press_AB");
      if (this.page === "home") {
        this.close(false);
      } else {
        this.page = "home";
        this.selected = 0;
        this.status = "4 OBJECTS";
        this.changed();
      }
      return;
    }

    const count = this.rowCount();
    if (input.wasPressed("up")) {
      this.selected = (this.selected + count - 1) % count;
      this.changed();
      return;
    }
    if (input.wasPressed("down")) {
      this.selected = (this.selected + 1) % count;
      this.changed();
      return;
    }
    if (this.page === "storage" && (input.wasPressed("left") || input.wasPressed("right"))) {
      const delta = input.wasPressed("left") ? -1 : 1;
      this.boxNumber = ((this.boxNumber - 1 + delta + 12) % 12) + 1;
      this.status = `BOX ${String(this.boxNumber).padStart(2, "0")} ONLINE`;
      this.changed();
      return;
    }
    if (!input.wasPressed("a")) return;
    this.game.audio.playSfx("Press_AB");
    this.activate();
  }

  private rowCount(): number {
    switch (this.page) {
      case "pokedex":
        return PC_DEX_ROWS.length;
      case "storage":
        return Math.max(1, this.party.length);
      case "mail":
        return PC_MAIL_ROWS.length;
      default:
        return PC_HOME_ROWS.length;
    }
  }

  private activate(): void {
    if (this.page === "home") {
      if (this.selected === 3) {
        this.close(false);
        return;
      }
      this.page = (["pokedex", "storage", "mail"] as const)[this.selected]!;
      this.selected = 0;
      this.status =
        this.page === "pokedex"
          ? "3 SPECIES INDEXED"
          : this.page === "storage"
            ? "BOX 01 ONLINE"
            : `${this.readMail.filter((read) => !read).length} NEW MESSAGES`;
      this.changed();
      return;
    }
    if (this.page === "pokedex") {
      this.status = `${PC_DEX_ROWS[this.selected]!.slice(0, 3)} DATA LOADED`;
    } else if (this.page === "storage") {
      this.status = `BOX ${String(this.boxNumber).padStart(2, "0")} SYNC COMPLETE`;
    } else {
      this.readMail[this.selected] = true;
      this.status = `${PC_MAIL_ROWS[this.selected]} MESSAGE READ`;
    }
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
  }

  private close(playPress = true): void {
    if (playPress) this.game.audio.playSfx("Press_AB");
    this.game.audio.playSfx("Turn_Off_PC");
    this.game.pop();
  }
}

// The warp fade: 32 ticks of held world (Timing WARP_FADE_OUT — pokered
// GBFadeOutToBlack), the map switch at the midpoint, no fade back in
// (WARP_FADE_IN = 0: LoadGBPal restores the palettes in one write).
class WarpFadeState implements GameState {
  readonly kind = "warpfade";
  constructor(
    private game: VoxelmonGame,
    private frames: number,
    private midpoint: () => void,
    private onDone?: () => void,
  ) {}
  update(): void {
    this.frames -= 1;
    if (this.frames <= 0) {
      this.game.pop();
      this.midpoint();
      this.onDone?.();
    }
  }
}

// The real wild battle (replacing the overworld slice's StubBattle seam):
// the gen1recomp BattleState port in battle/battle.ts, staged in the voxel
// arena (battle/staging.ts) and drawn through the GB tile layer
// (battle/ui.ts). This state owns the battle's lifetime on the stack; the
// scene reads it through SceneView.battleView().
class BattleGameState implements GameState, BattleSceneView {
  readonly kind = "battle";
  readonly battle: WildBattle;
  readonly staging: BattleStaging | null;
  readonly ui = new BattleUi();

  constructor(
    private game: VoxelmonGame,
    species: string,
    level: number,
  ) {
    this.battle = new WildBattle(game.data, game.save, game.battleRng, species, level);
    // stage where the player stands; nothing moves the player — the camera
    // goes to the arena (docs/VOXEL.md §4)
    const ow = game.overworld;
    this.staging = computeStaging(ow.map, ow.player.cellX, ow.player.cellY, ow.player.surfing);
    this.battle.enter();
  }

  update(): void {
    const b = this.battle;
    if (b.finished) {
      // BattleState.lua:4647-4653 — teardown pops the battle screen FIRST,
      // and it is the map that holds: POST_BATTLE_RETURN before EnterMap
      // (home/overworld.asm:351-352) and then MapEntryAfterBattle's
      // GBFadeInFromWhite (:22, :749-753). The port renders both as held
      // frames, the convention WarpFadeState already uses for the warp fade.
      this.game.pop();
      // OverworldController.lua:3851-3894 afterBattle: the blackout warps to
      // the heal point FIRST and takes evolutions() as its callback (:3882),
      // every other exit runs them straight away (:3892).
      if (b.finished === "lose") this.game.blackout();
      this.game.pushWarpFade(
        POST_BATTLE_RETURN + MAP_ENTRY_AFTER_BATTLE,
        () => {},
        () => this.game.runEvolutions(b.leveledUp),
      );
      return;
    }
    b.update(this.game.input);
  }
}

export class VoxelmonGame implements OverworldShell, SceneView {
  readonly data: VoxelmonData;
  readonly host: VoxelHost;
  readonly input = new Input();
  /** Encounter roll stream. Tests may swap it after construction. */
  rng: Rng;
  /** NPC wander stream — separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Battle stream — separate so in-battle rolls (enemy DVs, crits, catch
   * wobbles) can never perturb the overworld route's determinism. */
  battleRng: Rng;
  save!: GameSave;
  overworld!: Overworld;
  /** Music, SFX and cries: the POLICY, emitting audio ops. Silent until a
   *  caller hands it the manifest — setAudio(banks) on the Bun transport,
   *  setAudioFromPak() on device. A director with no manifest emits nothing. */
  audio = new AudioDirector(null);
  private stack: GameState[] = [];
  private scene: Scene;
  tickIndex = 0;
  /** Autopilot-only profiling hook (psp-main.ts installs it when the native
   * surface carries `now`/`perf` — the perf-runbook EBOOT alone). Splits
   * tick() into update / scene-emit / audio (and emit into its sections,
   * scene.ts) and reports 300-tick µs sums. Undefined in production and in
   * the Bun sim; gameplay never reads it. */
  prof?: Prof;
  // audio policy observation (the reference calls Music/Sound from the sites
  // themselves; the port watches the same state transitions from one place)
  private audioMap: string | null = null;
  private audioBattle = false;
  private audioRestored = false;

  constructor(data: VoxelmonData, host: VoxelHost, seed = 1) {
    this.data = data;
    this.host = host;
    this.rng = seededRng(seed >>> 0);
    // decorrelated second stream (fixed odd offset keeps seed 0 distinct)
    this.npcRng = seededRng(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    // third stream for battles (same decorrelation trick, distinct constant)
    this.battleRng = seededRng(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
    this.scene = new Scene(host);
  }

  /**
   * Install the audio manifest — `null` means NO manifest, which is total
   * silence: the director resolves nothing and emits no op. Pass the Bun
   * transport's manifest (gen/audio.json); `setAudioFromPak()` is the device
   * path.
   *
   * The `audiodata` op fires either way, on EVERY host, so a recorded trace
   * carries the same op stream a device run replays (SCHEMA.md ".vtrace").
   * Only setAudioFromPak() reads the answer.
   */
  setAudio(banks: AudioBanks | null): void {
    void this.host.audiodata();
    this.audio = new AudioDirector(banks, this.host);
  }

  /**
   * Load the audio manifest from the pak's AUDI section, over the `audiodata`
   * op — the device transport. Only the JSON half is parsed; the programs
   * stay in the pak, where the core reads them (banks.ts fromSection). A pak
   * cooked without audio answers null and the director stays silent.
   */
  setAudioFromPak(): void {
    this.audio = new AudioDirector(fromSection(this.host.audiodata()), this.host);
  }

  /**
   * The audio policy, ported from the reference's call sites: map themes on
   * map entry (Music.lua:339 playMap), the battle theme and the wild mon's
   * cry on encounter (BattleState.lua:1458, :1496-1498), the victory jingle
   * the moment the win is decided (Music.lua:370), and the map theme back
   * when the battle closes (:407 restoreMap).
   */
  private driveAudio(): void {
    const bv = this.battleView();
    if (bv) {
      if (!this.audioBattle) {
        this.audioBattle = true;
        // play_battle_music.asm runs before the transition (:1458); the cry
        // and the victory theme are NOT observed from out here — the battle
        // queues them where the reference does and we drain them below.
        this.audio.playBattle("wild");
      }
      this.drainBattleCues(bv.battle);
      return;
    }
    if (this.audioBattle) {
      this.audioBattle = false;
      // the battle's own finish() already queued music:restore; this is the
      // backstop for a battle torn down without one
      if (!this.audioRestored) this.audio.restore();
      this.audioRestored = false;
      return;
    }
    const mapId = this.overworld.map.id;
    // A connection crossing switches the map at the START of the seam step;
    // its theme is owed to the frame the step LANDS (OverworldController.lua:
    // 1075), and the overworld pays it through startMapMusic. Observing the
    // map id here would jump the gun by a whole step.
    if (mapId !== this.audioMap && !this.overworld.pendingSeamMusic) {
      this.audioMap = mapId;
      this.audio.startMap(mapId);
    }
  }

  /** Play what the battle queued, in the order it queued it. */
  private drainBattleCues(battle: WildBattle): void {
    const cues = battle.audioCues;
    for (const cue of cues) {
      if (cue.startsWith("cry:")) {
        this.audio.playCry(cue.slice(4));
      } else if (cue.startsWith("sfx:")) {
        this.audio.playSfx(cue.slice(4));
      } else if (cue === "music:victory") {
        // Music.playVictory only has a jingle for a won fight
        this.audio.playVictory("wild");
      } else if (cue === "music:restore") {
        this.audio.restore();
        this.audioRestored = true;
        this.audioMap = this.overworld.map.id;
      }
    }
    cues.length = 0;
  }

  /**
   * Boot straight into the overworld, skipping title/intro like the
   * reference driver's U.newGame: SaveData.lua:1345 pins the spawn at
   * REDS_HOUSE_2F (3,6) facing down, and :1303-1305 defaultHeal resolves
   * the vanilla bedroom spawn to PALLET_TOWN (5,6) for lastHeal AND
   * lastOutdoor (wLastMap is zero-filled and PALLET_TOWN is map 0), which
   * is what makes the 1F exit mat's LAST_MAP warp work before the player
   * has ever been outdoors.
   */
  newGame(): void {
    this.save = {
      // The starter is already in the party below, so the world must read
      // as it does AFTER Oak's lab: every hand-ported script branches on
      // this flag (data/scripts/reds_house.lua, pallet_town.lua), and with
      // it clear Mom would offer the wake-up line to a trainer who already
      // has a mon and Oak would still be barring the grass.
      flags: { EVENT_GOT_STARTER: true },
      inventory: {},
      player: { name: "RED", rival: "BLUE" },
      lastHeal: { map: "PALLET_TOWN", x: 5, y: 6 },
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
      // DEVIATION (battle slice): the reference new-game party is EMPTY
      // until Oak's lab hands out a starter (SaveData.lua newGame); the
      // slice has no lab script yet, so newGame grants SQUIRTLE L5 with
      // fixed zero DVs (deterministic — no rng draw at boot) so wild
      // encounters are playable end to end.
      party: [newMon(this.data, "SQUIRTLE", 5)],
    };
    this.overworld = new Overworld(this);
    this.stack = [new OverworldState(this.overworld)];
    this.overworld.enter("REDS_HOUSE_2F", 3, 6, "down");
  }

  /**
   * The blackout path a lost battle takes (pokered HandleBlackOut,
   * engine/battle/core.asm:1157+: heal the party, special-warp to the last
   * Pokémon center). v1: full heal + the warp fade to save.lastHeal; the
   * money halving (ResetStatusAndHalveMoneyOnBlackout) has no money field
   * to act on in this slice.
   */
  blackout(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
    const heal = this.save.lastHeal;
    if (heal) {
      this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down");
    }
  }

  /** One guest turn per host tick — exactly once. */
  tick(buttons: number): void {
    const p = this.prof;
    const t0 = p ? p.now() : 0;
    this.input.setButtons(buttons);
    this.input.step();
    const top = this.stack[this.stack.length - 1];
    top?.update();
    const t1 = p ? p.now() : 0;
    this.scene.emit(this);
    const t2 = p ? p.now() : 0;
    this.driveAudio();
    this.host.frameDone(this.tickIndex, buttons);
    if (p) {
      p.upd += t1 - t0;
      p.emit += t2 - t1;
      p.aud += p.now() - t2;
      if (this.tickIndex % 300 === 299) {
        p.line(
          `j${this.tickIndex} upd ${Math.round(p.upd)} emit ${Math.round(p.emit)}` +
            ` aud ${Math.round(p.aud)} maps ${Math.round(p.maps)}` +
            ` ents ${Math.round(p.ents)} ui ${Math.round(p.ui)}`,
        );
        p.upd = p.emit = p.aud = p.maps = p.ents = p.ui = 0;
      }
    }
    this.tickIndex += 1;
  }

  // stack ---------------------------------------------------------------

  push(state: GameState): void {
    this.stack.push(state);
  }

  pop(): void {
    this.stack.pop();
  }

  top(): GameState | undefined {
    return this.stack[this.stack.length - 1];
  }

  stackKinds(): string[] {
    return this.stack.map((s) => s.kind);
  }

  // OverworldShell ------------------------------------------------------

  /** Commands.lua:587 heal_party — Pokemon.lua:90 heal over the party. */
  healParty(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
  }

  /** Music.lua:383 playOnce / :407 restoreMap, for the script verbs. */
  playOnce(song: string): void {
    this.audio.playOnce(song);
  }

  restoreMapMusic(): void {
    this.audio.restore();
  }

  /** Music.lua:339 playMap, from the site that owns the moment. */
  startMapMusic(mapId: string): void {
    this.audioMap = mapId;
    this.audio.startMap(mapId);
  }

  showText(text: string, onDone?: () => void): void {
    this.push(new TextBoxState(this, text, onDone));
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.showMenuChoice(text, ["YES", "NO"], (index) => choice(index === 0));
  }

  /** A native GB dialogue with caller-owned labels (the PC uses LOCAL/REMOTE). */
  showMenuChoice(text: string, labels: readonly string[], choice: (index: number) => void): void {
    this.push(new TextBoxState(this, text, undefined, { labels, choose: choice }));
  }

  /**
   * OpenRedsPC replacement for this runtime's bedroom: choose a data source in
   * the game's native dialogue first, then mount the local shell as a modal
   * state. The remote branch is deliberately explicit and never falls back to
   * local when no mock host is online.
   */
  openBedroomComputer(): void {
    this.audio.playSfx("Turn_On_PC");
    this.showMenuChoice("Which PC do you\nwant to open?", ["LOCAL PC", "REMOTE PC"], (index) => {
      this.audio.playSfx("Enter_PC");
      if (index === 0) {
        this.push(new PcDesktopState(this));
        return;
      }
      this.showText("PALLETNET is\nsearching for a\nremote PC...\fNo remote PC is\nonline.", () => {
        this.audio.playSfx("Turn_Off_PC");
      });
    });
  }

  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void {
    this.push(new WarpFadeState(this, frames, midpoint, onDone));
  }

  /**
   * Evolution.lua:195-223 checkParty driving :156-178 evolve, one mon at a
   * time in party order. The Lua plays EvolutionState's flashing-forms movie
   * when it has graphics and falls back to the plain text flow otherwise;
   * this slice takes the fallback — the same two pages, the same apply, and
   * the evolved species' exact-level learn check afterwards (:174, the
   * evos_moves.asm EvolveMon -> LearnMoveFromLevelUp predef).
   */
  runEvolutions(leveledUp: ReadonlySet<PartyMon> | null | undefined): void {
    const pending = checkParty(this.data, this.save.party, leveledUp);
    if (pending.length === 0) return;
    const step = (i: number): void => {
      const row = pending[i];
      if (!row) return;
      const { mon, to } = row;
      const oldName = mon.nickname ?? this.data.pokemon[mon.species]!.name;
      const newName = this.data.pokemon[to]!.name;
      applyEvolution(this.data, mon, to);
      this.showText(
        `What?\n${oldName} is\nevolving!\fCongratulations!\nYour ${oldName}\nevolved into\n${newName}!`,
        () => {
          this.learnEvolutionMoves(mon, () => step(i + 1));
        },
      );
    };
    step(0);
  }

  /**
   * Evolution.lua:112-152 learnEvolutionMoves — the EVOLVED species' learnset
   * at exactly this level (movesLearnedAt, not movesAtLevel), each new move
   * announced on its own page. A full moveset keeps battle.ts's v1 deviation:
   * MoveLearnMenu is not in this slice, so the mon declines and says so.
   */
  private learnEvolutionMoves(mon: PartyMon, onDone: () => void): void {
    const def = this.data.pokemon[mon.species]!;
    const learned = movesLearnedAt(def, mon.level);
    const name = mon.nickname ?? def.name;
    const step = (i: number): void => {
      const moveId = learned[i];
      if (!moveId) {
        onDone();
        return;
      }
      const mdef = this.data.moves[moveId];
      if (!mdef || mon.moves.some((mv) => mv.id === moveId)) {
        step(i + 1);
        return;
      }
      if (mon.moves.length < 4) {
        mon.moves.push({ id: moveId, pp: mdef.pp });
        this.showText(`${name} learned\n${mdef.name}!`, () => step(i + 1));
        return;
      }
      this.showText(
        `${name} is trying to\nlearn ${mdef.name}!\f${name} did not learn\n${mdef.name}!`,
        () => step(i + 1),
      );
    };
    step(0);
  }

  // OverworldShell keeps the seam's method name (overworld.ts is another
  // task's file); since the battle port it constructs the REAL wild battle
  // (BattleState.newWild in the reference).
  pushStubBattle(species: string, level: number): void {
    this.push(new BattleGameState(this, species, level));
  }

  // SceneView -----------------------------------------------------------

  uiBox(): UiBoxSource | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i] as GameState & Partial<UiBoxSource>;
      if (s.box) return s as GameState & UiBoxSource;
    }
    return null;
  }

  uiChoice(): ChoiceSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "choice" ? (top as ChoiceState) : null;
  }

  pcDesktop(): PcDesktopSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pc-desktop" ? (top as PcDesktopState) : null;
  }

  battleView(): BattleSceneView | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s.kind === "battle") return s as BattleGameState;
    }
    return null;
  }
}
