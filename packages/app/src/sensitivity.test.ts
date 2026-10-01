import { describe, expect, it } from "vitest";
import type { OutputSummary, ScenarioResults } from "./scenarioRun";
import {
  effectOf,
  lopsided,
  matrixOrder,
  measure,
  nextSort,
  spiderLine,
  statistic,
  tornado,
} from "./sensitivity";

const value = (v: number): OutputSummary => ({ kind: "number", value: v });

/** y = x² at x = 3, with x scaled by 1 ± h. */
const square = (h: number) => ({ base: 9, down: (3 * (1 - h)) ** 2, up: (3 * (1 + h)) ** 2 });

describe("sensitivity measures", () => {
  it("give the elasticity of x² as 2, exactly, from the central difference", () => {
    expect(measure(square(0.01), 0.01, "elasticity")).toBeCloseTo(2, 10);
    expect(measure(square(0.1), 0.1, "elasticity")).toBeCloseTo(2, 10);
  });

  it("give the % and absolute change for the step", () => {
    // (up − down) / 2 = 2 × 9 × h for x².
    expect(measure(square(0.01), 0.01, "delta")).toBeCloseTo(0.18, 10);
    expect(measure(square(0.01), 0.01, "percent")).toBeCloseTo(0.02, 10);
  });

  it("are undefined as percentages of a zero base, but not as changes", () => {
    const effect = { base: 0, down: -1, up: 1 };
    expect(measure(effect, 0.01, "elasticity")).toBeNull();
    expect(measure(effect, 0.01, "percent")).toBeNull();
    expect(measure(effect, 0.01, "delta")).toBe(1);
  });

  it("keep the sign of the effect for a negative base", () => {
    // y = −2x at x = 5: a 1% rise in x lowers y by 1%, so the elasticity is 1.
    expect(measure({ base: -10, down: -9.9, up: -10.1 }, 0.01, "elasticity")).toBeCloseTo(1, 10);
  });

  it("flag a response whose rise and fall differ by more than 10%", () => {
    expect(lopsided({ base: 10, down: 9, up: 11 })).toBe(false);
    expect(lopsided(square(0.01))).toBe(false);
    expect(lopsided({ base: 10, down: 10, up: 12 })).toBe(true); // a kink, like MAX(x, 10)
    expect(lopsided({ base: 10, down: 10, up: 10 })).toBe(false);
  });
});

describe("statistics of results", () => {
  const uncertain: OutputSummary = {
    kind: "uncertain",
    count: 100,
    mean: 5,
    sd: 2,
    histogram: {
      lo: 0,
      hi: 10,
      counts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      below: 0,
      above: 0,
    },
  };

  it("read the mean, SD and percentiles", () => {
    expect(statistic(uncertain, "mean")).toBe(5);
    expect(statistic(uncertain, "sd")).toBe(2);
    expect(statistic(uncertain, "p10")).toBeCloseTo(1, 10);
    expect(statistic(uncertain, "p90")).toBeCloseTo(9, 10);
  });

  it("treat exact values as having no spread, and errors as missing", () => {
    expect(statistic(value(3), "p90")).toBe(3);
    expect(statistic(value(3), "sd")).toBe(0);
    expect(statistic({ kind: "error", code: "#DIV/0!", message: "" }, "mean")).toBeNull();
    expect(statistic(null, "mean")).toBeNull();
  });

  it("find each input's runs in the results", () => {
    // Two inputs, one step: runs are B1 −, B1 +, B2 −, B2 +.
    const results: ScenarioResults = {
      baseline: [value(10)],
      combinations: [[value(9)], [value(11)], [value(8)], [value(12)]],
      progress: { done: 5, total: 5 },
      complete: true,
    };
    const analysis = { steps: [0.01] };
    expect(effectOf(analysis, results, 1, 0, 0, "mean")).toEqual({ base: 10, down: 8, up: 12 });
    expect(effectOf(analysis, { ...results, combinations: [] }, 0, 0, 0, "mean")).toBeNull();
  });
});

describe("the sensitivity matrix", () => {
  // [input][output]
  const values = [
    [0.5, -3],
    [-2, null],
    [1, 1],
  ];

  it("sorts inputs by one output's effect, largest first whatever its sign, then flips", () => {
    const sort = nextSort(null, "output", 0);
    expect(matrixOrder(values, 2, sort).inputs).toEqual([1, 2, 0]);
    expect(matrixOrder(values, 2, nextSort(sort, "output", 0)).inputs).toEqual([0, 2, 1]);
  });

  it("keeps missing effects last, and sorts outputs by one input's effects", () => {
    expect(matrixOrder(values, 2, nextSort(null, "output", 1)).inputs).toEqual([0, 2, 1]);
    expect(matrixOrder(values, 2, nextSort(null, "input", 0)).outputs).toEqual([1, 0]);
  });

  it("starts a new sort, largest first, when another header is clicked", () => {
    const byOutput = nextSort(nextSort(null, "output", 0), "output", 0);
    expect(nextSort(byOutput, "input", 2)).toEqual({ by: "input", index: 2, descending: true });
  });
});

describe("charts", () => {
  it("rank tornado bars by swing", () => {
    expect(tornado([{ base: 10, down: 9, up: 11 }, null, { base: 10, down: 14, up: 5 }])).toEqual([
      { input: 2, down: 4, up: -5 },
      { input: 0, down: -1, up: 1 },
    ]);
  });

  it("draw spider lines through the origin, in % of the Baseline", () => {
    expect(
      spiderLine(
        [0.01, 0.1],
        [
          { base: 10, down: 9.9, up: 10.1 },
          { base: 10, down: 9, up: 11.5 },
        ],
      ),
    ).toEqual([
      [-10, -10],
      [-1, expect.closeTo(-1, 10)],
      [0, 0],
      [1, expect.closeTo(1, 10)],
      [10, 15],
    ]);
    expect(spiderLine([0.01], [{ base: 0, down: -1, up: 1 }])).toBeNull();
  });
});
