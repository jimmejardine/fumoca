import { describe, expect, it } from "vitest";
import { granularityOf, monthlyPeriods } from "./periods";

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

describe("monthlyPeriods", () => {
  it("counts months from the start month, across year boundaries", () => {
    expect(monthlyPeriods(new Date(2026, 10, 20), 4)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });
});
