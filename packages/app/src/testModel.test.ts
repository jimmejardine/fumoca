import { compile, evaluateCpu } from "@fumoca/engine";
import { parseWorkbook, serializeWorkbook } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { createTestWorkbook } from "./testModel";

describe("test model", () => {
  it("has uniquely named sheets", () => {
    const names = createTestWorkbook().sheets.map((sheet) => sheet.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(createTestWorkbook().sheets.map((sheet) => [sheet.name, sheet] as const))(
    "sheet %s compiles with the engine",
    (_, sheet) => {
      expect(() => compile(sheet.cells)).not.toThrow();
    },
  );

  it("survives a save and load", () => {
    const workbook = createTestWorkbook();
    const loaded = parseWorkbook(serializeWorkbook(workbook));
    expect(loaded.sheets.map((s) => s.cells)).toEqual(workbook.sheets.map((s) => s.cells));
  });

  it("computes the Black–Scholes prices from the option inputs", () => {
    const sheet = createTestWorkbook().sheets.find((s) => s.name === "Option pricing");
    if (!sheet) throw new Error("No option pricing sheet");
    const price = (cells: typeof sheet.cells) => {
      const result = evaluateCpu(compile(cells), {
        seed: 1,
        iterationStart: 0,
        count: 1,
        outputs: ["B14", "B15"],
      });
      return [result.get("B14")?.[0], result.get("B15")?.[0]];
    };
    // Textbook values for S=100, K=105, r=5%, σ=20%, T=1.
    const [call, put] = price(sheet.cells);
    expect(call).toBeCloseTo(8.0214, 4);
    expect(put).toBeCloseTo(7.9004, 4);
    // They follow the inputs: at a spot of 120 the call is worth more.
    const [richerCall] = price({ ...sheet.cells, B1: 120 });
    expect(richerCall).toBeGreaterThan(20);
  });
});
