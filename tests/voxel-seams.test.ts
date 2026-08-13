// Border-ring regression tests. The synthetic half runs without ROM data and
// pins the Lua ChunkMesher keep rules; the ROM-gated half cooks the six
// directed seams between Pallet, Route 1, Viridian and Route 2 in memory.

import { beforeAll, describe, expect, test } from "bun:test";

import {
  BAKE_PAGE_NONE,
  MESH_KIND,
  MESH_KINDS,
  VXPK_CHUNK_FLAG_BORDER_RING,
  VXPK_CHUNK_RECORD_SIZE,
  VXPK_TAG,
} from "../contracts/spec/voxel-spec.ts";
import type { Shape } from "../voxelmon/cook/classify.ts";
import { cookVoxelPak } from "../voxelmon/cook/core.ts";
import { GameMap, type GenData } from "../voxelmon/cook/data.ts";
import { GEN_DIR, genMissingReason, loadGen, loadProfile } from "../voxelmon/cook/data-node.ts";
import { FACE, keyOf, type Quad, type SGrid } from "../voxelmon/cook/geom.ts";
import {
  packMap,
  runGeometry,
  type BorderMask,
  type MapGeometry,
} from "../voxelmon/cook/mesh.ts";
import {
  placeDirectNeighbour,
  type ConnectionDirection,
} from "../voxelmon/shared/connections.ts";

const ground: Shape = { class: "ground", h: 0, art: "flat", flat: true, authored: false };

function syntheticMap(): GameMap {
  return new GameMap(
    {
      id: "SYNTH",
      index: 9000,
      tileset: "SYNTH_SET",
      width: 1,
      height: 1,
      blocks: [0],
      borderBlock: 0,
      outdoor: true,
    },
    {
      id: "SYNTH_SET",
      image: "assets/generated/synth.png",
      imageWidth: 128,
      imageHeight: 8,
      tilesPerRow: 16,
      blocks: [new Array<number>(16).fill(0)],
      walkable: [0],
    },
  );
}

function emptyGrid(): SGrid {
  return {
    shapeAt: new Map(),
    tileAt: new Map(),
    outdoor: true,
    hideBareRing: false,
    runs: new Map(),
    skip: new Set(),
    ground: new Map(),
    doorFold: new Set(),
    objectQuads: [],
    grassQuads: [],
    flowerQuads: [],
    roundStamps: [],
    round: new Set(),
    stampQuads: new Map(),
    wallTiles: null,
    x0: -12,
    x1: 15,
    y0: -12,
    y1: 15,
  };
}

function flatQuad(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  own = false,
): Quad {
  return {
    c: [
      [x0, 8, z0],
      [x1, 8, z0],
      [x1, 8, z1],
      [x0, 8, z1],
    ],
    u: 0,
    v: 0,
    shade: 1,
    f: FACE.up,
    own: own || undefined,
  };
}

function northEdgeQuad(x0: number, x1: number, facing: typeof FACE.north | typeof FACE.south): Quad {
  return {
    c: [
      [x1, 0, 0],
      [x0, 0, 0],
      [x0, 8, 0],
      [x1, 8, 0],
    ],
    u: 0,
    v: 0,
    shade: 1,
    f: facing,
  };
}

function bounds(q: Quad): [number, number, number, number] {
  const xs = q.c.map((corner) => corner[0]);
  const zs = q.c.map((corner) => corner[2]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

const NORTH_MASK: BorderMask = { x0: 0, z0: -32, x1: 32, z1: 0 };

describe("synthetic border-ring routing", () => {
  test("tile masks use open overlap and keep a boundary-touching ring cell", () => {
    const grid = emptyGrid();
    // This tile is under the neighbour body and must disappear.
    grid.shapeAt.set(keyOf(0, -1), ground);
    grid.tileAt.set(keyOf(0, -1), 0);
    // This one only TOUCHES the mask at x=0. Lua's strict `masked` keeps it.
    grid.shapeAt.set(keyOf(-1, -1), ground);
    grid.tileAt.set(keyOf(-1, -1), 0);

    const geometry = runGeometry(syntheticMap(), grid, [NORTH_MASK], true);
    const tops = geometry.terrain.filter((quad) => quad.f === FACE.up);
    expect(tops.some((quad) => bounds(quad).toString() === "0,-8,8,0")).toBe(false);
    const touching = tops.find((quad) => bounds(quad).toString() === "-8,-8,0,0");
    expect(touching).toBeDefined();
    expect(touching!.borderRing).toBe(true);
  });

  test("objects use closed masks while own and outward edge faces stay body geometry", () => {
    const grid = emptyGrid();
    grid.objectQuads.push(
      flatQuad(30, 8, 34, 12), // overlaps the open body interval
      flatQuad(2, -4, 6, -1, true), // own eave over the masked neighbour
      northEdgeQuad(8, 12, FACE.north), // outward body facade
      northEdgeQuad(16, 20, FACE.south), // inward ring scrap on the same plane
      flatQuad(32, -8, 36, -4), // only touches the mask at x=32
      flatQuad(-8, 8, -4, 12), // unmasked protective ring
    );

    const geometry = runGeometry(syntheticMap(), grid, [NORTH_MASK], true);
    const objects = geometry.terrain.filter((quad) => !quad.tree);
    expect(objects).toHaveLength(4);
    expect(objects.some((quad) => quad.own && quad.borderRing !== true)).toBe(true);
    expect(objects.some((quad) => quad.f === FACE.north && quad.borderRing !== true)).toBe(true);
    expect(objects.some((quad) => quad.f === FACE.south)).toBe(false);
    const ring = objects.find((quad) => bounds(quad).toString() === "-8,8,-4,12");
    expect(ring?.borderRing).toBe(true);
  });

  test("round stamps skip contained masks and split straddling versus ring quads", () => {
    const grid = emptyGrid();
    const template = flatQuad(-2, -2, 2, 2);
    grid.roundStamps.push(
      { quads: [template], coarse: [template], mx: 8, mz: -8 }, // contained in mask
      { quads: [template], coarse: [template], mx: 24, mz: 0 }, // overlaps body
      { quads: [template], coarse: [template], mx: -8, mz: 16 }, // pure unmasked ring
    );

    const geometry = runGeometry(syntheticMap(), grid, [NORTH_MASK], true);
    const fine = geometry.terrain.filter((quad) => quad.tree);
    expect(fine).toHaveLength(2);
    expect(geometry.treeCoarse).toHaveLength(2);
    for (const stream of [fine, geometry.treeCoarse]) {
      expect(stream.filter((quad) => quad.borderRing).length).toBe(1);
      expect(stream.filter((quad) => !quad.borderRing).length).toBe(1);
      expect(stream.some((quad) => bounds(quad).toString() === "6,-10,10,-6")).toBe(false);
    }
  });

  test("packer emits body and ring as distinct records at the same chunk coordinate", () => {
    const body = flatQuad(8, 8, 12, 12);
    const ring = { ...flatQuad(16, 16, 20, 20), borderRing: true };
    const geometry: MapGeometry = {
      terrain: [body, ring],
      treeCoarse: [],
      treeBox: [],
      water: [],
      grass: [],
      flower: [],
      stamps: new Map(),
    };
    const packed = packMap(geometry, { baseY: 0, pageW: 128, pageH: 128 });
    expect(packed.chunks).toHaveLength(2);
    expect(packed.chunks.map((chunk) => [chunk.cx, chunk.cy])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(packed.chunks.map((chunk) => chunk.flags ?? 0)).toEqual([
      VXPK_CHUNK_FLAG_BORDER_RING,
      0,
    ]);
    expect(
      packed.chunks.reduce(
        (sum, chunk) => sum + chunk.meshes[MESH_KIND.terrain].verts.length,
        0,
      ),
    ).toBe(8);
  });
});

interface ParsedMesh {
  verts: [number, number, number][];
  indexCount: number;
}

interface ParsedChunk {
  mapId: number;
  flags: number;
  bakePage: number;
  meshes: ParsedMesh[];
}

function parseChunks(bytes: Uint8Array): ParsedChunk[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let chunksOffset = -1;
  for (let i = 0; i < data.getUint16(6, true); i++) {
    const entry = 16 + i * 16;
    if (data.getUint32(entry, true) === VXPK_TAG.chunks) {
      chunksOffset = data.getUint32(entry + 4, true);
      break;
    }
  }
  expect(chunksOffset).toBeGreaterThanOrEqual(0);
  const mapCount = data.getUint16(chunksOffset, true);
  const total = data.getUint32(chunksOffset + 4, true);
  const vertsOffset = data.getUint32(chunksOffset + 8, true);
  const recordsOffset = chunksOffset + 32 + mapCount * 12;
  const owner = new Array<number>(total);
  for (let i = 0; i < mapCount; i++) {
    const entry = chunksOffset + 32 + i * 12;
    const mapId = data.getUint32(entry, true);
    const first = data.getUint32(entry + 4, true);
    const count = data.getUint32(entry + 8, true);
    for (let c = first; c < first + count; c++) owner[c] = mapId;
  }
  const chunks: ParsedChunk[] = [];
  for (let i = 0; i < total; i++) {
    const record = recordsOffset + i * VXPK_CHUNK_RECORD_SIZE;
    const meshes: ParsedMesh[] = [];
    for (let kind = 0; kind < MESH_KINDS; kind++) {
      const range = record + 20 + kind * 12;
      const vertBase = data.getUint32(range, true);
      const vertCount = data.getUint16(range + 4, true);
      const indexCount = data.getUint16(range + 6, true);
      const verts: [number, number, number][] = [];
      for (let v = 0; v < vertCount; v++) {
        const at = chunksOffset + vertsOffset + (vertBase + v) * 16;
        verts.push([
          data.getInt16(at + 8, true),
          data.getInt16(at + 10, true),
          data.getInt16(at + 12, true),
        ]);
      }
      meshes.push({ verts, indexCount });
    }
    chunks.push({
      mapId: owner[i]!,
      bakePage: data.getUint16(record + 16, true),
      flags: data.getUint16(record + 18, true),
      meshes,
    });
  }
  return chunks;
}

function masksFor(gen: GenData, mapId: string, cooked: ReadonlySet<string>): BorderMask[] {
  const current = gen.maps[mapId];
  const masks: BorderMask[] = [];
  for (const [direction, connection] of Object.entries(current.connections ?? {})) {
    if (!cooked.has(connection.map)) continue;
    const destination = gen.maps[connection.map];
    const { ox, oy } = placeDirectNeighbour(
      direction as ConnectionDirection,
      connection,
      current,
      destination,
    );
    masks.push({
      x0: ox,
      z0: oy,
      x1: ox + destination.width * 32,
      z1: oy + destination.height * 32,
    });
  }
  return masks;
}

function overlapsOpen(
  [x0, z0, x1, z1]: [number, number, number, number],
  mask: BorderMask,
): boolean {
  return x1 > mask.x0 && x0 < mask.x1 && z1 > mask.z0 && z0 < mask.z1;
}

const romReason = genMissingReason();
if (romReason) console.error(`voxel seam ROM tests skipped — ${romReason}`);

describe.skipIf(romReason !== null)("ROM connected-map seams", () => {
  const mapNames = ["PALLET_TOWN", "ROUTE_1", "VIRIDIAN_CITY", "ROUTE_2"] as const;
  const cooked = new Set<string>(mapNames);
  let gen: GenData;
  let chunks: ParsedChunk[];

  beforeAll(() => {
    gen = loadGen(GEN_DIR);
    const artifacts = cookVoxelPak({
      gen,
      profile: loadProfile(),
      redpp: null,
      mapNames,
    });
    chunks = parseChunks(artifacts.pak);
  });

  const directed = [
    ["PALLET_TOWN", "north", "ROUTE_1"],
    ["ROUTE_1", "south", "PALLET_TOWN"],
    ["ROUTE_1", "north", "VIRIDIAN_CITY"],
    ["VIRIDIAN_CITY", "south", "ROUTE_1"],
    ["VIRIDIAN_CITY", "north", "ROUTE_2"],
    ["ROUTE_2", "south", "VIRIDIAN_CITY"],
  ] as const;

  for (const [currentId, direction, destinationId] of directed) {
    test(`${currentId} ${direction} -> ${destinationId} has a reciprocal seam placement`, () => {
      const current = gen.maps[currentId];
      const destination = gen.maps[destinationId];
      const connection = current.connections?.[direction];
      expect(connection?.map).toBe(destinationId);
      const inverse = direction === "north" ? "south" : "north";
      const back = destination.connections?.[inverse];
      expect(back?.map).toBe(currentId);
      const forwardAt = placeDirectNeighbour(direction, connection!, current, destination);
      const backAt = placeDirectNeighbour(inverse, back!, destination, current);
      expect(forwardAt.ox + backAt.ox).toBe(0);
      expect(forwardAt.oy + backAt.oy).toBe(0);
    });
  }

  test("ring records never enter a cooked direct-neighbour body", () => {
    for (const mapName of mapNames) {
      const mapId = gen.maps[mapName].index;
      const records = chunks.filter((chunk) => chunk.mapId === mapId);
      const body = records.filter((chunk) => chunk.flags === 0);
      const ring = records.filter(
        (chunk) => chunk.flags === VXPK_CHUNK_FLAG_BORDER_RING,
      );
      expect(body.length, `${mapName} body records`).toBeGreaterThan(0);
      expect(ring.length, `${mapName} ring records`).toBeGreaterThan(0);
      const masks = masksFor(gen, mapName, cooked);
      expect(masks.length, `${mapName} cooked neighbour masks`).toBeGreaterThan(0);
      for (const chunk of ring) {
        expect(chunk.bakePage).toBe(BAKE_PAGE_NONE);
        expect(chunk.meshes[MESH_KIND.groundBake].indexCount).toBe(0);
        expect(chunk.meshes[MESH_KIND.grass].indexCount).toBe(0);
        expect(chunk.meshes[MESH_KIND.flower].indexCount).toBe(0);
        for (const mesh of chunk.meshes) {
          expect(mesh.verts.length % 4).toBe(0);
          for (let q = 0; q < mesh.verts.length; q += 4) {
            const quad: Quad = {
              c: mesh.verts.slice(q, q + 4),
              shade: 1,
              f: FACE.up,
            };
            const rect = bounds(quad);
            for (const mask of masks) {
              expect(
                overlapsOpen(rect, mask),
                `${mapName} ring quad ${rect.join(",")} overlaps ${JSON.stringify(mask)}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  test("an uncooked exit retains the protective ring over that destination", () => {
    const artifacts = cookVoxelPak({
      gen,
      profile: loadProfile(),
      redpp: null,
      mapNames: ["PALLET_TOWN"],
    });
    const pallet = parseChunks(artifacts.pak).filter(
      (chunk) => chunk.mapId === gen.maps.PALLET_TOWN.index,
    );
    const routeMask = masksFor(gen, "PALLET_TOWN", new Set(["PALLET_TOWN", "ROUTE_1"]))[0];
    let retained = false;
    for (const chunk of pallet) {
      if (chunk.flags !== VXPK_CHUNK_FLAG_BORDER_RING) continue;
      for (const mesh of chunk.meshes) {
        for (let q = 0; q < mesh.verts.length; q += 4) {
          const quad: Quad = {
            c: mesh.verts.slice(q, q + 4),
            shade: 1,
            f: FACE.up,
          };
          if (overlapsOpen(bounds(quad), routeMask)) retained = true;
        }
      }
    }
    expect(retained).toBe(true);
  });
});
