// voxelmon/cook/volumes.ts — volume measurement.
//
// Exact port of VoxelMod lib/Structures.lua:2145-2279 buildVolume: flood-fed
// regions of structural tiles get per-column vertical runs, repeat-aware
// drawn-unit heights, region height consensus (ties taller), door adoption,
// and the outdoor roof split.

import { VOLUME_MAX_ROWS } from "../../contracts/spec/voxel-spec.ts";
import type { GameMap } from "./data.ts";
import { keyOf, type Run, type SGrid } from "./geom.ts";

// VoxelMod Structures.lua:85 MAX_ROWS (== spec VOLUME_MAX_ROWS).
const MAX_ROWS = VOLUME_MAX_ROWS;

export function buildVolume(S: SGrid, map: GameMap, tiles: [number, number][]): void {
  // columns of the region, tx -> set of ty
  const cols = new Map<number, Set<number>>();
  for (const [tx, ty] of tiles) {
    let set = cols.get(tx);
    if (!set) cols.set(tx, (set = new Set()));
    set.add(ty);
  }

  const runs: { tx: number; run: Run }[] = [];
  const heightVotes = new Map<number, number>();
  const repeatVotes = new Map<number, number>();

  for (const tx of [...cols.keys()].sort((a, b) => a - b)) {
    // visit each contiguous vertical run in this column
    const sorted = [...cols.get(tx)!].sort((a, b) => a - b);
    let i = 0;
    while (i < sorted.length) {
      const north = sorted[i];
      let front = north;
      while (i + 1 < sorted.length && sorted[i + 1] === front + 1) {
        i++;
        front = sorted[i];
      }
      i++;
      const extent = front - north + 1;

      // The column's own reading: its extent, unless its tile sequence
      // repeats — then the repeat period is the drawn unit
      // (Structures.lua:2171-2199, including the trim-foot rule).
      let unit = Math.min(extent, MAX_ROWS);
      let repeatRead = false;
      if (extent > 1) {
        const t0 = map.tileAt(tx, front);
        for (let k = 1; k <= extent - 1; k++) {
          if (map.tileAt(tx, front - k) === t0) {
            unit = Math.min(Math.max(k, 2), MAX_ROWS);
            repeatRead = true;
            break;
          }
        }
        if (!repeatRead && extent > 2 && map.tileAt(tx, front - 1) === map.tileAt(tx, front - 2)) {
          unit = 2;
          repeatRead = true;
        }
      }
      let isDoor = false;
      for (let ty = north; ty <= front; ty++) {
        if (S.doorFold.has(keyOf(tx, ty))) {
          isDoor = true;
          break;
        }
      }
      const run: Run = {
        front,
        north,
        extent,
        unit,
        fromRepeat: repeatRead,
        door: isDoor,
        roofRows: 0,
        rise: 0,
        peak: 0,
        h: 0,
      };
      runs.push({ tx, run });
      const h = unit * 8;
      heightVotes.set(h, (heightVotes.get(h) ?? 0) + 1);
      if (repeatRead) repeatVotes.set(h, (repeatVotes.get(h) ?? 0) + 1);
    }
  }

  // Region consensus: the dominant height, ties taller
  // (Structures.lua:2221-2227).
  let modeH = 16;
  let modeN = 0;
  for (const [h, n] of [...heightVotes.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > modeN || (n === modeN && h > modeH)) {
      modeH = h;
      modeN = n;
    }
  }
  const modeRepeat = (repeatVotes.get(modeH) ?? 0) * 2 > modeN;

  for (const { tx, run } of runs) {
    let h = run.unit * 8;
    let adopted = false;
    let flatDoor = false;
    if (run.door) {
      // A folded doorway column answers to its region ENTIRELY
      // (Structures.lua:2233-2244).
      h = modeH;
      adopted = !modeRepeat;
      flatDoor = modeRepeat;
    } else if (run.fromRepeat && modeH > h) {
      h = modeH;
      adopted = true;
    }
    // Outdoors, drawn facades split roof rows off the top; repeats stay
    // flat unless adopted; flat ROOFTOPS (repeated top rows) stay level
    // (Structures.lua:2249-2270).
    let roofRows = 0;
    if (S.outdoor && (!run.fromRepeat || adopted) && h >= 16 && !flatDoor) {
      roofRows = Math.min(2, Math.floor(h / 8) - 1);
      if (roofRows > 0 && map.tileAt(tx, run.north) === map.tileAt(tx, run.north + 1)) {
        roofRows = 0;
      }
    }
    run.roofRows = roofRows;
    run.rise = roofRows * 8;
    run.peak = h;
    run.h = h - run.rise; // facade height: what sides build to
    for (let ty = run.north; ty <= run.front; ty++) {
      S.runs.set(keyOf(tx, ty), run);
    }
  }
}
