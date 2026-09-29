import { describe, expect, it } from "vitest";
import { cellKey, compileSheet, compileWorkbook, type SheetInput } from "./compile";
import { evaluateCpu } from "./cpu";
import { formulaNames, nameError, parseFormula, renameInFormula } from "./parser";

describe("named cells", () => {
  it("parse as names, unless they're called as functions", () => {
    expect(parseFormula("=Spot * 2")).toEqual({
      type: "binary",
      operator: "*",
      left: { type: "name", name: "Spot" },
      right: { type: "number", value: 2 },
    });
    expect(parseFormula("=SUM(1)")).toMatchObject({ type: "call", name: "SUM" });
    expect(parseFormula("=TRUE")).toEqual({ type: "number", value: 1 });
  });

  it("read their cells, on any sheet, matching regardless of case", () => {
    const sheets: SheetInput[] = [
      { name: "Inputs", cells: { B1: 100, B3: 0.05 }, names: { Spot: "B1", Rate: "B3" } },
      { name: "Model", cells: { A1: "=spot * (1 + RATE)", A2: "=Nothing + 1" } },
    ];
    const { program, sheets: outcomes } = compileWorkbook(sheets);
    const samples = evaluateCpu(program, {
      seed: 1,
      iterationStart: 0,
      count: 1,
      outputs: [cellKey(1, "A1")],
    });
    expect(samples.get(cellKey(1, "A1"))?.[0]).toBeCloseTo(105, 10);
    expect(outcomes[1]?.errors.get("A2")).toEqual({
      code: "#NAME?",
      message: "Unknown name Nothing",
    });
  });

  it("are dependencies like references, so cycles through names are caught", () => {
    const { errors } = compileWorkbook([
      { name: "S", cells: { A1: "=Loop + 1" }, names: { Loop: "A1" } },
    ]).sheets[0] ?? { errors: new Map() };
    expect(errors.get("A1")?.code).toBe("#CIRC!");
  });

  it("are unknown without a definition", () => {
    expect(compileSheet({ A1: "=Missing" }).errors.get("A1")?.code).toBe("#NAME?");
  });

  it("are found in formulas with their spans, skipping calls and lookups", () => {
    const text = "=Spot * EXP(Rate * Years) + Prices@2026-01 + TRUE + A1";
    expect(formulaNames(text).map((n) => [n.name, text.slice(n.start, n.end)])).toEqual([
      ["Spot", "Spot"],
      ["Rate", "Rate"],
      ["Years", "Years"],
    ]);
    expect(formulaNames("Spot")).toEqual([]);
  });

  it("are renamed inside formulas", () => {
    expect(renameInFormula("=spot * 2 + SPOT + Spotty + SPOT(1)", "Spot", "S0")).toBe(
      "=S0 * 2 + S0 + Spotty + SPOT(1)",
    );
  });

  it("follow Excel's rules", () => {
    expect(nameError("Spot")).toBeNull();
    expect(nameError("_rate.2026")).toBeNull();
    expect(nameError("Growth1")).toBeNull();
    expect(nameError("SUM")).toBeNull();
    expect(nameError("")).toMatch(/empty/);
    expect(nameError("1x")).toMatch(/starts with/);
    expect(nameError("my rate")).toMatch(/starts with/);
    expect(nameError("A1")).toMatch(/cell reference/);
    expect(nameError("Tax1")).toMatch(/cell reference/);
    expect(nameError("true")).toMatch(/reserved/);
  });
});
