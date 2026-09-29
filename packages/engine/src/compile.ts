import type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
import { type BinaryOperator, type Expr, type LookupTime, parseFormula } from "./parser";
import { type Granularity, granularityOf } from "./periods";
import { hash32 } from "./random";

/** Cell contents keyed by address: a number, or formula text starting with "=". */
export type CellInputs = Record<string, number | string>;

/** Spreadsheet error codes a cell can show (SPECS.md §4.3). */
export type ErrorCode = "#NAME?" | "#VALUE!" | "#CIRC!" | "#ERROR!" | "#REF!" | "#N/A";

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

/** A sheet to compile. Series sheets can be looked up from other sheets (SPECS.md §5.3). */
export interface SheetInput {
  name: string;
  cells: CellInputs;
  /** Named cells on this sheet: name → address. Names are workbook-wide (SPECS.md §4.1). */
  names?: Readonly<Record<string, string>>;
  /**
   * Present on time-series sheets: column A holds the periods, and value columns B, C, … hold the
   * series named by `columns`, in order.
   */
  series?: { granularity: Granularity; columns: readonly string[] };
}

/** Per-sheet outcome of compiling: why cells failed, which cells are roots, which are text. */
export interface SheetOutcome {
  /** Cells that can't be calculated. Cells that depend on an error cell share its code. */
  errors: Map<string, CellError>;
  /** Root cells: values and formulas that refer to no other cell (SPECS.md §6.5). */
  roots: Set<string>;
  /** Text cells. They may sit in a sheet but can't be used in calculations yet. */
  labels: Set<string>;
}

/**
 * The result of compiling a workbook: one program for every cell that compiled, across all sheets.
 * Program cells are keyed by `cellKey(sheetIndex, address)`.
 */
export interface WorkbookCompilation {
  program: Program;
  sheets: SheetOutcome[];
}

/** The result of compiling a single sheet: program cells are keyed by plain address. */
export interface SheetCompilation extends SheetOutcome {
  program: Program;
}

/** The key of a cell in a workbook program: sheet index and address, e.g. "2!B7". */
export function cellKey(sheetIndex: number, address: string): string {
  return `${sheetIndex}!${address}`;
}

/** Splits a workbook program key into its sheet index and address. */
export function splitCellKey(key: string): { sheetIndex: number; address: string } {
  const bang = key.indexOf("!");
  return { sheetIndex: Number(key.slice(0, bang)), address: key.slice(bang + 1) };
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

const GRANULARITY_NAMES: Record<Granularity, string> = {
  hour: "an hour",
  day: "a day",
  week: "a week",
  month: "a month",
  quarter: "a quarter",
  year: "a year",
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

/** A 32-bit FNV-1a hash of a cell's sheet name and address: the base of its random streams. */
function streamBase(sheetName: string, address: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${sheetName.toLowerCase()}!${address}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Orders cells so that every cell comes after the cells it refers to, using Tarjan's strongly
 * connected components algorithm. Components come out dependencies-first. A component with more
 * than one cell, or a cell that refers to itself, is a circular reference.
 */
function evaluationOrder(deps: Map<string, Set<string>>): { key: string; cycle?: string[] }[] {
  const order: { key: string; cycle?: string[] }[] = [];
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let counter = 0;

  const connect = (key: string): void => {
    index.set(key, counter);
    lowLink.set(key, counter);
    counter++;
    stack.push(key);
    onStack.add(key);

    for (const dep of deps.get(key) ?? []) {
      if (!deps.has(dep)) continue;
      if (!index.has(dep)) {
        connect(dep);
        lowLink.set(key, Math.min(lowLink.get(key) ?? 0, lowLink.get(dep) ?? 0));
      } else if (onStack.has(dep)) {
        lowLink.set(key, Math.min(lowLink.get(key) ?? 0, index.get(dep) ?? 0));
      }
    }

    if (lowLink.get(key) !== index.get(key)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== key);

    const isCycle = component.length > 1 || deps.get(key)?.has(key) === true;
    const cycle = isCycle ? component.reverse() : undefined;
    for (const cell of component) order.push(cycle ? { key: cell, cycle } : { key: cell });
  };

  for (const key of deps.keys()) {
    if (!index.has(key)) connect(key);
  }
  return order;
}

/**
 * Compiles a workbook into one program, cell by cell. A cell that fails to compile gets an error
 * code, and everything else still compiles.
 *
 * Series lookups (`Prices[Close]@2026-10`) are resolved here, to the one series cell they name,
 * so they compile to an ordinary cross-sheet reference. The time must be a period literal or a
 * cell holding one; lookups with a calculated time aren't supported yet.
 */
export function compileWorkbook(sheets: readonly SheetInput[]): WorkbookCompilation {
  const exprs = new Map<string, Expr>();
  const labels = new Set<string>();
  const errors = new Map<string, CellError>();
  const inputs = new Map<string, number | string>();

  sheets.forEach((sheet, sheetIndex) => {
    for (const [rawAddress, input] of Object.entries(sheet.cells)) {
      const key = cellKey(sheetIndex, normalizeAddress(rawAddress));
      inputs.set(key, input);
      try {
        const expr = parseCell(input);
        if (expr) exprs.set(key, expr);
        else labels.add(key);
      } catch (error) {
        const { code, message } = error as CompileError;
        errors.set(key, { code, message });
      }
    }
  });

  const sheetNames = (index: number) => sheets[index]?.name ?? `#${index}`;
  /** How a key is named in a message about a cell on `fromSheet`. */
  const display = (key: string, fromSheet: number) => {
    const { sheetIndex, address } = splitCellKey(key);
    return sheetIndex === fromSheet ? address : `${sheetNames(sheetIndex)}!${address}`;
  };

  // Series sheets: period text in column A → row number.
  const seriesRows = new Map<number, Map<string, number>>();
  const rowsOf = (sheetIndex: number): Map<string, number> => {
    let rows = seriesRows.get(sheetIndex);
    if (!rows) {
      rows = new Map();
      for (const [address, value] of Object.entries(sheets[sheetIndex]?.cells ?? {})) {
        const match = /^A([0-9]+)$/.exec(normalizeAddress(address));
        if (match) rows.set(String(value).trim(), Number(match[1]));
      }
      seriesRows.set(sheetIndex, rows);
    }
    return rows;
  };

  /** Resolves a lookup to the key of the series cell it names. */
  const resolveLookup = (
    lookup: { sheet: string; column?: string; when: LookupTime },
    fromSheet: number,
  ): string => {
    const target = sheets.findIndex((s) => s.name.toLowerCase() === lookup.sheet.toLowerCase());
    const sheet = sheets[target];
    if (!sheet) throw new CompileError(`There is no sheet named ${lookup.sheet}`, "#REF!");
    if (!sheet.series) throw new CompileError(`${sheet.name} is not a series sheet`, "#REF!");

    const columns = sheet.series.columns;
    const column =
      lookup.column === undefined
        ? 0
        : columns.findIndex((c) => c.toLowerCase() === lookup.column?.toLowerCase());
    if (column < 0 || column >= columns.length) {
      const name = lookup.column ?? "value";
      throw new CompileError(`${sheet.name} has no ${name} column`, "#REF!");
    }

    let period: string;
    if (lookup.when.kind === "period") {
      period = lookup.when.text;
    } else {
      const input = inputs.get(cellKey(fromSheet, lookup.when.address));
      if (input === undefined || (typeof input === "string" && input.startsWith("="))) {
        throw new CompileError(
          `${lookup.when.address} must hold a period, like 2026-10 (calculated times aren't supported yet)`,
          "#VALUE!",
        );
      }
      period = String(input).trim();
    }
    const granularity = granularityOf(period);
    if (!granularity) throw new CompileError(`${period} is not a period`, "#VALUE!");
    if (granularity !== sheet.series.granularity) {
      throw new CompileError(
        `${sheet.name} holds ${GRANULARITY_NAMES[sheet.series.granularity]} per row, ` +
          `but ${period} is ${GRANULARITY_NAMES[granularity]}`,
        "#N/A",
      );
    }
    const row = rowsOf(target).get(period);
    if (row === undefined) throw new CompileError(`${sheet.name} has no row for ${period}`, "#N/A");
    const key = cellKey(target, `${String.fromCharCode(66 + column)}${row}`);
    if (!exprs.has(key) && !labels.has(key) && !errors.has(key)) {
      throw new CompileError(`${sheet.name} has no ${columns[column]} value for ${period}`, "#N/A");
    }
    return key;
  };

  /** Resolves a cell reference, which may name another sheet (`Inputs!B3`), to its key. */
  // Named cells, workbook-wide, by lower-case name.
  const named = new Map<string, string>();
  sheets.forEach((sheet, sheetIndex) => {
    for (const [name, address] of Object.entries(sheet.names ?? {})) {
      named.set(name.toLowerCase(), cellKey(sheetIndex, normalizeAddress(address)));
    }
  });
  const resolveName = (name: string): string => {
    const key = named.get(name.toLowerCase());
    if (key === undefined) throw new CompileError(`Unknown name ${name}`, "#NAME?");
    return key;
  };

  const resolveRef = (ref: { address: string; sheet?: string }, fromSheet: number): string => {
    if (ref.sheet === undefined) return cellKey(fromSheet, normalizeAddress(ref.address));
    const target = sheets.findIndex((s) => s.name.toLowerCase() === ref.sheet?.toLowerCase());
    if (target < 0) throw new CompileError(`There is no sheet named ${ref.sheet}`, "#REF!");
    return cellKey(target, normalizeAddress(ref.address));
  };

  // Dependencies, with every reference and lookup resolved to its target cell.
  const lookupTargets = new WeakMap<Expr, string>();
  const collectDeps = (expr: Expr, sheetIndex: number, into: Set<string>): void => {
    switch (expr.type) {
      case "ref": {
        const key = resolveRef(expr, sheetIndex);
        lookupTargets.set(expr, key);
        into.add(key);
        break;
      }
      case "lookup": {
        const key = resolveLookup(expr, sheetIndex);
        lookupTargets.set(expr, key);
        into.add(key);
        break;
      }
      case "negate":
        collectDeps(expr.operand, sheetIndex, into);
        break;
      case "binary":
        collectDeps(expr.left, sheetIndex, into);
        collectDeps(expr.right, sheetIndex, into);
        break;
      case "call":
        for (const arg of expr.args) collectDeps(arg, sheetIndex, into);
        break;
      case "refError":
        throw new CompileError("A reference moved off the grid when it was copied", "#REF!");
      case "name": {
        const key = resolveName(expr.name);
        lookupTargets.set(expr, key);
        into.add(key);
        break;
      }
      case "number":
        break;
    }
  };

  const deps = new Map<string, Set<string>>();
  for (const [key, expr] of exprs) {
    const refs = new Set<string>();
    try {
      collectDeps(expr, splitCellKey(key).sheetIndex, refs);
      deps.set(key, refs);
    } catch (error) {
      const { code, message } = error as CompileError;
      errors.set(key, { code, message });
    }
  }
  const roots = new Set([...deps].filter(([, refs]) => refs.size === 0).map(([key]) => key));

  const ops: Op[] = [];
  const cells = new Map<string, Reg>();
  let streamCount = 0;
  let zero: Reg | undefined;
  // Each distribution call's random stream is named by its cell and its position in the formula,
  // not by compile order, so a cell's draws don't change when other cells do. Scenarios rely on
  // this for common random numbers (SPECS.md §7.3).
  let cellStreams = { base: 0, next: 0 };
  const nextStream = (): number => {
    streamCount++;
    return hash32((cellStreams.base + Math.imul(cellStreams.next++, 0x9e3779b9)) >>> 0);
  };

  const emit = (op: Op): Reg => ops.push(op) - 1;

  const readCell = (key: string, fromSheet: number): Reg => {
    if (labels.has(key)) {
      throw new CompileError(
        `Refers to text in ${display(key, fromSheet)}; text values are not supported yet`,
        "#VALUE!",
      );
    }
    const reg = cells.get(key);
    if (reg !== undefined) return reg;
    // Empty cells read as 0, as in Excel.
    zero ??= emit({ kind: "const", value: 0 });
    return zero;
  };

  const emitExpr = (expr: Expr, sheetIndex: number): Reg => {
    switch (expr.type) {
      case "number":
        return emit({ kind: "const", value: expr.value });
      case "ref":
        return readCell(lookupTargets.get(expr) ?? resolveRef(expr, sheetIndex), sheetIndex);
      case "lookup":
        return readCell(lookupTargets.get(expr) ?? "", sheetIndex);
      case "name":
        return readCell(lookupTargets.get(expr) ?? resolveName(expr.name), sheetIndex);
      case "refError":
        throw new CompileError("A reference moved off the grid when it was copied", "#REF!");
      case "negate":
        return emit({ kind: "unary", fn: "neg", a: emitExpr(expr.operand, sheetIndex) });
      case "binary":
        return emit({
          kind: "binary",
          fn: BINARY_OPERATORS[expr.operator],
          a: emitExpr(expr.left, sheetIndex),
          b: emitExpr(expr.right, sheetIndex),
        });
      case "call":
        return emitCall(expr.name, expr.args, sheetIndex);
    }
  };

  const emitCall = (name: string, args: Expr[], sheetIndex: number): Reg => {
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
      return emitExpr(expr, sheetIndex);
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
      return emit({ kind: "dist", dist: distribution.dist, args: regs, stream: nextStream() });
    }
    switch (name) {
      case "RAND": {
        arity(0);
        const lo = emit({ kind: "const", value: 0 });
        const hi = emit({ kind: "const", value: 1 });
        return emit({ kind: "dist", dist: "uniform", args: [lo, hi], stream: nextStream() });
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

  for (const { key, cycle } of evaluationOrder(deps)) {
    const sheetIndex = splitCellKey(key).sheetIndex;
    if (cycle) {
      const path = [...cycle, cycle[0] ?? key].map((k) => display(k, sheetIndex)).join(" → ");
      errors.set(key, { code: "#CIRC!", message: `Circular reference: ${path}` });
      continue;
    }
    const failedDep = [...(deps.get(key) ?? [])].find((dep) => errors.has(dep));
    const depError = failedDep === undefined ? undefined : errors.get(failedDep);
    if (failedDep !== undefined && depError) {
      errors.set(key, {
        code: depError.code,
        message: `Depends on ${display(failedDep, sheetIndex)}, which has an error`,
      });
      continue;
    }
    const expr = exprs.get(key);
    if (!expr) continue;
    const mark = ops.length;
    const streamMark = streamCount;
    const { address } = splitCellKey(key);
    cellStreams = { base: streamBase(sheets[sheetIndex]?.name ?? "", address), next: 0 };
    try {
      cells.set(key, emitExpr(expr, sheetIndex));
    } catch (error) {
      // Drop any operations the failed cell emitted.
      ops.length = mark;
      streamCount = streamMark;
      if (zero !== undefined && zero >= mark) zero = undefined;
      const { code, message } = error as CompileError;
      errors.set(key, { code, message });
    }
  }

  // Split per-cell outcomes back out by sheet.
  const outcomes: SheetOutcome[] = sheets.map(() => ({
    errors: new Map(),
    roots: new Set(),
    labels: new Set(),
  }));
  const outcome = (key: string) => {
    const { sheetIndex, address } = splitCellKey(key);
    return { sheet: outcomes[sheetIndex], address };
  };
  for (const [key, error] of errors) {
    const { sheet, address } = outcome(key);
    sheet?.errors.set(address, error);
  }
  for (const key of roots) {
    const { sheet, address } = outcome(key);
    sheet?.roots.add(address);
  }
  for (const key of labels) {
    const { sheet, address } = outcome(key);
    sheet?.labels.add(address);
  }

  return { program: { ops, cells, streamCount }, sheets: outcomes };
}

/**
 * Compiles a single-worksheet model into the IR, cell by cell. A cell that fails to compile gets
 * an error code, and the rest of the sheet still compiles.
 */
export function compileSheet(inputs: CellInputs): SheetCompilation {
  const { program, sheets } = compileWorkbook([{ name: "Sheet1", cells: inputs }]);
  const cells = new Map([...program.cells].map(([key, reg]) => [splitCellKey(key).address, reg]));
  const outcome = sheets[0] ?? { errors: new Map(), roots: new Set(), labels: new Set() };
  return { program: { ...program, cells }, ...outcome };
}

/** Compiles a single-worksheet model into the IR, throwing a `CompileError` for the first error. */
export function compile(inputs: CellInputs): Program {
  const { program, errors } = compileSheet(inputs);
  for (const [address, { code, message }] of errors) {
    throw new CompileError(`${address}: ${message}`, code);
  }
  return program;
}
