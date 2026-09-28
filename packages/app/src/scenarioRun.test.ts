import { type Backend, evaluateCpu } from "@fumoca/engine";
import { createScenario, createSheet, type Scenario, type Workbook } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { applyOverrides, type OutputSummary, startScenarioRun } from "./scenarioRun";

/** A synchronous stand-in for the CPU/GPU backends. */
const fakeBackend: Backend = {
  name: "fake",
  run: async (program, options) => evaluateCpu(program, options),
  dispose: () => {},
};

const inputs = createSheet("Inputs", { A1: 2, A2: 5, A3: "=NORMAL(0, 1)" });
const model = createSheet("Model", {
  B1: "=Inputs!A1 * 10 + Inputs!A2",
  B2: "=Inputs!A3 + Inputs!A1",
  B3: "Label",
});
const workbook: Workbook = { sheets: [inputs, model] };
const ref = (sheet: { id: string }, address: string) => ({ sheetId: sheet.id, address });

/** A1 in {3, 4} × a group setting A2 to 50, or leaving it unchanged. */
const scenario: Scenario = {
  ...createScenario("Test"),
  samples: 2_000,
  dimensions: [
    {
      id: "a1",
      kind: "cell",
      cell: ref(inputs, "A1"),
      alternatives: [
        { label: "", input: 3 },
        { label: "", input: 4 },
      ],
    },
    {
      id: "group",
      kind: "group",
      name: "Group",
      cells: [ref(inputs, "A2")],
      variants: [
        { label: "Big", inputs: [50] },
        { label: "Same", inputs: [null] },
      ],
    },
  ],
  outputs: [ref(model, "B1"), ref(model, "B2"), ref(model, "B3"), ref(model, "C9")],
};

const value = (summary: OutputSummary | null | undefined) =>
  summary?.kind === "number" ? summary.value : summary?.kind;

describe("startScenarioRun", () => {
  it("runs the Baseline and every combination, with the overrides applied", async () => {
    const updates: number[] = [];
    const results = await startScenarioRun(
      workbook,
      scenario,
      { backend: fakeBackend },
      { seed: 1, throttleMs: 0 },
      (update) => updates.push(update.progress.done),
    ).done;
    if (!results) throw new Error("cancelled");
    expect(results.complete).toBe(true);
    expect(results.progress).toEqual({ done: 5, total: 5 });
    expect(updates.at(-1)).toBe(5);
    expect(value(results.baseline[0])).toBe(25);
    // Combinations: (3, Big), (3, Same), (4, Big), (4, Same).
    expect(results.combinations.map((outputs) => value(outputs[0]))).toEqual([80, 35, 90, 45]);
    // Text and empty outputs.
    expect(results.baseline[2]).toMatchObject({ kind: "error", code: "#VALUE!" });
    expect(value(results.baseline[3])).toBe(0);
  });

  it("uses common random numbers: an overridden input shifts the output exactly", async () => {
    const results = await startScenarioRun(
      workbook,
      scenario,
      { backend: fakeBackend },
      { seed: 7, throttleMs: 0 },
      () => {},
    ).done;
    const baseline = results?.baseline[1];
    const first = results?.combinations[0]?.[1];
    if (baseline?.kind !== "uncertain" || first?.kind !== "uncertain") {
      throw new Error("expected uncertain outputs");
    }
    // B2 = NORMAL(0, 1) + A1: with the same draws, A1 = 3 instead of 2 moves the mean by exactly 1
    // and leaves the spread unchanged.
    expect(first.mean - baseline.mean).toBeCloseTo(1, 10);
    expect(first.sd).toBeCloseTo(baseline.sd, 10);
  });

  it("can be cancelled", async () => {
    const running = startScenarioRun(
      workbook,
      scenario,
      { backend: fakeBackend },
      { seed: 1 },
      () => {},
    );
    running.cancel();
    expect(await running.done).toBeNull();
  });
});

describe("applyOverrides", () => {
  it("replaces and clears cells without changing the workbook", () => {
    const changed = applyOverrides(workbook, [
      { cell: ref(inputs, "A1"), input: "=1+1" },
      { cell: ref(inputs, "A2"), input: "" },
    ]);
    expect(changed.sheets[0]?.cells).toEqual({ A1: "=1+1", A3: "=NORMAL(0, 1)" });
    expect(inputs.cells.A1).toBe(2);
    expect(changed.sheets[1]).toBe(model);
  });
});
