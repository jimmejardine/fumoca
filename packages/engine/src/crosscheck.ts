/**
 * Comparing CPU (f64) and GPU (f32) samples of the same cell, iteration by iteration
 * (SPECS.md §6.7). Both backends draw identical random inputs, so beyond f32 rounding any
 * difference is a bug in one of them.
 */

export interface SampleComparison {
  /** Largest relative error seen, with an absolute floor of 1 (see `relativeError`). */
  maxRelativeError: number;
  /** Iterations whose relative error exceeds the tolerance (or where one side is NaN). */
  mismatches: number;
  /** Whether the mismatches are within the allowed fraction. */
  agrees: boolean;
}

/** Relative error with an absolute floor, so values near 0 aren't judged on relative error alone. */
export function relativeError(expected: number, actual: number): number {
  return Math.abs(expected - actual) / Math.max(Math.abs(expected), 1);
}

/**
 * Compares the first `count` samples of two runs. A small fraction of mismatches is allowed:
 * f32 rounding can flip a comparison right on an `IF` threshold and send one iteration down a
 * different branch.
 */
export function compareSamples(
  expected: ArrayLike<number>,
  actual: ArrayLike<number>,
  count: number,
  tolerance = 1e-4,
  allowedMismatchFraction = 0.001,
): SampleComparison {
  let maxRelativeError = 0;
  let mismatches = 0;
  for (let i = 0; i < count; i++) {
    const a = expected[i] ?? Number.NaN;
    const b = actual[i] ?? Number.NaN;
    // Identical values (including both infinite with the same sign) always agree.
    const error = a === b ? 0 : relativeError(a, b);
    if (!(error <= tolerance)) mismatches++;
    if (error > maxRelativeError) maxRelativeError = error;
  }
  return {
    maxRelativeError,
    mismatches,
    agrees: mismatches <= Math.floor(count * allowedMismatchFraction),
  };
}
