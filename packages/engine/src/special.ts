/**
 * Special functions. `@fumoca/gpu`'s prelude mirrors these formula for formula (SPECS.md §6.7);
 * keep them in sync.
 */

/**
 * Standard normal cumulative distribution function, Φ(x). Hart's double-precision algorithm
 * (G. West, "Better approximations to cumulative normal functions", 2005): absolute error about
 * 1e-14, and relative error below 1e-8 even far in the tails. It uses only exp and rational
 * polynomials, so it translates directly to WGSL.
 */
export function normalCdf(x: number): number {
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      tail = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      tail = e / d / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/** Standard normal probability density function, φ(x). */
export function normalPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/** Acklam's coefficients for the inverse normal CDF: central region (a, b) and tails (c, d). */
const ACKLAM = {
  a: [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472,
    2.50662827745924,
  ],
  b: [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857],
  c: [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878,
  ],
  d: [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742],
};

/** The lower tail's crossover in Acklam's algorithm. */
export const NORMAL_INVERSE_LOW = 0.02425;

/**
 * Inverse standard normal CDF, Φ⁻¹(p), for p in (0, 1); NaN outside it (Excel's #NUM!).
 * P. J. Acklam's rational approximation (relative error 1.15e-9), which the GPU prelude mirrors
 * in f32, then one Halley step against `normalCdf` to reach double precision on the CPU.
 */
export function normalInverse(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;
  const { a, b, c, d } = ACKLAM;
  const poly = (k: number[], x: number) => k.reduce((acc, coefficient) => acc * x + coefficient, 0);
  let x: number;
  if (p < NORMAL_INVERSE_LOW || p > 1 - NORMAL_INVERSE_LOW) {
    const q = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
    const tail = poly(c, q) / (poly(d, q) * q + 1);
    x = p < 0.5 ? tail : -tail;
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (poly(a, r) * q) / (poly(b, r) * r + 1);
  }
  // Halley's method: the error in the CDF over the density, corrected for curvature.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
