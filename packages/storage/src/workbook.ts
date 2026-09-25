import { type CellInputs, GRANULARITIES, type Granularity, monthlyPeriods } from "@fumoca/engine";

/**
 * The model: one workbook holding several worksheets (SPECS.md §2). Only one workbook is open at a
 * time. Sheet ids exist only at runtime and are regenerated when a file is loaded.
 */
export interface Sheet {
  id: string;
  name: string;
  cells: CellInputs;
  /** Present on time-series sheets (SPECS.md §5): column A is the time column. */
  series?: SeriesSettings;
}

/** What kind of quantity a series holds, which sets its lookup defaults (SPECS.md §5.5). */
export type SeriesType = "flow" | "level" | "rate";

export const SERIES_TYPES: readonly { value: SeriesType; label: string }[] = [
  { value: "flow", label: "Flow" },
  { value: "level", label: "Level" },
  { value: "rate", label: "Rate" },
];

export interface SeriesSettings {
  granularity: Granularity;
  type: SeriesType;
  /** Value column names, in order: column B holds the first, C the second, … */
  columns: string[];
}

/** The time column's header. It isn't a value column and can't be renamed. */
export const PERIOD_COLUMN = "Period";

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
  sheets: { name: string; cells: CellInputs; series?: SeriesSettings }[];
}

export class WorkbookFormatError extends Error {
  override name = "WorkbookFormatError";
}

export function createSheet(name: string, cells: CellInputs = {}, series?: SeriesSettings): Sheet {
  return series
    ? { id: crypto.randomUUID(), name, cells, series }
    : { id: crypto.randomUUID(), name, cells };
}

/** Number of periods a new series sheet starts with. */
export const DEFAULT_SERIES_PERIODS = 24;

/**
 * A new time-series sheet with the defaults (SPECS.md §5.2): monthly, level, one value column
 * called "Value", 24 periods starting with the current month. Periods go down column A from row 1;
 * column names are shown as headers, not stored in cells.
 */
export function createSeriesSheet(name: string, today = new Date()): Sheet {
  const cells: CellInputs = {};
  monthlyPeriods(today, DEFAULT_SERIES_PERIODS).forEach((period, i) => {
    cells[`A${i + 1}`] = period;
  });
  return createSheet(name, cells, { granularity: "month", type: "level", columns: ["Value"] });
}

/**
 * Returns an error message if `name` can't be used as a value column name on a sheet (excluding
 * the column at `except`), or null if it's fine. Names are used in lookups like Sheet[Name]@2026-01.
 */
export function columnNameError(
  settings: SeriesSettings,
  name: string,
  except = -1,
): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "A column needs a name";
  if (/[[\]@']/.test(trimmed)) return "Column names can't contain [ ] @ or '";
  if (trimmed.toLowerCase() === PERIOD_COLUMN.toLowerCase())
    return `"${PERIOD_COLUMN}" is reserved`;
  const clash = settings.columns.findIndex(
    (column, i) => i !== except && column.toLowerCase() === trimmed.toLowerCase(),
  );
  return clash >= 0 ? `There is already a column called ${settings.columns[clash]}` : null;
}

/** Returns a copy of the workbook with a new value column (Value2, Value3, …) on a series sheet. */
export function addSeriesColumn(workbook: Workbook, sheetId: string): Workbook {
  return {
    sheets: workbook.sheets.map((sheet) => {
      if (sheet.id !== sheetId || !sheet.series) return sheet;
      const series = sheet.series;
      let n = series.columns.length + 1;
      while (columnNameError(series, `Value${n}`)) n++;
      return { ...sheet, series: { ...series, columns: [...series.columns, `Value${n}`] } };
    }),
  };
}

/** Returns a copy of the workbook with a series sheet's value column renamed. */
export function renameSeriesColumn(
  workbook: Workbook,
  sheetId: string,
  index: number,
  name: string,
): Workbook {
  return {
    sheets: workbook.sheets.map((sheet) => {
      if (sheet.id !== sheetId || !sheet.series) return sheet;
      const columns = sheet.series.columns.map((column, i) => (i === index ? name.trim() : column));
      return { ...sheet, series: { ...sheet.series, columns } };
    }),
  };
}

/** Returns a copy of the workbook with a sheet's series settings changed. */
export function setSeriesSettings(
  workbook: Workbook,
  sheetId: string,
  series: SeriesSettings,
): Workbook {
  return {
    sheets: workbook.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, series } : sheet)),
  };
}

/** A new, empty model with a single sheet. */
export function createWorkbook(): Workbook {
  return { sheets: [createSheet("Sheet1")] };
}

/** The first free name of the form "Sheet1", "Sheet2", … in a workbook. */
export function nextSheetName(workbook: Workbook, prefix = "Sheet"): string {
  const names = new Set(workbook.sheets.map((sheet) => sheet.name));
  for (let n = 1; ; n++) {
    if (!names.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
}

/** Returns a copy of the workbook with a sheet added at the end (a new, empty sheet by default). */
export function addSheet(
  workbook: Workbook,
  sheet: Sheet = createSheet(nextSheetName(workbook)),
): { workbook: Workbook; sheet: Sheet } {
  return { workbook: { sheets: [...workbook.sheets, sheet] }, sheet };
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
    sheets: workbook.sheets.map(({ name, cells, series }) =>
      series ? { name, cells, series } : { name, cells },
    ),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSeries(value: unknown, sheetName: string): SeriesSettings | undefined {
  if (value === undefined) return undefined;
  const granularities = GRANULARITIES.map((g) => g.value);
  const types = SERIES_TYPES.map((t) => t.value);
  if (
    !isRecord(value) ||
    !granularities.includes(value.granularity as Granularity) ||
    !types.includes(value.type as SeriesType)
  ) {
    throw new WorkbookFormatError(`Sheet "${sheetName}" has invalid series settings`);
  }
  const settings: SeriesSettings = {
    granularity: value.granularity as Granularity,
    type: value.type as SeriesType,
    columns: [],
  };
  const columns = value.columns ?? ["Value"];
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new WorkbookFormatError(`Sheet "${sheetName}" has no value columns`);
  }
  for (const column of columns) {
    const problem = typeof column === "string" ? columnNameError(settings, column) : "not text";
    if (problem) {
      throw new WorkbookFormatError(`Sheet "${sheetName}" has an invalid column name: ${problem}`);
    }
    settings.columns.push(column.trim());
  }
  return settings;
}

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
    return createSheet(sheet.name, cells, parseSeries(sheet.series, sheet.name));
  });
  return { sheets };
}
