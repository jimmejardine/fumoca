import {
  type Backend,
  type CellAccumulator,
  compileWorkbook,
  type SheetInput,
  splitCellKey,
  uncertainCells,
} from "@fumoca/engine";
import { type ProgressState, RunAbortedError, runProgressively } from "@fumoca/sim";
import type { Workbook } from "@fumoca/storage";

/** The calculated result of one cell, as the grid shows it (SPECS.md §6.5). */
export type CellResult =
  | { kind: "number"; value: number; root: boolean }
  | {
      kind: "uncertain";
      mean: number;
      sd: number;
      /** Bar heights (the tallest is 1) over the histogram's display window. */
      histogram: number[];
      /** The fractions of samples beyond the window on each side (SPECS.md §6.5). */
      tails: { below: number; above: number };
      root: boolean;
    }
  | { kind: "text"; text: string }
  | { kind: "error"; code: string; message: string; root: boolean };

/** Results per sheet id, then per cell address. */
export type WorkbookResults = Map<string, Map<string, CellResult>>;

/** Bins in each uncertain cell's histogram (SPECS.md §6.5). */
export const HISTOGRAM_BINS = 64;

/** A backend and how many iterations to run on it. */
export interface EngineRun {
  backend: Backend;
  count: number;
  /** Iterations per batch (defaults to the backend's own limit, or 10,000). */
  batch?: number;
  /** The backend computes in f32 (the GPU), so its results are shown to f32 precision. */
  f32?: boolean;
}

/**
 * The engines for a recalculation. The primary's results are shown. A secondary, when present,
 * runs the same model with the same seed and is compared with the primary over the iterations
 * both computed (SPECS.md §6.7).
 */
export interface Engines {
  primary: EngineRun;
  secondary?: EngineRun;
}

export interface RecalcOptions {
  seed: number;
  /** Minimum time between progress updates, in milliseconds. */
  throttleMs?: number;
}

/** How the secondary engine compares with the primary, so far. */
export interface Comparison {
  /** Iterations compared so far. */
  compared: number;
  /** Iterations that will be compared in all. */
  total: number;
  /** Cells whose samples differ beyond f32 rounding. */
  differing: { sheetId: string; address: string }[];
}

export interface Progress {
  done: number;
  total: number;
}

export interface Recalculation {
  results: WorkbookResults;
  comparison?: Comparison;
  progress: { primary: Progress; secondary?: Progress };
  /** Every iteration has run on every engine. */
  complete: boolean;
}

/** Significant digits an f32 holds: GPU results are shown to this precision, not beyond. */
const F32_DIGITS = 7;

function summarize(
  acc: CellAccumulator,
  uncertain: boolean,
  root: boolean,
  f32: boolean,
): CellResult {
  if (acc.hasNaN) {
    return { kind: "error", code: "#NUM!", message: "The result is not a number", root };
  }
  if (acc.hasInfinite) {
    return { kind: "error", code: "#DIV/0!", message: "The result is infinite", root };
  }
  if (!uncertain) {
    // An f32 result (from the GPU) is only good to ~7 significant digits: 103.2 comes back as
    // 103.1999969. Round it, so exact values show exactly.
    const value = f32 ? Number(acc.first.toPrecision(F32_DIGITS)) : acc.first;
    return { kind: "number", value, root };
  }
  return {
    kind: "uncertain",
    mean: acc.mean,
    sd: acc.sd,
    ...histogramOf(acc),
    root,
  };
}

/** An accumulator's histogram to show: its display window's bars, and its tails. */
function histogramOf(acc: CellAccumulator): {
  histogram: number[];
  tails: { below: number; above: number };
} {
  const { counts, below, above } = acc.displayHistogram(HISTOGRAM_BINS);
  return { histogram: counts, tails: { below, above } };
}

/** The engine's view of a workbook's sheets, including series columns for lookups. */
export function sheetInputs(workbook: Pick<Workbook, "sheets">): SheetInput[] {
  return workbook.sheets.map(({ name, cells, series, names }) => ({
    name,
    cells,
    ...(series ? { series: { granularity: series.granularity, columns: series.columns } } : {}),
    ...(names ? { names } : {}),
  }));
}

export interface RunningRecalculation {
  /** Stops the run; no more updates are delivered. */
  cancel(): void;
  /** The final recalculation, or null if it was cancelled. */
  done: Promise<Recalculation | null>;
}

/**
 * Starts recalculating a workbook progressively (SPECS.md §6.3, §6.4). The whole workbook compiles
 * to one program (so formulas can look up series sheets, §5.3), which runs in batches on one or
 * two engines. `onUpdate` receives results a few times a second, sharpening as batches arrive,
 * and a final time when the run completes.
 */
export function startRecalculation(
  workbook: Workbook,
  { primary, secondary }: Engines,
  { seed, throttleMs = 200 }: RecalcOptions,
  onUpdate: (recalculation: Recalculation) => void,
): RunningRecalculation {
  const controller = new AbortController();
  const { program, sheets } = compileWorkbook(sheetInputs(workbook));

  // Labels and compile errors stay the same for the whole run.
  const fixed: WorkbookResults = new Map();
  workbook.sheets.forEach((sheet, index) => {
    const sheetResults = new Map<string, CellResult>();
    const outcome = sheets[index];
    for (const address of outcome?.labels ?? []) {
      sheetResults.set(address, { kind: "text", text: String(sheet.cells[address] ?? "") });
    }
    for (const [address, { code, message }] of outcome?.errors ?? []) {
      const root = outcome?.roots.has(address) ?? false;
      sheetResults.set(address, { kind: "error", code, message, root });
    }
    fixed.set(sheet.id, sheetResults);
  });

  const outputs = [...program.cells.keys()];
  const uncertain = uncertainCells(program);
  const locate = (key: string) => {
    const { sheetIndex, address } = splitCellKey(key);
    const sheet = workbook.sheets[sheetIndex];
    return sheet ? { sheet, sheetIndex, address } : null;
  };

  const snapshot = (state: ProgressState): Recalculation => {
    const results: WorkbookResults = new Map(
      [...fixed].map(([sheetId, cells]) => [sheetId, new Map(cells)]),
    );
    for (const key of outputs) {
      const cell = locate(key);
      // Until the primary engine has results (the GPU may still be compiling a changed model),
      // show the secondary's, so the grid never waits on the slower engine to start.
      const primaryAcc = state.primary.accumulators.get(key);
      const usePrimary = (primaryAcc?.count ?? 0) > 0;
      const acc = usePrimary ? primaryAcc : state.secondary?.accumulators.get(key);
      if (!cell || !acc || acc.count === 0) continue;
      const f32 = (usePrimary ? primary.f32 : secondary?.f32) ?? false;
      const root = sheets[cell.sheetIndex]?.roots.has(cell.address) ?? false;
      results.get(cell.sheet.id)?.set(cell.address, summarize(acc, uncertain.has(key), root, f32));
    }
    const progress: Recalculation["progress"] = {
      primary: { done: state.primary.done, total: state.primary.total },
    };
    if (state.secondary) {
      progress.secondary = { done: state.secondary.done, total: state.secondary.total };
    }
    const recalculation: Recalculation = { results, progress, complete: state.complete };
    if (state.comparison) {
      recalculation.comparison = {
        compared: state.comparison.compared,
        total: state.comparison.total,
        differing: state.comparison.differing.flatMap((key) => {
          const cell = locate(key);
          return cell ? [{ sheetId: cell.sheet.id, address: cell.address }] : [];
        }),
      };
    }
    return recalculation;
  };

  const spec = ({ backend, count, batch }: EngineRun) =>
    batch === undefined ? { backend, total: count } : { backend, total: count, batch };

  const done = (async (): Promise<Recalculation | null> => {
    if (outputs.length === 0) {
      const final = snapshot({
        primary: { done: primary.count, total: primary.count, accumulators: new Map() },
        complete: true,
      });
      onUpdate(final);
      return final;
    }
    try {
      const options = {
        outputs,
        seed,
        primary: spec(primary),
        throttleMs,
        signal: controller.signal,
      };
      const final = await runProgressively(
        program,
        secondary ? { ...options, secondary: spec(secondary) } : options,
        (state) => {
          if (!controller.signal.aborted) onUpdate(snapshot(state));
        },
      );
      return snapshot(final);
    } catch (error) {
      if (error instanceof RunAbortedError) return null;
      throw error;
    }
  })();

  return { cancel: () => controller.abort(), done };
}

/** Recalculates a workbook to completion, without intermediate updates. */
export async function recalculate(
  workbook: Workbook,
  engines: Engines,
  { seed }: RecalcOptions,
): Promise<Recalculation> {
  const final = await startRecalculation(
    workbook,
    engines,
    { seed, throttleMs: Number.POSITIVE_INFINITY },
    () => {},
  ).done;
  if (!final) throw new Error("The recalculation was cancelled");
  return final;
}

/** Formats a number like Excel's "General" format: up to 10 significant digits, no grouping. */
export function formatNumber(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e15) return String(value);
  const text = abs >= 1e-9 && abs < 1e15 ? value.toPrecision(10) : value.toExponential(5);
  const [mantissa = "", exponent] = text.split("e");
  const trimmed = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

/**
 * Formats a mean and standard deviation as "mean ± SD", with the SD to 2 significant digits and
 * the mean rounded to the same decimal place.
 */
export function formatUncertain(mean: number, sd: number): string {
  if (!(sd > 0)) return formatNumber(mean);
  const decimals = Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(sd))));
  // A small negative mean can round to "-0"; show it as "0".
  const shownMean = mean.toFixed(decimals).replace(/^-(0\.?0*)$/, "$1");
  return `${shownMean} ± ${sd.toFixed(decimals)}`;
}

/** The text a cell shows for a result. */
export function formatResult(result: CellResult): string {
  switch (result.kind) {
    case "number":
      return formatNumber(result.value);
    case "uncertain":
      return formatUncertain(result.mean, result.sd);
    case "text":
      return result.text;
    case "error":
      return result.code;
  }
}
