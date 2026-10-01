import type { HistogramWindow } from "@fumoca/engine";
import type { OutputSummary } from "./scenarioRun";

/**
 * The scenario results pivot (SPECS.md §7.4): each dimension of a scenario, and the outputs, are
 * fields that sit on the rows, on the columns, or in the filters. A cell of the pivot shows one
 * output for the combinations its row, column and filters select: one combination, or several
 * pooled together when a filter is set to "All".
 */

/** The field that picks which output a pivot cell shows. */
export const OUTPUTS_FIELD = "~outputs";

export interface PivotField {
  id: string;
  name: string;
  /** Its values' labels: a dimension's alternatives, or the outputs. */
  values: string[];
}

/** A filter's setting: one value, or all of them pooled. */
export type FilterValue = number | "all";

export interface PivotLayout {
  rows: string[];
  columns: string[];
  /** Every field on neither axis, with its setting. */
  filters: Record<string, FilterValue>;
}

export type PivotZone = "rows" | "columns" | "filters";

/**
 * The starting layout: with one dimension, it goes down the rows and the outputs across; with
 * more, the first two dimensions take the rows and columns, and the outputs and any further
 * dimensions are filters at their first value (or, with few outputs, the outputs join the columns).
 */
export function defaultLayout(fields: PivotField[]): PivotLayout {
  const dimensions = fields.filter((f) => f.id !== OUTPUTS_FIELD);
  const outputs = fields.find((f) => f.id === OUTPUTS_FIELD);
  const layout: PivotLayout = { rows: [], columns: [], filters: {} };
  const [first, second, ...rest] = dimensions;
  if (first) layout.rows.push(first.id);
  if (second) layout.columns.push(second.id);
  for (const field of rest) layout.filters[field.id] = 0;
  if (outputs) {
    if (!second || outputs.values.length <= 1) layout.columns.push(outputs.id);
    else layout.filters[outputs.id] = 0;
  }
  return layout;
}

/** Keeps a layout valid for a set of fields: drops missing fields, adds new ones as filters. */
export function reconcileLayout(layout: PivotLayout, fields: PivotField[]): PivotLayout {
  const ids = new Set(fields.map((f) => f.id));
  const rows = layout.rows.filter((id) => ids.has(id));
  const columns = layout.columns.filter((id) => ids.has(id));
  const filters: Record<string, FilterValue> = {};
  for (const field of fields) {
    if (rows.includes(field.id) || columns.includes(field.id)) continue;
    const current = layout.filters[field.id];
    filters[field.id] =
      current === "all" || (typeof current === "number" && current < field.values.length)
        ? current
        : 0;
  }
  return { rows, columns, filters };
}

/** Moves a field to a zone (at `index`, or the end). A field moved to the filters takes its first value. */
export function moveField(
  layout: PivotLayout,
  fieldId: string,
  zone: PivotZone,
  index?: number,
): PivotLayout {
  const rows = layout.rows.filter((id) => id !== fieldId);
  const columns = layout.columns.filter((id) => id !== fieldId);
  const filters = { ...layout.filters };
  const previous = filters[fieldId];
  delete filters[fieldId];
  const insert = (list: string[]) => {
    const at = index === undefined ? list.length : Math.min(Math.max(index, 0), list.length);
    list.splice(at, 0, fieldId);
  };
  if (zone === "rows") insert(rows);
  else if (zone === "columns") insert(columns);
  else filters[fieldId] = fieldId === OUTPUTS_FIELD ? 0 : (previous ?? 0);
  return { rows, columns, filters };
}

/** Every combination of the given fields' values, the last varying fastest. */
function keysOf(fields: PivotField[]): number[][] {
  let keys: number[][] = [[]];
  for (const field of fields) {
    keys = keys.flatMap((key) => field.values.map((_, i) => [...key, i]));
  }
  return keys;
}

export interface PivotCell {
  /** The output shown. */
  output: number;
  /** The result: one combination's, or several pooled. Null while it's still to run. */
  summary: OutputSummary | null;
  /** The combinations it covers, as indices into the scenario's combinations. */
  combinations: number[];
}

export interface Pivot {
  rowFields: PivotField[];
  columnFields: PivotField[];
  /** Each row's value index per row field, and each column's per column field. */
  rowKeys: number[][];
  columnKeys: number[][];
  cell(row: number, column: number): PivotCell;
}

/**
 * Builds the pivot for a layout. `dimensions` are the scenario's dimension fields in combination
 * order (the last varies fastest), and `results[c][o]` is output `o` in combination `c`.
 */
export function buildPivot(
  dimensions: PivotField[],
  outputs: PivotField,
  layout: PivotLayout,
  results: (OutputSummary | null)[][],
  samples: number,
): Pivot {
  const fields = new Map([...dimensions, outputs].map((f) => [f.id, f]));
  const pick = (ids: string[]) => ids.flatMap((id) => fields.get(id) ?? []);
  const rowFields = pick(layout.rows);
  const columnFields = pick(layout.columns);
  const rowKeys = keysOf(rowFields);
  const columnKeys = keysOf(columnFields);

  // Mixed-radix strides: a combination's index from its choice of each dimension.
  const strides = dimensions.map((_, d) =>
    dimensions.slice(d + 1).reduce((n, f) => n * f.values.length, 1),
  );

  const cell = (row: number, column: number): PivotCell => {
    const fixed = new Map<string, number>();
    for (const [i, f] of rowFields.entries()) fixed.set(f.id, rowKeys[row]?.[i] ?? 0);
    for (const [i, f] of columnFields.entries()) fixed.set(f.id, columnKeys[column]?.[i] ?? 0);
    for (const [id, value] of Object.entries(layout.filters)) {
      if (value !== "all") fixed.set(id, value);
    }
    const output = fixed.get(OUTPUTS_FIELD) ?? 0;
    // Combinations matching the fixed dimensions; pooled ("All") dimensions take every value.
    let indices = [0];
    dimensions.forEach((field, d) => {
      const choice = fixed.get(field.id);
      const choices = choice === undefined ? field.values.map((_, i) => i) : [choice];
      indices = indices.flatMap((base) => choices.map((c) => base + c * (strides[d] ?? 0)));
    });
    const summaries = indices.map((c) => results[c]?.[output] ?? null);
    const summary = summaries.includes(null)
      ? null
      : poolSummaries(summaries as OutputSummary[], samples);
    return { output, summary, combinations: indices };
  };

  return { rowFields, columnFields, rowKeys, columnKeys, cell };
}

const HISTOGRAM_BINS = 64;

/** A sample set to re-bin: a histogram window over its samples, or a single value (`mean`). */
export interface BinnedPart {
  count: number;
  mean: number;
  histogram: HistogramWindow | null;
}

/** The range covering every part's histogram window (or value). */
export function histogramRange(parts: readonly BinnedPart[]): { lo: number; hi: number } {
  const lo = Math.min(...parts.map((p) => p.histogram?.lo ?? p.mean));
  const hi = Math.max(...parts.map((p) => p.histogram?.hi ?? p.mean));
  return { lo, hi: hi > lo ? hi : lo + HISTOGRAM_BINS };
}

/**
 * Re-bins parts' samples onto `bins` equal bins over [lo, hi), adding them together. A part's
 * samples outside its own window (its tails) aren't counted. Each source bin is scaled to its
 * share of the part's samples, then spread over the target bins it overlaps.
 */
export function rebin(
  parts: readonly BinnedPart[],
  lo: number,
  hi: number,
  bins = HISTOGRAM_BINS,
): number[] {
  const width = (hi - lo) / bins;
  const counts = new Array<number>(bins).fill(0);
  const binOf = (x: number) => Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / width)));
  for (const part of parts) {
    if (!part.histogram) {
      counts[binOf(part.mean)] = (counts[binOf(part.mean)] ?? 0) + part.count;
      continue;
    }
    const { lo: from, hi: to, counts: source, below, above } = part.histogram;
    const total = source.reduce((a, b) => a + b, 0);
    const sourceWidth = (to - from) / source.length;
    const inside = part.count * (1 - below - above);
    source.forEach((n, i) => {
      if (n === 0 || total === 0) return;
      const weight = (n / total) * inside;
      const a = from + i * sourceWidth;
      const b = a + sourceWidth;
      for (let bin = binOf(a); bin <= binOf(b); bin++) {
        const overlap = Math.min(b, lo + (bin + 1) * width) - Math.max(a, lo + bin * width);
        if (overlap > 0) counts[bin] = (counts[bin] ?? 0) + (weight * overlap) / sourceWidth;
      }
    });
  }
  return counts;
}

/**
 * Pools several results into one, as if their samples were combined (an equal-weight mixture):
 * counts, means and variances merge exactly (Chan et al.), and histograms are re-binned onto their
 * common range. An error in any of them is the pooled result.
 */
export function poolSummaries(list: OutputSummary[], samples: number): OutputSummary | null {
  const [first] = list;
  if (!first) return null;
  if (list.length === 1) return first;
  const error = list.find((s) => s.kind === "error");
  if (error) return error;
  if (
    list.every(
      (s) =>
        s.kind === "number" && s.value === (first.kind === "number" ? first.value : Number.NaN),
    )
  ) {
    return first;
  }
  // Every part as (count, mean, m2, histogram); a deterministic value is a point mass.
  const parts = list.map((s) =>
    s.kind === "uncertain"
      ? {
          count: s.count,
          mean: s.mean,
          m2: s.sd * s.sd * Math.max(0, s.count - 1),
          histogram: s.histogram,
        }
      : {
          count: samples,
          mean: s.kind === "number" ? s.value : 0,
          m2: 0,
          histogram: null,
        },
  );
  let count = 0;
  let mean = 0;
  let m2 = 0;
  for (const part of parts) {
    const total = count + part.count;
    if (total === 0) continue;
    const delta = part.mean - mean;
    mean += (delta * part.count) / total;
    m2 += part.m2 + (delta * delta * count * part.count) / total;
    count = total;
  }
  const { lo, hi } = histogramRange(parts);
  const counts = rebin(parts, lo, hi);
  const tail = (side: "below" | "above") =>
    parts.reduce((sum, p) => sum + p.count * (p.histogram?.[side] ?? 0), 0) / Math.max(1, count);
  return {
    kind: "uncertain",
    count,
    mean,
    sd: count > 1 ? Math.sqrt(m2 / (count - 1)) : 0,
    histogram: {
      lo,
      hi,
      counts,
      below: tail("below"),
      above: tail("above"),
    },
  };
}

/** The value below which a fraction `p` of a histogram's samples lie (linear within a bin). */
export function histogramQuantile(
  histogram: Pick<HistogramWindow, "lo" | "hi" | "counts">,
  p: number,
): number {
  const total = histogram.counts.reduce((a, b) => a + b, 0);
  const width = (histogram.hi - histogram.lo) / histogram.counts.length;
  let below = 0;
  for (const [i, n] of histogram.counts.entries()) {
    if (n > 0 && below + n >= p * total) {
      return histogram.lo + (i + (p * total - below) / n) * width;
    }
    below += n;
  }
  return histogram.hi;
}

/** The mean a result shows, for sorting and comparing with the Baseline. */
export const summaryMean = (summary: OutputSummary | null): number | null =>
  summary?.kind === "number" ? summary.value : summary?.kind === "uncertain" ? summary.mean : null;
