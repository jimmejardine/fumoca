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

fn fm_standard_normal(seed: u32, iteration: u32, stream: u32) -> f32 {
  let u1 = fm_unit(seed, iteration, stream, 0u);
  let u2 = fm_unit(seed, iteration, stream, 1u);
  return sqrt(-2.0 * log(u1)) * cos(3.14159265358979 * (2.0 * u2 - 1.0));
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

fn fm_bool(b: bool) -> f32 {
  return select(0.0, 1.0, b);
}
`;
