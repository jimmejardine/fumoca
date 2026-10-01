import { describe, expect, it } from "vitest";
import {
  alternativeLabel,
  cellInDimension,
  combinationCount,
  combinations,
  createScenario,
  createSensitivity,
  type Scenario,
  sensitivityIndex,
  type WhatIfScenario,
} from "./scenario";
import {
  addSheet,
  createWorkbook,
  nextScenarioName,
  parseWorkbook,
  putScenario,
  removeScenario,
  serializeWorkbook,
  setCell,
} from "./workbook";

const cell = (sheetId: string, address: string) => ({ sheetId, address });

/** Interest rate: 3 alternatives; strategy: a group of 2 cells with 2 variants. */
function example(sheetId: string): WhatIfScenario {
  return {
    ...createScenario("Rates and strategy"),
    dimensions: [
      {
        id: "rate",
        kind: "cell",
        cell: cell(sheetId, "B1"),
        alternatives: [
          { label: "Low", input: 0.03 },
          { label: "", input: 0.05 },
          { label: "High", input: "=NORMAL(0.07, 0.01)" },
        ],
      },
      {
        id: "strategy",
        kind: "group",
        name: "Strategy",
        cells: [cell(sheetId, "B2"), cell(sheetId, "B3")],
        variants: [
          { label: "Aggressive", inputs: [9.99, "=B1 * 2"] },
          { label: "Cautious", inputs: [12.99, null] },
        ],
      },
    ],
    outputs: [cell(sheetId, "C1")],
  };
}

describe("combinations", () => {
  it("are the Cartesian product of the dimensions, the last varying fastest", () => {
    const scenario = example("s");
    expect(combinationCount(scenario)).toBe(6);
    const all = combinations(scenario);
    expect(all.map((c) => [c.choices.get("rate"), c.choices.get("strategy")])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
  });

  it("override each dimension's cells, leaving unchanged group cells alone", () => {
    const [first, second] = combinations(example("s"));
    expect(first?.overrides).toEqual([
      { cell: cell("s", "B1"), input: 0.03 },
      { cell: cell("s", "B2"), input: 9.99 },
      { cell: cell("s", "B3"), input: "=B1 * 2" },
    ]);
    expect(second?.overrides).toEqual([
      { cell: cell("s", "B1"), input: 0.03 },
      { cell: cell("s", "B2"), input: 12.99 },
    ]);
  });

  it("skip dimensions that have no alternatives or no cell yet", () => {
    const scenario = example("s");
    scenario.dimensions.push({ id: "empty", kind: "cell", cell: null, alternatives: [] });
    expect(combinationCount(scenario)).toBe(6);
    expect(combinations(createScenario("Empty"))).toEqual([]);
    expect(combinationCount(createScenario("Empty"))).toBe(0);
  });

  it("label alternatives by label, or by their input", () => {
    const [rate, strategy] = example("s").dimensions;
    if (!rate || !strategy) throw new Error("missing dimensions");
    expect([0, 1, 2].map((i) => alternativeLabel(rate, i))).toEqual(["Low", "0.05", "High"]);
    expect(alternativeLabel(strategy, 1)).toBe("Cautious");
  });

  it("know which cells already belong to a dimension", () => {
    const scenario = example("s");
    expect(cellInDimension(scenario, cell("s", "B3"))).toBe(true);
    expect(cellInDimension(scenario, cell("s", "B3"), "strategy")).toBe(false);
    expect(cellInDimension(scenario, cell("s", "Z9"))).toBe(false);
  });
});

describe("sensitivity analyses", () => {
  const analysis = {
    ...createSensitivity("Drivers"),
    inputs: [cell("s", "B1"), cell("s", "B2")],
    steps: [0.01, 0.1],
  };

  it("scale each input down and up by each step, one input at a time", () => {
    expect(combinationCount(analysis)).toBe(8);
    const runs = combinations(analysis);
    expect(runs.map((run) => run.overrides)).toEqual([
      [{ cell: cell("s", "B1"), scale: 0.99 }],
      [{ cell: cell("s", "B1"), scale: 1.01 }],
      [{ cell: cell("s", "B1"), scale: 0.9 }],
      [{ cell: cell("s", "B1"), scale: 1.1 }],
      [{ cell: cell("s", "B2"), scale: 0.99 }],
      [{ cell: cell("s", "B2"), scale: 1.01 }],
      [{ cell: cell("s", "B2"), scale: 0.9 }],
      [{ cell: cell("s", "B2"), scale: 1.1 }],
    ]);
    expect(runs[sensitivityIndex(analysis, 1, 0, 1)]?.choices).toEqual(
      new Map([
        ["input", 1],
        ["step", 0],
        ["sign", 1],
      ]),
    );
  });

  it("start with a ±1% step and nothing to run", () => {
    const empty = createSensitivity("Empty");
    expect(empty.steps).toEqual([0.01]);
    expect(combinations(empty)).toEqual([]);
  });

  it("are saved and loaded alongside what-if scenarios", () => {
    const { workbook: base, sheet } = addSheet(createWorkbook());
    const drivers = {
      ...analysis,
      inputs: [cell(sheet.id, "B1")],
      outputs: [cell(sheet.id, "B9")],
    };
    const saved = serializeWorkbook(putScenario(putScenario(base, example(sheet.id)), drivers));
    const loaded = parseWorkbook(saved);
    const [whatIf, restored] = loaded.scenarios ?? [];
    expect(whatIf?.kind).toBe("scenario");
    const loadedSheet = loaded.sheets[1];
    if (!restored || !loadedSheet) throw new Error("analysis not loaded");
    expect({ ...restored, id: "" }).toEqual({
      ...drivers,
      id: "",
      inputs: [cell(loadedSheet.id, "B1")],
      outputs: [cell(loadedSheet.id, "B9")],
    });
  });

  it("reject invalid steps and unknown kinds in files", () => {
    const file = JSON.parse(serializeWorkbook(createWorkbook()));
    file.scenarios = [{ kind: "sensitivity", name: "S", inputs: [], outputs: [], steps: [2] }];
    expect(() => parseWorkbook(JSON.stringify(file))).toThrow(/invalid step/);
    file.scenarios = [{ kind: "tornado", name: "S", outputs: [] }];
    expect(() => parseWorkbook(JSON.stringify(file))).toThrow(/unknown kind/);
  });
});

describe("scenarios in the workbook", () => {
  it("are kept through cell edits and new sheets", () => {
    const workbook = createWorkbook();
    const sheet = workbook.sheets[0];
    if (!sheet) throw new Error("no sheet");
    const withScenario = putScenario(workbook, example(sheet.id));
    const edited = addSheet(setCell(withScenario, sheet.id, "A1", 5)).workbook;
    expect(edited.scenarios).toHaveLength(1);
  });

  it("are added, replaced, removed and named", () => {
    let workbook = createWorkbook();
    const scenario = createScenario(nextScenarioName(workbook));
    expect(scenario.name).toBe("Scenario1");
    workbook = putScenario(workbook, scenario);
    expect(nextScenarioName(workbook)).toBe("Scenario2");
    workbook = putScenario(workbook, { ...scenario, name: "Renamed" });
    expect(workbook.scenarios?.map((s) => s.name)).toEqual(["Renamed"]);
    expect(removeScenario(workbook, scenario.id).scenarios).toEqual([]);
  });

  it("are saved and loaded, with cells referring to sheets by name", () => {
    const { workbook: base, sheet: inputs } = addSheet(createWorkbook());
    const scenario = example(inputs.id);
    const saved = serializeWorkbook(putScenario(base, scenario));
    expect(saved).toContain('"sheet": "Sheet2"');
    const loaded = parseWorkbook(saved);
    const loadedInputs = loaded.sheets[1];
    const [restored] = loaded.scenarios ?? [];
    if (!loadedInputs || !restored) throw new Error("scenario not loaded");
    // Ids are regenerated on load; everything else round-trips.
    const withoutIds = (s: Scenario) =>
      s.kind === "scenario"
        ? { ...s, id: "", dimensions: s.dimensions.map((d) => ({ ...d, id: "" })) }
        : { ...s, id: "" };
    expect(withoutIds(restored)).toEqual(withoutIds(example(loadedInputs.id)));
  });

  it("are optional in files, and a reference to a missing sheet is an error", () => {
    const plain = serializeWorkbook(createWorkbook());
    expect(plain).not.toContain("scenarios");
    expect(parseWorkbook(plain).scenarios).toBeUndefined();
    const broken = JSON.parse(plain);
    broken.scenarios = [
      { name: "S", dimensions: [], outputs: [{ sheet: "Nope", address: "A1" }], samples: 10 },
    ];
    expect(() => parseWorkbook(JSON.stringify(broken))).toThrow(/missing sheet, Nope/);
  });
});
