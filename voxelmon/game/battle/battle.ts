// The wild-battle state machine. Ports gen1recomp src/battle/BattleState.lua
// for the v1 wild slice (docs/VOXEL.md §10): the message/action QUEUE is the
// engine — menus interleave with messages, drains and holds, and the queue
// is what sequences them (say/sayNext/act/actNext/waitNext, :833-963;
// updateQueue :1064) — plus intro (enter :1417), the FIGHT/PKMN/ITEM/RUN
// menu (:1856), move select (:1927), turn resolution (resolveTurn :2296,
// executeAction :3140, performMove :3397), damage application (:3596),
// fainting/exp (:3624/:3694), catching (throwBall :4484), running
// (tryRun :4282), end-of-turn (:2409) and finish (:4610).
//
// v1 scope cuts, each flagged where it lands: trainer battles, ghosts,
// Safari, the old-man demo, link play, move subanimations (anim rows keep
// their queue shape and the MOVE_ANIM_PRE beat, nothing draws), sound, the
// pokédex, nicknaming, the box system, and the replace-move prompt.

import type { MoveDef, VoxelmonData } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import {
  accuracyRoll as damageAccuracyRoll,
  compute as damageCompute,
  GEN1_FAITHFUL,
  type DamageInfo,
  type DamageMove,
  type Ruleset,
} from "../rules/damage.ts";
import { attempt as catchAttempt } from "../rules/catching.ts";
import { apply as expApply, movesLearnedAt } from "../rules/experience.ts";
import { beforeMove as statusBeforeMove, residual as statusResidual } from "../rules/status.ts";
import { effectiveSpeed, firstMover } from "../rules/turnorder.ts";
import { createTypeChart, type TypeChart } from "../rules/typechart.ts";
import {
  BATTLE_SLIDE_IN_FRAMES,
  BATTLE_START_SENDOUT,
  CRIT_OHKO_TEXT,
  FAINT_SLIDE,
  MOVE_ANIM_PRE,
  TEXT_PRE_ADVANCE,
  TEXT_SCROLL_PAIR,
  hpDrainClosingFrames,
  hpDrainStepFrames,
} from "../rules/timing.ts";
import { encodeGlyphs } from "../ui/tiles.ts";
import { displayName, makeBattler, prefixEnemy, type WildBattler } from "./battler.ts";
import {
  effectRecord,
  inflictStatus,
  makeCtx,
  runDamaging,
  warnUnknown,
  type AnimRowRef,
  type EffectBattle,
  type EffectMsgs,
  type HitFx,
} from "./effects.ts";
import { firstHealthy, newMon, partyAdd, type MoveSlot, type PartyMon } from "./mon.ts";

export type BattleResult = "win" | "lose" | "run" | "caught";

export type BattleButton = "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select";

export interface BattleInput {
  isDown(btn: BattleButton): boolean;
  wasPressed(btn: BattleButton): boolean;
}

/** The save slice the battle reads and mutates. */
export interface BattleSave {
  party: PartyMon[];
  inventory: Record<string, number>;
  player: { name: string; rival: string };
}

// ---------------------------------------------------------------------------
// queue rows (BattleState.lua:833-963)
// ---------------------------------------------------------------------------

export interface QueueRow extends AnimRowRef {
  /** message row */
  text?: string;
  auto?: boolean;
  autoDelay?: number;
  choice?: (yes: boolean) => void;
  choiceOpen?: boolean;
  /** action row */
  fn?: () => void;
  /** animation row (v1: pays MOVE_ANIM_PRE, draws nothing) */
  anim?: string | null;
  hitRow?: boolean;
  attackerIsPlayer?: boolean;
  animDelayed?: boolean;
  shakes?: number;
  ball?: string;
  hit?: HitFx;
  /** HP-bar drain hold (drainNext :934) */
  drain?: boolean;
  battler?: WildBattler;
  stopAt?: number;
  /** pure frame hold (waitNext :943) */
  wait?: number;
  /** the level-up stat window (PrintStatsBox; the Lua's ui row) */
  statBox?: PartyMon;
}

interface MsgLine {
  text: string;
  codes: number[];
  cont: boolean;
}

export interface MsgShown {
  text: string;
  codes: number[];
  revealed: number;
}

export type BattlePhase = "messages" | "menu" | "moveSelect" | "party" | "item";

export class WildBattle implements EffectBattle {
  readonly kind = "wild";
  readonly data: VoxelmonData;
  /** The battle rng stream. Tests may swap it after construction (the
   * harness.lua injection style — rng.ts). */
  rng: Rng;
  readonly save: BattleSave;
  /** Every message row as it starts typing, in queue order — the queue
   * discipline the tests pin (say -> act -> damage -> say ...). */
  readonly messageLog: string[] = [];
  readonly ruleset: Ruleset = GEN1_FAITHFUL;
  readonly chart: TypeChart;

  player!: WildBattler;
  enemy!: WildBattler;
  dead = false;

  queue: QueueRow[] = [];
  phase: BattlePhase = "messages";
  afterQueue: "menu" | "finish" = "menu";
  menuIndex = 1;
  moveIndex = 1;
  moveSwapIndex: number | null = null;
  frame = 0;
  turnCount = 0;
  runAttempts = 0;
  lastDamage = 0;
  result: BattleResult | null = null;
  /** Set once finish() ran; the shell pops the state and stages the return. */
  finished: BattleResult | null = null;

  // presentation flags the ui reads (enter() windows, BattleState.lua:1459+)
  introBalls = true;
  showPlayerBack = true;
  sendingOut = false;
  blackedOut = false;
  lastBall: string | null = null;

  // queue pump state (updateQueue :1064)
  private nextInsert = 0;
  private waitFrames = 0;
  private draining = false;
  moveAnimRow: QueueRow | null = null;
  current: QueueRow | null = null;
  statBoxMon: PartyMon | null = null;

  // message machine state (startMessage :1021)
  private lines: MsgLine[] = [];
  private lineIndex = 0;
  private codes: number[] = [];
  shown: MsgShown[] = [];
  msgWaiting = false;
  private msgPreWait = 0;
  msgPrompt = false;
  private msgPromptWait = 0;
  private msgAutoWait: number | null = null;
  msgHold = false;
  private charTimer = 0;
  choiceOpen = false;
  choiceYes = true;

  // party / item menus (v1 internal phases in place of the Lua's ui stack)
  partyIndex = 0;
  partyForced = false;
  itemIndex = 0;
  itemList: string[] = [];

  private participants = new Set<PartyMon>();
  /** mons that leveled up (EvolveAfterBattle hook — unused v1, kept). */
  leveledUp = new Set<PartyMon>();

  /**
   * BattleState.newWild (:576-594). The enemy mon's DVs consume the battle
   * rng stream; the overworld streams are untouched.
   */
  constructor(data: VoxelmonData, save: BattleSave, rng: Rng, species: string, level: number) {
    this.data = data;
    this.save = save;
    this.rng = rng;
    this.chart = createTypeChart(data.type_chart);
    const playerMon = firstHealthy(save.party);
    if (!playerMon) {
      // :580-583 — flagged dead; enter() takes the blackout path (#425)
      this.dead = true;
    } else {
      this.player = makeBattler(data, playerMon, true, save);
    }
    this.enemy = makeBattler(data, newMon(data, species, level, rng), false);
    if (this.dead) {
      // keep the shared phases nil-safe like makeOldManDemo (:810-817)
      this.player = this.enemy;
    }
  }

  // -------------------------------------------------------------------
  // queue builders (:833-963)
  // -------------------------------------------------------------------

  say(text: string): void {
    this.queue.push({ text });
  }

  /** :843-845 sayAuto — a `text_end` page: never waits on the player. */
  sayAuto(text: string, delay = 0): void {
    this.queue.push({ text, auto: true, autoDelay: delay });
  }

  /** :849-851 sayChoice — YES/NO over the still-visible text. */
  sayChoice(text: string, onChoose: (yes: boolean) => void): void {
    this.queue.push({ text, choice: onChoose });
  }

  act(fn: () => void): void {
    this.queue.push({ fn });
  }

  private insertNext(row: QueueRow): void {
    this.nextInsert += 1;
    this.queue.splice(this.nextInsert - 1, 0, row);
  }

  /** :867-872 animNext. */
  animNext(name: string, isPlayer: boolean, shakes?: number, ball?: string): void {
    this.insertNext({ anim: name, attackerIsPlayer: isPlayer, shakes, ball });
  }

  /** :874-878 actNext. */
  actNext(fn: () => void): void {
    this.insertNext({ fn });
  }

  /** :880-885 sayNext. */
  sayNext(text: string): void {
    this.insertNext({ text });
  }

  /** :887-892 sayNextAuto. */
  sayNextAuto(text: string, delay = 0): void {
    this.insertNext({ text, auto: true, autoDelay: delay });
  }

  /** :896-899 uiNext, narrowed to the one ui row v1 needs (StatBox). */
  statBoxNext(mon: PartyMon): void {
    this.insertNext({ statBox: mon });
  }

  /** :934-938 drainNext. */
  drainNext(battler?: WildBattler, stopAt?: number): void {
    this.insertNext({ drain: true, battler, stopAt });
  }

  /** :943-947 waitNext. */
  waitNext(frames: number): void {
    if (!frames || frames <= 0) return;
    this.insertNext({ wait: frames });
  }

  /** EffectRegistry hit rows (:227-241) — insert + return for `.hit`. */
  insertHitRow(anim: string | null, isPlayer: boolean): QueueRow {
    const row: QueueRow = anim
      ? { anim, attackerIsPlayer: isPlayer }
      : { hitRow: true, attackerIsPlayer: isPlayer };
    this.insertNext(row);
    return row;
  }

  /** :2511-2529 cancelMoveAnim — peel the announcement-time anim row. */
  cancelMoveAnim(): void {
    const row = this.moveAnimRow;
    if (!row) return;
    this.moveAnimRow = null;
    const i = this.queue.indexOf(row);
    if (i >= 0) {
      this.queue.splice(i, 1);
      if (i < this.nextInsert) this.nextInsert -= 1;
    }
  }

  // -------------------------------------------------------------------
  // HP-bar drain (stepHPDrain :964-1002)
  // -------------------------------------------------------------------

  private stepHPDrain(): boolean {
    let busy = false;
    for (const b of [this.player, this.enemy]) {
      if (!b) continue;
      let goal = b.mon.hp;
      if (b.drainFloor !== undefined && b.drainFloor > goal && b.shownHP >= b.drainFloor) {
        goal = b.drainFloor;
      }
      if ((b.drainHold ?? 0) > 0) {
        b.drainHold = (b.drainHold ?? 0) - 1;
        busy = true;
      } else if (b.shownHP !== goal) {
        const maxHP = Math.max(1, b.mon.stats.hp);
        const playerSide = b === this.player;
        let cost = 0;
        while (b.shownHP !== goal && cost < 1) {
          const nextHP = b.shownHP + (b.shownHP > goal ? -1 : 1);
          cost += hpDrainStepFrames(b.shownHP, nextHP, maxHP, playerSide);
          b.shownHP = nextHP;
        }
        b.drainHold = Math.max(0, cost - 1);
        b.draining = true;
        busy = true;
      } else if (b.draining) {
        b.draining = undefined;
        b.drainHold = hpDrainClosingFrames(b === this.player) - 1;
        busy = true;
      }
    }
    return busy;
  }

  // -------------------------------------------------------------------
  // message machine (startMessage :1021, beginMsgLine :1053)
  // -------------------------------------------------------------------

  private startMessage(item: QueueRow): void {
    this.current = item;
    this.lines = [];
    const text = item.text ?? "";
    this.messageLog.push(text);
    let pos = 0;
    let cont = false;
    for (;;) {
      const npos = text.slice(pos).search(/[\n\v]/);
      const chunk = npos < 0 ? text.slice(pos) : text.slice(pos, pos + npos);
      this.lines.push({ text: chunk, codes: encodeGlyphs(chunk), cont });
      if (npos < 0) break;
      cont = text[pos + npos] === "\v";
      pos += npos + 1;
    }
    this.shown = [];
    this.lineIndex = 0;
    this.msgWaiting = false;
    this.msgPrompt = false;
    this.msgAutoWait = null;
    this.msgHold = false;
    this.beginMsgLine();
  }

  private beginMsgLine(): void {
    this.lineIndex += 1;
    const ln = this.lines[this.lineIndex - 1];
    this.codes = ln ? ln.codes : [];
    if (this.shown.length >= 2) {
      // ScrollTextUpOneLine — instantaneous on the tile grid; the
      // TEXT_SCROLL_PAIR hold after a CONT keeps the pacing (:1250-1252)
      this.shown.shift();
    }
    this.shown.push({ text: ln ? ln.text : "", codes: this.codes, revealed: 0 });
  }

  // -------------------------------------------------------------------
  // the queue pump (updateQueue :1064-1343). Returns true while busy.
  // -------------------------------------------------------------------

  updateQueue(input: BattleInput): boolean {
    // the level-up stat window pauses the queue until A/B (StatBox :409-415)
    if (this.statBoxMon) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.statBoxMon = null;
      }
      return true;
    }
    if (this.waitFrames > 0) {
      this.waitFrames -= 1;
      return true;
    }
    // waitingSound (:1077-1081): no audio in the voxel v1 slice
    if (this.draining) {
      if (this.stepHPDrain()) return true;
      this.draining = false;
      if (this.player) this.player.drainFloor = undefined;
      if (this.enemy) this.enemy.drainFloor = undefined;
    }
    if (!this.current) {
      const item = this.queue.shift();
      if (!item) return false;
      if (item.fn) {
        this.nextInsert = 0; // sayNext inserts right after this item (:1114)
        item.fn();
        this.current = null;
        return true;
      }
      if (item.statBox) {
        this.statBoxMon = item.statBox;
        return true;
      }
      if (item.drain) {
        this.draining = true;
        if (item.battler) item.battler.drainFloor = item.stopAt;
        return true;
      }
      if (item.wait !== undefined) {
        this.waitFrames = item.wait;
        return true;
      }
      if (item.anim !== undefined || item.hitRow) {
        // PlayMoveAnimation's Delay3 before the first animation frame
        // (:1158-1167); v1 has no subanimation player, so the row then
        // resolves at once — the Lua's own no-animPlayer fallback applies
        // the hit immediately (:1209-1230). Nothing draws (scope ladder:
        // battle move animations are a later rung).
        if (item.anim && !item.animDelayed) {
          item.animDelayed = true;
          this.queue.unshift(item);
          this.waitFrames = MOVE_ANIM_PRE;
          return true;
        }
        this.current = null;
        return true;
      }
      this.startMessage(item);
    }
    // \v CONT wait (:1239-1255)
    if (this.msgWaiting) {
      if (this.msgPreWait > 0) {
        this.msgPreWait -= 1;
        return true;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.msgWaiting = false;
        this.beginMsgLine();
        this.waitFrames = TEXT_SCROLL_PAIR;
      }
      return true;
    }
    const cur = this.shown[this.shown.length - 1];
    if (cur.revealed < this.codes.length) {
      // PrintLetterDelay cadence (:1256-1274): OPTION text speed 3, or a
      // single frame while A/B is held
      let delay = 3;
      if (input.isDown("a") || input.isDown("b")) delay = 1;
      this.charTimer += 1;
      while (this.charTimer >= delay && cur.revealed < this.codes.length) {
        this.charTimer -= delay;
        cur.revealed += 1;
      }
    } else if (this.lineIndex < this.lines.length) {
      if (this.lines[this.lineIndex].cont) {
        this.msgWaiting = true;
        this.msgPreWait = TEXT_PRE_ADVANCE;
      } else {
        this.beginMsgLine();
      }
    } else {
      const item = this.current;
      // choice rows open YES/NO over the typed text (:1288-1299)
      if (item?.choice && !item.choiceOpen) {
        item.choiceOpen = true;
        this.choiceOpen = true;
        this.choiceYes = true;
        return true;
      }
      if (item?.choice && this.choiceOpen) {
        if (input.wasPressed("up") || input.wasPressed("down")) {
          this.choiceYes = !this.choiceYes;
        }
        let answer: boolean | null = null;
        if (input.wasPressed("a")) answer = this.choiceYes;
        else if (input.wasPressed("b")) answer = false; // ChoiceBox B = NO
        if (answer !== null) {
          const fn = item.choice;
          this.choiceOpen = false;
          this.current = null;
          fn(answer);
        }
        return true;
      }
      if (item?.auto) {
        // `text_end` pages never wait on the player (:1300-1317, #765)
        this.msgAutoWait = this.msgAutoWait ?? item.autoDelay ?? 0;
        if (this.msgAutoWait > 0) {
          this.msgAutoWait -= 1;
        } else {
          this.msgAutoWait = null;
          this.msgHold = true;
          this.current = null;
        }
      } else {
        // PromptText's ▼ + ProtectedDelay3 before the page can be
        // dismissed (:1318-1339, #317)
        if (!this.msgPrompt) {
          this.msgPrompt = true;
          this.msgPromptWait = TEXT_PRE_ADVANCE;
        }
        if (this.msgPromptWait > 0) {
          this.msgPromptWait -= 1;
        } else if (input.wasPressed("a") || input.wasPressed("b")) {
          this.msgPrompt = false;
          this.current = null;
        }
      }
    }
    return true;
  }

  // -------------------------------------------------------------------
  // intro (enter :1417-1622, wild slice)
  // -------------------------------------------------------------------

  enter(): void {
    if (this.dead) {
      // :1417-1447 — no healthy party: black out instead of skipping (#425).
      // v1 prints the two paragraphs on the battle screen (no map TextBox).
      this.result = "lose";
      this.say(`${this.save.player.name} is out of\nuseable POKéMON!`);
      this.say(`${this.save.player.name} blacked\nout!`);
      this.phase = "messages";
      this.afterQueue = "finish";
      return;
    }
    // SlidePlayerAndEnemySilhouettesOnScreen: nothing queued starts until
    // the slide has landed (:1465 introSlide + :1793-1802); the voxel v1
    // has no silhouettes, so the hold rides the queue instead.
    this.queue.push({ wait: BATTLE_SLIDE_IN_FRAMES });
    // PlayCry before WildMonAppearedText (:1496-1510, #303) — audio is a
    // later rung; the row order is kept without a row.
    this.say(`Wild ${this.enemy.name}\nappeared!`);
    // _InitBattleCommon clears the intro chrome the instant the intro text
    // is dismissed (:1534-1539, #317)
    this.act(() => {
      this.introBalls = false;
    });
    // StartBattle's unconditional `ld c, 40 / call DelayFrames` (:1580-1587)
    this.queue.push({ wait: BATTLE_START_SENDOUT });
    // the back pic walks off before "Go! X!" (:1588-1599, #317): 18 frames
    this.queue.push({ wait: 18 });
    this.act(() => {
      this.showPlayerBack = false;
      this.sendingOut = true;
    });
    this.say(this.sendOutText(this.player.name));
    this.queue.push({ anim: "POOF_ANIM", attackerIsPlayer: false });
    this.act(() => {
      this.sendingOut = false;
      // AnimateSendingOutMon grow-in + cry (:1604-1610) — later rung
    });
    this.markParticipant();
    this.phase = "messages";
    this.afterQueue = "menu";
  }

  /** :1353-1363 sendOutText — the shout scales with enemy HP remaining. */
  sendOutText(name: string): string {
    const e = this.enemy.mon;
    let pct = 100;
    if (e.hp > 0 && Math.floor(e.stats.hp / 4) > 0) {
      pct = Math.floor((e.hp * 25) / Math.floor(e.stats.hp / 4));
    }
    if (pct >= 70) return `Go! ${name}!`;
    if (pct >= 40) return `Do it! ${name}!`;
    if (pct >= 10) return `Get'm! ${name}!`;
    return `The enemy's weak!\nGet'm! ${name}!`;
  }

  /** Exp participants (wPartyGainExpFlags, :2257-2262). */
  markParticipant(): void {
    if (this.player?.mon) this.participants.add(this.player.mon);
  }

  // -------------------------------------------------------------------
  // update (:1777-1998) — one call per fixed step
  // -------------------------------------------------------------------

  update(input: BattleInput): void {
    this.frame += 1;

    // menu-idle safety net (:1783-1791): HP/status changed outside a drain
    if (this.phase === "menu") {
      for (const b of [this.player, this.enemy]) {
        if (!b) continue;
        b.shownHP = b.mon.hp;
        b.drainFloor = undefined;
        b.shownStatus = b.mon.status ?? null;
      }
    }

    if (this.phase === "messages") {
      if (!this.updateQueue(input)) {
        if (this.afterQueue === "menu") {
          this.phase = "menu";
        } else {
          this.finish();
        }
      }
      return;
    }

    if (this.phase === "menu") {
      // forced replacement after a faint (ChooseNextMon :1856-1865)
      if (this.player.mon.hp <= 0) {
        if (firstHealthy(this.save.party)) {
          this.openParty(true);
        }
        return;
      }
      this.clearTurnFlinches();
      // recharge/Rage/thrash/charge would skip DisplayBattleMenu
      // (:1867-1873); none is reachable from the v1 effect set
      const col0 = (this.menuIndex - 1) % 2;
      const row0 = Math.floor((this.menuIndex - 1) / 2);
      let col = col0;
      let row = row0;
      if (input.wasPressed("left")) col = Math.max(0, col - 1);
      else if (input.wasPressed("right")) col = Math.min(1, col + 1);
      else if (input.wasPressed("up")) row = Math.max(0, row - 1);
      else if (input.wasPressed("down")) row = Math.min(1, row + 1);
      this.menuIndex = row * 2 + col + 1;
      if (input.wasPressed("a")) {
        const choice = (["fight", "pkmn", "item", "run"] as const)[this.menuIndex - 1];
        if (choice === "fight") {
          // own trapping/Bide or foe Wrap would lock here (:1899-1906);
          // unreachable in v1
          if (!this.playerHasPP()) {
            // _NoMovesLeftText then Struggle (:1907-1911)
            this.say(`${this.player.name} has no\nmoves left!`);
            this.resolveTurn({ id: "STRUGGLE", pp: 1, struggle: true });
            return;
          }
          this.phase = "moveSelect";
          this.moveIndex = Math.min(this.moveIndex, this.player.curMoves.length);
          this.moveSwapIndex = null;
        } else if (choice === "run") {
          this.tryRun();
        } else if (choice === "item") {
          this.openItems();
        } else {
          this.openParty(false);
        }
      }
      return;
    }

    if (this.phase === "moveSelect") {
      const moves = this.player.curMoves;
      if (input.wasPressed("up")) {
        this.moveIndex = this.moveIndex > 1 ? this.moveIndex - 1 : moves.length;
      } else if (input.wasPressed("down")) {
        this.moveIndex = this.moveIndex < moves.length ? this.moveIndex + 1 : 1;
      } else if (input.wasPressed("select")) {
        // SELECT swap (:1940-1946)
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
        } else {
          this.moveSwapIndex = this.moveIndex;
        }
      } else if (input.wasPressed("b")) {
        this.moveSwapIndex = null;
        this.phase = "menu";
      } else if (input.wasPressed("a")) {
        if (this.moveSwapIndex !== null) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = null;
          return;
        }
        const mv = moves[this.moveIndex - 1];
        if (this.player.disabledSlot === this.moveIndex) {
          this.say("The move is\ndisabled!");
          this.phase = "messages";
          this.afterQueue = "menu";
        } else if (mv.pp <= 0) {
          this.say("No PP left for\nthis move!");
          this.phase = "messages";
          this.afterQueue = "menu";
        } else {
          this.resolveTurn(mv);
        }
      }
      return;
    }

    if (this.phase === "party") {
      this.updateParty(input);
      return;
    }
    if (this.phase === "item") {
      this.updateItems(input);
      return;
    }
  }

  /** :1689-1693 clearTurnFlinches. */
  private clearTurnFlinches(): void {
    for (const b of [this.player, this.enemy]) {
      if (b && !b.mustRecharge) b.flinched = false;
    }
  }

  /** :1736-1741 playerHasPP. */
  playerHasPP(): boolean {
    return this.player.curMoves.some(
      (mv, i) => mv.pp > 0 && this.player.disabledSlot !== i + 1,
    );
  }

  /** :1743-1760 swapMoves — curMoves aliases mon.moves, one swap does both. */
  private swapMoves(i: number, j: number): void {
    if (i === j) return;
    const moves = this.player.curMoves;
    const a = moves[i - 1];
    const b = moves[j - 1];
    if (!a || !b) return;
    moves[i - 1] = b;
    moves[j - 1] = a;
    if (this.player.disabledSlot === i) this.player.disabledSlot = j;
    else if (this.player.disabledSlot === j) this.player.disabledSlot = i;
  }

  // -------------------------------------------------------------------
  // turn resolution (:2266-2331)
  // -------------------------------------------------------------------

  /**
   * vanillaEnemyAction (:2275-2289) + TrainerAI.chooseMove (:226-252): a
   * wild enemy picks a UNIFORM RANDOM usable move — under gen1_faithful
   * SelectEnemyMove never consults enemy PP — and Struggles only when every
   * slot is missing or disabled.
   */
  enemyAction(): MoveSlot & { struggle?: boolean } {
    const usable: MoveSlot[] = [];
    this.enemy.curMoves.forEach((mv, i) => {
      if (this.enemy.disabledSlot !== i + 1 && (this.ruleset.enemyUnlimitedPP || mv.pp > 0)) {
        usable.push(mv);
      }
    });
    if (usable.length === 0) return { id: "STRUGGLE", pp: 1, struggle: true };
    return usable[randRange(this.rng, 1, usable.length) - 1];
  }

  /** :2296-2331 resolveTurn. */
  resolveTurn(playerAction: MoveSlot & { struggle?: boolean }): void {
    const enemyAction = this.enemyAction();
    this.turnCount += 1;
    const pMove = this.data.moves[playerAction.id] ?? null;
    const eMove = this.data.moves[enemyAction.id] ?? null;
    const pFirst = firstMover(this.player, pMove, this.enemy, eMove, this.rng);
    const order: [WildBattler, WildBattler, MoveSlot][] = pFirst
      ? [
          [this.player, this.enemy, playerAction],
          [this.enemy, this.player, enemyAction],
        ]
      : [
          [this.enemy, this.player, enemyAction],
          [this.player, this.enemy, playerAction],
        ];
    this.phase = "messages";
    this.afterQueue = "menu";
    for (const [user, target, action] of order) {
      this.act(() => {
        this.executeAction(user, target, action);
      });
    }
    this.act(() => {
      this.endOfTurn();
    });
  }

  // -------------------------------------------------------------------
  // residuals / end of turn (:2367-2462)
  // -------------------------------------------------------------------

  private residualAfterMove(): boolean {
    return this.ruleset.residualAfterMove !== false;
  }

  /** :2380-2399 residualFor — one side, right after its action. */
  residualFor(b: WildBattler, opp: WildBattler): void {
    if (this.result) return;
    if (this.player !== b && this.enemy !== b) return;
    if (b.mon.hp <= 0 || opp.mon.hp <= 0) return;
    const msgs = statusResidual(b, opp);
    for (const m of msgs) this.sayNext(prefixEnemy(m, b));
    if (b.leechSeeded && b.mon.hp > 0) {
      // the drain plays ABSORB from the healing side (:2386-2390)
      this.animNext("ABSORB", opp.isPlayer);
    }
    if (msgs.length > 0) this.drainNext();
    if (b.mon.hp <= 0) this.onFaint(b);
  }

  /** :2403-2407 queueResidual. */
  queueResidual(b: WildBattler, opp: WildBattler): void {
    if (this.residualAfterMove()) {
      this.act(() => this.residualFor(b, opp));
    }
  }

  /** :2409-2462 endOfTurn. */
  endOfTurn(): void {
    if (this.result) return;
    const sweep = !this.residualAfterMove();
    const playerAlive = this.player.mon.hp > 0;
    const enemyAlive = this.enemy.mon.hp > 0;
    const pairs: [WildBattler, WildBattler, boolean][] = [
      [this.player, this.enemy, enemyAlive],
      [this.enemy, this.player, playerAlive],
    ];
    for (const [b, opp, oppAlive] of pairs) {
      if (sweep && b.mon.hp > 0 && oppAlive) {
        const msgs = statusResidual(b, opp);
        for (const m of msgs) this.sayNext(prefixEnemy(m, b));
        if (msgs.length > 0) this.drainNext();
        if (b.mon.hp <= 0) this.onFaint(b);
      }
      b.skipMove = undefined;
      // CheckNumAttacksLeft's end-of-turn trapping release (:2454-2458)
      if (b.trappingTurns !== undefined && b.trappingTurns <= 0) {
        b.trappingTurns = undefined;
      }
    }
    // tickTokens (:2479-2484): side/field token lists are empty in v1
  }

  // -------------------------------------------------------------------
  // move execution (:3134-3544)
  // -------------------------------------------------------------------

  /** :3134-3138 syncShownStatus — HUD status reveal after the action. */
  syncShownStatus(): void {
    for (const b of [this.player, this.enemy]) {
      if (b) b.shownStatus = b.mon.status ?? null;
    }
  }

  /** :3140-3244 executeAction (wild slice: no AI items/switches, and the
   * recharge/bound/trapping/bide specials are unreachable v1 locks). */
  executeAction(
    user: WildBattler,
    target: WildBattler,
    action: (MoveSlot & { struggle?: boolean }) | null,
  ): void {
    if (this.result) return;
    if (user.mon.hp <= 0 || target.mon.hp <= 0) return;
    if (!action) return;

    // held-in-place mirror (:3158-3163)
    user.boundTurns =
      target.trappingTurns !== undefined ? Math.max(1, target.trappingTurns) : undefined;

    if (!this.statusInterrupt(user, target)) {
      this.performMove(user, target, action, false);
    }
    this.actNext(() => this.syncShownStatus());
    if (this.residualAfterMove()) {
      this.actNext(() => this.residualFor(user, target));
    }
  }

  /** :3326-3356 statusInterrupt — Status.beforeMove + the confusion
   * self-hit. The sleep/confusion onomatopoeia anims (:3250-3268) are text
   * only in v1. */
  statusInterrupt(user: WildBattler, target: WildBattler): boolean {
    const res = statusBeforeMove(user, this.rng);
    for (const m of res.messages) this.sayNext(prefixEnemy(m, user));
    if (res.selfHit) {
      // confusion self-hit (core.asm:3428-3434): 40-power typeless against
      // the mon's own defense, with the OPPONENT's screens applying
      const [dmg] = this.computeDamage(
        user,
        user,
        { id: "CONFUSED", power: 40, type: "NORMAL", accuracy: 100 },
        { rng: this.rng, forceCrit: false, typeless: true, screens: target },
      );
      this.sayNext("It hurt itself in\nits confusion!");
      this.clearVolatiles(user, true);
      this.applyDamage(user, dmg);
      if (user.mon.hp <= 0) this.onFaint(user);
      return true;
    }
    if (!res.canMove) {
      const last = res.messages[res.messages.length - 1];
      if (user.mon.status === "PAR" && last && last.includes("fully paralyzed")) {
        this.clearVolatiles(user, false);
      }
      return true;
    }
    return false;
  }

  /** :3362-3371 clearVolatiles. */
  private clearVolatiles(user: WildBattler, selfHit: boolean): void {
    user.trappingTurns = undefined;
    if (selfHit) {
      user.invulnerable = undefined;
      user.flinched = false;
    }
  }

  /** :3383-3395 primaryEffectFailed. */
  private primaryEffectFailed(msgs: EffectMsgs): boolean {
    if (!msgs || msgs.length === 0) return true;
    if (msgs.failed) return true;
    const m = msgs[0].replace(/\s+$/, "");
    if (m === "But, it failed!" || m === "Nothing happened!") return true;
    if (m.includes("didn't affect")) return true;
    if (m.includes("is unaffected")) return true;
    if (m.includes("protected by MIST")) return true;
    if (m.includes("Already")) return true;
    return false;
  }

  /** :3397-3544 performMove. */
  performMove(
    user: WildBattler,
    target: WildBattler,
    moveInst: MoveSlot & { struggle?: boolean },
    isCalled: boolean,
  ): void {
    const move = this.data.moves[moveInst.id];
    if (!move) {
      console.warn(`unknown move instance ${moveInst.id}`);
      return;
    }
    const record = effectRecord(move.effect);

    // PP: not for struggle, called moves, or (gen1_faithful) enemies —
    // DecrementPP only ever mutates the player side (:3411-3429)
    const enemyUnlimited = !user.isPlayer && this.ruleset.enemyUnlimitedPP;
    if (!moveInst.struggle && !isCalled && !enemyUnlimited) {
      moveInst.pp = Math.max(0, moveInst.pp - 1);
    }

    this.moveAnimRow = null;
    this.sayNextAuto(`${displayName(user)}\nused ${move.name}!`);
    if (!(record && record.announceAnim === false)) {
      const row: QueueRow = { anim: move.id, attackerIsPlayer: user.isPlayer };
      this.insertNext(row);
      this.moveAnimRow = row;
    }

    const ctx = makeCtx(this, user, target, move, moveInst, isCalled);

    if (record?.callsMove) {
      const pick = record.callsMove(ctx);
      if (move.id === "MIRROR_MOVE" || !pick) this.cancelMoveAnim();
      if (pick) this.performMove(user, target, { id: pick, pp: 1 }, true);
      return;
    }
    user.lastMove = move.id;

    // charge moves (:3470-3498) — no charge record is registered in v1
    if (record?.charge) {
      this.cancelMoveAnim();
      this.sayNext(`${displayName(user)}\nis charging up!`);
      return;
    }

    if (record?.perform) {
      record.perform(ctx);
      return;
    }

    // pure status moves (:3507-3534)
    if (move.power === 0 && record?.kind === "primary" && record.run) {
      if (
        record.accuracyChecked &&
        (target.invulnerable || !this.accuracyRoll(move, user, target))
      ) {
        this.cancelMoveAnim();
        this.sayNext(`${displayName(user)}'s\nattack missed!`);
        return;
      }
      const msgs = record.run(ctx);
      if (this.primaryEffectFailed(msgs)) {
        this.cancelMoveAnim();
      }
      for (const m of msgs) this.sayNext(m);
      this.drainNext(); // REST/RECOVER would move the user's bar (:3532)
      return;
    }
    if (move.power === 0 && record?.kind !== "full") {
      // unregistered status effect: the reference's own fallback (:3535-3540)
      if (move.effect) warnUnknown(move.effect);
      this.cancelMoveAnim();
      this.sayNext("But, it failed!");
      return;
    }

    runDamaging(this, ctx, record);
  }

  // rules bridge (:2210-2246 accuracyRoll/computeDamage/catchAttempt) ----

  accuracyRoll(move: DamageMove, user: WildBattler, target: WildBattler): boolean {
    return damageAccuracyRoll(this.ruleset, move, user, target, this.rng);
  }

  computeDamage(
    user: WildBattler,
    target: WildBattler,
    move: DamageMove,
    opts: {
      rng: Rng;
      explode?: boolean;
      forceCrit?: boolean;
      typeless?: boolean;
      screens?: WildBattler | null;
    },
  ): [number, DamageInfo] {
    return damageCompute(this.ruleset, this.chart, user, target, move, opts);
  }

  inflictStatus(
    target: WildBattler,
    status: string,
    opts: { toxic?: boolean; moveType?: string; secondary?: boolean; source?: string },
  ): string[] {
    return inflictStatus(this, target, status, opts);
  }

  // -------------------------------------------------------------------
  // damage / faint / exp (:3596-3806)
  // -------------------------------------------------------------------

  /** :3596-3618 applyDamage — returns the amount that counts as dealt. */
  applyDamage(target: WildBattler, dmg: number): number {
    if (target.substituteHP !== undefined) {
      target.substituteHP -= dmg;
      if (target.substituteHP <= 0) {
        target.substituteHP = undefined;
        this.sayNext(`${displayName(target)}'s\nSUBSTITUTE broke!`);
      } else {
        this.sayNext(`The SUBSTITUTE\ntook damage for\n${displayName(target)}!`);
      }
      return dmg;
    }
    const dealt = Math.min(dmg, target.mon.hp);
    target.mon.hp -= dealt;
    if (dealt > 0) this.drainNext(target, target.mon.hp);
    return dealt;
  }

  /** :3624-3689 onFaint. */
  onFaint(battler: WildBattler): void {
    if (battler.faintQueued) return;
    battler.faintQueued = true;
    if (battler.isPlayer) {
      // RemoveFaintedPlayerMon clears the gain-exp flag (:3627-3629)
      this.participants.delete(battler.mon);
    }
    this.actNext(() => {
      battler.fainted = true;
      // faint slide + cry are presentation (:3645-3662) — later rung; the
      // staging layer hides the side's card off the `fainted` flag
    });
    this.insertNext({ wait: FAINT_SLIDE });
    // wild victory music before EnemyMonFaintedText (:3673-3681) — audio out
    this.sayNext(`${displayName(battler)}\nfainted!`);
    if (battler.isPlayer) {
      this.act(() => this.playerMonFainted());
    } else {
      this.act(() => this.enemyMonFainted());
    }
  }

  /** :3694-3806 awardExp — participant split, EXP.ALL passes, level-ups,
   * stat boxes, learnset checks. */
  awardExp(): void {
    let participants = 0;
    const alive: PartyMon[] = [];
    for (const mon of this.save.party) {
      if (this.participants.has(mon)) {
        participants += 1;
        if (mon.hp > 0) alive.push(mon);
      }
    }
    if (participants === 0 && this.player.mon.hp > 0) {
      participants = 1;
      alive.length = 0;
      alive.push(this.player.mon);
    }
    const applyShare = (mon: PartyMon, split: number, announce: true | "expAll") => {
      const [levels, gained] = expApply(
        this.data,
        mon,
        this.enemy.def,
        this.enemy.mon.level,
        false,
        split,
        mon.traded,
      );
      if (levels.length > 0) this.leveledUp.add(mon);
      const name = mon.nickname ?? this.data.pokemon[mon.species].name;
      if (announce === "expAll") {
        this.sayNext(`${name} gained\nwith EXP.ALL,\v${gained} EXP. Points!`);
      } else if (mon.traded) {
        this.sayNext(`${name} gained\na boosted\v${gained} EXP. Points!`);
      } else {
        this.sayNext(`${name} gained\n${gained} EXP. Points!`);
      }
      for (const lv of levels) {
        this.sayNext(`${name} grew\nto level ${lv}!`);
        this.statBoxNext(mon);
        // the HP bar animates UP to the level-up heal (:3755-3765, #224)
        if (mon === this.player.mon) this.drainNext();
        for (const moveId of movesLearnedAt(this.data.pokemon[mon.species], lv)) {
          this.learnMove(mon, moveId);
        }
      }
    };
    // vanillaExpAward (:3776-3797)
    const expAll = (this.save.inventory.EXP_ALL ?? 0) > 0;
    for (const mon of alive) {
      applyShare(mon, participants * (expAll ? 2 : 1), true);
    }
    if (expAll) {
      for (const mon of this.save.party) {
        if (mon.hp > 0) {
          applyShare(mon, Math.max(1, participants) * this.save.party.length * 2, "expAll");
        }
      }
    }
    this.participants = new Set();
  }

  /** :3993-4012 learnMove — auto when a slot is free. DEVIATION (v1): with
   * four moves the replace-move prompt (MoveLearnMenu) is SKIPPED — the mon
   * declines automatically, message only. */
  learnMove(mon: PartyMon, moveId: string): void {
    const mdef = this.data.moves[moveId];
    if (!mdef) return;
    if (mon.moves.some((mv) => mv.id === moveId)) return;
    const name = mon.nickname ?? this.data.pokemon[mon.species].name;
    if (mon.moves.length < 4) {
      mon.moves.push({ id: moveId, pp: mdef.pp });
      this.sayNext(`${name} learned\n${mdef.name}!`);
      return;
    }
    this.sayNext(`${name} is trying to\nlearn ${mdef.name}!`);
    this.sayNext(`${name} did not learn\n${mdef.name}!`);
  }

  /** :3808-3990 enemyMonFainted, wild slice: exp then the win. */
  enemyMonFainted(): void {
    this.awardExp();
    this.result = "win";
    this.afterQueue = "finish";
  }

  /** :4030-4092 playerMonFainted — blackout, or the wild "Use next
   * POKéMON?" dialogue whose NO branch is a run check on party slot 1. */
  playerMonFainted(): void {
    const nextMon = firstHealthy(this.save.party);
    if (!nextMon && this.result !== "lose") {
      // HandlePlayerBlackOut (:4052-4064, #292): darken, then the lines
      this.blackedOut = true;
      this.sayNext(`${this.save.player.name} is out of\nuseable POKéMON!`);
      this.sayNext(`${this.save.player.name} blacked\nout!`);
      this.result = "lose";
      this.afterQueue = "finish";
      return;
    }
    if (this.result) return; // double faint: the battle is decided (:4069)
    this.sayChoice("Use next POKéMON?", (yes) => {
      if (yes) return; // the menu-phase guard opens the party menu (:1856)
      const pSpd = this.save.party[0]?.stats.speed ?? 0;
      if (this.runRoll(pSpd, effectiveSpeed(this.enemy))) {
        this.say("Got away safely!");
        this.result = "run";
        this.afterQueue = "finish";
      } else {
        this.say("Can't escape!");
      }
    });
  }

  // -------------------------------------------------------------------
  // run (:4253-4313)
  // -------------------------------------------------------------------

  /** :4265-4279 runRollVanilla — TryRunningFromBattle. */
  runRoll(pSpd: number, eSpd: number): boolean {
    this.runAttempts += 1;
    if (pSpd >= eSpd) return true;
    const b = Math.floor(eSpd / 4) % 256;
    if (b === 0) return true;
    let x = Math.floor((pSpd * 32) / b);
    x += 30 * (this.runAttempts - 1);
    return x >= 256 || this.rng.byte() <= x;
  }

  /** :4282-4313 tryRun. */
  tryRun(): void {
    this.phase = "messages";
    this.afterQueue = "menu";
    const escaped = this.runRoll(effectiveSpeed(this.player), effectiveSpeed(this.enemy));
    if (escaped) {
      this.say("Got away safely!");
      this.result = "run";
      this.afterQueue = "finish";
    } else {
      this.say("Can't escape!");
      this.act(() => {
        this.executeAction(this.enemy, this.player, this.enemyAction());
      });
      // a failed escape loses the turn but the residual still ticks (:4308)
      this.queueResidual(this.player, this.enemy);
      this.act(() => this.endOfTurn());
    }
  }

  // -------------------------------------------------------------------
  // items / catching (:4315-4575)
  // -------------------------------------------------------------------

  /** :4315-4321 openItems, narrowed to balls (v1: the bag is ball-only). */
  openItems(): void {
    this.itemList = Object.keys(this.save.inventory).filter((id) => {
      if ((this.save.inventory[id] ?? 0) <= 0) return false;
      const def = this.data.items?.[id];
      return def?.ball !== undefined || id.endsWith("_BALL");
    });
    if (this.itemList.length === 0) {
      // v1 stand-in for an empty battle bag; the reference opens the full
      // BagMenu screen (:4318)
      this.say("There are no\nitems to use!");
      this.phase = "messages";
      this.afterQueue = "menu";
      return;
    }
    this.itemIndex = Math.min(this.itemIndex, this.itemList.length - 1);
    this.phase = "item";
  }

  private updateItems(input: BattleInput): void {
    if (input.wasPressed("up")) {
      this.itemIndex = Math.max(0, this.itemIndex - 1);
    } else if (input.wasPressed("down")) {
      this.itemIndex = Math.min(this.itemList.length - 1, this.itemIndex + 1);
    } else if (input.wasPressed("b")) {
      this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const ball = this.itemList[this.itemIndex];
      // UseBagItem consumes the ball (item_effects.asm .done)
      this.save.inventory[ball] = (this.save.inventory[ball] ?? 1) - 1;
      if (this.save.inventory[ball] <= 0) delete this.save.inventory[ball];
      this.phase = "messages";
      this.afterQueue = "menu";
      this.throwBall(ball);
    }
  }

  /** :4342-4352 ballMissMessage — wobble text by shake count. */
  ballMissMessage(shakes: number): string {
    if (shakes === 0) return "You missed the\nPOKéMON!";
    if (shakes === 1) return "Darn! The POKéMON\nbroke free!";
    if (shakes === 2) return "Aww! It appeared\nto be caught!";
    return "Shoot! It was so\nclose too!";
  }

  /** :4447-4464 ballChain — the TossBallAnimation row chain; v1 rows pace
   * the queue (MOVE_ANIM_PRE each) but draw nothing. */
  private ballChain(caught: boolean, shakes: number, ball: string): void {
    this.animNext("TOSS_ANIM", true, undefined, ball);
    this.animNext("POOF_ANIM", true);
    if (!caught && shakes === 0) return;
    this.animNext("HIDEPIC_ANIM", true);
    this.animNext("SHAKE_ANIM", true, shakes);
    if (!caught) {
      this.animNext("POOF_ANIM", true);
      this.animNext("SHOWPIC_ANIM", true);
    }
  }

  /** :4484-4575 throwBall, wild branch (trainer block-ball is out). */
  throwBall(ball: string): void {
    const itemName = this.data.items?.[ball]?.name ?? ball;
    this.sayAuto(`${this.save.player.name} used\n${itemName}!`);
    this.act(() => {
      this.lastBall = ball;
      const [caught, shakes] = catchAttempt(ball, this.enemy.mon, this.enemy.def, this.rng);
      // ItemUseBall's 20-frame beat before the toss chain (:4551-4553)
      this.insertNext({ wait: 20 });
      this.ballChain(caught, shakes, ball);
      if (caught) {
        this.sayNext(`All right!\n${this.enemy.name} was\ncaught!`);
        this.act(() => this.storeCaughtMon());
      } else {
        this.sayNext(this.ballMissMessage(shakes));
        this.act(() => {
          this.executeAction(this.enemy, this.player, this.enemyAction());
        });
        this.queueResidual(this.player, this.enemy);
        this.act(() => this.endOfTurn());
      }
    });
  }

  /** :4387-4440 storeCaughtMon. DEVIATIONS (v1): no pokédex marks, no
   * nickname prompt, and with a full party the mon is NOT stored — the PC
   * transfer text prints and the mon is lost (the box system is a later
   * rung; item_effects.asm:518-566 is the reference flow). */
  storeCaughtMon(): void {
    if (partyAdd(this.save.party, this.enemy.mon)) {
      // joined the party
    } else {
      this.sayNext(`${this.enemy.name} was\ntransferred to\nsomeone's PC!`);
    }
    this.result = "caught";
    this.afterQueue = "finish";
  }

  // -------------------------------------------------------------------
  // party / switching (:2334-2365, :4097-4135, :4577-4594)
  // -------------------------------------------------------------------

  /** :4577-4594 openParty / :4097-4101 openReplacementMenu (forced). */
  openParty(forced: boolean): void {
    this.partyForced = forced;
    this.partyIndex = 0;
    this.phase = "party";
  }

  private updateParty(input: BattleInput): void {
    const party = this.save.party;
    if (input.wasPressed("up")) {
      this.partyIndex = Math.max(0, this.partyIndex - 1);
    } else if (input.wasPressed("down")) {
      this.partyIndex = Math.min(party.length - 1, this.partyIndex + 1);
    } else if (input.wasPressed("b")) {
      // ChooseNextMon loops until a healthy pick (:1856-1865): B only
      // backs out of a VOLUNTARY open
      if (!this.partyForced) this.phase = "menu";
    } else if (input.wasPressed("a")) {
      const mon = party[this.partyIndex];
      if (!mon) return;
      if (this.partyForced) {
        if (mon.hp <= 0) {
          this.say("There's no will\nto fight!");
          this.phase = "messages";
          this.afterQueue = "menu"; // the menu guard reopens the menu
          return;
        }
        this.replaceFainted(mon);
      } else if (mon === this.player.mon) {
        this.say(`${this.player.name} is\nalready out!`);
        this.phase = "messages";
        this.afterQueue = "menu";
      } else if (mon.hp <= 0) {
        this.say("There's no will\nto fight!");
        this.phase = "messages";
        this.afterQueue = "menu";
      } else {
        this.resolveSwitch(mon);
      }
    }
  }

  /** :4106-4134 openReplacementMenu onSwitch — send out with NO free enemy
   * move (ChooseNextMon). */
  private replaceFainted(mon: PartyMon): void {
    this.player = makeBattler(this.data, mon, true, this.save);
    this.markParticipant();
    this.sendOutMonCursors();
    this.nextInsert = 0;
    this.sendingOut = true;
    this.sayNext(this.sendOutText(this.player.name));
    this.animNext("POOF_ANIM", false);
    this.actNext(() => {
      this.sendingOut = false;
    });
    this.phase = "messages";
    this.afterQueue = "menu";
  }

  /** :2334-2365 resolveSwitch — voluntary switch; the enemy gets a free
   * move. */
  resolveSwitch(next: PartyMon): void {
    this.phase = "messages";
    this.afterQueue = "menu";
    this.act(() => {
      this.player = makeBattler(this.data, next, true, this.save);
      // SendOutMon clears the FOE's trapping bit (:2341-2343)
      this.enemy.trappingTurns = undefined;
      this.markParticipant();
      this.sendOutMonCursors();
      this.sendingOut = true;
      this.sayNext(this.sendOutText(this.player.name));
      this.animNext("POOF_ANIM", false);
      this.actNext(() => {
        this.sendingOut = false;
      });
    });
    this.act(() => {
      this.executeAction(this.enemy, this.player, this.enemyAction());
    });
    this.act(() => this.endOfTurn());
  }

  /** :1665-1668 sendOutMonCursors — every player send-out resets both. */
  private sendOutMonCursors(): void {
    this.menuIndex = 1;
    this.moveIndex = 1;
  }

  // -------------------------------------------------------------------
  // finish (:4610-4665)
  // -------------------------------------------------------------------

  finish(): void {
    // the no-healthy-party invariant (:4629-4634)
    if (this.result !== "lose" && !firstHealthy(this.save.party)) {
      console.warn(`battle finished ${this.result} with no healthy party; forcing blackout`);
      this.result = "lose";
    }
    this.finished = this.result ?? "run";
  }

  /** The integer HP the HUD shows (:1006-1010 shownHP). */
  shownHPInt(b: WildBattler): number {
    const shown = b.shownHP ?? b.mon.hp;
    return shown > b.mon.hp ? Math.ceil(shown) : Math.floor(shown);
  }
}
