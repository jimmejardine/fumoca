import { describe, expect, it } from "vitest";
import {
  createSheet,
  createWorkbook,
  parseWorkbook,
  serializeWorkbook,
  setCell,
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
