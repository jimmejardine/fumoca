import { describe, expect, it } from "vitest";
import {
  addSheet,
  cellName,
  cellNameError,
  createWorkbook,
  findName,
  namedCells,
  parseWorkbook,
  removeCellName,
  serializeWorkbook,
  setCell,
  setCellName,
  type Workbook,
} from "./workbook";

/** Sheet1 with inputs in B1 and B3, and Sheet2 using them by name. */
function example(): { workbook: Workbook; first: string; second: string } {
  const base = createWorkbook();
  const { workbook: withSecond, sheet } = addSheet(base);
  const first = withSecond.sheets[0]?.id ?? "";
  let workbook = setCell(withSecond, first, "B1", 100);
  workbook = setCell(workbook, first, "B3", 0.05);
  workbook = setCellName(workbook, first, "B1", "Spot");
  workbook = setCellName(workbook, first, "B3", "Rate");
  workbook = setCell(workbook, sheet.id, "A1", "=spot * (1 + Rate) + SPOT(1)");
  return { workbook, first, second: sheet.id };
}

describe("named cells", () => {
  it("are set, found and listed A–Z", () => {
    const { workbook, first } = example();
    const sheet = workbook.sheets[0];
    if (!sheet) throw new Error("no sheet");
    expect(cellName(sheet, "B1")).toBe("Spot");
    expect(cellName(sheet, "B2")).toBeUndefined();
    expect(namedCells(sheet)).toEqual([
      { name: "Rate", address: "B3" },
      { name: "Spot", address: "B1" },
    ]);
    expect(findName(workbook, "RATE")).toEqual({ sheetId: first, address: "B3" });
    expect(findName(workbook, "Nope")).toBeNull();
  });

  it("are unique across the workbook, regardless of case", () => {
    const { workbook, first, second } = example();
    expect(cellNameError(workbook, "spot", { sheetId: second, address: "C1" })).toMatch(/already/);
    // The cell that has the name may keep it.
    expect(cellNameError(workbook, "spot", { sheetId: first, address: "B1" })).toBeNull();
    expect(cellNameError(workbook, "A1")).toMatch(/cell reference/);
    expect(() => setCellName(workbook, second, "C1", "Spot")).toThrow(/already/);
  });

  it("rename a named cell, rewriting formulas on every sheet", () => {
    const { workbook, first, second } = example();
    const renamed = setCellName(workbook, first, "B1", "SpotPrice");
    expect(renamed.sheets[0]?.names).toEqual({ Rate: "B3", SpotPrice: "B1" });
    // Uses of the name change; a call to a function of the same name doesn't.
    expect(renamed.sheets.find((s) => s.id === second)?.cells.A1).toBe(
      "=SpotPrice * (1 + Rate) + SPOT(1)",
    );
  });

  it("are removed", () => {
    const { workbook, first } = example();
    const removed = removeCellName(workbook, first, "B1");
    expect(removed.sheets[0]?.names).toEqual({ Rate: "B3" });
  });

  it("are saved and loaded, and invalid ones are rejected", () => {
    const { workbook } = example();
    const saved = serializeWorkbook(workbook);
    const loaded = parseWorkbook(saved);
    expect(loaded.sheets.map((s) => s.names)).toEqual([{ Spot: "B1", Rate: "B3" }, undefined]);
    const file = JSON.parse(saved);
    file.sheets[1].names = { spot: "C1" };
    expect(() => parseWorkbook(JSON.stringify(file))).toThrow(/used twice/);
    file.sheets[1].names = { Q1: "C1" };
    expect(() => parseWorkbook(JSON.stringify(file))).toThrow(/invalid name/);
  });
});
