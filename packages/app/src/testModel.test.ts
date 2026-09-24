import { type Backend, compile, evaluateCpu } from "@fumoca/engine";
import { parseWorkbook, serializeWorkbook } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { recalculate } from "./recalc";
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

  it.each([
    ["B16", "X", 10, 3],
    ["B17", "Y", 20, 4],
    ["B18", "X + Y", 30, 5],
    ["B19", "X − Y", -10, 5],
    ["B20", "2X + 3", 23, 6],
    ["B21", "X + X", 20, 6],
    ["B22", "X + independent X", 20, 3 * Math.SQRT2],
  ])("sums of normals: %s (%s) has mean %d and SD %d", async (address, _, mean, sd) => {
    const backend: Backend = {
      name: "cpu",
      run: async (program, options) => evaluateCpu(program, options),
      dispose: () => {},
    };
    const workbook = createTestWorkbook();
    const sheet = workbook.sheets.find((s) => s.name === "Functions");
    if (!sheet) throw new Error("No functions sheet");
    const count = 50_000;
    const results = await recalculate({ sheets: [sheet] }, backend, { seed: 7, count });
    const result = results.get(sheet.id)?.get(address);
    if (result?.kind !== "uncertain") throw new Error(`${address} is not uncertain`);
    // Mean within 5 standard errors; SD within 2%.
    expect(Math.abs(result.mean - mean)).toBeLessThan((5 * sd) / Math.sqrt(count));
    expect(Math.abs(result.sd - sd) / sd).toBeLessThan(0.02);
  });
});
