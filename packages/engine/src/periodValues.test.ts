import { describe, expect, it } from "vitest";
import { cellKey, compileWorkbook } from "./compile";
import { evaluateCpu } from "./cpu";
import { parseFormula, shiftFormula } from "./parser";
import { formatPeriod, periodValue, serialOf } from "./periods";

/** Each cell's value as text: a period in its own form, a number, or an error code. */
function evaluate(cells: Record<string, number | string>, count = 1) {
  const { program, sheets } = compileWorkbook([{ name: "Model", cells }]);
  const outputs = Object.keys(cells)
    .map((address) => cellKey(0, address))
    .filter((key) => program.cells.has(key));
  const samples = evaluateCpu(program, { seed: 1, iterationStart: 0, count, outputs });
  const outcome = sheets[0];
  return Object.fromEntries(
    Object.keys(cells).map((address) => {
      const error = outcome?.errors.get(address);
      if (error) return [address, error.code];
      const value = samples.get(cellKey(0, address))?.[0];
      const granularity = outcome?.periods.get(address);
      return [
        address,
        granularity && value !== undefined ? formatPeriod(value, granularity) : value,
      ];
    }),
  );
}

const value = (formula: string, cells: Record<string, number | string> = {}) =>
  evaluate({ ...cells, Z9: formula }).Z9;

describe("period values", () => {
  it("number periods so that adding one moves to the next", () => {
    expect(periodValue("2027-Q1")).toEqual({ granularity: "quarter", index: 2027 * 4 });
    expect(periodValue("2027-01")).toEqual({ granularity: "month", index: 2027 * 12 });
    expect(periodValue("2027-01-15")).toEqual({ granularity: "day", index: 46402 });
    expect(serialOf(2027, 1, 15)).toBe(46402); // Excel's DATE(2027, 1, 15)
    for (const text of [
      "2027",
      "2027-Q4",
      "2026-12",
      "2027-W01",
      "2026-W53",
      "2024-02-29",
      "2027-01-15T09",
    ]) {
      const period = periodValue(text);
      expect(period && formatPeriod(period.index, period.granularity)).toBe(text);
    }
  });

  it("are written in formulas without spaces; with spaces it's subtraction", () => {
    expect(parseFormula("=2027-01")).toEqual({ type: "period", text: "2027-01" });
    expect(parseFormula("=2027-1")).toEqual({ type: "period", text: "2027-01" });
    expect(parseFormula("=2027-q2")).toEqual({ type: "period", text: "2027-Q2" });
    expect(parseFormula("=2027 - 1")).toMatchObject({ type: "binary", operator: "-" });
    expect(value("=2027 - 1")).toBe(2026);
    // Not a period, so subtraction: month 13, and a 3-digit "month".
    expect(value("=2027-13")).toBe(2014);
    expect(value("=2027-123")).toBe(1904);
  });

  it("take precedence over cell names that look like quarters and weeks", () => {
    expect(value("=2027-Q1", { Q1: 5 })).toBe("2027-Q1");
    expect(shiftFormula("=2027-Q1 + A1", 1, 1)).toBe("=2027-Q1 + B2");
  });

  it("can be typed into cells; a year alone stays a number", () => {
    expect(evaluate({ A1: "2027-Q1", A2: "2027-3", A3: "2027" })).toEqual({
      A1: "2027-Q1",
      A2: "2027-03",
      A3: 2027,
    });
  });

  it("move by whole periods, and subtract to a count", () => {
    expect(value("=2027-Q1 + 2")).toBe("2027-Q3");
    expect(value("=2027-12 + 1")).toBe("2028-01");
    expect(value("=2027-W52 + 1")).toBe("2028-W01");
    expect(value("=2027-01-31 + 1")).toBe("2027-02-01");
    expect(value("=2027-01-15T23 + 3")).toBe("2027-01-16T02");
    expect(value("=PERIOD.YEAR(2027) + 1")).toBe("2028");
    expect(value("=2027-Q3 - 2027-Q1")).toBe(2);
    expect(value("=2028-03-01 - 2028-02-01")).toBe(29);
  });

  it("compare within one granularity", () => {
    expect(value("=IF(2027-03 > 2027-01, 1, 0)")).toBe(1);
    expect(value("=MAX(2027-03, 2026-11, 2027-01)")).toBe("2027-03");
  });

  it("can't be mixed across granularities, or with numbers where it makes no sense", () => {
    expect(value("=2027-Q1 - 2027-01")).toBe("#VALUE!");
    expect(value("=2027-Q1 + 2027-Q2")).toBe("#VALUE!");
    expect(value("=2027-Q1 * 2")).toBe("#VALUE!");
    expect(value("=5 - 2027-Q1")).toBe("#VALUE!");
    expect(value("=2027-Q1 > 3")).toBe("#VALUE!");
    expect(value("=SQRT(2027-01)")).toBe("#VALUE!");
    expect(value("=IF(1, 2027-01, 0)")).toBe("#VALUE!");
  });

  it("convert between granularities: the containing period, or the first sub-period", () => {
    expect(value("=PERIOD.QUARTER(2027-08)")).toBe("2027-Q3");
    expect(value("=PERIOD.YEAR(2027-08-15)")).toBe("2027");
    expect(value("=PERIOD.MONTH(2027-Q3)")).toBe("2027-07");
    expect(value("=PERIOD.DAY(2027-Q3)")).toBe("2027-07-01");
    expect(value("=PERIOD.WEEK(2027-01-06)")).toBe("2027-W01");
    expect(value("=PERIOD.HOUR(2027-02-28)")).toBe("2027-02-28T00");
    expect(value("=PERIOD.MONTH(2027-W05)")).toBe("2027-02"); // its Monday is 1 February
  });

  it("are built from numbers, carrying over as Excel's DATE does", () => {
    expect(value("=PERIOD.MONTH(2027, 14)")).toBe("2028-02");
    expect(value("=PERIOD.QUARTER(2027, 2)")).toBe("2027-Q2");
    expect(value("=DATE(2027, 13, 1)")).toBe("2028-01-01");
    expect(value("=DATE(2027, 3, 0)")).toBe("2027-02-28");
    expect(value("=PERIOD.DAY(2024, 2, 29)")).toBe("2024-02-29");
  });

  it("start and end on days", () => {
    expect(value("=PERIOD.START(2027-Q2)")).toBe("2027-04-01");
    expect(value("=PERIOD.END(2027-Q2)")).toBe("2027-06-30");
    expect(value("=PERIOD.END(2024-02)")).toBe("2024-02-29");
    expect(value("=PERIOD.END(2027)")).toBe("#VALUE!"); // a number, not a year period
    expect(value("=PERIOD.END(PERIOD.YEAR(2027))")).toBe("2027-12-31");
  });

  it("have parts as numbers; a plain number is an Excel serial date", () => {
    expect(value("=YEAR(2027-08)")).toBe(2027);
    expect(value("=MONTH(2027-Q3)")).toBe(7);
    expect(value("=QUARTER(2027-08-15)")).toBe(3);
    expect(value("=DAY(2027-08-15)")).toBe(15);
    expect(value("=WEEKDAY(2027-08-15)")).toBe(1); // a Sunday
    expect(value("=HOUR(2027-08-15T13)")).toBe(13);
    expect(value("=YEAR(46402)")).toBe(2027);
    expect(value("=MONTH(46402)")).toBe(1);
  });

  it("can be uncertain: a launch month drawn from a distribution", () => {
    const { program, sheets } = compileWorkbook([
      { name: "Model", cells: { A1: "=2026-01 + ROUND(NORMAL(6, 3), 0)", A2: "=YEAR(A1)" } },
    ]);
    expect(sheets[0]?.periods.get("A1")).toBe("month");
    const key = cellKey(0, "A2");
    const years = evaluateCpu(program, {
      seed: 1,
      iterationStart: 0,
      count: 2000,
      outputs: [key],
    }).get(key);
    expect(new Set(years)).toEqual(new Set([2025, 2026, 2027]));
  });
});
