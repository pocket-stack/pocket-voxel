// Voxel staging for a battle: which arena cells the fight is shot on, which
// camera rig frames it, and which atlas pages the two mon cards draw
// (docs/VOXEL.md §4 battle ops). Nothing here moves the player — the camera
// goes to the arena, exactly as upstream (DramaticShapeVoxelMod
// BattleArena.lua:32-36).

import type { VoxelmonData } from "../data.ts";
import type { GameMap } from "../world/map.ts";
import { search, type Arena } from "./arena.ts";
import type { WildBattle } from "./battle.ts";

export interface BattleStaging {
  /** The map's pak index (the arena op's mapId arg). */
  mapIndex: number;
  arena: Arena;
  /** RIG index: 0 tele, 1 wide (voxel-spec). */
  rig: number;
}

export interface CardDesire {
  /** 0 player, 1 enemy (voxel-spec card op). */
  side: number;
  pic: number;
  x: number;
  y: number;
}

/**
 * Pic-page accessors against the cooked atlas directory the cooker adds to
 * gamedata (`atlas.picFront` / `atlas.picBack`, keyed by species id).
 * -1 = the page is not cooked (older pak): the caller SKIPS the card op —
 * the ui battle screen must stay fully playable without cards.
 */
interface AtlasDir {
  picFront?: Record<string, number>;
  picBack?: Record<string, number>;
}

function atlasOf(data: VoxelmonData): AtlasDir | undefined {
  return (data as VoxelmonData & { atlas?: AtlasDir }).atlas;
}

export function picPageFor(data: VoxelmonData, speciesId: string): number {
  return atlasOf(data)?.picFront?.[speciesId] ?? -1;
}

export function backPageFor(data: VoxelmonData, speciesId: string): number {
  return atlasOf(data)?.picBack?.[speciesId] ?? -1;
}

/**
 * Stage a wild battle on the current map: BattleArena.search from the
 * player's cell (v1: no authored table, no clearance walk — arena.ts), rig
 * tele by default, wide when the map is indoor. The v1 indoor test is
 * `tileset != OVERWORLD` (the dataset's field/darkMaps hints are a later
 * refinement).
 */
export function computeStaging(
  map: GameMap,
  playerCellX: number,
  playerCellY: number,
  surfing: boolean,
): BattleStaging | null {
  const arena = search(map, playerCellX, playerCellY, surfing);
  if (!arena) return null;
  const indoor = map.def.tileset !== "OVERWORLD";
  return {
    mapIndex: map.def.index,
    arena,
    rig: indoor ? 1 : 0, // RIG.tele / RIG.wide order in the spec
  };
}

/**
 * The cards the staging wants THIS tick: the enemy's front pic from battle
 * start (the wild mon is already on the field — pokered's wild intro), the
 * player mon's back pic once sent out, each dropped on faint/catch. A -1
 * page skips the card (accessor contract above).
 */
export function desiredCards(
  data: VoxelmonData,
  battle: WildBattle,
  staging: BattleStaging,
): CardDesire[] {
  const out: CardDesire[] = [];
  const [ex, ey] = staging.arena.enemyCell;
  const [px, py] = staging.arena.playerCell;
  if (battle.enemy && !battle.enemy.fainted && battle.result !== "caught") {
    const pic = picPageFor(data, battle.enemy.mon.species);
    if (pic >= 0) out.push({ side: 1, pic, x: ex, y: ey });
  }
  if (battle.player && !battle.player.fainted && !battle.showPlayerBack && !battle.sendingOut) {
    const pic = backPageFor(data, battle.player.mon.species);
    if (pic >= 0) out.push({ side: 0, pic, x: px, y: py });
  }
  return out;
}
