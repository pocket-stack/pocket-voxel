// The RNG contract for the voxelmon rules modules.
//
// Every rules function takes the rng as a parameter — never a global — the
// injection style of gen1recomp tests/harness.lua (T.rng.fixed/T.rng.seq are
// plain functions handed into the formula under test). The reference consumes
// rolls through Lua's `rng(min, max)` call shape (inclusive both ends, the
// love.math.random signature); the shapes map onto this interface as:
//
//   rng(0, 255)            -> rng.byte()
//   rng(0, n)              -> rng.int(n + 1)
//   rng(min, max)          -> randRange(rng, min, max)
//
// so a byte roll is one byte() call and every other roll is one int() call —
// roll-for-roll the same consumption as the Lua.

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform integer in [0, 255] — the Lua modules' rand(0..255) shape. */
  byte(): number;
}

/** The Lua `rng(min, max)` call shape (inclusive), one int() roll. */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng.int(max - min + 1);
}

/**
 * Deterministic seeded stream: a 32-bit LCG (Numerical Recipes constants).
 * Same seed, same roll sequence, on every host — this is the guest's own
 * RNG, not a port of a Lua generator (the reference leans on
 * love.math.random, which the harness always overrides with injected rolls).
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return {
    int(maxExclusive: number): number {
      return (next() >>> 8) % maxExclusive;
    },
    byte(): number {
      return next() >>> 24;
    },
  };
}

/**
 * Test injector mirroring harness.lua T.rng.fixed: every roll returns
 * `value` regardless of the requested range (the harness's fixed fn ignores
 * its min/max args the same way). Callers pick in-range values.
 */
export function fixedRng(value: number): Rng {
  return { int: () => value, byte: () => value };
}

/**
 * Test injector mirroring harness.lua T.rng.seq: successive rolls walk the
 * list, the last value repeats. int() and byte() share one cursor, matching
 * the Lua where every roll is the same function call.
 */
export function seqRng(...values: number[]): Rng {
  let i = 0;
  const next = (): number => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
  return { int: next, byte: next };
}
