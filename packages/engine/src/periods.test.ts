import { describe, expect, it } from "vitest";
import { granularityOf, nextPeriod, normalizePeriod, periodContaining } from "./periods";

describe("granularityOf", () => {
  it.each([
    ["2027", "year"],
    [2027, "year"],
    ["2027-Q1", "quarter"],
    ["2027-Q4", "quarter"],
    ["2027-01", "month"],
    ["2027-12", "month"],
    ["2027-W05", "week"],
    ["2020-W53", "week"], // 2020 has 53 ISO weeks
    ["2027-01-15", "day"],
    ["2028-02-29", "day"], // leap day
    ["2027-01-15T09", "hour"],
    ["2027-01-15T23", "hour"],
    [" 2027-03 ", "month"],
  ])("%j is a %s", (value, granularity) => {
    expect(granularityOf(value)).toBe(granularity);
  });

  it.each([
    ["2027-13"],
    ["2027-Q5"],
    ["2027-W54"],
    ["2027-W53"], // 2027 has 52 ISO weeks
    ["2027-02-29"],
    ["2027-01-15T24"],
    ["27-01"],
    ["Period"],
    [""],
    [12.5],
    [999],
    [undefined],
  ])("%j is not a period", (value) => {
    expect(granularityOf(value)).toBeNull();
  });
});

describe("normalizePeriod", () => {
  it.each([
    ["2026-7", "2026-07"],
    [" 2026-7 ", "2026-07"],
    ["2026-07", "2026-07"],
    ["2026-q3", "2026-Q3"],
    ["2026-w5", "2026-W05"],
    ["2026-3-5", "2026-03-05"],
    ["2026-3-5t9", "2026-03-05T09"],
  ])("%j → %j", (text, normalized) => {
    expect(normalizePeriod(text)).toBe(normalized);
  });

  it.each([["2026-13"], ["2026-2-30"], ["2026-q5"], ["Period"], ["=A1+1"], ["2026"]])(
    "leaves %j unchanged",
    (text) => {
      expect(normalizePeriod(text)).toBe(text);
    },
  );
});

describe("periodContaining", () => {
  const date = new Date(2026, 8, 25, 14, 30); // Friday 25 September 2026, 14:30 local
  it.each([
    ["year", "2026"],
    ["quarter", "2026-Q3"],
    ["month", "2026-09"],
    ["week", "2026-W39"],
    ["day", "2026-09-25"],
    ["hour", "2026-09-25T14"],
  ] as const)("%s → %s", (granularity, period) => {
    expect(periodContaining(date, granularity)).toBe(period);
  });

  it("uses the ISO week-numbering year around new year", () => {
    expect(periodContaining(new Date(2027, 0, 1), "week")).toBe("2026-W53"); // Friday
    expect(periodContaining(new Date(2024, 11, 30), "week")).toBe("2025-W01"); // Monday
  });
});

describe("nextPeriod", () => {
  it.each([
    ["2026", "2027"],
    ["2026-Q3", "2026-Q4"],
    ["2026-Q4", "2027-Q1"],
    ["2026-09", "2026-10"],
    ["2026-12", "2027-01"],
    ["2026-W39", "2026-W40"],
    ["2026-W53", "2027-W01"],
    ["2026-02-28", "2026-03-01"],
    ["2028-02-28", "2028-02-29"],
    ["2026-12-31", "2027-01-01"],
    ["2026-09-25T23", "2026-09-26T00"],
    ["2026-09-25T09", "2026-09-25T10"],
  ])("%s → %s", (period, next) => {
    expect(nextPeriod(period)).toBe(next);
  });

  it("returns null for text that isn't a period", () => {
    expect(nextPeriod("Sales")).toBeNull();
  });
});
