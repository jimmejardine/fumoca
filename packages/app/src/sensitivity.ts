import { type SensitivityAnalysis, sensitivityIndex } from "@fumoca/storage";
import { histogramQuantile } from "./pivot";
import type { OutputSummary, ScenarioResults } from "./scenarioRun";

/**
 * The arithmetic of a sensitivity analysis's results (SPECS.md §7.5): from each output's statistic
 * in the Baseline and with an input scaled by 1 ± h, the effect of the input on the output.
 */

/** The statistic of an output that changes are measured on. */
export type Statistic = "mean" | "p10" | "p90" | "sd";

/** How an effect is shown: elasticity (%Δy per %Δx), %Δy for the step, or Δy for the step. */
export type Measure = "elasticity" | "percent" | "delta";

export const STATISTICS: { value: Statistic; label: string }[] = [
  { value: "mean", label: "Mean" },
  { value: "p10", label: "P10" },
  { value: "p90", label: "P90" },
  { value: "sd", label: "SD" },
];

export const MEASURES: { value: Measure; label: string }[] = [
  { value: "elasticity", label: "Elasticity" },
  { value: "percent", label: "%Δy" },
  { value: "delta", label: "Δy" },
];

/** A statistic of one output's result, or null if it has none (an error, or not run yet). */
export function statistic(summary: OutputSummary | null, stat: Statistic): number | null {
  if (!summary || summary.kind === "error") return null;
  if (summary.kind === "number") return stat === "sd" ? 0 : summary.value;
  if (stat === "mean") return summary.mean;
  if (stat === "sd") return summary.sd;
  return histogramQuantile(summary.histogram, stat === "p10" ? 0.1 : 0.9);
}

/** An output's statistic in the Baseline and with one input scaled by 1 − h (down) and 1 + h (up). */
export interface Effect {
  base: number;
  down: number;
  up: number;
}

/** Picks out the results for one input, step and output. */
export function effectOf(
  analysis: Pick<SensitivityAnalysis, "steps">,
  results: ScenarioResults,
  input: number,
  step: number,
  output: number,
  stat: Statistic,
): Effect | null {
  const at = (summaries: (OutputSummary | null)[] | undefined) =>
    statistic(summaries?.[output] ?? null, stat);
  const base = at(results.baseline);
  const down = at(results.combinations[sensitivityIndex(analysis, input, step, -1)]);
  const up = at(results.combinations[sensitivityIndex(analysis, input, step, 1)]);
  return base === null || down === null || up === null ? null : { base, down, up };
}

/**
 * An effect as a number, from the central difference (up − down) / 2, which cancels the
 * curvature that one-sided differences pick up:
 * - elasticity: the % change in the output for a 1% change in the input;
 * - percent: the % change in the output for a change of h in the input (as a fraction);
 * - delta: the change in the output for a change of h in the input.
 * Percentages of a zero base are undefined: null.
 */
export function measure(effect: Effect, h: number, how: Measure): number | null {
  const change = (effect.up - effect.down) / 2;
  if (how === "delta") return change;
  if (effect.base === 0) return null;
  return how === "elasticity" ? change / h / effect.base : change / Math.abs(effect.base);
}

/** Whether the rise and the fall differ by more than 10% of the larger: a non-linear response. */
export function lopsided({ base, down, up }: Effect): boolean {
  const rise = up - base;
  const fall = base - down;
  const larger = Math.max(Math.abs(rise), Math.abs(fall));
  return larger > 0 && Math.abs(rise - fall) > 0.1 * larger;
}

/** The matrix's sort: inputs (rows) by one output's effects, or outputs (columns) by one input's. */
export type MatrixSort = { by: "output" | "input"; index: number; descending: boolean } | null;

/** Clicking a header: sort by it, largest effect first, then flip; another header starts over. */
export const nextSort = (sort: MatrixSort, by: "output" | "input", index: number): MatrixSort =>
  sort?.by === by && sort.index === index
    ? { by, index, descending: !sort.descending }
    : { by, index, descending: true };

/**
 * The order to show inputs (rows) and outputs (columns) in, given the matrix of values by
 * [input][output]. Sorting is by size of effect, whatever its sign; missing values go last.
 */
export function matrixOrder(
  values: (number | null)[][],
  outputCount: number,
  sort: MatrixSort,
): { inputs: number[]; outputs: number[] } {
  const inputs = values.map((_, i) => i);
  const outputs = Array.from({ length: outputCount }, (_, o) => o);
  if (!sort) return { inputs, outputs };
  const size = (value: number | null | undefined) =>
    value === null || value === undefined ? Number.NEGATIVE_INFINITY : Math.abs(value);
  const compare = (a: number, b: number) => (sort.descending ? b - a : a - b);
  const byEffect =
    (effectAt: (index: number) => number | null | undefined) => (a: number, b: number) => {
      const x = size(effectAt(a));
      const y = size(effectAt(b));
      // Missing values sort last either way.
      if (x === Number.NEGATIVE_INFINITY || y === Number.NEGATIVE_INFINITY) return y - x || 0;
      return compare(x, y);
    };
  if (sort.by === "output") inputs.sort(byEffect((i) => values[i]?.[sort.index]));
  else outputs.sort(byEffect((o) => values[sort.index]?.[o]));
  return { inputs, outputs };
}

/** One input's bar in a tornado: the output's change when the input goes down and up. */
export interface TornadoBar {
  input: number;
  down: number;
  up: number;
}

/** A tornado for one output and step: each input's swing about the Baseline, largest first. */
export function tornado(effects: (Effect | null)[]): TornadoBar[] {
  return effects
    .flatMap((effect, input) =>
      effect ? [{ input, down: effect.down - effect.base, up: effect.up - effect.base }] : [],
    )
    .sort((a, b) => Math.abs(b.up - b.down) - Math.abs(a.up - a.down));
}

/**
 * A spider line for one input and output: the output's % change against the input's % change,
 * over every step down and up, through (0, 0). Null when the Baseline is 0.
 */
export function spiderLine(steps: number[], effects: (Effect | null)[]): [number, number][] | null {
  const points: [number, number][] = [[0, 0]];
  for (const [step, h] of steps.entries()) {
    const effect = effects[step];
    if (!effect || effect.base === 0) return null;
    const percent = (value: number) => ((value - effect.base) / Math.abs(effect.base)) * 100;
    points.push([-h * 100, percent(effect.down)], [h * 100, percent(effect.up)]);
  }
  return points.sort((a, b) => a[0] - b[0]);
}
