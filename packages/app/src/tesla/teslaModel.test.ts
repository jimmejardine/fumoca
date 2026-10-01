import { cellKey, compileWorkbook, evaluateCpu } from "@fumoca/engine";
import { combinationCount, type Workbook } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { ARK_DRAWS, ARK_VALUES } from "./arkTesla.generated";
import { createTeslaWorkbook } from "./teslaModel";

const compile = (workbook: Workbook) =>
  compileWorkbook(
    workbook.sheets.map((s) => ({ name: s.name, cells: s.cells, names: s.names ?? {} })),
  );

/** The workbook with every input replaced by the value it drew in ARK's saved run. */
function withArkDraws(workbook: Workbook): Workbook {
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      const cells = { ...sheet.cells };
      for (const [name, address] of Object.entries(sheet.names ?? {})) {
        const draw = ARK_DRAWS[name];
        if (draw !== undefined) cells[address] = draw;
      }
      return { ...sheet, cells };
    }),
  };
}

describe("the Tesla model", () => {
  it("compiles without errors", () => {
    const { sheets } = compile(createTeslaWorkbook());
    const workbook = createTeslaWorkbook();
    const errors = sheets.flatMap((outcome, i) =>
      [...outcome.errors].map(
        ([address, e]) => `${workbook.sheets[i]?.name}!${address}: ${e.message}`,
      ),
    );
    expect(errors).toEqual([]);
  });

  it("computes every value ARK's saved run did, from the same draws", () => {
    const workbook = withArkDraws(createTeslaWorkbook());
    const { program } = compile(workbook);
    const index = new Map(workbook.sheets.map((s, i) => [s.name, i]));
    const keys = Object.keys(ARK_VALUES).map((location) => {
      const [sheet = "", address = ""] = location.split("!");
      return cellKey(index.get(sheet) ?? -1, address);
    });
    const outputs = keys.filter((key) => program.cells.has(key));
    const results = evaluateCpu(program, { seed: 1, iterationStart: 0, count: 1, outputs });
    const differences = Object.entries(ARK_VALUES).flatMap(([location, expected], i) => {
      const actual = results.get(keys[i] ?? "")?.[0];
      const error =
        actual === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
      return error < 1e-9 ? [] : [`${location}: ARK ${expected}, fumoca ${actual}`];
    });
    expect(differences.slice(0, 30)).toEqual([]);
    expect(ARK_VALUES["Valuation!L24"]).toBeCloseTo(2309.4608, 3);
  });

  it("gives ARK's Monte Carlo results, from fumoca's own draws", () => {
    // ARK's 5,000 runs: mean $2,617, quartiles $2,020 and $3,149.
    const workbook = createTeslaWorkbook();
    const { program } = compile(workbook);
    const valuation = workbook.sheets.findIndex((s) => s.name === "Valuation");
    const key = cellKey(valuation, workbook.sheets[valuation]?.names?.SharePrice2029 ?? "");
    const samples = evaluateCpu(program, {
      seed: 11,
      iterationStart: 0,
      count: 20_000,
      outputs: [key],
    }).get(key);
    if (!samples) throw new Error("no samples");
    const sorted = [...samples].sort((a, b) => a - b);
    expect(sorted.every(Number.isFinite)).toBe(true);
    const quartile = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? Number.NaN;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    expect(Math.abs(mean / 2617 - 1)).toBeLessThan(0.05);
    expect(Math.abs(quartile(0.25) / 2020 - 1)).toBeLessThan(0.05);
    expect(Math.abs(quartile(0.75) / 3149 - 1)).toBeLessThan(0.05);
  });

  it("has a scenario and a sensitivity analysis over its named cells", () => {
    const workbook = createTeslaWorkbook();
    const scenarios = workbook.scenarios ?? [];
    expect(scenarios.map((s) => [s.name, s.kind, combinationCount(s)])).toEqual([
      ["Robotaxi timing × production", "scenario", 9],
      ["Tesla drivers", "sensitivity", 18],
    ]);
    const cells = new Map(workbook.sheets.map((sheet) => [sheet.id, sheet.cells]));
    for (const scenario of scenarios) {
      const refs = [
        ...scenario.outputs,
        ...(scenario.kind === "scenario"
          ? scenario.dimensions.flatMap((d) => (d.kind === "cell" && d.cell ? [d.cell] : []))
          : scenario.inputs),
      ];
      for (const { sheetId, address } of refs) {
        expect(cells.get(sheetId)?.[address], `${scenario.name}: ${address}`).toBeDefined();
      }
    }
  });
});
