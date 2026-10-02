import { describe, expect, it } from "vitest";
import { cellKey, compileWorkbook, type SheetInput } from "./compile";
import { evaluateCpu } from "./cpu";
import { parseFormula } from "./parser";

const prices: SheetInput = {
  name: "Prices",
  series: { granularity: "month", columns: ["Open", "Close"] },
  cells: {
    A1: "2026-01",
    B1: 100,
    C1: 102,
    A2: "2026-02",
    B2: 102,
    C2: "=B2 * 1.05",
    A3: "2026-03",
    B3: "=NORMAL(105, 2)",
    // No Close value for March.
  },
};

/** Compiles `formulas` on a sheet next to Prices and returns each cell's value or error code. */
function evaluate(formulas: Record<string, number | string>) {
  const sheets = [prices, { name: "Model", cells: formulas }];
  const { program, sheets: outcomes } = compileWorkbook(sheets);
  const modelKeys = Object.keys(formulas).map((address) => cellKey(1, address));
  const outputs = modelKeys.filter((key) => program.cells.has(key));
  const samples = evaluateCpu(program, { seed: 1, iterationStart: 0, count: 1, outputs });
  return Object.fromEntries(
    Object.keys(formulas).map((address) => {
      const error = outcomes[1]?.errors.get(address);
      return [address, error ? error.code : samples.get(cellKey(1, address))?.[0]];
    }),
  );
}

describe("series lookup syntax", () => {
  it.each([
    [
      "=Prices[Close]@2026-10",
      { sheet: "Prices", column: "Close", when: { type: "period", text: "2026-10" } },
    ],
    ["=Prices@2026-Q1", { sheet: "Prices", when: { type: "period", text: "2026-Q1" } }],
    ["=Prices[Open]@A1", { sheet: "Prices", column: "Open", when: { type: "ref", address: "A1" } }],
    [
      "='Interest Rates'[Base Rate]@2027",
      { sheet: "Interest Rates", column: "Base Rate", when: { type: "period", text: "2027" } },
    ],
    ["=Prices@2026-01-15T09", { sheet: "Prices", when: { type: "period", text: "2026-01-15T09" } }],
    ["=Prices@Launch", { sheet: "Prices", when: { type: "name", name: "Launch" } }],
    [
      "=Prices@(A1 + 1)",
      {
        sheet: "Prices",
        when: {
          type: "binary",
          operator: "+",
          left: { type: "ref", address: "A1" },
          right: { type: "number", value: 1 },
        },
      },
    ],
    [
      "=Prices@2026-01:2026-03",
      {
        sheet: "Prices",
        when: { type: "period", text: "2026-01" },
        until: { type: "period", text: "2026-03" },
      },
    ],
  ])("parses %s", (formula, lookup) => {
    expect(parseFormula(formula)).toEqual({ type: "lookup", ...lookup });
  });

  it("parses lookups inside larger formulas", () => {
    expect(parseFormula("=Prices[Close]@2026-02 - Prices[Open]@2026-02")).toMatchObject({
      type: "binary",
      operator: "-",
      left: { type: "lookup", column: "Close" },
      right: { type: "lookup", column: "Open" },
    });
  });

  it("rejects incomplete lookups", () => {
    expect(() => parseFormula("=Prices[Close]")).toThrow(/Expected '@'/);
    expect(() => parseFormula("=Prices@")).toThrow(/Expected a period/);
    expect(() => parseFormula("=Prices@2026-01:")).toThrow(/Expected a period/);
    expect(() => parseFormula("=Prices@2026-01:A1")).toThrow(/needs a period after/);
  });
});

describe("series lookups", () => {
  it("read the named value column for a period", () => {
    expect(
      evaluate({
        A1: "=Prices[Close]@2026-01",
        A2: "=Prices[Close]@2026-02",
        A3: "=prices[open]@2026-02", // sheet and column names are case-insensitive
      }),
    ).toEqual({ A1: 102, A2: 102 * 1.05, A3: 102 });
  });

  it("use the first value column when none is named", () => {
    expect(evaluate({ A1: "=Prices@2026-02" })).toEqual({ A1: 102 });
  });

  it("take the period from a cell", () => {
    // A1 holds a month: its value is the month's index (2026 × 12 + 1).
    expect(evaluate({ A1: "2026-02", B1: "=Prices[Close]@A1 + 1" })).toEqual({
      A1: 2026 * 12 + 1,
      B1: 102 * 1.05 + 1,
    });
  });

  it("carry uncertainty from the series into the model", () => {
    const sheets = [prices, { name: "Model", cells: { A1: "=Prices[Open]@2026-03 * 2" } }];
    const { program } = compileWorkbook(sheets);
    const key = cellKey(1, "A1");
    const samples = evaluateCpu(program, {
      seed: 1,
      iterationStart: 0,
      count: 2000,
      outputs: [key],
    });
    const values = Array.from(samples.get(key) ?? []);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeCloseTo(210, 0);
    expect(new Set(values).size).toBeGreaterThan(1000);
  });

  it("report #N/A for periods outside the series, and carry levels over empty entries", () => {
    expect(
      evaluate({
        A1: "=Prices[Close]@2027-01",
        A2: "=Prices[Close]@2026-03", // empty: a level carries February's value forward
        A3: "=A1 + 1",
      }),
    ).toEqual({ A1: "#N/A", A2: 102 * 1.05, A3: "#N/A" });
    const { sheets } = compileWorkbook([prices, { name: "M", cells: { A1: "=Prices@2027-01" } }]);
    expect(sheets[1]?.errors.get("A1")?.message).toBe("Prices has no row for 2027-01");
  });

  it("report #REF! for unknown sheets, columns, and sheets that aren't series", () => {
    expect(
      evaluate({
        A1: "=Nope[Close]@2026-01",
        A2: "=Prices[Volume]@2026-01",
        A3: "=Model@2026-01",
      }),
    ).toEqual({ A1: "#REF!", A2: "#REF!", A3: "#REF!" });
  });

  it("report #VALUE! when the time cell doesn't hold a period", () => {
    expect(evaluate({ A1: "=1+1", B1: "=Prices@A1", C1: "Sales", D1: "=Prices@C1" })).toMatchObject(
      { B1: "#VALUE!", D1: "#VALUE!" },
    );
  });

  it("detect circular references through lookups", () => {
    // A series value that looks up itself.
    const sheets: SheetInput[] = [
      {
        name: "S",
        series: { granularity: "year", columns: ["Value"] },
        cells: { A1: 2027, B1: "=S@2027 + 1" },
      },
    ];
    expect(compileWorkbook(sheets).sheets[0]?.errors.get("B1")?.code).toBe("#CIRC!");
  });
});
