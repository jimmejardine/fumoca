import { describe, expect, it } from "vitest";
import {
  addSeriesColumn,
  addSheet,
  columnNameError,
  createSeriesSheet,
  createSheet,
  createWorkbook,
  nextSheetName,
  parseWorkbook,
  renameSeriesColumn,
  serializeWorkbook,
  setCell,
  setSeriesSettings,
  WorkbookFormatError,
} from "./workbook";

describe("workbook files", () => {
  it("round-trips sheets and cells, with fresh sheet ids", () => {
    const workbook = {
      sheets: [
        createSheet("Inputs", { A1: "Spot", B1: 100, B2: "=B1*2" }),
        createSheet("Other", {}),
      ],
    };
    const loaded = parseWorkbook(serializeWorkbook(workbook));
    expect(loaded.sheets.map(({ name, cells }) => ({ name, cells }))).toEqual(
      workbook.sheets.map(({ name, cells }) => ({ name, cells })),
    );
    expect(loaded.sheets[0]?.id).not.toBe(workbook.sheets[0]?.id);
  });

  it("writes a versioned format", () => {
    const file = JSON.parse(serializeWorkbook(createWorkbook()));
    expect(file).toMatchObject({ format: "fumoca", version: 1, sheets: [{ name: "Sheet1" }] });
  });

  it.each([
    ["not json", /not valid JSON/],
    ['{"format":"other"}', /not a fumoca workbook/],
    ['{"format":"fumoca","version":99,"sheets":[]}', /Unsupported workbook version 99/],
    ['{"format":"fumoca","version":1,"sheets":[]}', /no sheets/],
    ['{"format":"fumoca","version":1,"sheets":[{"cells":{}}]}', /Sheet 1 has no name/],
    [
      '{"format":"fumoca","version":1,"sheets":[{"name":"A","cells":{}},{"name":"A","cells":{}}]}',
      /Duplicate sheet name "A"/,
    ],
    ['{"format":"fumoca","version":1,"sheets":[{"name":"A","cells":{"a1":1}}]}', /invalid cell/],
    ['{"format":"fumoca","version":1,"sheets":[{"name":"A","cells":{"A1":true}}]}', /A!A1/],
  ])("rejects %s", (text, message) => {
    expect(() => parseWorkbook(text)).toThrow(WorkbookFormatError);
    expect(() => parseWorkbook(text)).toThrow(message);
  });
});

describe("adding sheets", () => {
  it("names new sheets with the first free SheetN name", () => {
    const workbook = { sheets: [createSheet("Sheet1"), createSheet("Sheet3")] };
    expect(nextSheetName(workbook)).toBe("Sheet2");
    const { workbook: next, sheet } = addSheet(workbook);
    expect(sheet.name).toBe("Sheet2");
    expect(next.sheets.map((s) => s.name)).toEqual(["Sheet1", "Sheet3", "Sheet2"]);
    expect(workbook.sheets).toHaveLength(2);
  });
});

describe("series sheets", () => {
  it("start monthly, level, one Value column, 24 periods from the current month", () => {
    const sheet = createSeriesSheet("Series1", new Date(2026, 10, 5));
    expect(sheet.series).toEqual({ granularity: "month", type: "level", columns: ["Value"] });
    expect(sheet.cells.A1).toBe("2026-11");
    expect(sheet.cells.A2).toBe("2026-12");
    expect(sheet.cells.A24).toBe("2028-10");
    expect(sheet.cells.A25).toBeUndefined();
  });

  it("round-trip their settings and columns through a file", () => {
    const series = createSeriesSheet("Series1");
    const { workbook } = addSheet({ sheets: [createSheet("Sheet1")] }, series);
    const changed = setSeriesSettings(workbook, series.id, {
      granularity: "quarter",
      type: "flow",
      columns: ["Open", "Close"],
    });
    const loaded = parseWorkbook(serializeWorkbook(changed));
    expect(loaded.sheets.map((s) => s.series)).toEqual([
      undefined,
      { granularity: "quarter", type: "flow", columns: ["Open", "Close"] },
    ]);
  });

  it("add value columns with the next free ValueN name, and rename them", () => {
    const series = createSeriesSheet("S");
    let { workbook } = addSheet({ sheets: [] }, series);
    workbook = addSeriesColumn(workbook, series.id);
    workbook = addSeriesColumn(workbook, series.id);
    expect(workbook.sheets[0]?.series?.columns).toEqual(["Value", "Value2", "Value3"]);
    workbook = renameSeriesColumn(workbook, series.id, 1, "  Close ");
    expect(workbook.sheets[0]?.series?.columns).toEqual(["Value", "Close", "Value3"]);
  });

  it("validate column names", () => {
    const settings = {
      granularity: "month" as const,
      type: "level" as const,
      columns: ["Open", "Close"],
    };
    expect(columnNameError(settings, "High")).toBeNull();
    expect(columnNameError(settings, " ")).toBe("A column needs a name");
    expect(columnNameError(settings, "close")).toMatch(/already a column called Close/);
    expect(columnNameError(settings, "Close", 1)).toBeNull(); // renaming a column to itself
    expect(columnNameError(settings, "period")).toMatch(/reserved/);
    expect(columnNameError(settings, "a[b]")).toMatch(/can't contain/);
  });

  it("reject invalid series settings in a file", () => {
    const file = (series: unknown) =>
      JSON.stringify({ format: "fumoca", version: 1, sheets: [{ name: "S", cells: {}, series }] });
    expect(() => parseWorkbook(file({ granularity: "fortnight", type: "level" }))).toThrow(
      /invalid series settings/,
    );
    expect(() =>
      parseWorkbook(file({ granularity: "month", type: "level", columns: ["A", "a"] })),
    ).toThrow(/invalid column name/);
    // Files without columns get a single Value column.
    expect(
      parseWorkbook(file({ granularity: "month", type: "level" })).sheets[0]?.series?.columns,
    ).toEqual(["Value"]);
  });
});

describe("setCell", () => {
  it("sets and clears cells without mutating the original", () => {
    const workbook = { sheets: [createSheet("S", { A1: 1 })] };
    const id = workbook.sheets[0]?.id ?? "";
    const changed = setCell(workbook, id, "B2", "=A1+1");
    expect(changed.sheets[0]?.cells).toEqual({ A1: 1, B2: "=A1+1" });
    expect(setCell(changed, id, "A1", "").sheets[0]?.cells).toEqual({ B2: "=A1+1" });
    expect(workbook.sheets[0]?.cells).toEqual({ A1: 1 });
  });
});
