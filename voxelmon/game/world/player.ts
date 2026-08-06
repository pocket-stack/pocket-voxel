// The player: tile-grid movement with pixel interpolation. Ports gen1recomp
// src/world/Player.lua — facing changes on a short tap, movement is
// tile-by-tile at 1px per frame (16 frames per step), input locked while
// stepping. Rendering concerns (sprites, shadows, fishing poses) stay in
// the presentation frontend; this class carries only the state it needs.

import { canMove, DELTA, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import type { GameMap } from "./map.ts";

// Player.lua:14 — wWalkCounter = 8, 2px per AdvancePlayerSprite
export const STEP_FRAMES = 16;
// Player.lua:15-28 — the turn-in-place window covers the original's
// 2-frame poll grid (#415)
export const TURN_FRAMES = 4;

export type MoveResult = "moved" | "turned" | "blocked" | null;

export class Player implements Mover {
  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: Dir;
  moving = false;
  progress = 0;
  stepFlip = false;
  turnTimer = 0;
  // Player.lua:87 wCheckFor180DegreeTurn: starts armed, tryMove spends it,
  // handleInput re-arms it from a standstill.
  turnArmed = true;
  inputLocked = false;
  targetX?: number;
  targetY?: number;
  stepFrames = STEP_FRAMES;
  turnFrames = TURN_FRAMES;
  stepFramesCur?: number;
  bumpFrames?: number;
  hopFrames?: number;
  hopTotal?: number;
  animClock = 0;
  stepLanded = false;
  /** Monotonic landed-step counter (port addition: the tape's walk unit). */
  landedCount = 0;
  surfing = false;
  lastBlockReason?: string;

  // Player.lua:34 Player.new
  constructor(cx: number, cy: number, facing?: Dir) {
    this.cellX = cx;
    this.cellY = cy;
    this.px = cx * 16;
    this.py = cy * 16;
    this.facing = facing ?? "down";
  }

  // Player.lua:114 tryMove — attempt to start a step.
  tryMove(
    dir: Dir,
    map: GameMap,
    entities: readonly Mover[],
    tilePairs?: TilePairs,
  ): MoveResult {
    if (this.moving || this.inputLocked) return null;
    if (this.facing !== dir) {
      this.facing = dir;
      this.bumpFrames = undefined; // turning to a new facing ends any wall-bonk cycle
      // Player.lua:120: only a poll whose previous pass found no direction
      // held (turnArmed) pays the turn delay; a corner turn mid-hold steps
      // straight away (#415).
      if (this.turnArmed) {
        this.turnArmed = false;
        this.turnTimer = this.turnFrames;
        return "turned";
      }
    }
    if (this.turnTimer > 0) return null;
    const { ok, why } = canMove(map, entities, this, dir, tilePairs);
    if (!ok) {
      // Player.lua:135: a blocked step still animates the walk in place —
      // the collision path spends a step's frames cycling the legs (#230).
      this.bumpFrames = this.stepFrames;
      this.lastBlockReason = why;
      return "blocked";
    }
    const [tx, ty] = target(this.cellX, this.cellY, dir);
    this.targetX = tx;
    this.targetY = ty;
    this.moving = true;
    this.bumpFrames = undefined;
    this.progress = 0;
    this.stepFramesCur = this.stepFrames;
    return "moved";
  }

  // Player.lua:168 update — advance one fixed step; true when a step just
  // completed.
  update(): boolean {
    // land-frame walk pose lasts only through the draw after completion
    this.stepLanded = false;
    // ledge-hop arc tracks the fixed step, not the display (issue #4)
    if (this.hopFrames !== undefined && this.hopFrames > 0) {
      this.hopFrames -= 1;
    }
    if (this.turnTimer > 0) {
      this.turnTimer -= 1;
    }
    // wall-bonk walk-in-place (issue #230), guarded on not-moving so a real
    // step never double-ticks the leg cadence
    if (!this.moving && this.bumpFrames !== undefined && this.bumpFrames > 0) {
      this.bumpFrames -= 1;
      this.animClock += 1;
    }
    if (!this.moving) return false;
    const stepLen = this.stepFramesCur ?? this.stepFrames;
    this.progress += 1;
    this.animClock += 1;
    const d = DELTA[this.facing];
    const px = Math.floor((this.progress * 16) / stepLen);
    this.px = this.cellX * 16 + d[0] * px;
    this.py = this.cellY * 16 + d[1] * px;
    if (this.progress >= stepLen) {
      this.cellX = this.targetX!;
      this.cellY = this.targetY!;
      this.targetX = undefined;
      this.targetY = undefined;
      this.px = this.cellX * 16;
      this.py = this.cellY * 16;
      this.moving = false;
      this.stepFlip = !this.stepFlip;
      // Player.lua:214: keep animClock's pose on the land frame (issue #82)
      this.stepLanded = true;
      this.landedCount += 1;
      return true;
    }
    return false;
  }

  // Player.lua:225
  facingCell(): [number, number] {
    return target(this.cellX, this.cellY, this.facing);
  }

  // Player.lua:229 walkPhase — moving, the land-frame after a completed
  // step, or an active wall-bonk animate; standing otherwise.
  walkPhase(): 0 | 1 {
    if (
      !this.moving &&
      !this.stepLanded &&
      !(this.bumpFrames !== undefined && this.bumpFrames > 0)
    ) {
      return 0;
    }
    const p = this.animClock % 16;
    return p >= 4 && p < 12 ? 1 : 0;
  }

  // Player.lua:275 — alternate walk cycles mirror the up/down frame,
  // derived from the fixed-rate animClock so shortened steps don't double
  // the leg cadence.
  animFlip(): boolean {
    return Math.floor(this.animClock / 16) % 2 === 1;
  }

  // Player.lua:259-265 — the hop arc's vertical lift in px (10px sine over
  // hopTotal frames); 0 when not hopping.
  hopLift(): number {
    if (this.hopFrames === undefined || this.hopFrames <= 0) return 0;
    const total = this.hopTotal ?? 32;
    const t = 1 - this.hopFrames / total;
    return Math.floor(10 * Math.sin(t * Math.PI) + 0.5);
  }
}
