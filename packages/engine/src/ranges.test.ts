import { describe, expect, it } from "vitest";
import { cellKey, compileWorkbook, MAX_RANGE_CELLS, type SheetInput } from "./compile";
import { evaluateCpu } from "./cpu";
import { formulaReferences, parseFormula, shiftFormula } from "./parser";

const tables: SheetInput = {
  name: "Tables",
  cells: {
    // Ascending tiers in A, prices in B, and a label in C.
    A1: 0,
    A2: 100,
    A3: 1000,
    A4: 10000,
    B1: 50,
    B2: 40,
    B3: 30,
    B4: 20,
    C1: "Tier",
  },
};

/**
 * Compiles `cells` on a Model sheet after the Tables sheet; returns each cell's value (NaN for a
 * run-time error) or its compile error code.
 */
function evaluate(cells: Record<string, number | string>) {
  const model = 1;
  const { program, sheets } = compileWorkbook([tables, { name: "Model", cells }]);
  const outputs = Object.keys(cells)
    .map((address) => cellKey(model, address))
    .filter((key) => program.cells.has(key));
  const samples = evaluateCpu(program, { seed: 1, iterationStart: 0, count: 1, outputs });
  return Object.fromEntries(
    Object.keys(cells).map((address) => {
      const error = sheets[model]?.errors.get(address);
      return [address, error ? error.code : samples.get(cellKey(model, address))?.[0]];
    }),
  );
}

const value = (formula: string, cells: Record<string, number | string> = {}) =>
  evaluate({ ...cells, Z99: formula }).Z99;

describe("ranges", () => {
  it("parse as two corners, on the formula's sheet or a named one", () => {
    expect(parseFormula("=SUM(A1:B5)")).toEqual({
      type: "call",
      name: "SUM",
      args: [{ type: "range", from: "A1", to: "B5" }],
    });
    expect(parseFormula("=SUM('Valuation ASP Tables'!$E$19:$E$25)")).toEqual({
      type: "call",
      name: "SUM",
      args: [{ type: "range", from: "E19", to: "E25", sheet: "Valuation ASP Tables" }],
    });
  });

  it("need a cell after the colon", () => {
    expect(() => parseFormula("=SUM(A1:)")).toThrow(/Expected a cell after ':'/);
    expect(() => parseFormula("=SUM(A1:Tables!B2)")).toThrow(/Expected a cell after ':'/);
  });

  it("report each corner as a reference, naming the other", () => {
    const [first, second] = formulaReferences("=SUM(Tables!A1:B2)");
    expect(first).toMatchObject({ address: "A1", sheet: "Tables", rangeTo: "B2" });
    expect(second).toMatchObject({ address: "B2", sheet: "Tables", rangeFrom: "A1" });
  });

  it("move each corner when copied, keeping anchors, as in Excel", () => {
    expect(shiftFormula("=SUM(A1:A3)", 1, 2)).toBe("=SUM(B3:B5)");
    expect(shiftFormula("=SUM($A$1:A3)", 1, 2)).toBe("=SUM($A$1:B5)");
  });

  it("are only allowed as function arguments", () => {
    expect(value("=A1:A3 + 1", { A1: 1 })).toBe("#VALUE!");
    expect(value("=IF(A1:A3, 1, 2)")).toBe("#VALUE!");
  });

  it("are limited in size", () => {
    expect(MAX_RANGE_CELLS).toBe(10_000);
    expect(value("=SUM(AA1:DV100)")).toBe(0); // 100 × 100 cells: at the limit
    expect(value("=SUM(A1:A10001)")).toBe("#VALUE!");
  });

  it("make a formula depend on every cell in them, across sheets", () => {
    const result = evaluate({ A1: "=A2 * 2", A2: 5, B1: "=SUM(A1:A2)", B2: "=SUM(Tables!B1:B4)" });
    expect(result).toMatchObject({ B1: 15, B2: 140 });
  });

  it("propagate an error in a cell they cover", () => {
    expect(value("=SUM(A1:A2)", { A1: "=NOPE()", A2: 1 })).toBe("#NAME?");
  });
});

describe("range functions", () => {
  const data = { A1: 1, A2: 2, A3: "label", A5: 6 }; // A4 is empty

  it("SUM, AVERAGE, MIN, MAX and COUNT skip empty and text cells, as in Excel", () => {
    expect(value("=SUM(A1:A5)", data)).toBe(9);
    expect(value("=AVERAGE(A1:A5)", data)).toBe(3);
    expect(value("=MIN(A1:A5)", data)).toBe(1);
    expect(value("=MAX(A1:A5, 10)", data)).toBe(10);
    expect(value("=COUNT(A1:A5)", data)).toBe(3);
    expect(value("=PRODUCT(A1:A5)", data)).toBe(12);
  });

  it("mix ranges with single values", () => {
    expect(value("=SUM(A1:A2, 10, A5)", data)).toBe(19);
  });

  it("give Excel's answers for no numbers at all", () => {
    expect(value("=SUM(A4:A4)", data)).toBe(0);
    expect(value("=MAX(A4:A4)", data)).toBe(0);
    expect(value("=AVERAGE(A4:A4)", data)).toBe("#DIV/0!");
  });

  it("SUMPRODUCT multiplies ranges position by position", () => {
    expect(value("=SUMPRODUCT(Tables!A1:A4, Tables!B1:B4)")).toBe(
      0 * 50 + 100 * 40 + 1000 * 30 + 10000 * 20,
    );
    expect(value("=SUMPRODUCT(Tables!A1:A4, Tables!B1:B3)")).toBe("#VALUE!");
  });

  it("AND, OR and NOT treat non-zero as true", () => {
    expect(value("=AND(1, 2, A1:A2)", data)).toBe(1);
    expect(value("=AND(1, 0)")).toBe(0);
    expect(value("=OR(0, A4:A4, 0)", data)).toBe(0);
    expect(value("=OR(0, 3)")).toBe(1);
    expect(value("=NOT(0)")).toBe(1);
  });
});

describe("lookups", () => {
  it("MATCH finds the last value ≤ x in ascending data (type 1, the default)", () => {
    expect(value("=MATCH(500, Tables!A1:A4)")).toBe(2);
    expect(value("=MATCH(1000, Tables!A1:A4, 1)")).toBe(3);
    expect(value("=MATCH(99999, Tables!A1:A4)")).toBe(4);
    expect(value("=MATCH(-1, Tables!A1:A4)")).toBeNaN(); // #N/A
  });

  it("MATCH finds the last value ≥ x in descending data (type −1)", () => {
    expect(value("=MATCH(35, Tables!B1:B4, -1)")).toBe(2);
    expect(value("=MATCH(51, Tables!B1:B4, -1)")).toBeNaN();
  });

  it("MATCH finds the first exact match (type 0)", () => {
    expect(value("=MATCH(30, Tables!B1:B4, 0)")).toBe(3);
    expect(value("=MATCH(31, Tables!B1:B4, 0)")).toBeNaN();
  });

  it("MATCH needs a written type and a single row or column", () => {
    expect(value("=MATCH(1, Tables!A1:A4, A1)", { A1: 1 })).toBe("#VALUE!");
    expect(value("=MATCH(1, Tables!A1:B4)")).toBe("#N/A");
  });

  it("INDEX picks a cell by position, truncating, with an error out of range", () => {
    expect(value("=INDEX(Tables!B1:B4, 3)")).toBe(30);
    expect(value("=INDEX(Tables!B1:B4, 2.9)")).toBe(40);
    expect(value("=INDEX(Tables!A1:B4, 4, 2)")).toBe(20);
    expect(value("=INDEX(Tables!B1:B4, 5)")).toBeNaN(); // #REF!
    expect(value("=INDEX(Tables!A1:B4, 1, 3)")).toBeNaN();
    expect(value("=INDEX(Tables!A1:B4, 2)")).toBe("#VALUE!");
  });

  it("INDEX with MATCH works as a tiered lookup, as in ARK's ASP tables", () => {
    expect(value("=INDEX(Tables!B1:B4, MATCH(2500, Tables!A1:A4))")).toBe(30);
    // Past the end of the tiers: an error that IFERROR catches.
    expect(value("=IFERROR(INDEX(Tables!A1:A4, MATCH(99999, Tables!A1:A4) + 1), 0)")).toBe(0);
  });

  it("VLOOKUP and HLOOKUP look up approximately or exactly", () => {
    expect(value("=VLOOKUP(2500, Tables!A1:B4, 2)")).toBe(30);
    expect(value("=VLOOKUP(2500, Tables!A1:B4, 2, TRUE)")).toBe(30);
    expect(value("=VLOOKUP(1000, Tables!A1:B4, 2, FALSE)")).toBe(30);
    expect(value("=VLOOKUP(2500, Tables!A1:B4, 2, FALSE)")).toBeNaN();
    expect(value("=VLOOKUP(2500, Tables!A1:B4, 3)")).toBe("#REF!");
    expect(value("=VLOOKUP(2500, Tables!A1:B4, A1)", { A1: 2 })).toBe(30);
    expect(value("=HLOOKUP(5, A1:C2, 2)", { A1: 1, B1: 5, C1: 9, A2: 10, B2: 50, C2: 90 })).toBe(
      50,
    );
  });
});

describe("rounding and arithmetic", () => {
  it("INT floors, and ROUND rounds halves away from zero, as in Excel", () => {
    expect(value("=INT(-2.5)")).toBe(-3);
    expect(value("=INT(2.9)")).toBe(2);
    expect(value("=ROUND(2.5, 0)")).toBe(3);
    expect(value("=ROUND(-2.5, 0)")).toBe(-3);
    expect(value("=ROUND(1234.567, -2)")).toBe(1200);
    expect(value("=ROUND(3.14159, 2)")).toBeCloseTo(3.14, 12);
    expect(value("=ROUNDUP(-2.1, 0)")).toBe(-3);
    expect(value("=ROUNDDOWN(-2.9, 0)")).toBe(-2);
    expect(value("=TRUNC(-2.9)")).toBe(-2);
  });

  it("MOD takes the divisor's sign, as in Excel", () => {
    expect(value("=MOD(7, 3)")).toBe(1);
    expect(value("=MOD(-3, 2)")).toBe(1);
    expect(value("=MOD(3, -2)")).toBe(-1);
    expect(value("=MOD(3, 0)")).toBeNaN();
  });

  it("RRI is the equivalent annual growth rate", () => {
    expect(value("=RRI(2, 100, 121)")).toBeCloseTo(0.1, 12);
  });

  it("IFERROR replaces errors, at run time or in its own formula", () => {
    expect(value("=IFERROR(1/0, 7)")).toBe(7);
    expect(value("=IFERROR(LN(-1), 7)")).toBe(7);
    expect(value("=IFERROR(5, 7)")).toBe(5);
    expect(value("=IFERROR(NOPE(), 7)")).toBe(7);
  });
});

describe("inverse distributions", () => {
  it("NORM.S.INV and NORM.INV invert the normal CDF", () => {
    expect(value("=NORM.S.INV(0.975)")).toBeCloseTo(1.959963984540054, 12);
    expect(value("=NORMSINV(0.5)")).toBeCloseTo(0, 14);
    expect(value("=NORM.INV(0.8413447460685429, 100, 10)")).toBeCloseTo(110, 9);
    expect(value("=LOGNORM.INV(0.5, 0, 1)")).toBeCloseTo(1, 12);
  });

  it("are errors outside their domain, as Excel's #NUM!", () => {
    expect(value("=NORM.S.INV(0)")).toBeNaN();
    expect(value("=NORM.S.INV(1.5)")).toBeNaN();
    expect(value("=NORM.INV(0.5, 0, 0)")).toBeNaN();
  });

  it("make NORM.INV(RAND(), mean, sd) a normal input, the common Excel idiom", () => {
    const { program } = compileWorkbook([
      { name: "Model", cells: { A1: "=NORM.INV(RAND(), 100, 10)" } },
    ]);
    const key = cellKey(0, "A1");
    const samples = evaluateCpu(program, {
      seed: 3,
      iterationStart: 0,
      count: 100_000,
      outputs: [key],
    }).get(key);
    if (!samples) throw new Error("no samples");
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1));
    expect(mean).toBeCloseTo(100, 0);
    expect(sd).toBeCloseTo(10, 0);
  });
});
