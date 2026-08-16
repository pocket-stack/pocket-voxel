// The presentation frontend: reads the whole game state once per tick and
// emits voxel-surface ops as DELTAS against what the retained core already
// holds (docs/VOXEL.md §3: per-frame boundary traffic is ~10-40 ops —
// camera + moving entities + a reveal counter; map/ui bursts happen once).
//
// Camera rule ports gen1recomp src/render/Camera.lua: at the 160x144 view,
// camera.x = px - 64, camera.y = py - 64, so the view CENTRE is
// (px + 16, py + 8) — the player sprite at screen tile (8,8). cam() takes
// that centre in Q4.

import { ENT_FLAG, ENTS_MAX, Q4, Q8 } from "../../contracts/spec/voxel-spec.ts";
import type { WildBattle } from "./battle/battle.ts";
import { desiredCards, type BattleStaging } from "./battle/staging.ts";
import type { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { emitPcDesktop, type PcDesktopSource } from "./ui/pc-desktop.ts";
import {
  emitRemoteDesktop,
  REMOTE_VIDEO_PLANE,
  type RemotePcSource,
} from "./ui/remote-desktop.ts";
import { isOutdoor } from "./world/map.ts";
import { computeNeighbors, type Overworld } from "./world/overworld.ts";
import { NPC } from "./world/npc.ts";
import type { Textbox } from "./world/textbox.ts";
import {
  ARROW_CURSOR,
  ARROW_MORE,
  ARROW_X,
  ARROW_Y,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  BOX_TH,
  BOX_TW,
  BOX_TX,
  BOX_TY,
  encodeGlyphs,
  LINE1_Y,
  LINE2_Y,
  MAX_COLS,
  SPACE,
  TEXT_X,
  toCells,
} from "./ui/tiles.ts";

// gen1recomp src/render/SpriteRenderer.lua:85 — the walk-sheet frame order
// (right = mirrored left, DIR order in the spec matches).
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };

export interface UiBoxSource {
  box: Textbox;
}

export interface ChoiceSource {
  labels: readonly string[];
  selected: number;
}

/** The battle state the scene stages and draws (game.ts's battle state). */
export interface BattleSceneView {
  battle: WildBattle;
  staging: BattleStaging | null;
  ui: BattleUi;
}

/** Autopilot-only profiling hook (game.ts owns and reports it; `emit` adds
 * its section sums when present — see game.ts `prof`). */
export interface Prof {
  now(): number;
  line(s: string): void;
  upd: number;
  emit: number;
  aud: number;
  /** emit() section sums, µs: map-slot diff, ents+emote+cam, ui/battle tail. */
  maps: number;
  ents: number;
  ui: number;
}

/** What the scene reads each tick — game.ts satisfies this. */
export interface SceneView {
  data: VoxelmonData;
  overworld: Overworld;
  /** Topmost dialogue box on the state stack, if any. */
  uiBox(): UiBoxSource | null;
  /** Topmost YES/NO choice, if any (drawn over its parent box). */
  uiChoice(): ChoiceSource | null;
  /** Topmost bedroom-PC desktop, if any (screen-space native overlay). */
  pcDesktop(): PcDesktopSource | null;
  /** Topmost remote-PC shell, if any (host video + native overlay chrome). */
  remotePc(): RemotePcSource | null;
  /** The active battle, if any — the scene then stages the arena and hands
   * the GB tile layer to the battle ui. */
  battleView(): BattleSceneView | null;
  /** Autopilot-only profiling hook; undefined in production and in the sim. */
  prof?: Prof;
}

interface UiRowCache {
  /** The ShownLine this row was built from. Its identity pins its text —
   * textbox.ts assigns `text` once at construction and mutates only
   * `revealed` — so an identity hit skips the per-tick pad rebuild AND the
   * `encodeGlyphs` lookup that used to run every frame a box was open. */
  line: unknown;
  wasLast: boolean;
  text: string;
  revealed: number;
}

export class Scene {
  private host: VoxelHost;
  private started = false;
  // Delta-gate state. The GATES are numeric or identity-based on purpose:
  // this emit runs under QuickJS on a 333 MHz part, where the earlier
  // rebuild-a-string-key-per-tick gates measured 15+ ms a frame (2026-08-06
  // device profile). Every replacement below preserves the exact op-emit
  // condition — a key was always a pure injective function of the numbers
  // now compared directly.
  private lastCamX = Number.NaN;
  private lastCamY = Number.NaN;
  private lastPalette: number | null = null;
  /** The GameMap emitMaps last ran against: transitions replace the map
   * object (overworld.ts), so identity is the change signal, and the
   * neighbor BFS + slot keys — once ~7 ms EVERY tick — run only then. */
  private lastMap: unknown = null;
  private mapSlots: (string | null)[] = [null, null, null, null, null];
  /** Per-slot ent-op args (6 ints each) + shown flags: the numeric mirror
   * of the old per-tick `${...}` key strings. `entSeen` is the per-tick
   * mark for the hide sweep. */
  private entVals = new Int32Array(ENTS_MAX * 6);
  private entShown = new Uint8Array(ENTS_MAX);
  private entSeen = new Uint8Array(ENTS_MAX);
  /** spriteId -> atlas page: the answer is boot-static, the regex +
   * toLowerCase that computed it ran per entity per tick. */
  private sheetCache = new Map<string, number>();
  private lastEmote: { slot: number; kind: number } | null = null;
  private uiOwner: UiBoxSource | null = null;
  private uiRows: UiRowCache[] = [];
  private uiPage = -1;
  private uiArrow = false;
  private choiceDrawn = false;
  private choiceSelected = 0;
  private choiceLabels = "";
  private choiceX = 0;
  private choiceY = 0;
  private choiceW = 0;
  private choiceH = 0;
  private pcOwner: PcDesktopSource | null = null;
  private pcRevision = -1;
  private remoteOwner: RemotePcSource | null = null;
  private remoteRevision = -1;
  // battle staging deltas (docs/VOXEL.md §4 battle ops)
  private battleActive = false;
  private arenaStaged = false;
  private cardShown = new Map<number, string>();

  constructor(host: VoxelHost) {
    this.host = host;
  }

  emit(view: SceneView): void {
    const host = this.host;
    if (!this.started) {
      this.started = true;
      // pitch rung 2 at boot (docs/VOXEL.md §10 scope; PITCH_RUNGS[2] = 35°)
      host.pitch(2);
    }
    const p = view.prof;
    const t0 = p ? p.now() : 0;
    this.emitMaps(view);
    const t1 = p ? p.now() : 0;
    this.emitCam(view);
    this.emitEnts(view);
    this.emitEmote(view);
    const t2 = p ? p.now() : 0;
    if (p) {
      p.maps += t1 - t0;
      p.ents += t2 - t1;
    }
    const bv = view.battleView();
    if (bv) {
      this.emitBattle(view, bv);
      if (p) p.ui += p.now() - t2;
      return;
    }
    if (this.battleActive) {
      this.endBattle();
    }
    this.emitUi(view);
    this.emitPcOverlay(view);
    if (p) p.ui += p.now() - t2;
  }

  // battle — arena/card/battleCam on entry, cardHide/arenaEnd on exit; the
  // GB tile layer is handed to the battle ui (battle/ui.ts) while a battle
  // is up. Nothing moves the player: the camera goes to the arena.
  private emitBattle(view: SceneView, bv: BattleSceneView): void {
    const host = this.host;
    if (!this.battleActive) {
      this.battleActive = true;
      // drop the overworld ui program; the battle ui repaints from uiClear
      this.uiOwner = null;
      this.uiRows = [];
      this.uiPage = -1;
      this.uiArrow = false;
      this.choiceDrawn = false;
      if (bv.staging) {
        const a = bv.staging.arena;
        host.arena(bv.staging.mapIndex, a.x, a.y, a.shape, bv.staging.rig);
        // battleCam defaults: orbit 0, pitch 0, zoom 1.0 (Q8); the solved
        // rig constants live core-side, keyed by the arena op's rig arg
        host.battleCam(0, 0, Q8);
        this.arenaStaged = true;
      }
    }
    const desired = bv.staging ? desiredCards(view.data, bv.battle, bv.staging) : [];
    const seen = new Set<number>();
    for (const c of desired) {
      seen.add(c.side);
      const key = `${c.pic},${c.x},${c.y}`;
      if (this.cardShown.get(c.side) !== key) {
        host.card(c.side, c.pic, c.x, c.y);
        this.cardShown.set(c.side, key);
      }
    }
    for (const side of [...this.cardShown.keys()]) {
      if (!seen.has(side)) {
        host.cardHide(side);
        this.cardShown.delete(side);
      }
    }
    bv.ui.emit(host, bv.battle);
  }

  private endBattle(): void {
    const host = this.host;
    for (const side of [...this.cardShown.keys()]) {
      host.cardHide(side);
    }
    this.cardShown.clear();
    if (this.arenaStaged) {
      host.arenaEnd();
      this.arenaStaged = false;
    }
    host.uiClear();
    this.battleActive = false;
  }

  // world — slot 0 current, 1..4 the directly connected neighbours at their
  // seam offsets (computeNeighbors hops=1; offsets in world px).
  private emitMaps(view: SceneView): void {
    const ow = view.overworld;
    // Everything below is a pure function of the current GameMap, and a
    // transition replaces that object — so an identity hit means the exact
    // keys the body would rebuild are the ones it built last time, and the
    // slot diff would emit nothing. Re-entering the same map id makes a new
    // object; the body re-runs and the slot keys still gate the ops.
    if (ow.map === this.lastMap) return;
    this.lastMap = ow.map;
    const maps = view.data.maps!;
    const desired: ({ id: string; index: number; ox: number; oy: number } | null)[] = [
      { id: ow.map.id, index: ow.map.def.index, ox: 0, oy: 0 },
    ];
    for (const n of computeNeighbors(maps, ow.map.id, 1).slice(0, 4)) {
      // Un-cooked neighbours stay unseen: the pak has nothing to draw for
      // them, and the crossing guard (overworld.ts) already walls them off.
      if (view.data.cookedMaps && !view.data.cookedMaps.includes(n.id)) continue;
      desired.push({ id: n.id, index: maps[n.id].index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0; slot < 5; slot++) {
      const want = desired[slot] ?? null;
      const key = want ? `${want.id}@${want.ox},${want.oy}` : null;
      if (key === this.mapSlots[slot]) continue;
      if (want) {
        this.host.mapShow(slot, want.index, want.ox, want.oy);
      } else {
        this.host.mapHide(slot);
      }
      this.mapSlots[slot] = key;
    }
    // VoxelScene.skyColor/skyFor: an interior has no sky. This is retained
    // map state, so one op rides the same map-identity burst as mapShow and
    // the unchanged-map fast path above emits nothing on later ticks.
    this.host.sky(isOutdoor(ow.map.def) ? 1 : 0);
    // The current map's SGB palette (gamedata mapPalette — the cooker's
    // port of SetPal_Overworld), delta-emitted like the slots above: one
    // palette op whenever the slot-0 map changes it. -1 = grayscale ramp.
    const want = view.data.mapPalette?.[ow.map.id] ?? -1;
    if (want !== this.lastPalette) {
      this.host.palette(want);
      this.lastPalette = want;
    }
  }

  private emitCam(view: SceneView): void {
    const p = view.overworld.player;
    // Camera.lua follow at the 160x144 view: centre = (px + 16, py + 8)
    const cx = (p.px + 16) * Q4;
    const cy = (p.py + 8) * Q4;
    if (cx !== this.lastCamX || cy !== this.lastCamY) {
      this.host.cam(cx, cy);
      this.lastCamX = cx;
      this.lastCamY = cy;
    }
  }

  private sheetIndex(view: SceneView, spriteId: string): number {
    const hit = this.sheetCache.get(spriteId);
    if (hit !== undefined) return hit;
    // The ent op carries the pak's ABSOLUTE atlas page (core page_at):
    // resolve SPRITE_RED -> atlas.sprites["red"] through the cooked page
    // map. The ROM spriteOrder index is NOT a page index — sending it bound
    // the player to page 0 (the terrain atlas: a card wearing tree art).
    const atlas = (view.data as { atlas?: { sprites?: Record<string, number> } }).atlas;
    const name = spriteId.replace(/^SPRITE_/, "").toLowerCase();
    const page = atlas?.sprites?.[name];
    const index = typeof page === "number" ? page : -1; // -1: core skips the card
    this.sheetCache.set(spriteId, index);
    return index;
  }

  /** Emit one ent op iff any of its six (integer) args changed — the exact
   * condition the old per-tick `${...}` key string tested, minus the six
   * int→string coercions and the allocation. */
  private emitSlot(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void {
    const b = slot * 6;
    const v = this.entVals;
    this.entSeen[slot] = 1;
    if (
      this.entShown[slot] !== 0 &&
      v[b] === sheet &&
      v[b + 1] === frame &&
      v[b + 2] === x &&
      v[b + 3] === y &&
      v[b + 4] === lift &&
      v[b + 5] === flags
    ) {
      return;
    }
    this.host.ent(slot, sheet, frame, x, y, lift, flags);
    v[b] = sheet;
    v[b + 1] = frame;
    v[b + 2] = x;
    v[b + 3] = y;
    v[b + 4] = lift;
    v[b + 5] = flags;
    this.entShown[slot] = 1;
  }

  private emitEnts(view: SceneView): void {
    const ow = view.overworld;
    this.entSeen.fill(0);
    // player: slot 0, ghost silhouette + grass-occluded walker
    const p = ow.player;
    {
      const phase = p.walkPhase();
      const frame = phase === 1 ? WALK[p.facing] : STAND[p.facing];
      // SpriteRenderer.lua:189-193 flip: right-facing mirrors; alternate
      // up/down walk cycles mirror via the fixed-rate animClock
      const mirror =
        p.facing === "right" ||
        ((p.facing === "down" || p.facing === "up") && phase === 1 && p.animFlip());
      let flags = ENT_FLAG.ghost | ENT_FLAG.walker;
      if (mirror) flags |= ENT_FLAG.mirror;
      this.emitSlot(
        0,
        this.sheetIndex(view, "SPRITE_RED"),
        frame,
        p.px * Q4,
        p.py * Q4,
        ow.map.groundAt(p.cellX, p.cellY) + p.hopLift(),
        flags,
      );
    }
    const npcs = ow.npcs;
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i]!;
      const slot = i + 1;
      if (slot >= ENTS_MAX) break;
      const def = view.data.sprites?.[npc.def.sprite];
      const frames = def?.frames ?? 6;
      const phase = npc.walkPhase();
      // single-frame sprites (item balls) have one fixed pose
      // (SpriteRenderer.lua:183)
      const frame =
        frames <= 1 ? 0 : phase === 1 && def?.walker ? WALK[npc.facing] : STAND[npc.facing];
      const mirror =
        frames > 1 &&
        (npc.facing === "right" ||
          ((npc.facing === "down" || npc.facing === "up") && phase === 1 && npc.stepFlip));
      let flags = def?.walker ? ENT_FLAG.walker : 0;
      if (mirror) flags |= ENT_FLAG.mirror;
      this.emitSlot(
        slot,
        this.sheetIndex(view, npc.def.sprite),
        frame,
        npc.px * Q4,
        npc.py * Q4,
        ow.map.groundAt(npc.cellX, npc.cellY),
        flags,
      );
    }
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (this.entSeen[slot] === 0 && this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
  }

  private emitEmote(view: SceneView): void {
    const ow = view.overworld;
    const e = ow.emote;
    if (e) {
      const slot = e.entity === ow.player ? 0 : ow.npcs.indexOf(e.entity as NPC) + 1;
      if (!this.lastEmote || this.lastEmote.slot !== slot || this.lastEmote.kind !== e.kind) {
        this.host.emote(slot, e.kind);
        this.lastEmote = { slot, kind: e.kind };
      }
    } else if (this.lastEmote) {
      this.host.emote(this.lastEmote.slot, 0);
      this.lastEmote = null;
    }
  }

  /** Static label into the retained grid, glyph by glyph (tile id == code). */
  private stamp(host: VoxelHost, x: number, y: number, s: string): void {
    const codes = encodeGlyphs(s);
    for (let i = 0; i < codes.length; i++) host.uiTile(x + i, y, codes[i]!);
  }

  // ui — the dialogue box as a retained tile-layer program: border once on
  // open, uiText for the row that is typing, uiReveal as the typewriter
  // advances (the reveal counter applies to the LAST uiText — voxel-spec),
  // and every finished row stamped into the grid.
  private emitUi(view: SceneView): void {
    const host = this.host;
    const owner = view.uiBox();
    const choice = view.uiChoice();
    if (!owner) {
      if (this.uiOwner) {
        host.uiClear();
        this.uiOwner = null;
        this.uiRows = [];
        this.uiPage = -1;
        this.uiArrow = false;
        this.choiceDrawn = false;
      }
      return;
    }
    const box = owner.box;
    let textsEmitted = false;
    if (owner !== this.uiOwner) {
      // fresh box: border + white interior (Font.lua:407 drawBox as tiles)
      if (this.uiOwner) host.uiClear();
      this.uiOwner = owner;
      this.uiRows = [];
      this.uiPage = box.pageIndex;
      this.uiArrow = false;
      this.choiceDrawn = false;
      host.uiTile(BOX_TX, BOX_TY, BORDER_TL);
      host.uiFill(BOX_TX + 1, BOX_TY, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY, BORDER_TR);
      host.uiFill(BOX_TX, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiFill(BOX_TX + BOX_TW - 1, BOX_TY + 1, 1, BOX_TH - 2, BORDER_V);
      host.uiTile(BOX_TX, BOX_TY + BOX_TH - 1, BORDER_BL);
      host.uiFill(BOX_TX + 1, BOX_TY + BOX_TH - 1, BOX_TW - 2, 1, BORDER_H);
      host.uiTile(BOX_TX + BOX_TW - 1, BOX_TY + BOX_TH - 1, BORDER_BR);
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
    } else if (box.pageIndex !== this.uiPage) {
      // page advance: ClearScreenArea (TextBox.lua:295-301) as one fill
      host.uiFill(BOX_TX + 1, BOX_TY + 1, BOX_TW - 2, BOX_TH - 2, SPACE);
      this.uiRows = [];
      this.uiPage = box.pageIndex;
    }
    // rows: shown[0] at LINE1_Y, shown[1] at LINE2_Y. TextBox.lua:370 draws
    // EVERY retained line every frame, but `uiText` is the ONE live
    // typewriter run and the core keeps only the last (voxel-spec §ui), so a
    // finished row has to be stamped into the retained tile grid or it
    // disappears the moment the next line begins typing. Glyph codes ARE ui
    // tile ids under the GB convention, so the stamp is the encode.
    for (let i = 0; i < box.shown.length; i++) {
      const line = box.shown[i]!;
      const isLast = i === box.shown.length - 1;
      const y = i === 0 ? LINE1_Y : LINE2_Y;
      const cached = this.uiRows[i];
      // Identity hit: same ShownLine in the same role emits the same ops by
      // construction, so the encode + full-string compare (once EVERY tick a
      // box was open) both skip.
      if (cached && cached.line === line && cached.wasLast === isLast) {
        continue;
      }
      if (!isLast) {
        const codes = encodeGlyphs(line.text);
        for (let c = 0; c < codes.length; c++) host.uiTile(TEXT_X + c, y, codes[c]!);
        // a scroll must clear whatever the row above used to carry
        if (codes.length < MAX_COLS) {
          host.uiFill(TEXT_X + codes.length, y, MAX_COLS - codes.length, 1, SPACE);
        }
        this.uiRows[i] = { line, wasLast: isLast, text: line.text, revealed: -1 };
        continue;
      }
      const text = toCells(line.text);
      if (!cached || cached.text !== text) {
        host.uiText(TEXT_X, y, text);
        this.uiRows[i] = { line, wasLast: isLast, text, revealed: -1 };
        textsEmitted = true;
      } else {
        // Same text as the row already typing (a scrolled-in twin): the op
        // stream stays silent exactly as before — only the identity re-pins.
        cached.line = line;
        cached.wasLast = isLast;
      }
    }
    this.uiRows.length = box.shown.length;
    // reveal counter for the last row (fresh uiTexts re-target it)
    const last = box.shown[box.shown.length - 1];
    if (last) {
      const cached = this.uiRows[box.shown.length - 1];
      if (textsEmitted || cached.revealed !== last.revealed) {
        host.uiReveal(last.revealed);
        cached.revealed = last.revealed;
      }
    }
    // blinking ▼ (TextBox.lua:381; pokered prints at hlcoord 18,16)
    const arrow = box.arrowVisible() && !choice;
    if (arrow !== this.uiArrow) {
      if (arrow) {
        host.uiTile(ARROW_X, ARROW_Y, ARROW_MORE);
      } else {
        // restore what the second text row has under the arrow cell
        const under = box.shown[1];
        const codes = under ? encodeGlyphs(under.text) : [];
        const idx = ARROW_X - TEXT_X;
        const glyph = under && codes.length > idx && under.revealed > idx ? codes[idx] : SPACE;
        host.uiTile(ARROW_X, ARROW_Y, glyph);
      }
      this.uiArrow = arrow;
    }
    // Choice window over the still-visible text (Commands.lua ask -> TextBox
    // opts.choice). YES/NO remains byte-for-byte the old 6x5 window; callers
    // may supply wider labels such as LOCAL PC / REMOTE PC.
    if (choice) {
      const labels = choice.labels.slice(0, 4);
      const labelsKey = labels.join("\u0000");
      const cw = Math.min(20, Math.max(...labels.map((s) => encodeGlyphs(s).length)) + 3);
      const ch = labels.length * 2 + 1;
      const cx = 20 - cw;
      const cy = 7;
      if (!this.choiceDrawn || labelsKey !== this.choiceLabels) {
        if (this.choiceDrawn) {
          host.uiFill(this.choiceX, this.choiceY, this.choiceW, this.choiceH, 0);
        }
        this.choiceDrawn = true;
        this.choiceSelected = choice.selected;
        this.choiceLabels = labelsKey;
        this.choiceX = cx;
        this.choiceY = cy;
        this.choiceW = cw;
        this.choiceH = ch;
        host.uiTile(cx, cy, BORDER_TL);
        host.uiFill(cx + 1, cy, cw - 2, 1, BORDER_H);
        host.uiTile(cx + cw - 1, cy, BORDER_TR);
        host.uiFill(cx, cy + 1, 1, ch - 2, BORDER_V);
        host.uiFill(cx + cw - 1, cy + 1, 1, ch - 2, BORDER_V);
        host.uiTile(cx, cy + ch - 1, BORDER_BL);
        host.uiFill(cx + 1, cy + ch - 1, cw - 2, 1, BORDER_H);
        host.uiTile(cx + cw - 1, cy + ch - 1, BORDER_BR);
        host.uiFill(cx + 1, cy + 1, cw - 2, ch - 2, SPACE);
        // static labels go into the grid, never through uiText (voxel-spec
        // §ui): a uiText here would take the live run away from the dialogue
        // row typing underneath it
        labels.forEach((text, i) => this.stamp(host, cx + 2, cy + 1 + i * 2, text));
        host.uiTile(cx + 1, cy + 1 + choice.selected * 2, ARROW_CURSOR);
      } else if (choice.selected !== this.choiceSelected) {
        host.uiTile(cx + 1, cy + 1 + this.choiceSelected * 2, SPACE);
        this.choiceSelected = choice.selected;
        host.uiTile(cx + 1, cy + 1 + choice.selected * 2, ARROW_CURSOR);
      }
    } else if (this.choiceDrawn) {
      // the parent box usually pops with the choice; clear just the window
      // in case it lingers (tile 0 = unset)
      host.uiFill(this.choiceX, this.choiceY, this.choiceW, this.choiceH, 0);
      this.choiceDrawn = false;
      this.choiceLabels = "";
    }
  }

  private emitPcOverlay(view: SceneView): void {
    const remote = view.remotePc();
    if (remote) {
      this.pcOwner = null;
      this.pcRevision = -1;
      if (remote === this.remoteOwner && remote.revision === this.remoteRevision) return;
      this.host.uiOverlayClear();
      this.host.remotePlane(
        REMOTE_VIDEO_PLANE.x,
        REMOTE_VIDEO_PLANE.y,
        REMOTE_VIDEO_PLANE.w,
        REMOTE_VIDEO_PLANE.h,
      );
      emitRemoteDesktop(this.host, remote);
      this.remoteOwner = remote;
      this.remoteRevision = remote.revision;
      return;
    }
    if (this.remoteOwner) {
      this.host.remotePlane(0, 0, 0, 0);
      this.host.uiOverlayClear();
      this.remoteOwner = null;
      this.remoteRevision = -1;
    }

    const source = view.pcDesktop();
    if (!source) {
      if (this.pcOwner) {
        this.host.uiOverlayClear();
        this.pcOwner = null;
        this.pcRevision = -1;
      }
      return;
    }
    if (source === this.pcOwner && source.revision === this.pcRevision) return;
    this.host.uiOverlayClear();
    emitPcDesktop(this.host, source);
    this.pcOwner = source;
    this.pcRevision = source.revision;
  }
}
