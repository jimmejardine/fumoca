import type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
import { type BinaryOperator, type Expr, parseFormula } from "./parser";

/** Cell contents keyed by address: a number, or formula text starting with "=". */
export type CellInputs = Record<string, number | string>;

/** Spreadsheet error codes a cell can show (SPECS.md §4.3). */
export type ErrorCode = "#NAME?" | "#VALUE!" | "#CIRC!" | "#ERROR!";

export interface CellError {
  code: ErrorCode;
  message: string;
}

export class CompileError extends Error {
  override name = "CompileError";

  constructor(
    message: string,
    readonly code: ErrorCode = "#ERROR!",
  ) {
    super(message);
  }
}

/** The result of compiling a sheet: a program for every cell that compiled, and errors for the rest. */
export interface SheetCompilation {
  program: Program;
  /** Cells that can't be calculated. Cells that depend on an error cell share its code. */
  errors: Map<string, CellError>;
  /** Root cells: values and formulas that refer to no other cell (SPECS.md §6.5). */
  roots: Set<string>;
  /** Text cells. They may sit in a sheet but can't be used in calculations yet. */
  labels: Set<string>;
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
function parseCell(input: number | string): Expr | null {
  if (typeof input === "number") return { type: "number", value: input };
  if (input.startsWith("=")) {
    try {
      return parseFormula(input);
    } catch (error) {
      throw new CompileError((error as Error).message, "#ERROR!");
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

/**
 * Orders cells so that every cell comes after the cells it refers to, using Tarjan's strongly
 * connected components algorithm. Components come out dependencies-first. A component with more
 * than one cell, or a cell that refers to itself, is a circular reference.
 */
function evaluationOrder(deps: Map<string, Set<string>>): { address: string; cycle?: string[] }[] {
  const order: { address: string; cycle?: string[] }[] = [];
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;

  const connect = (address: string): void => {
    index.set(address, counter);
    lowLink.set(address, counter);
    counter++;
    stack.push(address);
    onStack.add(address);

    for (const dep of deps.get(address) ?? []) {
      if (!deps.has(dep)) continue;
      if (!index.has(dep)) {
        connect(dep);
        lowLink.set(address, Math.min(lowLink.get(address) ?? 0, lowLink.get(dep) ?? 0));
      } else if (onStack.has(dep)) {
        lowLink.set(address, Math.min(lowLink.get(address) ?? 0, index.get(dep) ?? 0));
      }
    }

    if (lowLink.get(address) !== index.get(address)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== address);

    const isCycle = component.length > 1 || deps.get(address)?.has(address) === true;
    const cycle = isCycle ? component.reverse() : undefined;
    for (const cell of component) order.push(cycle ? { address: cell, cycle } : { address: cell });
  };

  for (const address of deps.keys()) {
    if (!index.has(address)) connect(address);
  }
  return order;
}

/**
 * Compiles a single-worksheet model into the IR, cell by cell. A cell that fails to compile gets
 * an error code, and the rest of the sheet still compiles.
 */
export function compileSheet(inputs: CellInputs): SheetCompilation {
  const exprs = new Map<string, Expr>();
  const labels = new Set<string>();
  const errors = new Map<string, CellError>();
  for (const [rawAddress, input] of Object.entries(inputs)) {
    const address = normalizeAddress(rawAddress);
    try {
      const expr = parseCell(input);
      if (expr) exprs.set(address, expr);
      else labels.add(address);
    } catch (error) {
      const { code, message } = error as CompileError;
      errors.set(address, { code, message });
    }
  }

  const deps = new Map<string, Set<string>>();
  for (const [address, expr] of exprs) deps.set(address, collectRefs(expr, new Set()));
  const roots = new Set(
    [...deps].filter(([, refs]) => refs.size === 0).map(([address]) => address),
  );

  const ops: Op[] = [];
  const cells = new Map<string, Reg>();
  let streamCount = 0;
  let zero: Reg | undefined;

  const emit = (op: Op): Reg => ops.push(op) - 1;

  const emitExpr = (expr: Expr): Reg => {
    switch (expr.type) {
      case "number":
        return emit({ kind: "const", value: expr.value });
      case "ref": {
        if (labels.has(expr.address)) {
          throw new CompileError(
            `Refers to text in ${expr.address}; text values are not supported yet`,
            "#VALUE!",
          );
        }
        const reg = cells.get(expr.address);
        if (reg !== undefined) return reg;
        // Empty cells read as 0, as in Excel.
        zero ??= emit({ kind: "const", value: 0 });
        return zero;
      }
      case "negate":
        return emit({ kind: "unary", fn: "neg", a: emitExpr(expr.operand) });
      case "binary":
        return emit({
          kind: "binary",
          fn: BINARY_OPERATORS[expr.operator],
          a: emitExpr(expr.left),
          b: emitExpr(expr.right),
        });
      case "call":
        return emitCall(expr.name, expr.args);
    }
  };

  const emitCall = (name: string, args: Expr[]): Reg => {
    const arity = (min: number, max = min): void => {
      if (args.length < min || args.length > max) {
        const expected = min === max ? `${min}` : `${min}–${max}`;
        throw new CompileError(
          `${name} takes ${expected} argument(s), got ${args.length}`,
          "#NAME?",
        );
      }
    };
    const arg = (i: number): Reg => {
      const expr = args[i];
      if (!expr) throw new CompileError(`${name} is missing argument ${i + 1}`, "#NAME?");
      return emitExpr(expr);
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
      case "NORM.S.DIST": {
        // Excel: NORM.S.DIST(z, cumulative) is Φ(z) when cumulative is TRUE, else φ(z).
        arity(2);
        const z = arg(0);
        const cumulative = arg(1);
        const then = emit({ kind: "unary", fn: "normcdf", a: z });
        const otherwise = emit({ kind: "unary", fn: "normpdf", a: z });
        return emit({ kind: "select", cond: cumulative, then, otherwise });
      }
      case "NORMSDIST":
        // Excel's legacy name for NORM.S.DIST(z, TRUE).
        arity(1);
        return emit({ kind: "unary", fn: "normcdf", a: arg(0) });
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
        throw new CompileError(`Unknown function ${name}`, "#NAME?");
    }
  };

  for (const { address, cycle } of evaluationOrder(deps)) {
    if (cycle) {
      const path = [...cycle, cycle[0]].join(" → ");
      errors.set(address, { code: "#CIRC!", message: `Circular reference: ${path}` });
      continue;
    }
    const failedDep = [...(deps.get(address) ?? [])].find((dep) => errors.has(dep));
    const depError = failedDep === undefined ? undefined : errors.get(failedDep);
    if (failedDep !== undefined && depError) {
      errors.set(address, {
        code: depError.code,
        message: `Depends on ${failedDep}, which has an error`,
      });
      continue;
    }
    const expr = exprs.get(address);
    if (!expr) continue;
    const mark = ops.length;
    const streamMark = streamCount;
    try {
      cells.set(address, emitExpr(expr));
    } catch (error) {
      // Drop any operations the failed cell emitted.
      ops.length = mark;
      streamCount = streamMark;
      if (zero !== undefined && zero >= mark) zero = undefined;
      const { code, message } = error as CompileError;
      errors.set(address, { code, message });
    }
  }

  return { program: { ops, cells, streamCount }, errors, roots, labels };
}

/** Compiles a single-worksheet model into the IR, throwing a `CompileError` for the first error. */
export function compile(inputs: CellInputs): Program {
  const { program, errors } = compileSheet(inputs);
  for (const [address, { code, message }] of errors) {
    throw new CompileError(`${address}: ${message}`, code);
  }
  return program;
}
