/**
 * WGSL helper functions included in every generated kernel.
 *
 * The random-number functions mirror `@fumoca/engine`'s random.ts bit for bit, and the samplers
 * mirror its CPU evaluator formula for formula (SPECS.md §6.7). Keep them in sync.
 */
export const PRELUDE = /* wgsl */ `
fn fm_hash(input: u32) -> u32 {
  var h = input;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn fm_random_u32(seed: u32, iteration: u32, stream: u32, k: u32) -> u32 {
  return fm_hash(fm_hash(fm_hash(fm_hash(seed) ^ iteration) ^ stream) ^ k);
}

fn fm_unit(seed: u32, iteration: u32, stream: u32, k: u32) -> f32 {
  return (f32(fm_random_u32(seed, iteration, stream, k) >> 9u) + 0.5) * (1.0 / 8388608.0);
}

// WGSL leaves log and sqrt of a negative number undefined, and some adapters (SwiftShader) return
// a finite value. Match the CPU: NaN for negatives, and -infinity for ln(0). The special values
// are built from x's bits because WGSL rejects NaN and infinity in constant expressions.
fn fm_ln(x: f32) -> f32 {
  if (x < 0.0) {
    return bitcast<f32>(bitcast<u32>(x) | 0x7fc00000u);
  }
  if (x == 0.0) {
    return bitcast<f32>(bitcast<u32>(x) | 0xff800000u);
  }
  return log(x);
}

fn fm_sqrt(x: f32) -> f32 {
  if (x < 0.0) {
    return bitcast<f32>(bitcast<u32>(x) | 0x7fc00000u);
  }
  return sqrt(x);
}

// cos(pi * t) for t in [-1, 1]. WGSL only requires the builtin cos to be accurate to 2^-11
// absolute, and some adapters (SwiftShader, some mobile GPUs) use all of that, which is far
// beyond f32 rounding and breaks the CPU cross-check. Arithmetic keeps f32 accuracy everywhere.
fn fm_cospi(t: f32) -> f32 {
  var a = abs(t);
  var sign = 1.0;
  if (a > 0.5) {
    a = 1.0 - a; // cos(pi * a) = -cos(pi * (1 - a))
    sign = -1.0;
  }
  // Now a is in [0, 0.5]. Use sin(pi * (0.5 - a)) past 0.25 so the argument stays within pi / 4.
  if (a > 0.25) {
    let x = 3.14159265358979 * (0.5 - a);
    let x2 = x * x;
    return sign * x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0
      + x2 * (1.0 / 362880.0)))));
  }
  let x = 3.14159265358979 * a;
  let x2 = x * x;
  return sign * (1.0 + x2 * (-0.5 + x2 * (1.0 / 24.0 + x2 * (-1.0 / 720.0 + x2 * (1.0 / 40320.0
    + x2 * (-1.0 / 3628800.0))))));
}

fn fm_standard_normal(seed: u32, iteration: u32, stream: u32) -> f32 {
  let u1 = fm_unit(seed, iteration, stream, 0u);
  let u2 = fm_unit(seed, iteration, stream, 1u);
  return sqrt(-2.0 * log(u1)) * fm_cospi(2.0 * u2 - 1.0);
}

fn fm_uniform(seed: u32, iteration: u32, stream: u32, lo: f32, hi: f32) -> f32 {
  return lo + (hi - lo) * fm_unit(seed, iteration, stream, 0u);
}

fn fm_normal(seed: u32, iteration: u32, stream: u32, mean: f32, sd: f32) -> f32 {
  return mean + sd * fm_standard_normal(seed, iteration, stream);
}

// Excel's LOGNORM convention: mean and sd are the parameters of ln(X).
fn fm_lognormal(seed: u32, iteration: u32, stream: u32, mean: f32, sd: f32) -> f32 {
  return exp(mean + sd * fm_standard_normal(seed, iteration, stream));
}

fn fm_triangular(seed: u32, iteration: u32, stream: u32, lo: f32, mode: f32, hi: f32) -> f32 {
  let u = fm_unit(seed, iteration, stream, 0u);
  let width = hi - lo;
  if (u < (mode - lo) / width) {
    return lo + sqrt(u * width * (mode - lo));
  }
  return hi - sqrt((1.0 - u) * width * (hi - mode));
}

// WGSL's pow is undefined for x <= 0. Match Excel (and the CPU) for negative bases with
// integer exponents, and for zero bases.
fn fm_pow(x: f32, y: f32) -> f32 {
  if (x == 0.0) {
    if (y > 0.0) { return 0.0; }
    if (y == 0.0) { return 1.0; }
  }
  if (x < 0.0 && y == floor(y)) {
    let p = pow(-x, y);
    if (abs(y % 2.0) == 1.0) { return -p; }
    return p;
  }
  return pow(x, y);
}

// Standard normal CDF: Hart's algorithm, mirroring @fumoca/engine special.ts.
fn fm_normcdf(x: f32) -> f32 {
  let z = abs(x);
  var tail = 0.0;
  if (z <= 37.0) {
    let e = exp(-z * z / 2.0);
    if (z < 7.07106781186547) {
      var n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      var d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      tail = e * n / d;
    } else {
      var d = z + 0.65;
      d = z + 4.0 / d;
      d = z + 3.0 / d;
      d = z + 2.0 / d;
      d = z + 1.0 / d;
      tail = e / d / 2.506628274631;
    }
  }
  if (x > 0.0) { return 1.0 - tail; }
  return tail;
}

// Standard normal density.
fn fm_normpdf(x: f32) -> f32 {
  return exp(-x * x / 2.0) / 2.5066282746310002;
}

// 1 for a finite value, 0 for NaN or infinity (an error). Tested on the bits, since compilers
// may assume floats are never NaN.
fn fm_finite(x: f32) -> f32 {
  return select(0.0, 1.0, (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u);
}

// Inverse standard normal CDF: Acklam's rational approximation, as in the engine's
// normalInverse, then one Newton step against fm_normcdf, since f32 rounding in Acklam's central
// polynomial costs up to 1e-4. It works on the lower tail and mirrors it, because f32 can't tell
// values of Φ close to 1 apart. NaN outside (0, 1), built from p's bits.
fn fm_norminv(p: f32) -> f32 {
  if (!(p > 0.0 && p < 1.0)) {
    return bitcast<f32>(bitcast<u32>(p) | 0x7fc00000u);
  }
  let lower = min(p, 1.0 - p);
  var x: f32;
  if (lower < 0.02425) {
    let q = sqrt(-2.0 * log(lower));
    let n = ((((-0.00778489400243029 * q - 0.322396458041136) * q - 2.40075827716184) * q
      - 2.54973253934373) * q + 4.37466414146497) * q + 2.93816398269878;
    let d = (((0.00778469570904146 * q + 0.32246712907004) * q + 2.445134137143) * q
      + 3.75440866190742) * q + 1.0;
    x = n / d;
  } else {
    let q = lower - 0.5;
    let r = q * q;
    let n = (((((-39.6968302866538 * r + 220.946098424521) * r - 275.928510446969) * r
      + 138.357751867269) * r - 30.6647980661472) * r + 2.50662827745924) * q;
    let d = ((((-54.4760987982241 * r + 161.585836858041) * r - 155.698979859887) * r
      + 66.8013118877197) * r - 13.2806815528857) * r + 1.0;
    x = n / d;
  }
  x = x - (fm_normcdf(x) - lower) * 2.5066282746310002 * exp(x * x / 2.0);
  return select(x, -x, p > 0.5);
}

fn fm_bool(b: bool) -> f32 {
  return select(0.0, 1.0, b);
}
`;
