import type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
import { type BinaryOperator, type Expr, parseFormula } from "./parser";

/** Cell contents keyed by address: a number, or formula text starting with "=". */
export type CellInputs = Record<string, number | string>;

export class CompileError extends Error {
  override name = "CompileError";
}

const BINARY_OPERATORS: Record<BinaryOperator, BinaryFn> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "^": "pow",
  "=": "eq",
  "<>": "ne",
  "<": "lt",
  ">": "gt",
  "<=": "le",
  ">=": "ge",
};

const UNARY_FUNCTIONS: Record<string, UnaryFn> = {
  SQRT: "sqrt",
  EXP: "exp",
  LN: "ln",
  ABS: "abs",
};

/** Distribution functions and their argument counts (SPECS.md §6.2). */
const DISTRIBUTIONS: Record<string, { dist: DistKind; arity: number }> = {
  UNIFORM: { dist: "uniform", arity: 2 },
  NORMAL: { dist: "normal", arity: 2 },
  LOGNORMAL: { dist: "lognormal", arity: 2 },
  TRIANGULAR: { dist: "triangular", arity: 3 },
};

function normalizeAddress(address: string): string {
  return address.replaceAll("$", "").toUpperCase();
}

/**
 * Parses a cell's contents. Returns null for a text label: labels may sit in a sheet, but text
 * values aren't supported in calculations yet.
 */
function parseCell(address: string, input: number | string): Expr | null {
  if (typeof input === "number") return { type: "number", value: input };
  if (input.startsWith("=")) {
    try {
      return parseFormula(input);
    } catch (error) {
      throw new CompileError(`${address}: ${(error as Error).message}`);
    }
  }
  const value = Number(input);
  if (input.trim() === "" || Number.isNaN(value)) return null;
  return { type: "number", value };
}

function collectRefs(expr: Expr, into: Set<string>): Set<string> {
  switch (expr.type) {
    case "ref":
      into.add(expr.address);
      break;
    case "negate":
      collectRefs(expr.operand, into);
      break;
    case "binary":
      collectRefs(expr.left, into);
      collectRefs(expr.right, into);
      break;
    case "call":
      for (const arg of expr.args) collectRefs(arg, into);
      break;
    case "number":
      break;
  }
  return into;
}

/** Orders cells so that every cell comes after the cells it refers to. */
function topologicalOrder(deps: Map<string, Set<string>>): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (address: string): void => {
    const current = state.get(address);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...path.slice(path.indexOf(address)), address].join(" → ");
      throw new CompileError(`Circular reference: ${cycle}`);
    }
    state.set(address, "visiting");
    path.push(address);
    for (const dep of deps.get(address) ?? []) {
      if (deps.has(dep)) visit(dep);
    }
    path.pop();
    state.set(address, "done");
    order.push(address);
  };

  for (const address of deps.keys()) visit(address);
  return order;
}

/** Compiles a single-worksheet model into the IR. */
export function compile(inputs: CellInputs): Program {
  const exprs = new Map<string, Expr>();
  const labels = new Set<string>();
  for (const [rawAddress, input] of Object.entries(inputs)) {
    const address = normalizeAddress(rawAddress);
    const expr = parseCell(address, input);
    if (expr) exprs.set(address, expr);
    else labels.add(address);
  }

  const deps = new Map<string, Set<string>>();
  for (const [address, expr] of exprs) deps.set(address, collectRefs(expr, new Set()));

  const ops: Op[] = [];
  const cells = new Map<string, Reg>();
  let streamCount = 0;
  let zero: Reg | undefined;

  const emit = (op: Op): Reg => ops.push(op) - 1;

  const emitExpr = (expr: Expr, address: string): Reg => {
    switch (expr.type) {
      case "number":
        return emit({ kind: "const", value: expr.value });
      case "ref": {
        if (labels.has(expr.address)) {
          throw new CompileError(
            `${address}: refers to text in ${expr.address}; text values are not supported yet`,
          );
        }
        const reg = cells.get(expr.address);
        if (reg !== undefined) return reg;
        // Empty cells read as 0, as in Excel.
        zero ??= emit({ kind: "const", value: 0 });
        return zero;
      }
      case "negate":
        return emit({ kind: "unary", fn: "neg", a: emitExpr(expr.operand, address) });
      case "binary":
        return emit({
          kind: "binary",
          fn: BINARY_OPERATORS[expr.operator],
          a: emitExpr(expr.left, address),
          b: emitExpr(expr.right, address),
        });
      case "call":
        return emitCall(expr.name, expr.args, address);
    }
  };

  const emitCall = (name: string, args: Expr[], address: string): Reg => {
    const arity = (min: number, max = min): void => {
      if (args.length < min || args.length > max) {
        const expected = min === max ? `${min}` : `${min}–${max}`;
        throw new CompileError(
          `${address}: ${name} takes ${expected} argument(s), got ${args.length}`,
        );
      }
    };
    const arg = (i: number): Reg => {
      const expr = args[i];
      if (!expr) throw new CompileError(`${address}: ${name} is missing argument ${i + 1}`);
      return emitExpr(expr, address);
    };

    const unary = UNARY_FUNCTIONS[name];
    if (unary) {
      arity(1);
      return emit({ kind: "unary", fn: unary, a: arg(0) });
    }
    const distribution = DISTRIBUTIONS[name];
    if (distribution) {
      arity(distribution.arity);
      const regs = args.map((_, i) => arg(i));
      return emit({ kind: "dist", dist: distribution.dist, args: regs, stream: streamCount++ });
    }
    switch (name) {
      case "RAND": {
        arity(0);
        const lo = emit({ kind: "const", value: 0 });
        const hi = emit({ kind: "const", value: 1 });
        return emit({ kind: "dist", dist: "uniform", args: [lo, hi], stream: streamCount++ });
      }
      case "POWER":
        arity(2);
        return emit({ kind: "binary", fn: "pow", a: arg(0), b: arg(1) });
      case "MIN":
      case "MAX": {
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        const fn = name === "MIN" ? "min" : "max";
        let result = arg(0);
        for (let i = 1; i < args.length; i++) {
          result = emit({ kind: "binary", fn, a: result, b: arg(i) });
        }
        return result;
      }
      case "IF": {
        arity(2, 3);
        const cond = arg(0);
        const then = arg(1);
        const otherwise = args.length === 3 ? arg(2) : emit({ kind: "const", value: 0 });
        return emit({ kind: "select", cond, then, otherwise });
      }
      default:
        throw new CompileError(`${address}: unknown function ${name}`);
    }
  };

  for (const address of topologicalOrder(deps)) {
    const expr = exprs.get(address);
    if (expr) cells.set(address, emitExpr(expr, address));
  }

  return { ops, cells, streamCount };
}
