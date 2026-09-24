/**
 * Counter-based random numbers (SPECS.md §6.6, §6.7).
 *
 * Every random number is a pure function of (seed, iteration, stream, k), with no shared state,
 * so any backend can compute any iteration in any order. Only 32-bit integer operations are used,
 * which lets the WGSL kernel reproduce the exact same bits (see `@fumoca/gpu` prelude).
 * Keep the two implementations in sync.
 */

/** A 32-bit integer hash ("lowbias32" by Chris Wellons). */
export function hash32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The k-th random 32-bit integer for a stream at an iteration. */
export function randomU32(seed: number, iteration: number, stream: number, k: number): number {
  return hash32(hash32(hash32(hash32(seed) ^ iteration) ^ stream) ^ k);
}

/**
 * Maps a random 32-bit integer to a uniform number in the open interval (0, 1).
 * Keeps 23 bits so that the result is exactly representable in f32, making CPU (f64) and GPU (f32)
 * uniforms bit-identical.
 */
export function toUnit(u32: number): number {
  return ((u32 >>> 9) + 0.5) * 2 ** -23;
}

export function uniformUnit(seed: number, iteration: number, stream: number, k: number): number {
  return toUnit(randomU32(seed, iteration, stream, k));
}

/**
 * Standard normal sample using Box–Muller. The angle is kept in [-π, π], where WGSL's `cos` has
 * its tightest accuracy guarantee.
 */
export function standardNormal(seed: number, iteration: number, stream: number): number {
  const u1 = uniformUnit(seed, iteration, stream, 0);
  const u2 = uniformUnit(seed, iteration, stream, 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(Math.PI * (2 * u2 - 1));
}
