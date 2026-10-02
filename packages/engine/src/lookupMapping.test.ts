import { describe, expect, it } from "vitest";
import { cellKey, compileWorkbook, type SeriesKind, type SheetInput } from "./compile";
import { evaluateCpu } from "./cpu";

/** A monthly series of one kind: January to April 2026, with March left empty. */
const monthly = (type: SeriesKind): SheetInput => ({
  name: "S",
  series: { granularity: "month", columns: ["V"], type },
  cells: { A1: "2026-01", B1: 310, A2: "2026-02", B2: 280, A3: "2026-03", A4: "2026-04", B4: 300 },
});

/** Compiles `cells` beside a series sheet; returns each cell's value or error code. */
function evaluate(series: SheetInput, cells: Record<string, number | string>, count = 1) {
  const { program, sheets } = compileWorkbook([series, { name: "M", cells }]);
  const outputs = Object.keys(cells)
    .map((address) => cellKey(1, address))
    .filter((key) => program.cells.has(key));
  const samples = evaluateCpu(program, { seed: 1, iterationStart: 0, count, outputs });
  return Object.fromEntries(
    Object.keys(cells).map((address) => {
      const error = sheets[1]?.errors.get(address);
      return [address, error ? error.code : samples.get(cellKey(1, address))?.[0]];
    }),
  );
}

describe("lookups at calculated times", () => {
  it("take any period: a cell, a calculation, a name", () => {
    const result = evaluate(
      { ...monthly("level"), names: { Start: "A1" } },
      { A1: "2026-01", B1: "=S@(A1 + 1)", B2: "=S@B3", B3: "=PERIOD.MONTH(2026, 4)" },
    );
    expect(result).toMatchObject({ B1: 280, B2: 300 });
  });

  it("can be uncertain, and select among the rows as they run", () => {
    const { program } = compileWorkbook([
      monthly("level"),
      { name: "M", cells: { A1: "=2026-01 + ROUND(UNIFORM(0, 1), 0)", A2: "=S@A1" } },
    ]);
    const key = cellKey(1, "A2");
    const samples = evaluateCpu(program, {
      seed: 1,
      iterationStart: 0,
      count: 500,
      outputs: [key],
    }).get(key);
    expect(new Set(samples)).toEqual(new Set([310, 280]));
  });

  it("are an error outside the series when calculated, and #N/A when written", () => {
    // Arithmetic on constants is worked out when compiling, so only a truly calculated time
    // (here, an uncertain one) reaches the run.
    const result = evaluate(monthly("level"), {
      A1: "=S@(2026-01 + 9 + ROUND(UNIFORM(0, 0.4), 0))",
      A2: "=S@2026-10",
      A3: "=S@(2026-01 + 9)",
    });
    expect(result.A1).toBeNaN();
    expect(result.A2).toBe("#N/A");
    expect(result.A3).toBe("#N/A");
  });

  it("must be periods, except into yearly series, where a number is a year", () => {
    expect(evaluate(monthly("level"), { A1: "=S@5" }).A1).toBe("#ERROR!"); // not a period
    expect(evaluate(monthly("level"), { A1: 5, A2: "=S@A1" }).A2).toBe("#VALUE!");
    const yearly: SheetInput = {
      name: "S",
      series: { granularity: "year", columns: ["V"] },
      cells: { A1: 2026, B1: 7, A2: 2027, B2: 9 },
    };
    expect(evaluate(yearly, { A1: 2027, B1: "=S@A1", B2: "=S@(PERIOD.YEAR(2026))" })).toMatchObject(
      { B1: 9, B2: 7 },
    );
  });
});

describe("lookups between granularities, by series type", () => {
  it("sum flows over a coarser window, with empty entries as 0", () => {
    expect(evaluate(monthly("flow"), { A1: "=S@2026-Q1", A2: "=S@PERIOD.YEAR(2026)" })).toEqual({
      A1: 310 + 280,
      A2: 310 + 280 + 300,
    });
  });

  it("spread flows evenly over finer periods", () => {
    // 310 in January's 31 days is 10 a day; 280 in February's 28, also 10.
    expect(evaluate(monthly("flow"), { A1: "=S@2026-01-15", A2: "=S@(2026-02-01 + 3)" })).toEqual({
      A1: 10,
      A2: 10,
    });
  });

  it("take a level's last value in a window, carrying it over empty entries", () => {
    expect(evaluate(monthly("level"), { A1: "=S@2026-Q1", A2: "=S@2026-03" })).toEqual({
      A1: 280,
      A2: 280,
    });
  });

  it("interpolate a level between rows for finer periods, holding after the last", () => {
    // 1 January is 310; halfway through January (16 of 31 days in) is part way to 280.
    const result = evaluate(monthly("level"), {
      A1: "=S@2026-01-01",
      A2: "=S@2026-01-16",
      A3: "=S@2026-04-20",
    });
    expect(result.A1).toBe(310);
    expect(result.A2).toBeCloseTo(310 + (15 / 31) * (280 - 310), 10);
    expect(result.A3).toBe(300);
  });

  it("average rates over a window, and hold them for finer periods", () => {
    const rates: SheetInput = {
      ...monthly("rate"),
      cells: { A1: "2026-01", B1: 0.03, A2: "2026-02", B2: 0.05, A3: "2026-03", B3: 0.04 },
    };
    const result = evaluate(rates, { A1: "=S@2026-Q1", A2: "=S@2026-02-20" });
    expect(result.A1).toBeCloseTo(0.04, 12);
    expect(result.A2).toBe(0.05);
  });

  it("make an empty rate entry an error", () => {
    expect(evaluate(monthly("rate"), { A1: "=S@2026-03" }).A1).toBeNaN();
  });
});

describe("ranges of periods", () => {
  it("sum or average a series over a span", () => {
    expect(
      evaluate(monthly("flow"), {
        A1: "=SUM(S@2026-01:2026-04)",
        A2: "=AVERAGE(S@2026-01:2026-02)",
        A3: "=MAX(S@2026-01:2026-04, 1000)",
      }),
    ).toEqual({ A1: 890, A2: 295, A3: 1000 });
  });

  it("are only allowed inside functions, and must run forwards", () => {
    expect(
      evaluate(monthly("flow"), { A1: "=S@2026-01:2026-04", A2: "=SUM(S@2026-04:2026-01)" }),
    ).toEqual({ A1: "#VALUE!", A2: "#VALUE!" });
  });
});

describe("wide series sheets", () => {
  it("look up value columns past Z", () => {
    const columns = Array.from({ length: 30 }, (_, i) => `C${i + 1}`);
    const wide: SheetInput = {
      name: "W",
      series: { granularity: "year", columns },
      // Column 30's values sit in AE (the 31st column; A holds the periods).
      cells: { A1: 2026, AE1: 42 },
    };
    expect(evaluate(wide, { A1: "=W[C30]@2026" })).toEqual({ A1: 42 });
  });
});
