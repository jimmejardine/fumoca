import type { BinaryFn, Op, Program, UnaryFn } from "@fumoca/engine";
import { PRELUDE } from "./prelude";

/** Threads per workgroup. Each thread computes one iteration of the model. */
export const WORKGROUP_SIZE = 64;

/**
 * Constants are read from a storage buffer (`consts`) rather than written into the shader, so
 * editing a value leaves the WGSL unchanged and the compiled pipeline can be reused
 * (SPECS.md §6.6). Slot `i` holds the program's `i`-th constant operation.
 */
function constantSlots(program: Program): Map<number, number> {
  const slots = new Map<number, number>();
  program.ops.forEach((op, reg) => {
    if (op.kind === "const") slots.set(reg, slots.size);
  });
  return slots;
}

/** The values for a program's `consts` buffer, in slot order (at least one, for a valid binding). */
export function constantValues(program: Program): Float32Array {
  const values = program.ops.flatMap((op) => (op.kind === "const" ? [op.value] : []));
  return Float32Array.from(values.length > 0 ? values : [0]);
}

const CONSTS_BINDING = `@group(0) @binding(2) var<storage, read> consts: array<f32>;`;

const r = (reg: number): string => `r${reg}`;

function unary(fn: UnaryFn, a: string): string {
  switch (fn) {
    case "neg":
      return `-${a}`;
    case "sqrt":
      return `fm_sqrt(${a})`;
    case "exp":
      return `exp(${a})`;
    case "ln":
      return `fm_ln(${a})`;
    case "abs":
      return `abs(${a})`;
    case "floor":
      return `floor(${a})`;
    case "finite":
      return `fm_finite(${a})`;
    case "norminv":
      return `fm_norminv(${a})`;
    case "normcdf":
      return `fm_normcdf(${a})`;
    case "normpdf":
      return `fm_normpdf(${a})`;
  }
}

function binary(fn: BinaryFn, a: string, b: string): string {
  switch (fn) {
    case "add":
      return `${a} + ${b}`;
    case "sub":
      return `${a} - ${b}`;
    case "mul":
      return `${a} * ${b}`;
    case "div":
      return `${a} / ${b}`;
    case "pow":
      return `fm_pow(${a}, ${b})`;
    case "min":
      return `min(${a}, ${b})`;
    case "max":
      return `max(${a}, ${b})`;
    case "eq":
      return `fm_bool(${a} == ${b})`;
    case "ne":
      return `fm_bool(${a} != ${b})`;
    case "lt":
      return `fm_bool(${a} < ${b})`;
    case "le":
      return `fm_bool(${a} <= ${b})`;
    case "gt":
      return `fm_bool(${a} > ${b})`;
    case "ge":
      return `fm_bool(${a} >= ${b})`;
  }
}

function expression(op: Op, reg: number, slots: Map<number, number>): string {
  switch (op.kind) {
    case "const":
      return `consts[${slots.get(reg) ?? 0}u]`;
    case "unary":
      return unary(op.fn, r(op.a));
    case "binary":
      return binary(op.fn, r(op.a), r(op.b));
    case "select":
      return `select(${r(op.otherwise)}, ${r(op.then)}, ${r(op.cond)} != 0.0)`;
    case "dist": {
      const args = ["params.seed", "iteration", `${op.stream}u`, ...op.args.map(r)].join(", ");
      return `fm_${op.dist}(${args})`;
    }
  }
}

/**
 * Generates a WGSL compute shader that evaluates the whole program once per thread, one iteration
 * per thread, and writes the output registers to `out[output * count + index]` (SPECS.md §6.6).
 */
export function generateWgsl(program: Program, outputRegs: readonly number[]): string {
  const slots = constantSlots(program);
  const body = program.ops.map((op, i) => `  let ${r(i)}: f32 = ${expression(op, i, slots)};`);
  const writes = outputRegs.map((reg, k) => `  out[${k}u * params.count + index] = ${r(reg)};`);
  return `${PRELUDE}
struct Params {
  seed: u32,
  iteration_start: u32,
  count: u32,
  _padding: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
${CONSTS_BINDING}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= params.count) {
    return;
  }
  let iteration = params.iteration_start + index;
${body.join("\n")}
${writes.join("\n")}
}
`;
}

/** Iterations each thread of the summary kernel evaluates and folds into its running statistics. */
export const ITERATIONS_PER_THREAD = 64;

/** Floats per partial summary: count, mean, M2, NaN count, infinity count. */
export const SUMMARY_FIELDS = 5;

/**
 * Generates a WGSL compute shader that evaluates the program for `ITERATIONS_PER_THREAD`
 * consecutive iterations per thread and keeps, per output, a running count, mean and M2
 * (Welford), plus NaN and infinity counts (SPECS.md §6.6). Each thread writes one partial summary
 * per output to `partials[(output * threads + thread) * 5 + field]`; `REDUCE_WGSL` merges them.
 */
export function generateSummaryWgsl(program: Program, outputRegs: readonly number[]): string {
  const outputs = Math.max(1, outputRegs.length);
  const slots = constantSlots(program);
  const body = program.ops.map((op, i) => `    let ${r(i)}: f32 = ${expression(op, i, slots)};`);
  const accumulate = outputRegs.map(
    (reg, k) => `    {
      let kind = fm_classify(${r(reg)});
      if (kind == 1u) {
        nan_count[${k}] += 1.0;
      } else if (kind == 2u) {
        inf_count[${k}] += 1.0;
      } else {
        n[${k}] += 1.0;
        let delta = ${r(reg)} - mean[${k}];
        mean[${k}] += delta / n[${k}];
        m2[${k}] += delta * (${r(reg)} - mean[${k}]);
      }
    }`,
  );
  const writes = outputRegs.map(
    (_, k) => `  {
    let base = (${k}u * params.threads + thread) * ${SUMMARY_FIELDS}u;
    partials[base] = n[${k}];
    partials[base + 1u] = mean[${k}];
    partials[base + 2u] = m2[${k}];
    partials[base + 3u] = nan_count[${k}];
    partials[base + 4u] = inf_count[${k}];
  }`,
  );
  return `${PRELUDE}
struct SummaryParams {
  seed: u32,
  iteration_start: u32,
  count: u32,
  threads: u32,
}

@group(0) @binding(0) var<uniform> params: SummaryParams;
@group(0) @binding(1) var<storage, read_write> partials: array<f32>;
${CONSTS_BINDING}

// 0 = finite, 1 = NaN, 2 = infinite. Tested on the bits: compilers may assume floats are never NaN.
fn fm_classify(x: f32) -> u32 {
  let bits = bitcast<u32>(x);
  if ((bits & 0x7f800000u) != 0x7f800000u) {
    return 0u;
  }
  if ((bits & 0x007fffffu) != 0u) {
    return 1u;
  }
  return 2u;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let thread = id.x;
  if (thread >= params.threads) {
    return;
  }
  var n: array<f32, ${outputs}>;
  var mean: array<f32, ${outputs}>;
  var m2: array<f32, ${outputs}>;
  var nan_count: array<f32, ${outputs}>;
  var inf_count: array<f32, ${outputs}>;
  let first = thread * ${ITERATIONS_PER_THREAD}u;
  for (var j = 0u; j < ${ITERATIONS_PER_THREAD}u; j++) {
    let index = first + j;
    if (index >= params.count) {
      break;
    }
    let iteration = params.iteration_start + index;
${body.join("\n")}
${accumulate.join("\n")}
  }
${writes.join("\n")}
}
`;
}

/**
 * Merges the summary kernel's partials: one workgroup per output combines all threads' partials
 * with Chan et al.'s parallel formula, then a tree reduction in workgroup memory. Writes
 * `result[output * 5 + field]`.
 */
export const REDUCE_WGSL = /* wgsl */ `
struct ReduceParams {
  threads: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

struct Stats {
  n: f32,
  mean: f32,
  m2: f32,
}

@group(0) @binding(0) var<uniform> params: ReduceParams;
@group(0) @binding(1) var<storage, read> partials: array<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;

var<workgroup> shared_n: array<f32, 64>;
var<workgroup> shared_mean: array<f32, 64>;
var<workgroup> shared_m2: array<f32, 64>;
var<workgroup> shared_nan: array<f32, 64>;
var<workgroup> shared_inf: array<f32, 64>;

fn merge(a: Stats, b: Stats) -> Stats {
  let n = a.n + b.n;
  if (n == 0.0) {
    return a;
  }
  let delta = b.mean - a.mean;
  return Stats(n, a.mean + delta * b.n / n, a.m2 + b.m2 + delta * delta * a.n * b.n / n);
}

@compute @workgroup_size(64)
fn reduce(
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
) {
  let output = group.x;
  let lane = local.x;
  var stats = Stats(0.0, 0.0, 0.0);
  var nan_count = 0.0;
  var inf_count = 0.0;
  for (var t = lane; t < params.threads; t += 64u) {
    let base = (output * params.threads + t) * 5u;
    stats = merge(stats, Stats(partials[base], partials[base + 1u], partials[base + 2u]));
    nan_count += partials[base + 3u];
    inf_count += partials[base + 4u];
  }
  shared_n[lane] = stats.n;
  shared_mean[lane] = stats.mean;
  shared_m2[lane] = stats.m2;
  shared_nan[lane] = nan_count;
  shared_inf[lane] = inf_count;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (lane < stride) {
      let other = lane + stride;
      let merged = merge(
        Stats(shared_n[lane], shared_mean[lane], shared_m2[lane]),
        Stats(shared_n[other], shared_mean[other], shared_m2[other]),
      );
      shared_n[lane] = merged.n;
      shared_mean[lane] = merged.mean;
      shared_m2[lane] = merged.m2;
      shared_nan[lane] += shared_nan[other];
      shared_inf[lane] += shared_inf[other];
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let base = output * 5u;
    result[base] = shared_n[0];
    result[base + 1u] = shared_mean[0];
    result[base + 2u] = shared_m2[0];
    result[base + 3u] = shared_nan[0];
    result[base + 4u] = shared_inf[0];
  }
}
`;
