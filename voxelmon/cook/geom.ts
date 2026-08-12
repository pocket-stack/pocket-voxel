// voxelmon/cook/geom.ts — shared geometry types for the cook passes.
//
// Every pass emits QUADS in map-local world px (voxel-spec WORLD_AXES: +X
// east, +Y up, +Z south). UVs are carried in SHEET-PIXEL coordinates of the
// tileset atlas (texel units, insets included); cook/mesh.ts converts them
// into combined-page UV space when packing vertices.

import type { Shape } from "./classify.ts";

/**
 * Face direction ids, the terrain mesher's `SIDES` numbering (VoxelMod
 * Voxel3D.lua:63, the same order as spec `FACE_SHADE`). Every emitted quad
 * names the direction its FRONT points in, independent of corner winding —
 * the cooked streams do not share one winding (docs/VOXEL.md §6), so the
 * outward direction has to be stated, not derived.
 */
export const FACE = {
  east: 1, // +X
  west: 2, // -X
  up: 3, // +Y
  down: 4, // -Y
  south: 5, // +Z
  north: 6, // -Z
} as const;

export type Facing = (typeof FACE)[keyof typeof FACE];

export interface Quad {
  /** Four corners, [x, y, z] world px. */
  c: [number, number, number][];
  /** Per-corner UV in sheet px, or a single point via u/v. */
  uv?: [number, number][];
  u?: number;
  v?: number;
  /** Flat shade, or per-corner shades (AO-folded). */
  shade: number | number[];
  /** Which way this face points (see FACE). Required: it drives the cull. */
  f: Facing;
  /** A body-anchored building's own quad — exempt from edge keep-rules. */
  own?: boolean;
  /**
   * A carved round-scenery (tree) quad. It rides the TERRAIN stream through
   * the whole cook — analysis, culling, chunk partition and batching — and
   * is split off into `MESH_KIND.treeHull` only at pack time, so the near
   * level of detail keeps the exact quad order it had when tree hulls were
   * simply part of the terrain (cook/mesh.ts packMap).
   */
  tree?: boolean;
}

/**
 * The hidden-face cull: faces no camera this runtime can build will ever see
 * from the front, dropped at cook time. The caller's `keepHidden` option
 * restores every face, which is the A/B control the acceptance runs use.
 *
 * **What the cameras can reach.** The field camera has a FIXED AZIMUTH
 * (pocketvoxel-core/src/cam.rs `orbit`): the eye is always
 * `(cx, dist*cos a, cy + dist*sin a)` looking at `(cx, 0, cy)` — due south of
 * the focus, looking north, with only the pitch `a` varying over PITCH_RUNGS
 * (0..75 degrees from straight down) and its tween. The battle rig
 * (cam.rs `battle`) does orbit, and it draws the SAME chunk meshes.
 *
 * **-Y (down) faces below the eye-height floor are unreachable.** A downward
 * face at world y is front-facing only when the eye is BELOW it. Eye height
 * is a function of the rung / rig alone, never of where the player stands:
 * `WORLD_VIEW_H * cos 75deg` = 35.20 px for the field camera, 37.12 px for the
 * tele rig and 27.91 px for the wide rig (both at minimum dolly and zero pitch
 * steer, which only raises the eye). `DOWN_CULL_Y` sits under all three.
 *
 * **-Z (north) faces are NOT unreachable — measured, not assumed.** A
 * north-facing wall is front-facing wherever `z > eye.z = cy + dist*sin a`,
 * and at rung 0 `eye.z` IS the middle of the frame: the southern half of a
 * top-down frame shows the north walls of everything in it. Dropping them
 * moves 16 of the 30 pitch-ladder frames (20916 pixels, worst 7076 in one
 * frame) and breaks the `route-1` story golden. The facing is tagged anyway
 * so the next camera change can be re-measured against it, but it is kept.
 *
 * **Pulled streams are exempt.** draw.rs draws GRASS and FLOWER with a
 * camera-ward `pull` (46 px at rung 0), displacing each vertex along its OWN
 * eye ray — not a rigid transform, so a quad's cooked facing is not its drawn
 * facing. TERRAIN, WATER and the stamps draw with `pull = 0.0` and keep
 * theirs. Culling the pulled streams costs 4380 (grass) + 415 (flower) pixels
 * over the ladder and breaks six story and two battle goldens.
 *
 * A free-roam or orbiting FIELD camera (docs/VOXEL.md §6, "first/third-person
 * free-roam ... are later rungs") must DELETE this optimisation rather than
 * work around it: the pak would be missing faces that camera can reach.
 * Anything that lowers a camera's eye under `DOWN_CULL_Y` — a new rig, a
 * lower `RIG.*.height`, a sixth pitch rung past 75 degrees — invalidates the
 * cooked pak, not just this file.
 */
/** Eye-height floor in world px, held under the runtime's lowest camera
 * (27.91, the wide battle rig). A -Y face topping out at or below this is
 * back-facing for every camera. */
export const DOWN_CULL_Y = 24;

/** Streams draw.rs displaces per-vertex toward the camera: facing-exempt. */
export const PULLED = true;

/** True when a quad of this facing, whose highest corner is at `topY`, can be
 * front-facing for some camera this runtime can build. */
export function visibleFacing(f: Facing, topY: number): boolean {
  return f !== FACE.down || topY > DOWN_CULL_Y;
}

/** Drop the faces `visibleFacing` rules out. THE one drop site. */
export function cullHidden(quads: Quad[], pulled = false, keepHidden = false): Quad[] {
  if (keepHidden || pulled) return quads;
  return quads.filter((q) => visibleFacing(q.f, Math.max(...q.c.map((c) => c[1]))));
}

/** One measured volume run (VoxelMod Structures.lua:2208/2271). */
export interface Run {
  front: number;
  north: number;
  extent: number;
  unit: number;
  fromRepeat: boolean;
  door: boolean;
  roofRows: number;
  rise: number;
  peak: number;
  /** Facade height: what sides build to. */
  h: number;
}

/** Grid key (VoxelMod Structures.lua:133 keyOf). */
export function keyOf(tx: number, ty: number): number {
  return (ty + 64) * 4096 + (tx + 64);
}

export function txOf(key: number): number {
  return (key % 4096) - 64;
}

export function tyOf(key: number): number {
  return Math.floor(key / 4096) - 64;
}

export const DIRS4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The per-map analysis state (VoxelMod Structures.forMap's `S`). */
export interface SGrid {
  shapeAt: Map<number, Shape>;
  tileAt: Map<number, number>;
  outdoor: boolean;
  hideBareRing: boolean;
  runs: Map<number, Run>;
  skip: Set<number>;
  /** Synthesized ground under claimed tiles; false = vote pending. */
  ground: Map<number, number | false>;
  doorFold: Set<number>;
  objectQuads: Quad[];
  grassQuads: Quad[];
  flowerQuads: Quad[];
  roundStamps: { quads: Quad[]; coarse: Quad[]; mx: number; mz: number; r?: number }[];
  /**
   * Tile keys a carved hull claimed. These are the cells the FAR level of
   * detail re-extrudes as plain boxes (`MESH_KIND.treeBox`), so it is the
   * hull's own claim list and not `skip`, which buildings, standees and
   * grass also write to.
   */
  round: Set<number>;
  /** Cut-tree stamps: "cx,cy" cell key -> quads (become STMP records). */
  stampQuads: Map<string, Quad[]>;
  /**
   * The border tree wall's tile set, when this map rings with trees. Wall
   * cells take the BOX path instead of the hull carve — replicating a
   * ~700-quad hull over hundreds of identical wall cells blows the §8
   * vertex budget (see cook/trees.ts).
   */
  wallTiles: Set<number> | null;
  /** Analysed tile range (body + ring), inclusive. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
