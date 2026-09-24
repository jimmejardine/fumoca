import { compile } from "@fumoca/engine";
import { parseWorkbook, serializeWorkbook } from "@fumoca/storage";
import { describe, expect, it } from "vitest";
import { createTestWorkbook } from "./testModel";

describe("test model", () => {
  it("has uniquely named sheets", () => {
    const names = createTestWorkbook().sheets.map((sheet) => sheet.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(createTestWorkbook().sheets.map((sheet) => [sheet.name, sheet] as const))(
    "sheet %s compiles with the engine",
    (_, sheet) => {
      expect(() => compile(sheet.cells)).not.toThrow();
    },
  );

  it("survives a save and load", () => {
    const workbook = createTestWorkbook();
    const loaded = parseWorkbook(serializeWorkbook(workbook));
    expect(loaded.sheets.map((s) => s.cells)).toEqual(workbook.sheets.map((s) => s.cells));
  });
});
