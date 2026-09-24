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
