import type { BinaryFn, DistKind, Program, UnaryFn } from "./ir";
import { standardNormal, uniformUnit } from "./random";

export interface RunOptions {
  /** 32-bit seed. */
  seed: number;
  /** Index of the first iteration to compute. */
  iterationStart: number;
  /** Number of iterations to compute. */
  count: number;
  /** Addresses of the cells whose samples should be returned. */
  outputs: string[];
}

export function outputRegisters(program: Program, outputs: string[]): number[] {
  return outputs.map((address) => {
    const reg = program.cells.get(address.toUpperCase());
    if (reg === undefined) throw new Error(`Unknown output cell ${address}`);
    return reg;
  });
}

function unary(fn: UnaryFn, a: number): number {
  switch (fn) {
    case "neg":
      return -a;
    case "sqrt":
      return Math.sqrt(a);
    case "exp":
      return Math.exp(a);
    case "ln":
      return Math.log(a);
    case "abs":
      return Math.abs(a);
  }
}

function binary(fn: BinaryFn, a: number, b: number): number {
  switch (fn) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      return a / b;
    case "pow":
      return a ** b;
    case "min":
      return Math.min(a, b);
    case "max":
      return Math.max(a, b);
    case "eq":
      return a === b ? 1 : 0;
    case "ne":
      return a !== b ? 1 : 0;
    case "lt":
      return a < b ? 1 : 0;
    case "le":
      return a <= b ? 1 : 0;
    case "gt":
      return a > b ? 1 : 0;
    case "ge":
      return a >= b ? 1 : 0;
  }
}

function sample(
  dist: DistKind,
  args: readonly number[],
  seed: number,
  iteration: number,
  stream: number,
): number {
  const [p0 = 0, p1 = 0, p2 = 0] = args;
  switch (dist) {
    case "uniform":
      return p0 + (p1 - p0) * uniformUnit(seed, iteration, stream, 0);
    case "normal":
      return p0 + p1 * standardNormal(seed, iteration, stream);
    case "lognormal":
      // Excel's LOGNORM convention: p0 and p1 are the mean and SD of ln(X) (SPECS.md §6.2).
      return Math.exp(p0 + p1 * standardNormal(seed, iteration, stream));
    case "triangular": {
      // Inverse CDF with p0 = min, p1 = mode, p2 = max.
      const u = uniformUnit(seed, iteration, stream, 0);
      const width = p2 - p0;
      return u < (p1 - p0) / width
        ? p0 + Math.sqrt(u * width * (p1 - p0))
        : p2 - Math.sqrt((1 - u) * width * (p2 - p1));
    }
  }
}

/**
 * Evaluates a program synchronously on the current thread in f64, returning the samples of each
 * output cell. This is the kernel each CPU worker runs; use `CpuBackend` from `@fumoca/sim` to
 * run it across all cores.
 */
export function evaluateCpu(program: Program, options: RunOptions): Map<string, Float64Array> {
  const { seed, iterationStart, count, outputs } = options;
  const outRegs = outputRegisters(program, outputs);
  const results = outputs.map(() => new Float64Array(count));
  const regs = new Float64Array(program.ops.length);
  const read = (reg: number): number => regs[reg] as number;

  for (let i = 0; i < count; i++) {
    const iteration = (iterationStart + i) >>> 0;
    program.ops.forEach((op, r) => {
      switch (op.kind) {
        case "const":
          regs[r] = op.value;
          break;
        case "unary":
          regs[r] = unary(op.fn, read(op.a));
          break;
        case "binary":
          regs[r] = binary(op.fn, read(op.a), read(op.b));
          break;
        case "select":
          regs[r] = read(op.cond) !== 0 ? read(op.then) : read(op.otherwise);
          break;
        case "dist":
          regs[r] = sample(op.dist, op.args.map(read), seed, iteration, op.stream);
          break;
      }
    });
    outRegs.forEach((reg, k) => {
      (results[k] as Float64Array)[i] = read(reg);
    });
  }

  return new Map(outputs.map((address, k) => [address, results[k] as Float64Array]));
}
