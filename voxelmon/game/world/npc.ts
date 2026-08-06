// Map object (NPC/item) built from a generated object_event entry. Ports
// gen1recomp src/world/NPC.lua: STAY objects keep their facing; WALK
// objects wander randomly within the roam constraint (ANY_DIR / UP_DOWN /
// LEFT_RIGHT).
//
// Divergence from the Lua, on purpose: wander rolls come from an injected
// Rng stream (the guest owns its RNG — docs/VOXEL.md §3) instead of
// love.math.random, and the overworld hands NPCs a stream separate from
// the encounter rolls so wander cannot perturb encounter determinism.

import type { MapObject } from "../data.ts";
import { randRange, type Rng } from "../rng.ts";
import { canMove, DELTA, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import type { GameMap } from "./map.ts";

const STEP_FRAMES = 16;

// NPC.lua:13
const FACING_FROM_RANGE: Record<string, Dir> = {
  DOWN: "down",
  UP: "up",
  LEFT: "left",
  RIGHT: "right",
};

// NPC.lua:17
const ROAM_DIRS: Record<string, Dir[]> = {
  ANY_DIR: ["up", "down", "left", "right"],
  UP_DOWN: ["up", "down"],
  LEFT_RIGHT: ["left", "right"],
};

export class NPC implements Mover {
  readonly def: MapObject;
  readonly id: string;
  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: Dir;
  moving = false;
  progress = 0;
  stepFlip = false;
  frozen = false; // scripts freeze NPCs while talking
  wanders: boolean;
  roamDirs: Dir[];
  timer: number;
  targetX?: number;
  targetY?: number;
  passable?: boolean;
  marching = false;

  // NPC.lua:23 — object_event coordinates are already walk-grid cells
  constructor(mapId: string, objDef: MapObject, rng: Rng) {
    this.def = objDef;
    this.id = `${mapId}_obj_${objDef.index}`;
    this.cellX = objDef.x;
    this.cellY = objDef.y;
    this.px = this.cellX * 16;
    this.py = this.cellY * 16;
    this.facing = FACING_FROM_RANGE[objDef.range] ?? "down";
    this.wanders = objDef.movement === "WALK";
    this.roamDirs = ROAM_DIRS[objDef.range] ?? ROAM_DIRS.ANY_DIR;
    this.timer = randRange(rng, 30, 120);
  }

  // NPC.lua:44
  facePlayer(player: Mover): void {
    const dx = player.cellX - this.cellX;
    const dy = player.cellY - this.cellY;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? "right" : "left";
    } else {
      this.facing = dy > 0 ? "down" : "up";
    }
  }

  // NPC.lua:54 update — wander AI
  update(map: GameMap, entities: readonly Mover[], rng: Rng, tilePairs?: TilePairs): void {
    const stepLen = STEP_FRAMES;
    if (this.moving) {
      this.progress += 1;
      // NPC.lua:70 marching (NPC_CHANGE_FACING): walk cycle in place
      if (this.marching) {
        if (this.progress >= stepLen) {
          this.progress = 0;
          this.moving = false;
          this.marching = false;
          this.stepFlip = !this.stepFlip;
        }
        return;
      }
      const d = DELTA[this.facing];
      const moved = Math.floor((this.progress * 16) / stepLen);
      this.px = this.cellX * 16 + d[0] * moved;
      this.py = this.cellY * 16 + d[1] * moved;
      if (this.progress >= stepLen) {
        this.cellX = this.targetX!;
        this.cellY = this.targetY!;
        this.targetX = undefined;
        this.targetY = undefined;
        this.px = this.cellX * 16;
        this.py = this.cellY * 16;
        this.moving = false;
        this.stepFlip = !this.stepFlip;
      }
      return;
    }
    if (this.frozen || !this.wanders) return;
    this.timer -= 1;
    if (this.timer > 0) return;
    this.timer = randRange(rng, 30, 180);
    const dir = this.roamDirs[rng.int(this.roamDirs.length)];
    this.facing = dir;
    // NPC.lua:103 — sometimes just turn (the Lua's random() < 0.5 as a
    // one-byte roll to keep the stream integral)
    if (rng.byte() < 128) return;
    // NPC.lua:105 — never wander onto warps, so NPCs don't walk out of the map
    const [tx, ty] = target(this.cellX, this.cellY, dir);
    if (map.warpAtCell(tx, ty)) return;
    if (canMove(map, entities, this, dir, tilePairs).ok) {
      this.targetX = tx;
      this.targetY = ty;
      this.moving = true;
      this.progress = 0;
    }
  }

  // NPC.lua:114
  walkPhase(): 0 | 1 {
    if (!this.moving) return 0;
    const p = this.progress % 16;
    return p >= 4 && p < 12 ? 1 : 0;
  }
}
