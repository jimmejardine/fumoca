import { type Backend, evaluateCpu } from "@fumoca/engine";
import { createSheet } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { parseCellInput } from "./cellInput";
import { formatNumber, formatResult, formatUncertain, HISTOGRAM_BINS, recalculate } from "./recalc";

/** A synchronous stand-in for the CPU/GPU backends. */
const fakeBackend: Backend = {
  name: "fake",
  run: async (program, options) => evaluateCpu(program, options),
  dispose: () => {},
};

async function calc(cells: Record<string, number | string>) {
  const sheet = createSheet("S", cells);
  const results = await recalculate({ sheets: [sheet] }, fakeBackend, { seed: 1, count: 20_000 });
  return results.get(sheet.id) ?? new Map();
}

describe("recalculate", () => {
  it("calculates deterministic cells, marking roots", async () => {
    const results = await calc({ A1: 1250, A2: "=A1 * 1.08 - 40", A3: "=1+2" });
    expect(results.get("A1")).toEqual({ kind: "number", value: 1250, root: true });
    expect(results.get("A2")).toEqual({ kind: "number", value: 1310, root: false });
    expect(results.get("A3")).toEqual({ kind: "number", value: 3, root: true });
  });

  it("summarizes uncertain cells as mean and SD", async () => {
    const results = await calc({ A1: "=NORMAL(100, 10)", A2: "=A1 * 2" });
    const a1 = results.get("A1");
    const a2 = results.get("A2");
    expect(a1).toMatchObject({ kind: "uncertain", root: true });
    expect(a2).toMatchObject({ kind: "uncertain", root: false });
    if (a1?.kind !== "uncertain" || a2?.kind !== "uncertain") throw new Error("not uncertain");
    expect(a1.mean).toBeCloseTo(100, 0);
    expect(a1.sd).toBeCloseTo(10, 0);
    expect(a2.mean).toBeCloseTo(2 * a1.mean, 10);
  });

  it("attaches a histogram to uncertain cells only, peaking near the mean", async () => {
    const results = await calc({ A1: "=NORMAL(100, 10)", A2: 5, A3: "=A2*2" });
    const a1 = results.get("A1");
    if (a1?.kind !== "uncertain") throw new Error("not uncertain");
    expect(a1.histogram).toHaveLength(HISTOGRAM_BINS);
    expect(Math.max(...a1.histogram)).toBe(1);
    // A normal distribution: the middle is taller than the edges.
    const middle = Math.max(...a1.histogram.slice(HISTOGRAM_BINS * 0.375, HISTOGRAM_BINS * 0.625));
    expect(middle).toBe(1);
    expect(a1.histogram[0]).toBeLessThan(0.05);
    expect(a1.histogram[HISTOGRAM_BINS - 1]).toBeLessThan(0.05);
    expect(results.get("A2")).not.toHaveProperty("histogram");
    expect(results.get("A3")).not.toHaveProperty("histogram");
  });

  it("reports labels, compile errors and non-finite results", async () => {
    const results = await calc({
      A1: "Spot",
      A2: "=FOO()",
      A3: "=A2+1",
      A4: "=LN(-1)",
      A5: "=1/0",
    });
    expect(results.get("A1")).toEqual({ kind: "text", text: "Spot" });
    expect(results.get("A2")).toMatchObject({ kind: "error", code: "#NAME?" });
    expect(results.get("A3")).toMatchObject({ kind: "error", code: "#NAME?" });
    expect(results.get("A4")).toMatchObject({ kind: "error", code: "#NUM!" });
    expect(results.get("A5")).toMatchObject({ kind: "error", code: "#DIV/0!" });
  });
});

describe("formatting", () => {
  it.each([
    [0, "0"],
    [1310, "1310"],
    [-42, "-42"],
    [0.05, "0.05"],
    [1 / 3, "0.3333333333"],
    [1234567.891, "1234567.891"],
    [1e-12, "1e-12"],
    [2.5e20, "2.5e+20"],
  ])("formatNumber(%d) = %s", (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });

  it.each([
    [100.0168, 10.02, "100 ± 10"],
    [1.00003, 0.0578, "1.000 ± 0.058"],
    [8.0229, 13.2, "8 ± 13"],
    [95.013, 0.0012345, "95.0130 ± 0.0012"],
    [5, 0, "5"],
    [-0.03, 13.2, "0 ± 13"],
    [-0.004, 5.5, "0.0 ± 5.5"],
    [-0.06, 5.5, "-0.1 ± 5.5"],
  ])("formatUncertain(%d, %d) = %s", (mean, sd, text) => {
    expect(formatUncertain(mean, sd)).toBe(text);
  });

  it("shows error codes and text as they are", () => {
    expect(formatResult({ kind: "error", code: "#NAME?", message: "", root: false })).toBe(
      "#NAME?",
    );
    expect(formatResult({ kind: "text", text: "Spot" })).toBe("Spot");
  });
});

describe("parseCellInput", () => {
  it.each([
    ["42", 42],
    [" 1.5 ", 1.5],
    ["=A1+1", "=A1+1"],
    [" =A1 ", "=A1"],
    ["Spot price", "Spot price"],
    ["", ""],
    ["   ", ""],
  ])("%j → %j", (input, value) => {
    expect(parseCellInput(input)).toBe(value);
  });
});
