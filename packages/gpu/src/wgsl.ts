import type { BinaryFn, Op, Program, UnaryFn } from "@fumoca/engine";
import { PRELUDE } from "./prelude";

/** Threads per workgroup. Each thread computes one iteration of the model. */
export const WORKGROUP_SIZE = 64;

/** Formats a number as an f32 WGSL literal. */
function literal(value: number): string {
  const f = Math.fround(value);
  if (!Number.isFinite(f)) throw new Error(`Constant ${value} can't be represented in f32`);
  const text = String(Math.abs(f));
  return f < 0 ? `(-${text}f)` : `${text}f`;
}

const r = (reg: number): string => `r${reg}`;

function unary(fn: UnaryFn, a: string): string {
  switch (fn) {
    case "neg":
      return `-${a}`;
    case "sqrt":
      return `sqrt(${a})`;
    case "exp":
      return `exp(${a})`;
    case "ln":
      return `log(${a})`;
    case "abs":
      return `abs(${a})`;
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

function expression(op: Op): string {
  switch (op.kind) {
    case "const":
      return literal(op.value);
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
  const body = program.ops.map((op, i) => `  let ${r(i)}: f32 = ${expression(op)};`);
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
