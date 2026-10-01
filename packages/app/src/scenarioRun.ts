import {
  type Backend,
  type CellAccumulator,
  cellKey,
  compileWorkbook,
  type HistogramWindow,
  uncertainCells,
} from "@fumoca/engine";
import { RunAbortedError, runProgressively } from "@fumoca/sim";
import {
  type CellInput,
  type Combination,
  combinations,
  type Override,
  type Scenario,
  type Workbook,
} from "@fumoca/storage";
import { HISTOGRAM_BINS, sheetInputs } from "./recalc";

/**
 * Running a scenario (SPECS.md §7.3): the Baseline (the workbook as it is) and then every
 * combination of the scenario's alternatives, each a full Monte Carlo run of the scenario's
 * output cells. Every run uses the same seed, and random streams are named by cell, so cells a
 * combination doesn't override draw the same numbers in every combination (common random
 * numbers).
 */

/** One output's result in one combination: mergeable, so the results view can pool them. */
export type OutputSummary =
  | { kind: "number"; value: number }
  | {
      kind: "uncertain";
      count: number;
      mean: number;
      sd: number;
      /**
       * The histogram's display window (SPECS.md §6.5): bar counts over [lo, hi), and the
       * fractions of samples below and above it.
       */
      histogram: HistogramWindow;
    }
  | { kind: "error"; code: string; message: string };

export interface ScenarioResults {
  /** Each output's result in the Baseline, in the order of the scenario's outputs. */
  baseline: (OutputSummary | null)[];
  /** Each combination's outputs, in the order of `combinations(scenario)`. */
  combinations: (OutputSummary | null)[][];
  /** Combinations finished (the Baseline counts as one) and in all. */
  progress: { done: number; total: number };
  complete: boolean;
}

/**
 * A cell's input scaled by a factor: a number times it, and a formula wrapped as
 * `=(formula)*factor`, which scales a distribution's every sample. Text and empty cells stay.
 */
export function scaleInput(input: CellInput | undefined, scale: number): CellInput | undefined {
  if (typeof input === "number") return input * scale;
  if (typeof input === "string" && input.startsWith("=")) return `=(${input.slice(1)})*${scale}`;
  return input;
}

/**
 * Returns a copy of the workbook with some cells' inputs replaced or scaled. An empty input
 * clears one.
 */
export function applyOverrides(workbook: Workbook, overrides: readonly Override[]): Workbook {
  if (overrides.length === 0) return workbook;
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      const mine = overrides.filter((o) => o.cell.sheetId === sheet.id);
      if (mine.length === 0) return sheet;
      const cells = { ...sheet.cells };
      for (const override of mine) {
        const { address } = override.cell;
        const input =
          "scale" in override ? scaleInput(cells[address], override.scale) : override.input;
        if (input === "" || input === undefined) delete cells[address];
        else cells[address] = input;
      }
      return { ...sheet, cells };
    }),
  };
}

/** Significant digits an f32 holds: GPU results are shown to this precision. */
const F32_DIGITS = 7;

function summarize(acc: CellAccumulator, uncertain: boolean, f32: boolean): OutputSummary {
  if (acc.hasNaN) return { kind: "error", code: "#NUM!", message: "The result is not a number" };
  if (acc.hasInfinite) return { kind: "error", code: "#DIV/0!", message: "The result is infinite" };
  if (!uncertain) {
    return { kind: "number", value: f32 ? Number(acc.first.toPrecision(F32_DIGITS)) : acc.first };
  }

  return {
    kind: "uncertain",
    count: acc.count,
    mean: acc.mean,
    sd: acc.sd,
    histogram: acc.histogram.display(HISTOGRAM_BINS),
  };
}

export interface ScenarioEngine {
  backend: Backend;
  /** Iterations per batch (defaults to the backend's own limit). */
  batch?: number;
  /** The backend computes in f32 (the GPU). */
  f32?: boolean;
}

export interface RunningScenario {
  cancel(): void;
  /** The final results, or null if the run was cancelled. */
  done: Promise<ScenarioResults | null>;
}

/**
 * Runs a scenario's Baseline and combinations one after another on one engine, calling
 * `onUpdate` as results arrive (throttled) and when each combination finishes.
 */
export function startScenarioRun(
  workbook: Workbook,
  scenario: Scenario,
  { backend, batch, f32 = false }: ScenarioEngine,
  { seed, throttleMs = 200 }: { seed: number; throttleMs?: number },
  onUpdate: (results: ScenarioResults) => void,
): RunningScenario {
  const controller = new AbortController();
  const runs: Combination[] = [{ choices: new Map(), overrides: [] }, ...combinations(scenario)];
  const results: ScenarioResults = {
    baseline: scenario.outputs.map(() => null),
    combinations: runs.slice(1).map(() => scenario.outputs.map(() => null)),
    progress: { done: 0, total: runs.length },
    complete: false,
  };
  const outputsOf = (run: number) => (run === 0 ? results.baseline : results.combinations[run - 1]);
  const post = () => onUpdate(structuredClone(results));

  const runOne = async (run: number, combination: Combination): Promise<void> => {
    const target = outputsOf(run);
    if (!target) return;
    const sheets = applyOverrides(workbook, combination.overrides).sheets;
    const { program, sheets: outcomes } = compileWorkbook(sheetInputs({ sheets }));
    const uncertain = uncertainCells(program);
    // Each output's program key, or its fixed result (an error, text, or an empty cell).
    const keys: (string | null)[] = scenario.outputs.map(({ sheetId, address }, i) => {
      const sheetIndex = sheets.findIndex((s) => s.id === sheetId);
      const outcome = outcomes[sheetIndex];
      const error = outcome?.errors.get(address);
      if (sheetIndex < 0) {
        target[i] = { kind: "error", code: "#REF!", message: "The sheet no longer exists" };
      } else if (error) {
        target[i] = { kind: "error", code: error.code, message: error.message };
      } else if (outcome?.labels.has(address)) {
        target[i] = { kind: "error", code: "#VALUE!", message: "The output cell holds text" };
      } else {
        const key = cellKey(sheetIndex, address);
        if (program.cells.has(key)) return key;
        target[i] = { kind: "number", value: 0 }; // an empty cell reads as 0
      }
      return null;
    });
    const outputs = keys.filter((key): key is string => key !== null);
    if (outputs.length === 0) return;
    const fill = (accumulators: Map<string, CellAccumulator>) =>
      keys.forEach((key, i) => {
        const acc = key === null ? undefined : accumulators.get(key);
        if (key !== null && acc && acc.count > 0)
          target[i] = summarize(acc, uncertain.has(key), f32);
      });
    const primary =
      batch === undefined
        ? { backend, total: scenario.samples }
        : { backend, total: scenario.samples, batch };
    const final = await runProgressively(
      program,
      {
        outputs,
        seed,
        primary,
        throttleMs,
        signal: controller.signal,
      },
      (state) => {
        if (controller.signal.aborted) return;
        fill(state.primary.accumulators);
        post();
      },
    );
    fill(final.primary.accumulators);
  };

  const done = (async (): Promise<ScenarioResults | null> => {
    try {
      for (const [run, combination] of runs.entries()) {
        await runOne(run, combination);
        if (controller.signal.aborted) return null;
        results.progress.done = run + 1;
        results.complete = run + 1 === runs.length;
        post();
      }
      return structuredClone(results);
    } catch (error) {
      if (error instanceof RunAbortedError) return null;
      throw error;
    }
  })();

  return { cancel: () => controller.abort(), done };
}
