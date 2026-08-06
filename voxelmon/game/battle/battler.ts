// The battler table: the merged view of a party mon the pure battle rules
// read (rules/damage Battler + rules/status StatusBattler) plus the battle
// engine's own volatile/presentation fields. Ports gen1recomp
// src/battle/BattleState.lua makeBattler (:437-476); the sprite field
// becomes the voxel card's atlas page, resolved by the staging layer.

import type { SpeciesDef, VoxelmonData } from "../data.ts";
import { BADGE_BOOSTS, type Battler as DamageBattler, type StageKey } from "../rules/damage.ts";
import type { MoveSlot, PartyMon } from "./mon.ts";

// WildBattler narrows Battler.mon to the full PartyMon (which also
// satisfies rules/status StatusMon), and carries the StatusBattler fields
// inline — the two rules interfaces declare `mon` with different shapes, so
// a double extends cannot express the merge the Lua table simply is.
export interface WildBattler extends DamageBattler {
  mon: PartyMon;
  def: SpeciesDef;
  name: string;
  isPlayer: boolean;
  curMoves: MoveSlot[];
  // rules/status.ts StatusBattler volatiles
  sleepTurns?: number;
  toxicCounter?: number;
  leechSeeded?: boolean;
  flinched?: boolean;
  skipMove?: boolean;
  boundTurns?: number;
  disabledTurns?: number;
  disabledSlot?: number;
  confusedTurns?: number;
  /** The HP the bar displays (UpdateHPBar drain, BattleState.lua:458). */
  shownHP: number;
  /** HUD status label lag (BattleState.lua:459-462 shownStatus). */
  shownStatus: string | null;
  stages: Partial<Record<StageKey, number>>;
  /** drain pacing state (stepHPDrain, BattleState.lua:964-1002) */
  drainHold?: number;
  draining?: boolean;
  drainFloor?: number;
  fainted?: boolean;
  faintQueued?: boolean;
  lastMove?: string;
  /** Hyper Beam recharge etc. — outside the reachable v1 effect set but the
   * menu-lock checks read them (BattleState.lua:1699-1729). */
  mustRecharge?: boolean;
  invulnerable?: boolean;
  /** Substitute / Mist / trapping — unreachable in v1 but the pipeline's
   * guards read them (EffectRegistry.lua, MoveEffects.lua changeStage). */
  substituteHP?: number;
  mist?: boolean;
  trappingTurns?: number;
}

interface BattlerSave {
  inventory: Record<string, number>;
}

/**
 * BattleState.lua:437-476 makeBattler — curStats/curTypes/curMoves ALIAS the
 * mon's tables (Transform would override; v1 never does), badges from the
 * save inventory for the player side, and the shownHP/shownStatus HUD lag.
 */
export function makeBattler(
  data: VoxelmonData,
  mon: PartyMon,
  isPlayer: boolean,
  save?: BattlerSave,
): WildBattler {
  const def = data.pokemon[mon.species];
  if (!def) throw new Error(`unknown species ${mon.species}`);
  let badges: Record<string, boolean> | undefined;
  if (isPlayer && save) {
    badges = {};
    for (const row of BADGE_BOOSTS) {
      if (save.inventory[row.badge]) badges[row.badge] = true;
    }
  }
  return {
    mon,
    def,
    name: mon.nickname ?? def.name,
    isPlayer,
    badges,
    shownHP: mon.hp,
    shownStatus: mon.status,
    stages: {},
    curStats: mon.stats,
    curTypes: def.types,
    curMoves: mon.moves,
  };
}

/**
 * pokered's <USER>/<TARGET> text macros (home/text.asm PlaceMoveUsersName):
 * enemy-mon texts print "Enemy " before the nickname (BattleState.lua:385).
 */
export function displayName(b: WildBattler): string {
  return b.isPlayer ? b.name : `Enemy ${b.name}`;
}

/**
 * BattleState.lua:392-398 prefixEnemy — qualify a pre-built message from a
 * module that only knows the raw nickname (Status.beforeMove/residual).
 */
export function prefixEnemy(msg: string, battler: WildBattler): string {
  if (battler.isPlayer) return msg;
  const s = msg.indexOf(battler.name);
  if (s < 0) return msg;
  return `${msg.slice(0, s)}Enemy ${battler.name}${msg.slice(s + battler.name.length)}`;
}
