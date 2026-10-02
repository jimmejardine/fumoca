import { addressPosition, columnLetters, rangeAddresses } from "./addresses";
import { calendar, GRANULARITY_ORDER, jsCalendar } from "./calendar";
import { binary, unary } from "./cpu";
import type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
import { type BinaryOperator, type Expr, parseFormula } from "./parser";
import {
  formatPeriod,
  type Granularity,
  granularityOf,
  normalizePeriod,
  periodValue,
} from "./periods";
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
  series?: {
    granularity: Granularity;
    columns: readonly string[];
    /** What the series hold, which sets how lookups map between granularities (SPECS.md §5.5). */
    type?: SeriesKind;
  };
}

/** What a series holds (SPECS.md §5.5): an amount over a period, a level at a time, or a rate. */
export type SeriesKind = "flow" | "level" | "rate";

/**
 * How lookups map between granularities, by series type (SPECS.md §5.4, §5.5): coarser lookups
 * combine the rows in their window, finer lookups read inside the containing row's period.
 */
const LOOKUP_MAPPING: Record<
  SeriesKind,
  { coarser: "sum" | "end" | "average"; finer: "spread" | "linear" | "hold" }
> = {
  flow: { coarser: "sum", finer: "spread" },
  level: { coarser: "end", finer: "linear" },
  rate: { coarser: "average", finer: "hold" },
};

/** A series column, resolved: its rows in period order, each with its value cell's key. */
interface SeriesColumn {
  sheetIndex: number;
  name: string;
  column: string;
  granularity: Granularity;
  kind: SeriesKind;
  rows: { index: number; key: string }[];
}

/** Per-sheet outcome of compiling: why cells failed, which cells are roots, which are text. */
export interface SheetOutcome {
  /** Cells that can't be calculated. Cells that depend on an error cell share its code. */
  errors: Map<string, CellError>;
  /** Root cells: values and formulas that refer to no other cell (SPECS.md §6.5). */
  roots: Set<string>;
  /** Text cells. They may sit in a sheet but can't be used in calculations yet. */
  labels: Set<string>;
  /** Cells holding periods (SPECS.md §3.1), with their granularity: their values are indexes. */
  periods: Map<string, Granularity>;
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
  if (input.trim() !== "" && !Number.isNaN(value)) return { type: "number", value };
  // A period typed into a cell, such as 2027-Q1 or 2027-01 (a year alone is a number).
  const period = normalizePeriod(input);
  const granularity = granularityOf(period);
  return granularity && granularity !== "year" ? { type: "period", text: period } : null;
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

  /** Resolves a lookup's sheet and column to the series it reads, rows in period order. */
  const resolveSeries = (lookup: { sheet: string; column?: string }): SeriesColumn => {
    const target = sheets.findIndex((s) => s.name.toLowerCase() === lookup.sheet.toLowerCase());
    const sheet = sheets[target];
    if (!sheet) throw new CompileError(`There is no sheet named ${lookup.sheet}`, "#REF!");
    if (!sheet.series) throw new CompileError(`${sheet.name} is not a series sheet`, "#REF!");
    const { columns, granularity, type = "level" } = sheet.series;
    const column =
      lookup.column === undefined
        ? 0
        : columns.findIndex((c) => c.toLowerCase() === lookup.column?.toLowerCase());
    if (column < 0 || column >= columns.length) {
      throw new CompileError(`${sheet.name} has no ${lookup.column ?? "value"} column`, "#REF!");
    }
    // Column A holds the periods; rows of another granularity are left out (they show red).
    const rows: SeriesColumn["rows"] = [];
    for (const [address, value] of Object.entries(sheet.cells)) {
      const match = /^A([0-9]+)$/.exec(normalizeAddress(address));
      const period = match && periodValue(String(value));
      if (period?.granularity === granularity) {
        const letter = columnLetters(column + 2);
        rows.push({ index: period.index, key: cellKey(target, `${letter}${match?.[1]}`) });
      }
    }
    rows.sort((a, b) => a.index - b.index);
    return {
      sheetIndex: target,
      name: sheet.name,
      column: columns[column] ?? "",
      granularity,
      kind: type,
      rows,
    };
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
  const lookupSeries = new WeakMap<Expr, SeriesColumn>();
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
        // A lookup may read any row of its series, and depends on its time's cells too.
        const series = resolveSeries(expr);
        lookupSeries.set(expr, series);
        for (const { key } of series.rows) if (inputs.has(key)) into.add(key);
        collectDeps(expr.when, sheetIndex, into);
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

  /**
   * Adds an operation. One on constants is worked out now, with the CPU's own arithmetic, so the
   * GPU gets the exact value: 10^6 is 1,000,000, where the GPU's pow would be a hair off.
   */
  const emit = (op: Op): Reg => {
    const value = (reg: Reg) => {
      const source = ops[reg];
      return source?.kind === "const" ? source.value : undefined;
    };
    if (op.kind === "unary") {
      const a = value(op.a);
      if (a !== undefined) return ops.push({ kind: "const", value: unary(op.fn, a) }) - 1;
    } else if (op.kind === "binary") {
      const a = value(op.a);
      const b = value(op.b);
      if (a !== undefined && b !== undefined) {
        return ops.push({ kind: "const", value: binary(op.fn, a, b) }) - 1;
      }
    }
    return ops.push(op) - 1;
  };
  const select = (cond: Reg, then: Reg, otherwise: Reg): Reg =>
    emit({ kind: "select", cond, then, otherwise });

  // The granularity of every register holding a period; other registers hold numbers.
  const periodOf = new Map<Reg, Granularity>();
  const cellPeriods = new Map<string, Granularity>();
  const typed = (reg: Reg, granularity: Granularity | undefined): Reg => {
    if (granularity) periodOf.set(reg, granularity);
    return reg;
  };
  const kindName = (granularity: Granularity | undefined) =>
    granularity ? `a ${granularity}` : "a number";
  /** The one type of some values: their granularity, or undefined for numbers. */
  const sameType = (regs: Reg[], what: string): Granularity | undefined => {
    const [first, ...rest] = regs.map((reg) => periodOf.get(reg));
    const other = rest.find((g) => g !== first);
    if (rest.length > 0 && rest.some((g) => g !== first)) {
      throw new CompileError(`${what} mixes ${kindName(first)} and ${kindName(other)}`, "#VALUE!");
    }
    return first;
  };
  const cal = calendar({
    constant: (value) => emit({ kind: "const", value }),
    un: (fn, a) => emit({ kind: "unary", fn, a }),
    bin: (fn, a, b) => emit({ kind: "binary", fn, a, b }),
    select: (cond, then, otherwise) => emit({ kind: "select", cond, then, otherwise }),
  });

  /**
   * Arithmetic and comparisons on periods (SPECS.md §3.1): a period plus or minus a number is a
   * period of the same granularity; a period minus a period of the same granularity is the number
   * of periods between them; periods of one granularity compare. Anything else is #VALUE!.
   */
  const emitBinary = (operator: BinaryOperator, a: Reg, b: Reg): Reg => {
    const reg = emit({ kind: "binary", fn: BINARY_OPERATORS[operator], a, b });
    const ga = periodOf.get(a);
    const gb = periodOf.get(b);
    if (!ga && !gb) return reg;
    const fail = (why: string): never => {
      throw new CompileError(why, "#VALUE!");
    };
    if (ga && gb && ga !== gb) {
      fail(
        `Can't combine a ${ga} with a ${gb}: convert one with PERIOD.${ga.toUpperCase()} or PERIOD.${gb.toUpperCase()}`,
      );
    }
    switch (operator) {
      case "+":
        if (ga && gb) fail(`Can't add two ${ga}s together`);
        return typed(reg, ga ?? gb);
      case "-":
        if (!ga) fail(`Can't subtract a ${gb} from a number`);
        // A period minus a period is a count; a period minus a number, a period.
        return gb ? reg : typed(reg, ga);
      case "*":
      case "/":
      case "^":
        return fail(
          `Can't ${operator === "^" ? "raise" : operator === "*" ? "multiply" : "divide"} a ${ga ?? gb}: convert it to a number first, e.g. with YEAR or MONTH`,
        );
      default:
        if (!ga || !gb) fail(`Can't compare a ${ga ?? gb} with a number`);
        return reg;
    }
  };

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

  /**
   * A series lookup (SPECS.md §5.3–5.5) at a time held in a register. A time fixed when compiling
   * reads its row directly, and a missing period is #N/A then; a calculated time (even an
   * uncertain one) selects among the rows as it runs, and a missing period is an error value.
   * Times of another granularity map by the series type: coarser times combine the rows in their
   * window (flows sum, levels take the last, rates average), finer times read inside the
   * containing row's period (flows spread evenly, levels interpolate towards the next row, rates
   * hold). Empty entries: flows read 0, levels carry the last value forward, rates are an error.
   */
  const emitLookup = (
    expr: { sheet: string; column?: string },
    time: Reg,
    sheetIndex: number,
  ): Reg => {
    const series = lookupSeries.get(expr as Expr) ?? resolveSeries(expr);
    const { granularity, kind, name } = series;
    const k = (value: number) => emit({ kind: "const", value });
    const nan = () => k(Number.NaN);
    const at = periodOf.get(time) ?? (granularity === "year" ? "year" : undefined);
    if (!at) {
      throw new CompileError(
        `The time after @ must be a period, like 2026-10: ${name} holds ${GRANULARITY_NAMES[granularity]} per row`,
        "#VALUE!",
      );
    }
    const op = ops[time];
    const fixed = op?.kind === "const" ? op.value : undefined;
    const missing = (index: number, g: Granularity) =>
      new CompileError(`${name} has no row for ${formatPeriod(index, g)}`, "#N/A");

    // Each row's value, with empty entries filled as the series type says.
    let last: Reg | undefined;
    const values = series.rows.map(({ index, key }) => {
      let reg: Reg;
      if (cells.has(key) || labels.has(key)) reg = readCell(key, sheetIndex);
      else if (kind === "flow") reg = k(0);
      else if (kind === "level") reg = last ?? nan();
      else reg = nan();
      last = reg;
      return { index, reg };
    });
    // A period is either known when compiling (`fixed`) or calculated as the model runs (`reg`).
    type Period = { fixed: number } | { reg: Reg };
    const shift = (p: Period, n: number): Period =>
      "fixed" in p
        ? { fixed: p.fixed + n }
        : { reg: emit({ kind: "binary", fn: "add", a: p.reg, b: k(n) }) };
    const regOf = (p: Period): Reg => ("fixed" in p ? k(p.fixed) : p.reg);
    /** A period at another granularity. */
    const convert = (p: Period, from: Granularity, to: Granularity): Period =>
      "fixed" in p
        ? { fixed: jsCalendar.convert(p.fixed, from, to) }
        : { reg: cal.convert(p.reg, from, to) };
    /** The value of a row: directly when the period is fixed, else selected among the rows. */
    const valueAt = (p: Period, orElse?: Reg): Reg => {
      if ("fixed" in p) {
        const row = values.find((v) => v.index === p.fixed);
        if (row) return row.reg;
        if (orElse !== undefined) return orElse;
        throw missing(p.fixed, granularity);
      }
      let result = orElse ?? nan();
      for (const { index, reg } of [...values].reverse()) {
        const cond = emit({ kind: "binary", fn: "eq", a: p.reg, b: k(index) });
        result = select(cond, reg, result);
      }
      return result;
    };
    const when: Period = fixed !== undefined ? { fixed } : { reg: time };

    const rank = (g: Granularity) => GRANULARITY_ORDER.indexOf(g);
    if (at === granularity) return valueAt(when);

    if (rank(at) > rank(granularity)) {
      // Coarser: combine the rows in each window.
      const method = LOOKUP_MAPPING[kind].coarser;
      const windows = new Map<number, Reg[]>();
      for (const { index, reg } of values) {
        const window = jsCalendar.convert(index, granularity, at);
        windows.set(window, [...(windows.get(window) ?? []), reg]);
      }
      const combine = (regs: Reg[]): Reg => {
        if (method === "end") return regs[regs.length - 1] ?? nan();
        const sum = regs.reduce((acc, reg) => emit({ kind: "binary", fn: "add", a: acc, b: reg }));
        return method === "sum"
          ? sum
          : emit({ kind: "binary", fn: "div", a: sum, b: k(regs.length) });
      };
      if ("fixed" in when) {
        const regs = windows.get(when.fixed);
        if (!regs) throw missing(when.fixed, at);
        return combine(regs);
      }
      let result = nan();
      for (const [window, regs] of [...windows].reverse()) {
        const cond = emit({ kind: "binary", fn: "eq", a: when.reg, b: k(window) });
        result = select(cond, combine(regs), result);
      }
      return result;
    }

    // Finer: read inside the row's period containing the time.
    const method = LOOKUP_MAPPING[kind].finer;
    const containing = convert(when, at, granularity);
    const value = valueAt(containing);
    if (method === "hold") return value;
    // How many finer periods the row's period holds, and how far into it the time is.
    const start = regOf(convert(containing, granularity, at));
    const end = regOf(convert(shift(containing, 1), granularity, at));
    const count = emit({ kind: "binary", fn: "sub", a: end, b: start });
    if (method === "spread") return emit({ kind: "binary", fn: "div", a: value, b: count });
    const offset = emit({ kind: "binary", fn: "sub", a: regOf(when), b: start });
    const fraction = emit({ kind: "binary", fn: "div", a: offset, b: count });
    // Towards the next row's value; after the last row, the value holds.
    const next = valueAt(shift(containing, 1), value);
    const step = emit({ kind: "binary", fn: "sub", a: next, b: value });
    const interpolated = emit({
      kind: "binary",
      fn: "add",
      a: value,
      b: emit({ kind: "binary", fn: "mul", a: fraction, b: step }),
    });
    return select(emit({ kind: "unary", fn: "finite", a: next }), interpolated, value);
  };

  const emitExpr = (expr: Expr, sheetIndex: number): Reg => {
    switch (expr.type) {
      case "number":
        return emit({ kind: "const", value: expr.value });
      case "ref":
        return readCell(lookupTargets.get(expr) ?? resolveRef(expr, sheetIndex), sheetIndex);
      case "lookup": {
        if (expr.until) {
          throw new CompileError(
            "A range of periods like @2027-01:2027-12 can only be used inside a function such as SUM",
            "#VALUE!",
          );
        }
        return emitLookup(expr, emitExpr(expr.when, sheetIndex), sheetIndex);
      }
      case "name":
        return readCell(lookupTargets.get(expr) ?? resolveName(expr.name), sheetIndex);
      case "refError":
        throw new CompileError("A reference moved off the grid when it was copied", "#REF!");
      case "range":
        throw new CompileError(
          "A range like A1:B5 can only be used inside a function such as SUM, AVERAGE or INDEX",
          "#VALUE!",
        );
      case "period": {
        const period = periodValue(expr.text);
        if (!period) throw new CompileError(`${expr.text} is not a period`, "#VALUE!");
        return typed(emit({ kind: "const", value: period.index }), period.granularity);
      }
      case "negate": {
        const operand = emitExpr(expr.operand, sheetIndex);
        const granularity = periodOf.get(operand);
        if (granularity) throw new CompileError(`Can't negate a ${granularity}`, "#VALUE!");
        return emit({ kind: "unary", fn: "neg", a: operand });
      }
      case "binary":
        return emitBinary(
          expr.operator,
          emitExpr(expr.left, sheetIndex),
          emitExpr(expr.right, sheetIndex),
        );
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
    /** An argument's value. Unless `periods` is set, it must be a number. */
    const arg = (i: number, periods = false): Reg => {
      const expr = args[i];
      if (!expr) throw new CompileError(`${name} is missing argument ${i + 1}`, "#NAME?");
      const reg = emitExpr(expr, sheetIndex);
      const granularity = periodOf.get(reg);
      if (granularity && !periods) {
        throw new CompileError(
          `${name} takes numbers, not periods: argument ${i + 1} is a ${granularity}`,
          "#VALUE!",
        );
      }
      return reg;
    };
    /** A period argument: its value and granularity. */
    const periodArg = (i: number): { reg: Reg; granularity: Granularity } => {
      const reg = arg(i, true);
      const granularity = periodOf.get(reg);
      if (!granularity) {
        throw new CompileError(`${name}'s argument ${i + 1} must be a period`, "#VALUE!");
      }
      return { reg, granularity };
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
    /**
     * A range cell's number, or null for an empty or text cell, which range functions skip. A
     * period is an error unless `periods` is set.
     */
    const rangeNumber = (key: string, periods = false): Reg | null => {
      if (!cells.has(key)) return null;
      const reg = readCell(key, sheetIndex);
      if (periodOf.has(reg) && !periods) {
        throw new CompileError(
          `${name} takes numbers, not periods: ${display(key, sheetIndex)} is a ${periodOf.get(reg)}`,
          "#VALUE!",
        );
      }
      return reg;
    };
    /** A range cell's value when picked out (INDEX): 0 if empty, as in Excel; text is an error. */
    const rangeValue = (key: string): Reg =>
      labels.has(key) ? error() : readCell(key, sheetIndex);
    /** Every number among the arguments: scalars, and the numeric cells of ranges. */
    const numbers = (periods = false): Reg[] =>
      args.flatMap((expr, i) =>
        expr.type === "range"
          ? rangeArg(i).keys.flatMap((key) => rangeNumber(key, periods) ?? [])
          : expr.type === "lookup" && expr.until
            ? lookupRange(expr, expr.when, expr.until)
            : [arg(i, periods)],
      );
    /** A lookup at each period from `from` to `until`: `Sales[Units]@2027-01:2027-12`. */
    const lookupRange = (expr: Expr & { type: "lookup" }, from: Expr, until: Expr): Reg[] => {
      const start = from.type === "period" ? periodValue(from.text) : null;
      const end = until.type === "period" ? periodValue(until.text) : null;
      if (!start || !end || start.granularity !== end.granularity) {
        throw new CompileError(
          "A range of periods needs two periods of one granularity",
          "#VALUE!",
        );
      }
      if (end.index < start.index) {
        throw new CompileError("A range of periods must run forwards in time", "#VALUE!");
      }
      if (end.index - start.index >= MAX_RANGE_CELLS) {
        throw new CompileError("The range of periods is too long", "#VALUE!");
      }
      return Array.from({ length: end.index - start.index + 1 }, (_, n) =>
        emitLookup(expr, typed(constant(start.index + n), start.granularity), sheetIndex),
      );
    };
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
      return typed(
        result,
        sameType(
          list.filter((reg) => reg !== zero),
          name,
        ),
      );
    };
    /**
     * Where `x` is in `list` (1-based), as MATCH finds it: type 1, the last value <= x (Excel's
     * answer for ascending values); type -1, the last value >= x (for descending values); type 0,
     * the first equal value. Empty and text cells never match. No match is an error (#N/A).
     */
    const match = (x: Reg, list: (Reg | null)[], type: number): Reg => {
      sameType([x, ...list.filter((r): r is Reg => r !== null)], name);
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
    /** A day from year, month and day, carrying months beyond 12 and days beyond the month. */
    const date = (year: Reg, month: Reg, day: Reg): Reg => {
      const m = bin("sub", month, constant(1));
      const carried = bin("add", year, cal.div(m, 12));
      const first = cal.serialOf(carried, bin("add", cal.mod(m, 12), constant(1)), constant(1));
      return bin("add", first, bin("sub", day, constant(1)));
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
      case "MAX": {
        // Empty and text cells in ranges are skipped; with no numbers at all, the answer is 0.
        // Periods of one granularity have a minimum and maximum too.
        if (args.length === 0) arity(1, Number.POSITIVE_INFINITY);
        const list = numbers(true);
        return typed(fold(name === "MIN" ? "min" : "max", list, 0), sameType(list, name));
      }
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
        return match(
          arg(0, true),
          range.keys.map((key) => rangeNumber(key, true)),
          constantArg(2, 1),
        );
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
        const firsts = Array.from({ length: lines }, (_, line) => rangeNumber(at(line, 0), true));
        const found = match(arg(0, true), firsts, constantArg(3, 1) === 0 ? 0 : 1);
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
          value = arg(0, true);
        } catch (failure) {
          // An error in the formula itself, such as a lookup past the end of a table.
          if (failure instanceof CompileError) return arg(1, true);
          throw failure;
        }
        const fallback = arg(1, true);
        const granularity = sameType([value, fallback], name);
        return typed(select(un("finite", value), value, fallback), granularity);
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
        // Written digits give an exact power of ten: a calculated power isn't exact on the GPU,
        // so ROUND(1, 2) could come out a hair above 1 there.
        const digits = args[1];
        const written =
          digits?.type === "number" ||
          (digits?.type === "negate" && digits.operand.type === "number");
        const scale =
          digits === undefined
            ? constant(1)
            : written
              ? constant(10 ** constantArg(1, 0))
              : bin("pow", constant(10), arg(1));
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
      case "PERIOD.YEAR":
      case "PERIOD.QUARTER":
      case "PERIOD.MONTH":
      case "PERIOD.WEEK":
      case "PERIOD.DAY":
      case "PERIOD.HOUR": {
        const to = name.slice("PERIOD.".length).toLowerCase() as Granularity;
        // Built from numbers: PERIOD.YEAR(2027), PERIOD.QUARTER(2027, 1), PERIOD.MONTH(2027, 1),
        // PERIOD.DAY(2027, 1, 15). Parts out of range carry over, as in Excel's DATE.
        const parts = {
          year: "the year",
          quarter: "a year and a quarter",
          month: "a year and a month",
          day: "a year, month and day",
          week: "",
          hour: "",
        }[to];
        const needed = { year: 1, quarter: 2, month: 2, day: 3, week: 0, hour: 0 }[to];
        const usage = parts ? `a period, or ${parts}` : "a period, to convert it";
        if (args.length === 0 || args.length > Math.max(1, needed)) {
          throw new CompileError(`${name} takes ${usage}`, "#NAME?");
        }
        const first = arg(0, true);
        const from = periodOf.get(first);
        if (from) {
          // A period at another granularity.
          if (args.length > 1) throw new CompileError(`${name} takes ${usage}`, "#VALUE!");
          return typed(cal.convert(first, from, to), to);
        }
        if (args.length !== needed) throw new CompileError(`${name} takes ${usage}`, "#VALUE!");
        switch (to) {
          case "year":
            // A new register: the argument's own stays a number.
            return typed(bin("add", first, constant(0)), "year");
          case "quarter":
          case "month": {
            const per = to === "quarter" ? 4 : 12;
            const index = bin(
              "add",
              bin("mul", first, constant(per)),
              bin("sub", arg(1), constant(1)),
            );
            return typed(index, to);
          }
          default:
            return typed(date(first, arg(1), arg(2)), "day");
        }
      }
      case "DATE":
        arity(3);
        return typed(date(arg(0), arg(1), arg(2)), "day");
      case "PERIOD.START":
      case "PERIOD.END": {
        // The first or last day of a period.
        arity(1);
        const { reg, granularity } = periodArg(0);
        if (name === "PERIOD.START") return typed(cal.toDay(reg, granularity), "day");
        const next = cal.toDay(bin("add", reg, constant(1)), granularity);
        return typed(
          granularity === "hour" ? cal.toDay(reg, granularity) : bin("sub", next, constant(1)),
          "day",
        );
      }
      case "YEAR":
      case "QUARTER":
      case "MONTH":
      case "DAY":
      case "WEEKDAY":
      case "HOUR": {
        // Parts of a period, as numbers. A plain number is an Excel serial date, as in Excel.
        arity(1);
        const value = arg(0, true);
        const granularity = periodOf.get(value) ?? "day";
        switch (name) {
          case "YEAR":
            return cal.convert(value, granularity, "year");
          case "QUARTER":
            return bin("add", cal.mod(cal.convert(value, granularity, "quarter"), 4), constant(1));
          case "MONTH":
            return bin("add", cal.mod(cal.toMonth(value, granularity), 12), constant(1));
          case "DAY":
            return cal.dateOf(cal.toDay(value, granularity)).day;
          case "WEEKDAY":
            // Excel's default numbering: Sunday is 1.
            return bin(
              "add",
              cal.mod(bin("sub", cal.toDay(value, granularity), constant(1)), 7),
              constant(1),
            );
          default:
            return granularity === "hour" ? cal.mod(value, 24) : constant(0);
        }
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
        const then = arg(1, true);
        const otherwise = args.length === 3 ? arg(2, true) : emit({ kind: "const", value: 0 });
        const granularity = sameType([then, otherwise], "IF's results");
        return typed(emit({ kind: "select", cond, then, otherwise }), granularity);
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
      const reg = emitExpr(expr, sheetIndex);
      cells.set(key, reg);
      const granularity = periodOf.get(reg);
      if (granularity) cellPeriods.set(key, granularity);
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
    periods: new Map(),
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
  for (const [key, granularity] of cellPeriods) {
    const { sheet, address } = outcome(key);
    sheet?.periods.set(address, granularity);
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
  const outcome = sheets[0] ?? {
    errors: new Map(),
    roots: new Set(),
    labels: new Set(),
    periods: new Map(),
  };
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
