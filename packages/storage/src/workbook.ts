import type { CellInputs } from "@fumoca/engine";

/**
 * The model: one workbook holding several worksheets (SPECS.md §2). Only one workbook is open at a
 * time. Sheet ids exist only at runtime and are regenerated when a file is loaded.
 */
export interface Sheet {
  id: string;
  name: string;
  cells: CellInputs;
}

export interface Workbook {
  sheets: Sheet[];
}

/** File format identifier and version (SPECS.md §8.2). */
export const FILE_FORMAT = "fumoca";
export const FILE_VERSION = 1;
export const FILE_EXTENSION = ".fumoca";

interface WorkbookFileV1 {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  sheets: { name: string; cells: CellInputs }[];
}

export class WorkbookFormatError extends Error {
  override name = "WorkbookFormatError";
}

export function createSheet(name: string, cells: CellInputs = {}): Sheet {
  return { id: crypto.randomUUID(), name, cells };
}

/** A new, empty model with a single sheet. */
export function createWorkbook(): Workbook {
  return { sheets: [createSheet("Sheet1")] };
}

/** Returns a copy of the workbook with one cell changed. An empty value clears the cell. */
export function setCell(
  workbook: Workbook,
  sheetId: string,
  address: string,
  value: number | string,
): Workbook {
  return {
    sheets: workbook.sheets.map((sheet) => {
      if (sheet.id !== sheetId) return sheet;
      const cells = { ...sheet.cells };
      if (value === "") delete cells[address];
      else cells[address] = value;
      return { ...sheet, cells };
    }),
  };
}

/** Serializes a workbook as a versioned JSON file. */
export function serializeWorkbook(workbook: Workbook): string {
  const file: WorkbookFileV1 = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    sheets: workbook.sheets.map(({ name, cells }) => ({ name, cells })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses and validates a workbook file. Throws `WorkbookFormatError` if it isn't valid. */
export function parseWorkbook(text: string): Workbook {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorkbookFormatError("The file is not valid JSON");
  }
  if (!isRecord(data) || data.format !== FILE_FORMAT) {
    throw new WorkbookFormatError("The file is not a fumoca workbook");
  }
  if (data.version !== FILE_VERSION) {
    throw new WorkbookFormatError(`Unsupported workbook version ${String(data.version)}`);
  }
  if (!Array.isArray(data.sheets) || data.sheets.length === 0) {
    throw new WorkbookFormatError("The workbook has no sheets");
  }

  const names = new Set<string>();
  const sheets = data.sheets.map((sheet: unknown, i: number) => {
    if (!isRecord(sheet) || typeof sheet.name !== "string" || sheet.name === "") {
      throw new WorkbookFormatError(`Sheet ${i + 1} has no name`);
    }
    if (names.has(sheet.name)) {
      throw new WorkbookFormatError(`Duplicate sheet name "${sheet.name}"`);
    }
    names.add(sheet.name);
    if (!isRecord(sheet.cells)) {
      throw new WorkbookFormatError(`Sheet "${sheet.name}" has no cells`);
    }
    const cells: CellInputs = {};
    for (const [address, value] of Object.entries(sheet.cells)) {
      if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(address)) {
        throw new WorkbookFormatError(
          `Sheet "${sheet.name}" has an invalid cell address ${address}`,
        );
      }
      if (typeof value !== "number" && typeof value !== "string") {
        throw new WorkbookFormatError(`Cell ${sheet.name}!${address} has an invalid value`);
      }
      cells[address] = value;
    }
    return createSheet(sheet.name, cells);
  });
  return { sheets };
}
