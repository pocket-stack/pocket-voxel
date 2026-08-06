// The overworld controller SLICE. Ports the world-facing core of gen1recomp
// src/world/OverworldController.lua: map entry and connections, grid
// movement, ledges, warps (arrival / collision / edge), NPC wander,
// scripted movement, sign/talk interaction, and the completed-step
// land-triggers with wild-encounter rolls.
//
// UPDATE ORDER MATTERS and mirrors OverworldController.lua:883 update():
// script runner -> emote hold -> NPC wander -> scripted movement -> input
// (gated on scripted/transitioning) -> player animation -> warp-entry
// staleness -> land-triggers (onStepComplete, suppressed on scripted
// steps). Trainer sight, surf, bikes, boulders, spinners, Safari, poison,
// menus and the hand-ported map scripts are outside this slice.

import type { EncounterDef, MapObject, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { roll as encounterRoll } from "../rules/encounter.ts";
import { WARP_FADE_OUT } from "../rules/timing.ts";
import { canMove, occupied, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import { defPassable, GameMap, isOutside } from "./map.ts";
import { NPC } from "./npc.ts";
import { Player } from "./player.ts";
import { ScriptRunner, type ScriptWorld } from "./script.ts";
import {
  destination,
  onArrive,
  onCollision,
  onEdge,
  type LastOutdoor,
  type WarpCarpets,
} from "./warp.ts";
import type { MapWarp } from "../data.ts";

// OverworldController.lua:37
const COMPASS: Record<Dir, "north" | "south" | "east" | "west"> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

export interface SaveSlice {
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  player: { name: string; rival: string };
  lastOutdoor?: LastOutdoor;
  lastHeal?: { map: string; x: number; y: number };
}

/** What the overworld needs from the game shell (game.ts implements it). */
export interface OverworldShell {
  data: VoxelmonData;
  save: SaveSlice;
  input: {
    isDown(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
    wasPressed(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
  };
  /** Encounter/battle roll stream (the guest owns the RNG). */
  rng: Rng;
  /** NPC wander stream, separate so ambience can't perturb encounters. */
  npcRng: Rng;
  showText(text: string, onDone?: () => void): void;
  showChoice(text: string, choice: (yes: boolean) => void): void;
  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void;
  pushStubBattle(species: string, level: number): void;
}

interface ScriptMove {
  entity: Player | NPC;
  dir?: Dir;
  remaining: number;
  onDone?: () => void;
  inPlace?: boolean;
}

export interface EmoteHold {
  entity: Player | NPC;
  kind: number;
  frames: number;
  onDone?: () => void;
}

// OverworldController.lua:164 computeNeighbors — walk the connection graph
// `hops` out, composing the strip offsets, deduped by map id (BFS, so a
// direct connection always wins over a two-hop path). Offsets are world
// pixels; connection offsets are in blocks (32 px). The view-reach widening
// (reachW/reachH) is a renderer concern and stays out of the port.
export function computeNeighbors(
  maps: NonNullable<VoxelmonData["maps"]>,
  rootId: string,
  hops: number,
): { id: string; ox: number; oy: number }[] {
  const out: { id: string; ox: number; oy: number }[] = [];
  const rootDef = maps[rootId];
  if (!rootDef) return out;
  const placed = new Set([rootId]);
  const queue: { def: typeof rootDef; ox: number; oy: number; hops: number }[] = [
    { def: rootDef, ox: 0, oy: 0, hops: 0 },
  ];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi];
    qi += 1;
    for (const [dir, conn] of Object.entries(cur.def.connections ?? {})) {
      const destDef = maps[conn.map];
      if (!destDef || placed.has(conn.map)) continue;
      placed.add(conn.map);
      let ox: number;
      let oy: number;
      if (dir === "north") {
        ox = conn.offset * 32;
        oy = -destDef.height * 32;
      } else if (dir === "south") {
        ox = conn.offset * 32;
        oy = cur.def.height * 32;
      } else if (dir === "west") {
        ox = -destDef.width * 32;
        oy = conn.offset * 32;
      } else {
        ox = cur.def.width * 32;
        oy = conn.offset * 32;
      }
      ox += cur.ox;
      oy += cur.oy;
      if (cur.hops + 1 <= hops) {
        out.push({ id: conn.map, ox, oy });
        if (cur.hops + 1 < hops) {
          queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
        }
      }
    }
  }
  return out;
}

export class Overworld implements ScriptWorld {
  /** The content-boundary test: a map outside the pak's cooked set exists
   * as DATA (warp targets, connection math) but must never be entered —
   * the pak has no geometry for it, so warps bump and connections neither
   * show nor cross. Old gamedata without the list means "everything". */
  isCooked(mapId: string): boolean {
    if (mapId === "LAST_MAP") return true; // resolves to a map we came from
    const list = this.shell.data.cookedMaps;
    return !list || list.includes(mapId);
  }

  readonly shell: OverworldShell;
  map!: GameMap;
  player!: Player;
  npcs: NPC[] = [];
  entities: Mover[] = [];
  runner: ScriptRunner;
  scriptMoves: ScriptMove[] = [];
  emote?: EmoteHold;
  lastOutdoor?: LastOutdoor;
  standingOnWarp = false;
  warpEntryCell?: { x: number; y: number };
  transitioning = false;
  private doorWarp = false;
  private joyLatch?: { a?: boolean };
  private npcPool = new Map<string, NPC>();
  readonly tilePairs: TilePairs;
  readonly carpets?: WarpCarpets;
  /** Battle-port seam bookkeeping the tests and the sim read. */
  encounterCount = 0;
  lastEncounter?: { species: string; level: number };

  constructor(shell: OverworldShell) {
    this.shell = shell;
    const field = shell.data.field as
      | { tilePairs?: TilePairs; warpCarpets?: WarpCarpets }
      | undefined;
    // Collision.load equivalent (Collision.lua:36)
    this.tilePairs = field?.tilePairs ?? { land: [], water: [] };
    this.carpets = field?.warpCarpets;
    this.runner = new ScriptRunner(this);
  }

  get data(): VoxelmonData {
    return this.shell.data;
  }

  get save(): SaveSlice {
    return this.shell.save;
  }

  // OverworldController.lua:209 enter
  enter(mapId: string, x: number, y: number, facing?: Dir): void {
    // survives save/load: a loaded game may start inside a building whose
    // exit mat is a LAST_MAP warp
    this.lastOutdoor = this.shell.save.lastOutdoor;
    this.setMap(mapId, x, y, facing, { via: "boot" });
    // boot/load: derive the flag from the tile the save left us standing on
    // (MapEntryAfterBattle's IsPlayerStandingOnWarp — issue #378)
    this.refreshStandingOnWarp();
  }

  // OverworldController.lua:283 setMap — the single choke point for every
  // map-id change, warps and seamless connection crossings alike.
  setMap(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    opts?: { via?: string; seamless?: boolean },
  ): void {
    const def = this.shell.data.maps?.[mapId];
    if (!def) throw new Error(`unknown map ${mapId}`);
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset) throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(def, tileset);
    // NPC instances persist across connection crossings in the pool (keyed
    // by NPC.id) so nothing snaps back to its spawn point at a seam; warps
    // rebuild from scratch, like the original's per-entry sprite init
    // (OverworldController.lua:376-385).
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map();
    }
    this.npcs = [];
    for (const obj of def.objects ?? []) {
      if (this.objectVisible(obj)) {
        const npc = this.pooledNPC(mapId, obj);
        npc.frozen = false;
        this.npcs.push(npc);
      }
    }
    if (this.player) {
      this.player.cellX = x;
      this.player.cellY = y;
      this.player.px = x * 16;
      this.player.py = y * 16;
      this.player.facing = facing ?? this.player.facing;
      this.player.moving = false;
      this.player.targetX = undefined;
      this.player.targetY = undefined;
    } else {
      this.player = new Player(x, y, facing);
    }
    this.entities = [this.player, ...this.npcs];
  }

  // OverworldController.lua:110 objectVisible — the spawn filter. The slice
  // carries only the `hidden` gate (toggles/items-taken/defeated need save
  // machinery outside this slice).
  private objectVisible(obj: MapObject): boolean {
    return !(obj as MapObject & { hidden?: boolean }).hidden;
  }

  // OverworldController.lua:131 pooledNPC
  private pooledNPC(mapId: string, obj: MapObject): NPC {
    const key = `${mapId}_obj_${obj.index}`;
    let npc = this.npcPool.get(key);
    if (!npc) {
      npc = new NPC(mapId, obj, this.shell.npcRng);
      this.npcPool.set(key, npc);
    }
    return npc;
  }

  // OverworldController.lua:883 update
  update(): void {
    this.runner.update();
    // the emotion-bubble pause holds the world for a beat
    // (OverworldController.lua:1018); only the player animates through it
    if (this.emote) {
      this.emote.frames -= 1;
      if (this.emote.frames <= 0) {
        const done = this.emote.onDone;
        this.emote = undefined;
        done?.();
      }
      this.player.update();
      return;
    }
    for (const npc of this.npcs) {
      npc.update(this.map, this.entities, this.shell.npcRng, this.tilePairs);
    }
    this.updateScriptMoves();
    // emote is included: a hold queued from a scriptMove onDone is assigned
    // mid-frame, after the early emote return above already missed it
    // (OverworldController.lua:1045-1052)
    const scripted =
      this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined;
    if (!scripted && !this.transitioning) {
      this.handleInput();
    }
    const stepped = this.player.update();
    // the warp-arrival cell goes stale the instant the player's real cell
    // leaves it, scripted walk-outs included (OverworldController.lua:1071)
    const entry = this.warpEntryCell;
    if (entry && (this.player.cellX !== entry.x || this.player.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
    }
    if (stepped && !scripted) {
      this.onStepComplete();
    }
  }

  // OverworldController.lua:1113 dirHeld (hJoyHeld & PAD_CTRL_PAD)
  dirHeld(): boolean {
    const input = this.shell.input;
    return (
      input.isDown("up") || input.isDown("down") || input.isDown("left") || input.isDown("right")
    );
  }

  // OverworldController.lua:1131 — BIT_STANDING_ON_WARP: the warp under the
  // player's feet may only fire from a collision (blocked step / map edge)
  // while this flag is set.
  canCollisionWarp(): boolean {
    return this.standingOnWarp;
  }

  // OverworldController.lua:1138 refreshStandingOnWarp — a door tile keeps
  // the flag, a stair/ladder warp tile clears it (issues #230/#378).
  refreshStandingOnWarp(): void {
    const p = this.player;
    this.standingOnWarp = false;
    if (
      this.map.warpAtCell(p.cellX, p.cellY) &&
      !(this.map.isWarpTileCell(p.cellX, p.cellY) && !this.map.isDoorTileCell(p.cellX, p.cellY))
    ) {
      this.standingOnWarp = true;
    }
  }

  // OverworldController.lua:1148 handleInput — gated on the walk counter:
  // A and direction initiation are only acted on standing on a tile (#286).
  handleInput(): void {
    const input = this.shell.input;
    if (this.player.moving) {
      // OverworldController.lua:1177: a button pressed mid-step and STILL
      // HELD when the step lands reads as a fresh press at the next poll
      // (hJoyLast frozen for the animation, #525); one released before then
      // is genuinely lost.
      if (input.wasPressed("a")) {
        this.joyLatch = { ...this.joyLatch, a: true };
      }
      return;
    }
    const latch = this.joyLatch;
    this.joyLatch = undefined;
    if (input.wasPressed("a") || (latch?.a === true && input.isDown("a"))) {
      this.interact();
      return;
    }
    // START menu: outside the slice (the early return still skips the
    // turn re-arm below, like the original's jump to .displayDialogue)
    if (input.wasPressed("start")) {
      return;
    }
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      if (!input.isDown(dir)) continue;
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir)) return;
        if (this.checkLedgeHop(dir)) return;
        // boulder pushes: outside the slice
      }
      // Content boundary, standing case: a warp TILE whose destination map
      // is not in the cooked set must not even be stepped on (the real game
      // warps the instant you land — with the warp locked, landing would
      // leave the player standing inside the doorway's geometry, e.g. the
      // Diglett's Cave mouth on Route 2). Bump instead.
      {
        const [tx, ty] = target(this.player.cellX, this.player.cellY, dir);
        const w = this.map.warpAtCell(tx, ty);
        if (w && this.map.isWarpTileCell(tx, ty) && !this.isCooked(w.def.destMap)) {
          this.player.facing = dir;
          this.player.bumpFrames = this.player.stepFrames;
          continue;
        }
      }
      const result = this.player.tryMove(dir, this.map, this.entities, this.tilePairs);
      // a collision while standing on a warp square fires the warp when
      // the extra check passes (CheckWarpsCollision), only while
      // BIT_STANDING_ON_WARP is set (issue #230)
      if (result === "blocked" && this.canCollisionWarp()) {
        const w = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (w) {
          this.takeWarp(w.def);
        }
      }
      return;
    }
    // OverworldController.lua:1233: a poll that found no direction held is
    // what re-arms the next turn in place (#415); the early returns above
    // skip it exactly as the original's jumps do.
    this.player.turnArmed = true;
  }

  // OverworldController.lua:1322 checkLedgeHop — standing tile + ledge tile
  // in front + matching input direction -> jump two cells.
  checkLedgeHop(dir: Dir): boolean {
    const p = this.player;
    const tileset = this.map.def.tileset;
    const standing = this.map.cellTile(p.cellX, p.cellY);
    const [fx, fy] = target(p.cellX, p.cellY, dir);
    if (!this.map.inBounds(fx, fy)) return false;
    const front = this.map.cellTile(fx, fy);
    const ledges = (this.shell.data.field as { ledges?: Array<Record<string, unknown>> })
      ?.ledges;
    for (const ledge of ledges ?? []) {
      if (
        ((ledge.tileset as string | undefined) ?? "OVERWORLD") === tileset &&
        ledge.facing === dir &&
        ledge.input === dir &&
        ledge.standingTile === standing &&
        ledge.ledgeTile === front
      ) {
        const [lx, ly] = target(fx, fy, dir);
        if (!this.map.inBounds(lx, ly)) {
          // OverworldController.lua:1337: the landing is on the CONNECTED
          // map (issue #223) — validate the seam cell like crossConnection,
          // hop the first cell, hand the second to checkEdgeExit.
          const landing = this.connectionLanding(dir);
          if (!landing) return false;
          const { dest, ts, x, y } = landing;
          if (!defPassable(dest, ts, x, y, p.surfing)) return false;
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 1, () => this.checkEdgeExit(dir));
          return true;
        }
        if (!occupied(this.entities, lx, ly, p) && this.map.isWalkableCell(lx, ly)) {
          p.hopFrames = 32; // jump arc (cosmetic; entities can't collide mid-hop
          p.hopTotal = 32; // because the hop is a scripted move that owns input)
          this.scriptMove(p, dir, 2);
          return true;
        }
      }
    }
    return false;
  }

  // OverworldController.lua:1370 checkEdgeExit — walking off the map edge:
  // connection crossing or edge warp (exit mats).
  checkEdgeExit(dir: Dir): boolean {
    const p = this.player;
    const [tx, ty] = target(p.cellX, p.cellY, dir);
    if (this.map.inBounds(tx, ty)) return false;
    const w = onEdge(this.map, p.cellX, p.cellY, dir);
    if (w) {
      // only with BIT_STANDING_ON_WARP set: pushing into the edge beside a
      // staircase bonks instead of bouncing floors (issue #230), while the
      // door mat you warped in on keeps it and exits (issue #378)
      if (!this.canCollisionWarp()) return false;
      this.takeWarp(w.def);
      return true;
    }
    const conn = this.map.connection(COMPASS[dir]);
    if (conn) {
      return this.crossConnection(dir, conn);
    }
    return false;
  }

  // OverworldController.lua:1396 connectionLanding — landing cell on the
  // connected map for a step off this map's edge (destX = curX - offset*2).
  connectionLanding(dir: Dir) {
    const conn = this.map.connection(COMPASS[dir]);
    if (!conn) return null;
    const dest = this.shell.data.maps?.[conn.map];
    if (!dest) return null;
    const ts = this.shell.data.tilesets?.[dest.tileset];
    if (!ts) return null;
    const p = this.player;
    const destW = dest.width * 2;
    const destH = dest.height * 2;
    let x: number;
    let y: number;
    if (dir === "up") {
      x = p.cellX - conn.offset * 2;
      y = destH - 1;
    } else if (dir === "down") {
      x = p.cellX - conn.offset * 2;
      y = 0;
    } else if (dir === "left") {
      x = destW - 1;
      y = p.cellY - conn.offset * 2;
    } else {
      x = 0;
      y = p.cellY - conn.offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return { dest, ts, x, y, conn };
  }

  // OverworldController.lua:1425 crossConnection — the map data swaps while
  // the player is placed one cell before the entry point (their old world
  // position, which the neighbor strips render identically) and walks the
  // seam step. pokered's collision check reads the NEIGHBOR strip's tiles,
  // so stepping onto a solid tile of the connected map bumps like a wall.
  crossConnection(dir: Dir, _conn: { map: string; offset: number }): boolean {
    if (!this.isCooked(_conn.map)) return false; // content boundary: a wall
    const landing = this.connectionLanding(dir);
    if (!landing) return false;
    const { dest, ts, x, y } = landing;
    const p = this.player;
    if (!defPassable(dest, ts, x, y, p.surfing)) {
      return false;
    }
    this.setMap(dest.id, x, y, p.facing, { seamless: true });
    // place the player one cell before the seam and start the step into the
    // new map RIGHT NOW so there is no one-frame stall at the boundary
    const d: Record<Dir, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    p.cellX = x - d[dir][0];
    p.cellY = y - d[dir][1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.progress = 0;
    // fresh walk-cycle clock so the seam step always shows leg frames
    p.animClock = 0;
    p.stepFramesCur = p.stepFrames;
    // FixedStep:discardCatchup (OverworldController.lua:1477) is a no-op
    // here: the voxel host runs exactly one tick per frame, so there is no
    // catch-up accumulator to discard.
    return true;
  }

  // OverworldController.lua:1729 interact — the A press: NPC (with the
  // counter-tile reach-across), then sign. Card-key doors, hidden objects
  // and bookshelves are outside the slice.
  interact(): void {
    const p = this.player;
    const [fx, fy] = p.facingCell();
    let npc = this.npcAtCell(fx, fy);
    if (!npc && this.map.isCounterCell(fx, fy)) {
      // talk across counters (mart clerks, nurses)
      const [fx2, fy2] = target(fx, fy, p.facing);
      npc = this.npcAtCell(fx2, fy2);
    }
    if (npc) {
      if (!npc.moving) {
        this.talkTo(npc);
      }
      return;
    }
    const sign = this.map.signAtCell(fx, fy);
    if (sign) {
      this.showMapText(sign.text);
      return;
    }
  }

  // OverworldController.lua:2520 talkTo — the slice keeps the plain-text
  // path: freeze, face the player, resolve the object's TEXT_* constant.
  // Item balls, static encounters, trainer engagement and TX_SCRIPT marts/
  // nurses are the battle/menu ports' seams.
  talkTo(npc: NPC): void {
    npc.frozen = true;
    const unfreeze = () => {
      npc.frozen = false;
    };
    this.showMapText(npc.def.text, npc, unfreeze);
  }

  // OverworldController.lua:3241 showMapText — dispatch a TEXT_* constant
  // through extracted text (hand-ported scripts are outside the slice).
  showMapText(textConst: string, npc?: NPC, onDone?: () => void): void {
    const text = this.resolveText(textConst);
    if (text !== null) {
      if (npc) npc.facePlayer(this.player);
      this.shell.showText(text, onDone);
    } else {
      onDone?.();
    }
  }

  // src/core/Data.lua:304 resolveText — map label + TEXT_* const through
  // text_pointers; a text_asm entry falls back to its extracted _Label
  // string when one exists (#318).
  resolveText(textConst: string): string | null {
    const pointers = this.shell.data.text_pointers as
      | Record<string, Record<string, { label?: string; text?: string; asm?: boolean }>>
      | undefined;
    const texts = this.shell.data.text as Record<string, string> | undefined;
    const entry = pointers?.[this.map.def.label]?.[textConst];
    if (!entry || !texts) return null;
    if (entry.text) {
      const s = texts[entry.text];
      if (s) return s;
    }
    if (entry.label) {
      const s = texts[`_${entry.label}`];
      if (s) return s;
    }
    return null;
  }

  // OverworldController.lua:1713
  npcAtCell(cx: number, cy: number): NPC | undefined {
    return this.npcs.find(
      (npc) =>
        (npc.cellX === cx && npc.cellY === cy) || (npc.targetX === cx && npc.targetY === cy),
    );
  }

  // OverworldController.lua:3361 onStepComplete — the completed-step
  // land-triggers, in the original's order: warp-entry staleness, the
  // standing-on-warp refresh, arrival/held-collision warps, then the wild
  // encounter roll. (Spinners, badge gates, forced movement, Safari,
  // day-care, poison and repel are outside the slice.)
  onStepComplete(): void {
    const p = this.player;
    // The arrival disable is POSITIONAL (issue #265): the cell we warped in
    // on is inert until we step off it; pokered has no one-shot counter —
    // every completed step runs CheckWarpsNoCollision.
    let entry = this.warpEntryCell;
    if (entry && (p.cellX !== entry.x || p.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
      entry = undefined;
    }
    // BIT_STANDING_ON_WARP maintenance: cleared before the check, set again
    // on a warp square, cleared once more when the square is warp-activating
    // but not a door (home/overworld.asm:324 + player_state.asm).
    this.refreshStandingOnWarp();
    if (!entry) {
      // CheckWarpsNoCollision: door/warp tiles fire immediately; otherwise
      // ExtraWarpCheck must pass AND a d-pad is held.
      let w = onArrive(this.map, p.cellX, p.cellY);
      if (!w && this.dirHeld()) {
        w = onCollision(this.map, this.carpets, p.cellX, p.cellY, p.facing);
      }
      if (w) {
        this.takeWarp(w.def);
        return;
      }
    }
    // wild encounters in grass, on water while surfing, or — on indoor maps
    // whose tileset is not FOREST — on EVERY tile (wild_encounters.asm)
    const encDef = this.shell.data.encounters[this.map.id] as EncounterDef | undefined;
    const indoor = (this.shell.data.field as {
      indoorEncounters?: { firstIndoorMap: number; excludedTileset: string };
    })?.indoorEncounters;
    let enc: { species: string; level: number } | null = null;
    if (p.surfing && encDef?.water && this.map.isWaterCell(p.cellX, p.cellY)) {
      enc = encounterRoll({ grass: encDef.water }, this.shell.rng);
    } else if (this.map.isGrassCell(p.cellX, p.cellY)) {
      enc = encounterRoll(encDef, this.shell.rng);
    } else if (
      indoor &&
      this.map.def.index >= indoor.firstIndoorMap &&
      this.map.def.tileset !== indoor.excludedTileset
    ) {
      enc = encounterRoll(encDef, this.shell.rng);
    }
    if (enc) {
      this.encounterCount += 1;
      this.lastEncounter = enc;
      // BATTLE-PORT SEAM: the real battle state machine replaces this push
      // in a later task (BattleState.newWild in the reference).
      this.shell.pushStubBattle(enc.species, enc.level);
    }
  }

  // OverworldController.lua:3907 takeWarp
  takeWarp(warpDef: MapWarp): void {
    let last = this.lastOutdoor;
    if (warpDef.destMap === "LAST_MAP" && !last) {
      // old saves / unexpected states: never crash on an exit mat — fall
      // back to the remembered heal point (OverworldController.lua:3909)
      const heal = this.shell.save.lastHeal;
      if (heal) last = { id: heal.map, x: heal.x, y: heal.y };
    }
    const dest = destination(this.shell.data, warpDef, last);
    // facing carries across the warp (leaving a gate sideways keeps you
    // walking sideways; house exit mats are stepped onto facing down)
    const facing = this.player.facing;
    // warp pads and fall-through holes are not doors (WarpFound2
    // .indoorMaps): no door SFX, no walk-out step
    const pad = this.map.warpPadOrHoleAt(this.player.cellX, this.player.cellY);
    if (pad === undefined) {
      this.doorWarp = true; // door SFX + PlayerStepOutFromDoor walk-out
    }
    this.startWarpTo(dest.map, dest.x, dest.y, facing);
  }

  // OverworldController.lua:3949 rememberOutdoor (pokered's wLastMap)
  rememberOutdoor(id: string, x: number, y: number): void {
    this.lastOutdoor = { id, x, y };
    this.shell.save.lastOutdoor = this.lastOutdoor;
  }

  // OverworldController.lua:4004 startWarpTo — the fade out (32 ticks,
  // Timing WARP_FADE_OUT), the map switch at the midpoint, no fade back in
  // (LoadGBPal restores the palettes in one write).
  startWarpTo(mapId: string, x: number, y: number, facing?: Dir, onDone?: () => void): void {
    if (!this.isCooked(mapId)) {
      // The door is locked: a warp into a map the pak has no geometry for
      // would land the player in an invisible world.
      return;
    }
    // ANY transition off an outdoor map remembers the outdoor side, so
    // LAST_MAP exits keep working (CheckIfInOutsideMap includes PLATEAU).
    if (isOutside(this.map.def) && mapId !== this.map.id) {
      this.rememberOutdoor(this.map.id, this.player.cellX, this.player.cellY);
    }
    this.transitioning = true;
    const doorWarp = this.doorWarp;
    this.doorWarp = false;
    this.shell.pushWarpFade(
      WARP_FADE_OUT,
      () => {
        this.setMap(mapId, x, y, facing ?? "down");
        // The warp we land ON stays inert until we physically step off it,
        // so a warp whose destination cell is itself a warp cannot bounce
        // us straight back. BIT_STANDING_ON_WARP is deliberately NOT
        // touched here: the flag the departing tile set rides through the
        // warp (issue #378).
        this.warpEntryCell = { x, y };
        if (doorWarp && this.map.isDoorTileCell(this.player.cellX, this.player.cellY)) {
          // PlayerStepOutFromDoor: any warp landing on a door tile
          // auto-steps south once. The walk-out is a simulated d-pad press,
          // so it obeys collision; a blocked landing keeps the player on
          // the door with the arrival disable intact.
          if (canMove(this.map, this.entities, this.player, "down", this.tilePairs).ok) {
            this.warpEntryCell = undefined;
            this.scriptMove(this.player, "down", 1);
          } else {
            this.player.facing = "down";
          }
        }
      },
      () => {
        this.transitioning = false;
        onDone?.();
      },
    );
  }

  // OverworldController.lua:4172 scriptMove
  scriptMove(entity: Player | NPC, dir: Dir, tiles: number, onDone?: () => void): void {
    this.scriptMoves.push({ entity, dir, remaining: tiles, onDone });
  }

  // OverworldController.lua:4195 updateScriptMoves — two phases so a
  // chained step begins the SAME frame the previous one ends: phase 1
  // retires finished moves (which may chain new ones); phase 2 starts
  // every not-yet-moving move.
  updateScriptMoves(): void {
    let i = 0;
    while (i < this.scriptMoves.length) {
      const mv = this.scriptMoves[i];
      if (!mv.entity.moving && mv.remaining <= 0) {
        this.scriptMoves.splice(i, 1);
        mv.onDone?.();
        // don't advance i: a move chained by onDone may now sit at i
      } else {
        i += 1;
      }
    }
    for (const mv of this.scriptMoves) {
      const e = mv.entity;
      if (!e.moving && mv.remaining > 0) {
        if (mv.inPlace) {
          e.moving = true;
          (e as NPC).marching = true;
          e.progress = 0;
        } else {
          e.facing = mv.dir!;
          const [tx, ty] = target(e.cellX, e.cellY, mv.dir!);
          e.targetX = tx;
          e.targetY = ty;
          e.moving = true;
          e.progress = 0;
          if (e instanceof Player) {
            e.stepFramesCur = e.stepFrames;
          }
        }
        mv.remaining -= 1;
      }
    }
  }

  // ScriptWorld surface for the runner's verbs -------------------------------

  showText(text: string, onDone?: () => void): void {
    this.shell.showText(text, onDone);
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.shell.showChoice(text, choice);
  }

  setEmote(entity: unknown, kind: number, frames: number, onDone: () => void): void {
    this.emote = { entity: entity as Player | NPC, kind, frames, onDone };
  }
}
