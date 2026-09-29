import { describe, expect, it } from "vitest";
import {
  buildPivot,
  defaultLayout,
  histogramQuantile,
  moveField,
  OUTPUTS_FIELD,
  type PivotField,
  poolSummaries,
  reconcileLayout,
} from "./pivot";
import type { OutputSummary } from "./scenarioRun";

const rate: PivotField = { id: "rate", name: "Rate", values: ["3%", "5%", "7%"] };
const strategy: PivotField = {
  id: "strategy",
  name: "Strategy",
  values: ["Aggressive", "Cautious"],
};
const outputs: PivotField = { id: OUTPUTS_FIELD, name: "Output", values: ["Profit", "Cash"] };

/** Output o of combination (r, s) is the number 100·r + 10·s + o. */
const results: (OutputSummary | null)[][] = [0, 1, 2].flatMap((r) =>
  [0, 1].map((s) =>
    [0, 1].map((o) => ({ kind: "number", value: 100 * r + 10 * s + o }) as OutputSummary),
  ),
);
const shown = (summary: OutputSummary | null) =>
  summary?.kind === "number" ? summary.value : summary?.kind === "uncertain" ? summary.mean : null;

describe("pivot layouts", () => {
  it("default to the first dimensions on rows and columns, the rest as filters", () => {
    expect(defaultLayout([rate, outputs])).toEqual({
      rows: ["rate"],
      columns: [OUTPUTS_FIELD],
      filters: {},
    });
    expect(defaultLayout([rate, strategy, outputs])).toEqual({
      rows: ["rate"],
      columns: ["strategy"],
      filters: { [OUTPUTS_FIELD]: 0 },
    });
    const third: PivotField = { id: "third", name: "Third", values: ["a", "b"] };
    expect(defaultLayout([rate, strategy, third, outputs]).filters).toEqual({
      third: 0,
      [OUTPUTS_FIELD]: 0,
    });
  });

  it("move fields between zones", () => {
    const layout = defaultLayout([rate, strategy, outputs]);
    const flat = moveField(layout, "strategy", "rows");
    expect(flat).toEqual({
      rows: ["rate", "strategy"],
      columns: [],
      filters: { [OUTPUTS_FIELD]: 0 },
    });
    expect(moveField(flat, OUTPUTS_FIELD, "columns")).toEqual({
      rows: ["rate", "strategy"],
      columns: [OUTPUTS_FIELD],
      filters: {},
    });
    expect(moveField(flat, "rate", "filters").filters).toEqual({ [OUTPUTS_FIELD]: 0, rate: 0 });
    expect(moveField(flat, "strategy", "rows", 0).rows).toEqual(["strategy", "rate"]);
  });

  it("stay valid when the fields change", () => {
    const layout = { rows: ["gone", "rate"], columns: [], filters: { strategy: 5 } };
    expect(reconcileLayout(layout, [rate, strategy, outputs])).toEqual({
      rows: ["rate"],
      columns: [],
      filters: { strategy: 0, [OUTPUTS_FIELD]: 0 },
    });
  });
});

describe("buildPivot", () => {
  it("places each combination's output at its row and column", () => {
    const layout = defaultLayout([rate, strategy, outputs]);
    const pivot = buildPivot([rate, strategy], outputs, layout, results, 1000);
    expect(pivot.rowKeys).toEqual([[0], [1], [2]]);
    expect(pivot.columnKeys).toEqual([[0], [1]]);
    expect(shown(pivot.cell(2, 1).summary)).toBe(210);
    const cash = buildPivot(
      [rate, strategy],
      outputs,
      { ...layout, filters: { [OUTPUTS_FIELD]: 1 } },
      results,
      1000,
    );
    expect(shown(cash.cell(2, 1).summary)).toBe(211);
  });

  it("lists every combination when all dimensions are on the rows", () => {
    const layout = { rows: ["rate", "strategy"], columns: [OUTPUTS_FIELD], filters: {} };
    const pivot = buildPivot([rate, strategy], outputs, layout, results, 1000);
    expect(pivot.rowKeys).toHaveLength(6);
    expect(pivot.rowKeys.map((_, r) => shown(pivot.cell(r, 1).summary))).toEqual([
      1, 11, 101, 111, 201, 211,
    ]);
  });

  it("pools a dimension set to All in the filters", () => {
    const layout = {
      rows: ["rate"],
      columns: [OUTPUTS_FIELD],
      filters: { strategy: "all" as const },
    };
    const pivot = buildPivot([rate, strategy], outputs, layout, results, 1000);
    const pooled = pivot.cell(1, 0);
    expect(pooled.combinations).toEqual([2, 3]);
    // 100 and 110, pooled equally: a mean of 105, as two point masses.
    expect(pooled.summary).toMatchObject({ kind: "uncertain", count: 2000, mean: 105 });
    expect(pooled.summary?.kind === "uncertain" && pooled.summary.sd).toBeCloseTo(5, 2);
  });

  it("shows nothing for combinations still to run", () => {
    const partial = results.map((outputsOf, c) => (c === 5 ? [null, null] : outputsOf));
    const pivot = buildPivot(
      [rate, strategy],
      outputs,
      defaultLayout([rate, strategy, outputs]),
      partial,
      10,
    );
    expect(pivot.cell(2, 1).summary).toBeNull();
  });
});

describe("poolSummaries", () => {
  const normalish = (mean: number): OutputSummary => ({
    kind: "uncertain",
    count: 1000,
    mean,
    sd: 1,
    histogram: {
      lo: mean - 4,
      hi: mean + 4,
      counts: [1, 4, 10, 20, 20, 10, 4, 1],
      below: 0,
      above: 0,
    },
  });

  it("merges counts, means and spreads exactly", () => {
    const pooled = poolSummaries([normalish(0), normalish(10)], 1000);
    if (pooled?.kind !== "uncertain") throw new Error("expected a pooled distribution");
    expect(pooled.count).toBe(2000);
    expect(pooled.mean).toBeCloseTo(5, 10);
    // Variance of the mixture: within (1) plus between (25), with n − 1 corrections.
    expect(pooled.sd).toBeCloseTo(Math.sqrt((999 * 2 + 25 * 2000) / 1999), 8);
    // The histogram covers both, and keeps the total.
    expect(pooled.histogram.lo).toBeCloseTo(-4, 10);
    expect(pooled.histogram.hi).toBeCloseTo(14, 10);
    expect(pooled.histogram.counts.reduce((a, b) => a + b, 0)).toBeCloseTo(2000, 6);
  });

  it("keeps a single result, equal numbers and errors as they are", () => {
    const one = normalish(3);
    expect(poolSummaries([one], 10)).toBe(one);
    expect(
      poolSummaries(
        [
          { kind: "number", value: 2 },
          { kind: "number", value: 2 },
        ],
        10,
      ),
    ).toEqual({
      kind: "number",
      value: 2,
    });
    const error: OutputSummary = { kind: "error", code: "#DIV/0!", message: "x" };
    expect(poolSummaries([one, error], 10)).toBe(error);
  });
});

describe("histogramQuantile", () => {
  it("interpolates within bins", () => {
    const histogram = { lo: 0, hi: 4, counts: [1, 1, 1, 1] };
    expect(histogramQuantile(histogram, 0.5)).toBeCloseTo(2, 10);
    expect(histogramQuantile(histogram, 0.1)).toBeCloseTo(0.4, 10);
  });
});
