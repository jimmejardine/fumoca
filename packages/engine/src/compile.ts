import { addressPosition, rangeAddresses } from "./addresses";
import type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
import { type BinaryOperator, type Expr, type LookupTime, parseFormula } from "./parser";
import { type Granularity, granularityOf } from "./periods";
import { hash32 } from "./random";

/** Cell contents keyed by address: a number, or formula text starting with "=". */
export type CellInputs = Record<string, number | string>;

/** Spreadsheet error codes a cell can show (SPECS.md §4.3). */
export type ErrorCode =
  | "#NAME?"
  | "#VALUE!"
  | "#CIRC!"
  | "#ERROR!"
  | "#REF!"
  | "#N/A"
  | "#DIV/0!"
  | "#NUM!";

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

/** The most cells a range may cover: each is expanded into the compiled program. */
export const MAX_RANGE_CELLS = 10_000;

/** A range's cells, resolved: its shape, and every cell's key, row by row. */
interface RangeCells {
  rows: number;
  columns: number;
  keys: string[];
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

  /** Resolves a range to its cells, row by row. */
  const resolveRange = (
    range: { from: string; to: string; sheet?: string },
    fromSheet: number,
  ): RangeCells => {
    const sheetIndex = splitCellKey(
      resolveRef(
        range.sheet === undefined
          ? { address: range.from }
          : { address: range.from, sheet: range.sheet },
        fromSheet,
      ),
    ).sheetIndex;
    const a = addressPosition(normalizeAddress(range.from));
    const b = addressPosition(normalizeAddress(range.to));
    const columns = Math.abs(a.column - b.column) + 1;
    const rows = Math.abs(a.row - b.row) + 1;
    if (rows * columns > MAX_RANGE_CELLS) {
      throw new CompileError(
        `The range ${range.from}:${range.to} has ${(rows * columns).toLocaleString("en")} cells; ranges are limited to ${MAX_RANGE_CELLS.toLocaleString("en")}`,
        "#VALUE!",
      );
    }
    const keys = rangeAddresses(range.from, range.to)
      .flat()
      .map((address) => cellKey(sheetIndex, address));
    return { rows, columns, keys };
  };

  // Dependencies, with every reference and lookup resolved to its target cell.
  const lookupTargets = new WeakMap<Expr, string>();
  const rangeTargets = new WeakMap<Expr, RangeCells>();
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
      case "range": {
        const range = resolveRange(expr, sheetIndex);
        rangeTargets.set(expr, range);
        // Only cells with contents matter: empty cells have nothing to wait for.
        for (const key of range.keys) if (inputs.has(key)) into.add(key);
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
      case "range":
        throw new CompileError(
          "A range like A1:B5 can only be used inside a function such as SUM, AVERAGE or INDEX",
          "#VALUE!",
        );
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

    const constant = (value: number): Reg => emit({ kind: "const", value });
    const un = (fn: UnaryFn, a: Reg): Reg => emit({ kind: "unary", fn, a });
    const bin = (fn: BinaryFn, a: Reg, b: Reg): Reg => emit({ kind: "binary", fn, a, b });
    const select = (cond: Reg, then: Reg, otherwise: Reg): Reg =>
      emit({ kind: "select", cond, then, otherwise });
    // An error value: NaN, which shows as an error wherever it ends up.
    let nan: Reg | undefined;
    const error = (): Reg => {
      nan ??= constant(Number.NaN);
      return nan;
    };

    /** The cells of a range argument; an error if the argument isn't a range. */
    const rangeArg = (i: number, what = "a range, like A1:B5"): RangeCells => {
      const expr = args[i];
      const range = expr?.type === "range" ? rangeTargets.get(expr) : undefined;
      if (!range) throw new CompileError(`${name}'s argument ${i + 1} must be ${what}`, "#VALUE!");
      return range;
    };
    /** A range cell's number, or null for an empty or text cell, which range functions skip. */
    const rangeNumber = (key: string): Reg | null =>
      cells.has(key) ? readCell(key, sheetIndex) : null;
    /** A range cell's value when picked out (INDEX): 0 if empty, as in Excel; text is an error. */
    const rangeValue = (key: string): Reg =>
      labels.has(key) ? error() : readCell(key, sheetIndex);
    /** Every number among the arguments: scalars, and the numeric cells of ranges. */
    const numbers = (): Reg[] =>
      args.flatMap((expr, i) =>
        expr.type === "range"
          ? rangeArg(i).keys.flatMap((key) => rangeNumber(key) ?? [])
          : [arg(i)],
      );
    const fold = (fn: BinaryFn, regs: Reg[], empty: number): Reg =>
      regs.reduce<Reg | undefined>(
        (acc, reg) => (acc === undefined ? reg : bin(fn, acc, reg)),
        undefined,
      ) ?? constant(empty);
    /** A number written in the formula (such as MATCH's type), or `fallback` if it's omitted. */
    const constantArg = (i: number, fallback: number): number => {
      const expr = args[i];
      if (expr === undefined) return fallback;
      if (expr.type === "number") return expr.value;
      if (expr.type === "negate" && expr.operand.type === "number") return -expr.operand.value;
      throw new CompileError(
        `${name}'s argument ${i + 1} must be a number, not a formula`,
        "#VALUE!",
      );
    };
    /** The value at a 1-based position of `list` (truncated, as in Excel), or an error. */
    const pick = (position: Reg, list: Reg[]): Reg => {
      const at = un("floor", position);
      let result = error();
      for (let i = list.length; i >= 1; i--) {
        result = select(bin("eq", at, constant(i)), list[i - 1] ?? error(), result);
      }
      return result;
    };
    /**
     * Where `x` is in `list` (1-based), as MATCH finds it: type 1, the last value <= x (Excel's
     * answer for ascending values); type -1, the last value >= x (for descending values); type 0,
     * the first equal value. Empty and text cells never match. No match is an error (#N/A).
     */
    const match = (x: Reg, list: (Reg | null)[], type: number): Reg => {
      const test: BinaryFn = type > 0 ? "le" : type < 0 ? "ge" : "eq";
      const positions = [...list.keys()];
      // The outermost test wins: the last position for approximate types, the first for exact.
      if (type === 0) positions.reverse();
      let result = error();
      for (const i of positions) {
        const value = list[i];
        if (value !== null && value !== undefined) {
          result = select(bin(test, value, x), constant(i + 1), result);
        }
      }
      return result;
    };
    const oneDimensional = (range: RangeCells): void => {
      if (range.rows !== 1 && range.columns !== 1) {
        throw new CompileError(`${name} needs a single row or column`, "#N/A");
      }
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
      case "MAX":
        // Empty and text cells in ranges are skipped; with no numbers at all, the answer is 0.
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        return fold(name === "MIN" ? "min" : "max", numbers(), 0);
      case "SUM":
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        return fold("add", numbers(), 0);
      case "PRODUCT":
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        return fold("mul", numbers(), 0);
      case "COUNT":
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        return constant(numbers().length);
      case "AVERAGE": {
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        const list = numbers();
        if (list.length === 0)
          throw new CompileError("AVERAGE has no numbers to average", "#DIV/0!");
        return bin("div", fold("add", list, 0), constant(list.length));
      }
      case "SUMPRODUCT": {
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        const ranges = args.map((_, i) => rangeArg(i));
        const [first] = ranges;
        if (!first || ranges.some((r) => r.rows !== first.rows || r.columns !== first.columns)) {
          throw new CompileError("SUMPRODUCT's ranges must all be the same shape", "#VALUE!");
        }
        // Non-numeric cells count as 0.
        const terms = first.keys.map((_, p) =>
          fold(
            "mul",
            ranges.map((r) => rangeNumber(r.keys[p] ?? "") ?? constant(0)),
            0,
          ),
        );
        return fold("add", terms, 0);
      }
      case "INDEX": {
        arity(2, 3);
        const range = rangeArg(0);
        const values = range.keys.map(rangeValue);
        if (args.length === 2) {
          // One index into a single row or column picks along it, as in Excel.
          if (range.rows !== 1 && range.columns !== 1) {
            throw new CompileError(
              "INDEX into several rows and columns needs a row and a column",
              "#VALUE!",
            );
          }
          return pick(arg(1), values);
        }
        const row = un("floor", arg(1));
        const column = un("floor", arg(2));
        const inside = fold(
          "min",
          [
            bin("ge", row, constant(1)),
            bin("le", row, constant(range.rows)),
            bin("ge", column, constant(1)),
            bin("le", column, constant(range.columns)),
          ],
          0,
        );
        const position = bin(
          "add",
          bin("mul", bin("sub", row, constant(1)), constant(range.columns)),
          column,
        );
        return select(inside, pick(position, values), error());
      }
      case "MATCH": {
        arity(2, 3);
        const range = rangeArg(1);
        oneDimensional(range);
        return match(arg(0), range.keys.map(rangeNumber), constantArg(2, 1));
      }
      case "VLOOKUP":
      case "HLOOKUP": {
        arity(3, 4);
        const table = rangeArg(1, "a table, like A1:C9");
        const vertical = name === "VLOOKUP";
        const lines = vertical ? table.rows : table.columns;
        const across = vertical ? table.columns : table.rows;
        const at = (line: number, k: number) =>
          (vertical
            ? table.keys[line * table.columns + k]
            : table.keys[k * table.columns + line]) ?? "";
        const firsts = Array.from({ length: lines }, (_, line) => rangeNumber(at(line, 0)));
        const found = match(arg(0), firsts, constantArg(3, 1) === 0 ? 0 : 1);
        const valuesIn = (k: number) =>
          pick(
            found,
            Array.from({ length: lines }, (_, line) => rangeValue(at(line, k))),
          );
        const index = args[2];
        if (index?.type === "number") {
          const k = Math.floor(index.value);
          if (k < 1 || k > across) {
            throw new CompileError(
              `${name}'s table has no ${vertical ? "column" : "row"} ${k}`,
              "#REF!",
            );
          }
          return valuesIn(k - 1);
        }
        return pick(
          arg(2),
          Array.from({ length: across }, (_, k) => valuesIn(k)),
        );
      }
      case "AND":
      case "OR": {
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        const list = numbers();
        if (list.length === 0) throw new CompileError(`${name} has no values to test`, "#VALUE!");
        const zeroReg = constant(0);
        const truths = list.map((reg) => bin("ne", reg, zeroReg));
        return fold(name === "AND" ? "min" : "max", truths, 0);
      }
      case "NOT":
        arity(1);
        return bin("eq", arg(0), constant(0));
      case "IFERROR": {
        arity(2);
        let value: Reg;
        try {
          value = arg(0);
        } catch (failure) {
          // An error in the formula itself, such as a lookup past the end of a table.
          if (failure instanceof CompileError) return arg(1);
          throw failure;
        }
        return select(un("finite", value), value, arg(1));
      }
      case "INT":
        arity(1);
        return un("floor", arg(0));
      case "ROUND":
      case "ROUNDUP":
      case "ROUNDDOWN":
      case "TRUNC": {
        if (name === "TRUNC") arity(1, 2);
        else arity(2);
        // On the magnitude, then signed again: halves round away from zero, as in Excel.
        const x = arg(0);
        const scale = args.length > 1 ? bin("pow", constant(10), arg(1)) : constant(1);
        const magnitude = bin("mul", un("abs", x), scale);
        const rounded =
          name === "ROUND"
            ? un("floor", bin("add", magnitude, constant(0.5)))
            : name === "ROUNDUP"
              ? un("neg", un("floor", un("neg", magnitude)))
              : un("floor", magnitude);
        const result = bin("div", rounded, scale);
        return select(bin("lt", x, constant(0)), un("neg", result), result);
      }
      case "MOD": {
        // The remainder takes the divisor's sign, as in Excel.
        arity(2);
        const a = arg(0);
        const b = arg(1);
        return bin("sub", a, bin("mul", b, un("floor", bin("div", a, b))));
      }
      case "RRI": {
        // The equivalent annual growth rate from pv to fv over n periods.
        arity(3);
        const n = arg(0);
        const growth = bin("div", arg(2), arg(1));
        return bin("sub", bin("pow", growth, bin("div", constant(1), n)), constant(1));
      }
      case "NORM.S.INV":
      case "NORMSINV":
        arity(1);
        return un("norminv", arg(0));
      case "NORM.INV":
      case "NORMINV":
      case "LOGNORM.INV":
      case "LOGINV": {
        arity(3);
        const p = arg(0);
        const mean = arg(1);
        const sd = arg(2);
        const normal = bin("add", mean, bin("mul", sd, un("norminv", p)));
        const value = name.startsWith("NORM") ? normal : un("exp", normal);
        // A standard deviation that isn't positive is #NUM! in Excel.
        return select(bin("gt", sd, constant(0)), value, error());
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
