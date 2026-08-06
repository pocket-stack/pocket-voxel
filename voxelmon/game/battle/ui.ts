// The classic 160x144 battle screen as a retained tile-layer program:
// gen1recomp src/battle/BattleState.lua drawClassic (:5631) / drawHUDs
// (:5368) / drawTextArea (:5497) re-expressed as voxel ui ops (uiTile /
// uiFill / uiText / uiReveal), delta-emitted against what the core retains.
// A layout-mode change repaints from a uiClear (menu opens burst a few
// hundred ops once — docs/VOXEL.md §3); within a mode only the moving parts
// (bar cells, digits, reveal counter, cursors, the blinking ▼) cross.
//
// HUD tile codes are the GB battle overlay's OWN codes (src/render/
// HudTiles.lua + pokered's charmap space $62-$7F): in battle the HP-bar and
// HUD-line sheets overlay the font_extra page (font_battle_extra -> $62,
// battle_hud_1 -> $6D, battle_hud_2 -> $73, battle_hud_3 -> $76 —
// HudTiles.lua:20-29), so uiTile ids stay the GB VRAM convention
// (SCHEMA.md) and the cooker must satisfy this mapping for the battle
// overlay exactly as it does for the borders.

import type { VoxelHost } from "../host.ts";
import {
  ARROW_CURSOR,
  ARROW_HOLLOW,
  ARROW_MORE,
  BORDER_BL,
  BORDER_BR,
  BORDER_H,
  BORDER_TL,
  BORDER_TR,
  BORDER_V,
  MAX_COLS,
  SPACE,
  encodeGlyphs,
} from "../ui/tiles.ts";
import { HP_BAR_PIXELS, hpBarPixels } from "../rules/timing.ts";
import type { WildBattle } from "./battle.ts";
import type { WildBattler } from "./battler.ts";

// ---------------------------------------------------------------------------
// The battle overlay's tile codes (HudTiles.lua drawHPBar :144-174,
// capTile :119-121; BattleState.lua drawHUDs hudTile sites :5401-5493).
// ---------------------------------------------------------------------------

export const HUD_HP_LABEL = 0x71; // "HP" pair-glyph (drawHPBar :147)
export const HUD_BAR_LEFT = 0x62; // ":[" bar opener (:148)
export const HUD_BAR_EMPTY = 0x63; // +n = n-pixel partial fill (:171)
export const HUD_BAR_FULL = 0x6b; // full 8px segment (:171)
export const HUD_CAP_NUB = 0x6c; // enemy/party right cap (capTile)
export const HUD_CAP_DOUBLE = 0x6d; // player's in-battle right cap (type 1)
export const HUD_LV = 0x6e; // <LV> glyph (drawHUDs :5401)
export const HUD_TICK = 0x73; // vertical tick (PlaceEnemyHUDTiles $73)
export const HUD_EDGE_L = 0x74; // enemy underline left ($74)
export const HUD_LINE = 0x76; // underline run ($76)
export const HUD_EDGE_DOWN = 0x77; // player underline right ($77)
export const HUD_EDGE_R = 0x78; // enemy underline right ($78)
export const HUD_HALF_ARROW = 0x6f; // player underline left ($6F)
export const GLYPH_PK = 0xe1; // <PK> (charmap.asm $E1)
export const GLYPH_MN = 0xe2; // <MN> ($E2)

/** HP bar segments (the bar is 6 tiles = 48 px, HP_BAR_PIXELS). */
export const HP_BAR_SEGMENTS = HP_BAR_PIXELS / 8;

/**
 * The 9 tile codes of one HP bar row: "HP" + ":[" + six segment tiles +
 * the barType cap (HudTiles.drawHPBar; pixel math = Timing.hpBarPixels —
 * a nonzero HP always shows at least a one-pixel sliver).
 */
export function hpBarTiles(hp: number, maxHP: number, playerSide: boolean): number[] {
  const px = hpBarPixels(hp, maxHP);
  const out = [HUD_HP_LABEL, HUD_BAR_LEFT];
  for (let i = 0; i < HP_BAR_SEGMENTS; i++) {
    const seg = Math.min(8, Math.max(0, px - i * 8));
    out.push(seg >= 8 ? HUD_BAR_FULL : HUD_BAR_EMPTY + seg);
  }
  out.push(playerSide ? HUD_CAP_DOUBLE : HUD_CAP_NUB);
  return out;
}

/** CenterMonName (:4677-4683): 1-2 glyph names sit two tiles right, 3-4 one. */
export function nameTileX(tx: number, name: string): number {
  const n = encodeGlyphs(name).length;
  return tx + (n <= 2 ? 2 : n <= 4 ? 1 : 0);
}

// battle message rows: hlcoord *,14 / *,16 (drawTextArea :5515), col 1
const MSG_X = 1;
const MSG_ROWS = [14, 16] as const;
// the blinking ▼ cell — home/text.asm PromptText writes (18,16)
const ARROW_X = 18;
const ARROW_Y = 16;

interface MsgRowCache {
  text: string;
  revealed: number;
}

export class BattleUi {
  private mode: string | null = null;
  private msgRows: MsgRowCache[] = [];
  private msgVisible = false;
  private arrowShown = false;
  private enemyBar: number[] | null = null;
  private playerBar: number[] | null = null;
  private playerDigits: string | null = null;
  private enemyLevel: string | null = null;
  private playerLevel: string | null = null;
  private cursorCell: [number, number] | null = null;
  private swapCell: [number, number] | null = null;
  private choiceYes = true;
  private chromeTextDirty = false;

  /** Full repaint + delta emit for this tick. Call once per tick while the
   * battle is the visible screen. */
  emit(host: VoxelHost, battle: WildBattle): void {
    const enemyHud = this.enemyHudVisible(battle);
    const playerHud = this.playerHudVisible(battle);
    const mode = [
      battle.phase,
      enemyHud ? 1 : 0,
      playerHud ? 1 : 0,
      battle.choiceOpen ? 1 : 0,
      battle.statBoxMon ? 1 : 0,
      battle.phase === "party" ? battle.save.party.length : 0,
      battle.phase === "item" ? battle.itemList.length : 0,
    ].join("|");
    this.chromeTextDirty = false;
    if (mode !== this.mode) {
      this.mode = mode;
      this.repaint(host, battle, enemyHud, playerHud);
    } else {
      this.deltas(host, battle, enemyHud, playerHud);
    }
    this.emitMessage(host, battle);
  }

  /** Reset so the next emit repaints from scratch (battle start/end). */
  reset(): void {
    this.mode = null;
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;
  }

  // -----------------------------------------------------------------
  // visibility windows (drawHUDs :5386-5390, :5472-5474)
  // -----------------------------------------------------------------

  private enemyHudVisible(battle: WildBattle): boolean {
    // wild intro: DrawEnemyHUDAndHPBar runs only after the intro text is
    // dismissed (#317); the HUD clears again when the mon faints
    return !!battle.enemy && !battle.introBalls && !battle.enemy.fainted;
  }

  private playerHudVisible(battle: WildBattle): boolean {
    return !!battle.player && !battle.showPlayerBack && !battle.sendingOut;
  }

  // -----------------------------------------------------------------
  // chrome painters
  // -----------------------------------------------------------------

  /** Font.drawBox as tiles (the DEFAULT_BORDER family, ui/tiles.ts). */
  private box(host: VoxelHost, x: number, y: number, w: number, h: number): void {
    host.uiTile(x, y, BORDER_TL);
    host.uiFill(x + 1, y, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y, BORDER_TR);
    host.uiFill(x, y + 1, 1, h - 2, BORDER_V);
    host.uiFill(x + w - 1, y + 1, 1, h - 2, BORDER_V);
    host.uiTile(x, y + h - 1, BORDER_BL);
    host.uiFill(x + 1, y + h - 1, w - 2, 1, BORDER_H);
    host.uiTile(x + w - 1, y + h - 1, BORDER_BR);
    host.uiFill(x + 1, y + 1, w - 2, h - 2, SPACE);
  }

  private text(host: VoxelHost, x: number, y: number, s: string): void {
    // Static chrome goes into the tile grid glyph-by-glyph: uiText is the
    // ONE live typewriter run (the core retains only the last, gated by
    // uiReveal), so labels routed through it vanish when the next message
    // arrives — glyph codes ARE ui tile ids under the GB convention.
    const glyphs = encodeGlyphs(s);
    for (let i = 0; i < glyphs.length; i++) host.uiTile(x + i, y, glyphs[i]);
    this.chromeTextDirty = true;
  }

  private repaint(host: VoxelHost, battle: WildBattle, enemyHud: boolean, playerHud: boolean): void {
    host.uiClear();
    this.msgRows = [];
    this.msgVisible = false;
    this.arrowShown = false;
    this.enemyBar = null;
    this.playerBar = null;
    this.playerDigits = null;
    this.enemyLevel = null;
    this.playerLevel = null;
    this.cursorCell = null;
    this.swapCell = null;

    // the text box spans the screen bottom for the whole battle
    // (drawTextArea :5498 Font.drawBox(0,12,20,6))
    this.box(host, 0, 12, 20, 6);

    if (enemyHud) this.paintEnemyHud(host, battle);
    if (playerHud && battle.phase !== "moveSelect") this.paintPlayerHud(host, battle);

    if (battle.phase === "menu") {
      // BATTLE_MENU_TEMPLATE: box (8,12) 12x6, "FIGHT <PK><MN> / ITEM RUN"
      // from (10,14), cursor columns 9/15 (:5553-5559)
      this.box(host, 8, 12, 12, 6);
      this.text(host, 10, 14, "FIGHT");
      host.uiTile(16, 14, GLYPH_PK);
      host.uiTile(17, 14, GLYPH_MN);
      this.text(host, 10, 16, "ITEM");
      this.text(host, 16, 16, "RUN");
      this.paintMenuCursor(host, battle);
    } else if (battle.phase === "moveSelect") {
      // MoveSelectionMenu: move box (4,12) 16x6, TYPE/PP box (0,8) 11x5,
      // the two border-merge cells, names at column 6 (:5561-5611)
      this.box(host, 0, 8, 11, 5);
      this.box(host, 4, 12, 16, 6);
      host.uiTile(4, 12, BORDER_H);
      host.uiTile(10, 12, BORDER_BR);
      battle.player.curMoves.forEach((mv, i) => {
        const def = battle.data.moves[mv.id];
        this.text(host, 6, 13 + i, def?.name ?? mv.id);
      });
      this.text(host, 1, 9, "TYPE/");
      const sel = battle.player.curMoves[battle.moveIndex - 1];
      const selDef = sel ? battle.data.moves[sel.id] : undefined;
      if (selDef) {
        this.text(host, 2, 10, battle.chart.displayName(selDef.type));
        const maxPP = selDef.pp + (sel.ppUps ?? 0) * Math.floor(selDef.pp / 5);
        this.text(host, 5, 11, `${String(sel.pp).padStart(2)}/${String(maxPP).padStart(2)}`);
      }
      this.paintMoveCursor(host, battle);
    } else if (battle.phase === "party") {
      // v1 stand-in for the PartyMenu screen (the reference pushes a full
      // screen; ChooseNextMon :4097): name/level/HP rows + cursor
      const party = battle.save.party;
      this.box(host, 0, 0, 20, Math.max(4, 2 + party.length * 2));
      party.forEach((mon, i) => {
        const name = mon.nickname ?? battle.data.pokemon[mon.species].name;
        this.text(host, 2, 1 + i * 2, name);
        this.text(
          host,
          12,
          1 + i * 2,
          `L${String(mon.level).padStart(2)} ${String(mon.hp).padStart(3)}/${String(mon.stats.hp).padStart(3)}`,
        );
      });
      host.uiTile(1, 1 + (battle.partyIndex ?? 0) * 2, ARROW_CURSOR);
      this.cursorCell = [1, 1 + (battle.partyIndex ?? 0) * 2];
    } else if (battle.phase === "item") {
      // v1 stand-in for the battle BagMenu (balls only)
      const list = battle.itemList;
      this.box(host, 4, 2, 16, Math.max(4, 2 + list.length * 2));
      list.forEach((id, i) => {
        const name = battle.data.items?.[id]?.name ?? id;
        this.text(host, 6, 3 + i * 2, name);
        this.text(host, 15, 3 + i * 2, `x${String(battle.save.inventory[id] ?? 0).padStart(2)}`);
      });
      host.uiTile(5, 3 + battle.itemIndex * 2, ARROW_CURSOR);
      this.cursorCell = [5, 3 + battle.itemIndex * 2];
    }

    // the level-up stat window (PrintStatsBox: box (9,2) 11x10, :400-431)
    if (battle.statBoxMon) {
      this.box(host, 9, 2, 11, 10);
      const s = battle.statBoxMon.stats;
      const rows: [string, number][] = [
        ["ATTACK", s.attack],
        ["DEFENSE", s.defense],
        ["SPEED", s.speed],
        ["SPECIAL", s.special],
      ];
      rows.forEach(([label, v], i) => {
        this.text(host, 11, 3 + i * 2, label);
        this.text(host, 16, 4 + i * 2, String(v).padStart(3));
      });
    }

    // YES/NO over the still-visible text (sayChoice; placement follows the
    // overworld ChoiceBox approximation in scene.ts)
    if (battle.choiceOpen) {
      this.box(host, 14, 7, 6, 5);
      this.text(host, 16, 8, "YES");
      this.text(host, 16, 10, "NO");
      this.choiceYes = battle.choiceYes;
      host.uiTile(15, battle.choiceYes ? 8 : 10, ARROW_CURSOR);
    }
  }

  /** DrawEnemyHUDAndHPBar (:5391-5413): name row 0, <LV>/status row 1, tick
   * + bar row 2, underline row 3. */
  private paintEnemyHud(host: VoxelHost, battle: WildBattle): void {
    const e = battle.enemy;
    this.text(host, nameTileX(1, e.name), 0, e.name);
    this.paintLevelOrStatus(host, battle, e, 4, 1, false);
    host.uiTile(1, 2, HUD_TICK);
    this.paintBar(host, battle, e, 2, 2, false);
    host.uiTile(1, 3, HUD_EDGE_L);
    host.uiFill(2, 3, 8, 1, HUD_LINE);
    host.uiTile(10, 3, HUD_EDGE_R);
  }

  /** DrawPlayerHUDAndHPBar (:5473-5493): name (10,7), <LV> (14,8), bar
   * (10,9), digits row 10, underline row 11. */
  private paintPlayerHud(host: VoxelHost, battle: WildBattle): void {
    const p = battle.player;
    this.text(host, nameTileX(10, p.name), 7, p.name);
    this.paintLevelOrStatus(host, battle, p, 14, 8, true);
    this.paintBar(host, battle, p, 10, 9, true);
    this.paintPlayerDigits(host, battle);
    host.uiTile(18, 10, HUD_TICK);
    host.uiTile(9, 11, HUD_HALF_ARROW);
    host.uiFill(10, 11, 8, 1, HUD_LINE);
    host.uiTile(18, 11, HUD_EDGE_DOWN);
  }

  /** the HUD status label replaces <LV>+level (statusLabel :2201-2207). */
  private paintLevelOrStatus(
    host: VoxelHost,
    battle: WildBattle,
    b: WildBattler,
    lvX: number,
    y: number,
    player: boolean,
  ): void {
    const label = b.shownStatus ? b.shownStatus : String(b.mon.level);
    if (b.shownStatus) {
      this.text(host, lvX + 1, y, label);
    } else {
      host.uiTile(lvX, y, HUD_LV);
      this.text(host, lvX + 1, y, label);
    }
    if (player) this.playerLevel = label;
    else this.enemyLevel = label;
  }

  private paintBar(
    host: VoxelHost,
    battle: WildBattle,
    b: WildBattler,
    tx: number,
    ty: number,
    player: boolean,
  ): void {
    const tiles = hpBarTiles(battle.shownHPInt(b), b.mon.stats.hp, player);
    tiles.forEach((t, i) => host.uiTile(tx + i, ty, t));
    if (player) this.playerBar = tiles;
    else this.enemyBar = tiles;
  }

  private paintPlayerDigits(host: VoxelHost, battle: WildBattle): void {
    const p = battle.player;
    const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
    this.text(host, 11, 10, digits);
    this.playerDigits = digits;
  }

  private paintMenuCursor(host: VoxelHost, battle: WildBattle): void {
    const col = (battle.menuIndex - 1) % 2;
    const row = Math.floor((battle.menuIndex - 1) / 2);
    const cell: [number, number] = [col === 0 ? 9 : 15, 14 + row * 2];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }

  private paintMoveCursor(host: VoxelHost, battle: WildBattle): void {
    const cell: [number, number] = [5, 12 + battle.moveIndex];
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
    if (battle.moveSwapIndex !== null && battle.moveSwapIndex !== battle.moveIndex) {
      const swap: [number, number] = [5, 12 + battle.moveSwapIndex];
      host.uiTile(swap[0], swap[1], ARROW_HOLLOW);
      this.swapCell = swap;
    } else {
      this.swapCell = null;
    }
  }

  // -----------------------------------------------------------------
  // within-mode deltas
  // -----------------------------------------------------------------

  private deltas(host: VoxelHost, battle: WildBattle, enemyHud: boolean, playerHud: boolean): void {
    if (enemyHud) {
      const e = battle.enemy;
      const bar = hpBarTiles(battle.shownHPInt(e), e.mon.stats.hp, false);
      if (this.enemyBar) {
        bar.forEach((t, i) => {
          if (this.enemyBar![i] !== t) host.uiTile(2 + i, 2, t);
        });
      }
      this.enemyBar = bar;
      const label = e.shownStatus ?? String(e.mon.level);
      if (label !== this.enemyLevel) this.paintLevelOrStatus(host, battle, e, 4, 1, false);
    }
    if (playerHud && battle.phase !== "moveSelect") {
      const p = battle.player;
      const bar = hpBarTiles(battle.shownHPInt(p), p.mon.stats.hp, true);
      if (this.playerBar) {
        bar.forEach((t, i) => {
          if (this.playerBar![i] !== t) host.uiTile(10 + i, 9, t);
        });
      }
      this.playerBar = bar;
      const digits = `${String(battle.shownHPInt(p)).padStart(3)}/${String(p.mon.stats.hp).padStart(3)}`;
      if (digits !== this.playerDigits) this.paintPlayerDigits(host, battle);
      const label = p.shownStatus ?? String(p.mon.level);
      if (label !== this.playerLevel) this.paintLevelOrStatus(host, battle, p, 14, 8, true);
    }
    // cursor moves (PlaceMenuCursor: erase the old cell, draw the new)
    if (battle.phase === "menu") {
      const col = (battle.menuIndex - 1) % 2;
      const row = Math.floor((battle.menuIndex - 1) / 2);
      const cell: [number, number] = [col === 0 ? 9 : 15, 14 + row * 2];
      this.moveCursor(host, cell);
    } else if (battle.phase === "moveSelect") {
      const cell: [number, number] = [5, 12 + battle.moveIndex];
      const moved =
        !this.cursorCell || this.cursorCell[0] !== cell[0] || this.cursorCell[1] !== cell[1];
      this.moveCursor(host, cell);
      const swap =
        battle.moveSwapIndex !== null && battle.moveSwapIndex !== battle.moveIndex
          ? ([5, 12 + battle.moveSwapIndex] as [number, number])
          : null;
      const swapKey = swap ? `${swap[0]},${swap[1]}` : null;
      const oldKey = this.swapCell ? `${this.swapCell[0]},${this.swapCell[1]}` : null;
      if (swapKey !== oldKey) {
        if (this.swapCell && (!swap || swap[1] !== this.swapCell[1])) {
          // only clear if the cursor is not sitting there now
          if (!this.cursorCell || this.cursorCell[1] !== this.swapCell[1]) {
            host.uiTile(this.swapCell[0], this.swapCell[1], SPACE);
          }
        }
        if (swap) host.uiTile(swap[0], swap[1], ARROW_HOLLOW);
        this.swapCell = swap;
      }
      if (moved) {
        // the TYPE/PP panel follows the highlighted move (PrintMenuItem)
        const sel = battle.player.curMoves[battle.moveIndex - 1];
        const selDef = sel ? battle.data.moves[sel.id] : undefined;
        host.uiFill(1, 10, 9, 1, SPACE);
        host.uiFill(1, 11, 9, 1, SPACE);
        if (selDef) {
          this.text(host, 2, 10, battle.chart.displayName(selDef.type));
          const maxPP = selDef.pp + (sel.ppUps ?? 0) * Math.floor(selDef.pp / 5);
          this.text(host, 5, 11, `${String(sel.pp).padStart(2)}/${String(maxPP).padStart(2)}`);
        }
      }
    } else if (battle.phase === "party") {
      this.moveCursor(host, [1, 1 + battle.partyIndex * 2]);
    } else if (battle.phase === "item") {
      this.moveCursor(host, [5, 3 + battle.itemIndex * 2]);
    }
    if (battle.choiceOpen && battle.choiceYes !== this.choiceYes) {
      this.choiceYes = battle.choiceYes;
      host.uiTile(15, battle.choiceYes ? 10 : 8, SPACE);
      host.uiTile(15, battle.choiceYes ? 8 : 10, ARROW_CURSOR);
    }
  }

  private moveCursor(host: VoxelHost, cell: [number, number]): void {
    const old = this.cursorCell;
    if (old && old[0] === cell[0] && old[1] === cell[1]) return;
    if (old) host.uiTile(old[0], old[1], SPACE);
    host.uiTile(cell[0], cell[1], ARROW_CURSOR);
    this.cursorCell = cell;
  }

  // -----------------------------------------------------------------
  // the message window (drawTextArea :5500-5525): the rolling two-line
  // window at rows 14/16, uiText + uiReveal typewriter, blinking ▼
  // -----------------------------------------------------------------

  private emitMessage(host: VoxelHost, battle: WildBattle): void {
    const visible =
      battle.phase === "messages" && (battle.current !== null || battle.msgHold);
    if (!visible) {
      if (this.msgVisible) {
        // the gate dropped (:5500-5503): clear the interior rows
        host.uiFill(1, 13, 18, 4, SPACE);
        this.msgRows = [];
        this.msgVisible = false;
        this.arrowShown = false;
      }
      return;
    }
    this.msgVisible = true;
    // a chrome uiText this tick would steal the reveal counter's target;
    // force the message rows to re-emit so the LAST uiText is the typing row
    if (this.chromeTextDirty) this.msgRows = [];
    let textsEmitted = false;
    battle.shown.forEach((line, i) => {
      if (i >= MSG_ROWS.length) return;
      const isLast = i === battle.shown.length - 1;
      const pad = Math.max(0, MAX_COLS - line.codes.length);
      const text = isLast ? line.text : line.text + " ".repeat(pad);
      const cached = this.msgRows[i];
      if (!cached || cached.text !== text) {
        host.uiText(MSG_X, MSG_ROWS[i], text);
        this.msgRows[i] = { text, revealed: -1 };
        textsEmitted = true;
      }
    });
    this.msgRows.length = Math.min(battle.shown.length, MSG_ROWS.length);
    const last = battle.shown[battle.shown.length - 1];
    if (last && battle.shown.length <= MSG_ROWS.length) {
      const cached = this.msgRows[battle.shown.length - 1];
      if (cached && (textsEmitted || cached.revealed !== last.revealed)) {
        host.uiReveal(last.revealed);
        cached.revealed = last.revealed;
      }
    }
    // the blinking ▼ while a CONT or a typed page holds the box (:5521-5525)
    const arrow = (battle.msgWaiting || battle.msgPrompt) && battle.frame % 60 < 30;
    if (arrow !== this.arrowShown) {
      if (arrow) {
        host.uiTile(ARROW_X, ARROW_Y, ARROW_MORE);
      } else {
        const under = battle.shown[1];
        const idx = ARROW_X - MSG_X;
        const glyph =
          under && under.codes.length > idx && under.revealed > idx ? under.codes[idx] : SPACE;
        host.uiTile(ARROW_X, ARROW_Y, glyph);
      }
      this.arrowShown = arrow;
    }
  }
}
