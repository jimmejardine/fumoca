import { describe, expect, it } from "vitest";
import { hasNoPeriods, lastUsedRow, seriesIssues, sortSeriesSheet, suggestPeriod } from "./series";
import { createSheet } from "./workbook";

const monthly = (cells: Record<string, number | string>) =>
  createSheet("S", cells, { granularity: "month", type: "level", columns: ["Value", "Other"] });

describe("series sheets", () => {
  it("find the last used row and whether the time column is empty", () => {
    expect(lastUsedRow({})).toBe(0);
    expect(lastUsedRow({ A1: "2026-01", C7: 3 })).toBe(7);
    expect(hasNoPeriods(monthly({ B1: 5 }))).toBe(true);
    expect(hasNoPeriods(monthly({ A1: "2026-01" }))).toBe(false);
  });

  it("find duplicate periods", () => {
    const sheet = monthly({
      A1: "2026-01",
      A2: "2026-02",
      A3: "2026-01",
      A4: "2026-02",
      A5: "2026-03",
    });
    expect(seriesIssues(sheet).duplicates).toEqual([
      { period: "2026-01", rows: [1, 3] },
      { period: "2026-02", rows: [2, 4] },
    ]);
  });

  it("detect periods out of order, ignoring rows with a wrong or missing period", () => {
    expect(seriesIssues(monthly({ A1: "2026-01", A2: "2026-02", A4: "2026-03" })).outOfOrder).toBe(
      false,
    );
    expect(seriesIssues(monthly({ A1: "2026-03", A2: "2026-01" })).outOfOrder).toBe(true);
    expect(
      seriesIssues(monthly({ A1: "2026-01", A2: "2026-05-01", A3: "2026-02" })).outOfOrder,
    ).toBe(false);
  });

  it("sort rows by period, keeping each row's values together", () => {
    const sheet = monthly({
      A1: "2026-03",
      B1: 30,
      C1: "=B1*2",
      A2: "bad",
      B2: 99,
      A3: "2026-01",
      B3: 10,
      A5: "2026-02",
      B5: 20,
    });
    const sorted = sortSeriesSheet({ sheets: [sheet] }, sheet.id).sheets[0]?.cells;
    expect(sorted).toEqual({
      A1: "2026-01",
      B1: 10,
      A2: "2026-02",
      B2: 20,
      A3: "2026-03",
      B3: 30,
      C3: "=B1*2", // formulas move with their row, unchanged (as in Excel)
      A4: "bad",
      B4: 99,
    });
  });

  it("sort years typed as numbers", () => {
    const sheet = createSheet(
      "S",
      { A1: 2028, A2: 2026, A3: 2027 },
      {
        granularity: "year",
        type: "level",
        columns: ["Value"],
      },
    );
    expect(sortSeriesSheet({ sheets: [sheet] }, sheet.id).sheets[0]?.cells).toEqual({
      A1: 2026,
      A2: 2027,
      A3: 2028,
    });
  });

  it("suggest the current period with nothing above, else the latest above plus one", () => {
    const today = new Date(2026, 8, 25);
    const sheet = monthly({ A1: "2026-03", A2: "2026-05", A3: "2026-04", A4: "bad" });
    expect(suggestPeriod(monthly({}), 1, today)).toBe("2026-09");
    expect(suggestPeriod(sheet, 1, today)).toBe("2026-09"); // nothing above row 1
    expect(suggestPeriod(sheet, 2, today)).toBe("2026-04");
    expect(suggestPeriod(sheet, 5, today)).toBe("2026-06"); // latest above is 2026-05
    const quarterly = createSheet(
      "Q",
      { A1: "2026-Q4" },
      {
        granularity: "quarter",
        type: "level",
        columns: ["Value"],
      },
    );
    expect(suggestPeriod(quarterly, 2, today)).toBe("2027-Q1");
  });
});
