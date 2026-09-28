import { type CellInputs, GRANULARITIES, type Granularity } from "@fumoca/engine";
import {
  type CellInput,
  type CellRef,
  DEFAULT_SCENARIO_SAMPLES,
  type Dimension,
  type Scenario,
} from "./scenario";

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
  /** Named scenarios (SPECS.md §7). Absent means none. */
  scenarios?: Scenario[];
}

/** File format identifier and version (SPECS.md §8.2). */
export const FILE_FORMAT = "fumoca";
export const FILE_VERSION = 1;
export const FILE_EXTENSION = ".fumoca";

/** A cell reference in a file: sheets are named, since sheet ids exist only at runtime. */
interface CellRefFile {
  sheet: string;
  address: string;
}

type DimensionFile =
  | { kind: "cell"; cell: CellRefFile | null; alternatives: { label: string; input: CellInput }[] }
  | {
      kind: "group";
      name: string;
      cells: CellRefFile[];
      variants: { label: string; inputs: (CellInput | null)[] }[];
    };

interface ScenarioFile {
  name: string;
  dimensions: DimensionFile[];
  outputs: CellRefFile[];
  samples: number;
}

interface WorkbookFileV1 {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  sheets: { name: string; cells: CellInputs; series?: SeriesSettings }[];
  scenarios?: ScenarioFile[];
}

export class WorkbookFormatError extends Error {
  override name = "WorkbookFormatError";
}

export function createSheet(name: string, cells: CellInputs = {}, series?: SeriesSettings): Sheet {
  return series
    ? { id: crypto.randomUUID(), name, cells, series }
    : { id: crypto.randomUUID(), name, cells };
}

/**
 * A new, empty time-series sheet (SPECS.md §5.2): monthly, level, one value column called
 * "Value". The first period typed into an empty sheet sets its granularity.
 */
export function createSeriesSheet(name: string): Sheet {
  return createSheet(name, {}, { granularity: "month", type: "level", columns: ["Value"] });
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
    ...workbook,
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
    ...workbook,
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
    ...workbook,
    ...workbook,
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
  return { workbook: { ...workbook, sheets: [...workbook.sheets, sheet] }, sheet };
}

/** Returns a copy of the workbook with one cell changed. An empty value clears the cell. */
export function setCell(
  workbook: Workbook,
  sheetId: string,
  address: string,
  value: number | string,
): Workbook {
  return {
    ...workbook,
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
  const names = new Map(workbook.sheets.map((sheet) => [sheet.id, sheet.name]));
  const ref = ({ sheetId, address }: CellRef): CellRefFile => ({
    sheet: names.get(sheetId) ?? "",
    address,
  });
  const dimension = (d: Dimension): DimensionFile =>
    d.kind === "cell"
      ? { kind: "cell", cell: d.cell && ref(d.cell), alternatives: d.alternatives }
      : { kind: "group", name: d.name, cells: d.cells.map(ref), variants: d.variants };
  const file: WorkbookFileV1 = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    sheets: workbook.sheets.map(({ name, cells, series }) =>
      series ? { name, cells, series } : { name, cells },
    ),
  };
  if (workbook.scenarios?.length) {
    file.scenarios = workbook.scenarios.map((scenario) => ({
      name: scenario.name,
      dimensions: scenario.dimensions.map(dimension),
      outputs: scenario.outputs.map(ref),
      samples: scenario.samples,
    }));
  }
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
  const scenarios = parseScenarios(data.scenarios, sheets);
  return scenarios.length > 0 ? { sheets, scenarios } : { sheets };
}

const isInput = (value: unknown): value is CellInput =>
  typeof value === "number" || typeof value === "string";

/** Parses a file's scenarios, resolving sheet names to the loaded sheets' ids. */
function parseScenarios(value: unknown, sheets: Sheet[]): Scenario[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WorkbookFormatError("The scenarios are invalid");
  const ids = new Map(sheets.map((sheet) => [sheet.name, sheet.id]));
  return value.map((scenario: unknown, i: number) => {
    if (!isRecord(scenario) || typeof scenario.name !== "string") {
      throw new WorkbookFormatError(`Scenario ${i + 1} has no name`);
    }
    const name = scenario.name;
    const invalid = (what: string) => new WorkbookFormatError(`Scenario "${name}" has ${what}`);
    const ref = (cell: unknown): CellRef => {
      if (!isRecord(cell) || typeof cell.sheet !== "string" || typeof cell.address !== "string") {
        throw invalid("an invalid cell reference");
      }
      const sheetId = ids.get(cell.sheet);
      if (!sheetId) throw invalid(`a reference to a missing sheet, ${cell.sheet}`);
      return { sheetId, address: cell.address };
    };
    const dimension = (d: unknown): Dimension => {
      if (isRecord(d) && d.kind === "cell" && Array.isArray(d.alternatives)) {
        return {
          id: crypto.randomUUID(),
          kind: "cell",
          cell: d.cell === null || d.cell === undefined ? null : ref(d.cell),
          alternatives: d.alternatives.map((a: unknown) => {
            if (!isRecord(a) || !isInput(a.input)) throw invalid("an invalid alternative");
            return { label: typeof a.label === "string" ? a.label : "", input: a.input };
          }),
        };
      }
      if (
        isRecord(d) &&
        d.kind === "group" &&
        Array.isArray(d.cells) &&
        Array.isArray(d.variants)
      ) {
        const cells = d.cells.map(ref);
        return {
          id: crypto.randomUUID(),
          kind: "group",
          name: typeof d.name === "string" ? d.name : "Group",
          cells,
          variants: d.variants.map((v: unknown) => {
            if (!isRecord(v) || typeof v.label !== "string" || !Array.isArray(v.inputs)) {
              throw invalid("an invalid variant");
            }
            const inputs = v.inputs as unknown[];
            return {
              label: v.label,
              inputs: cells.map((_, c) => {
                const input = inputs[c];
                return isInput(input) ? input : null;
              }),
            };
          }),
        };
      }
      throw invalid("an invalid dimension");
    };
    const dimensions = (Array.isArray(scenario.dimensions) ? scenario.dimensions : []).map(
      dimension,
    );
    const outputs = (Array.isArray(scenario.outputs) ? scenario.outputs : []).map(ref);
    const samples =
      typeof scenario.samples === "number" && scenario.samples > 0
        ? Math.floor(scenario.samples)
        : DEFAULT_SCENARIO_SAMPLES;
    return { id: crypto.randomUUID(), name, dimensions, outputs, samples };
  });
}

/** The first free scenario name of the form "Scenario1", "Scenario2", … */
export function nextScenarioName(workbook: Workbook): string {
  const names = new Set((workbook.scenarios ?? []).map((scenario) => scenario.name));
  for (let n = 1; ; n++) {
    if (!names.has(`Scenario${n}`)) return `Scenario${n}`;
  }
}

/** Returns a copy of the workbook with a scenario added, or replaced if one has its id. */
export function putScenario(workbook: Workbook, scenario: Scenario): Workbook {
  const scenarios = workbook.scenarios ?? [];
  const exists = scenarios.some((s) => s.id === scenario.id);
  return {
    ...workbook,
    scenarios: exists
      ? scenarios.map((s) => (s.id === scenario.id ? scenario : s))
      : [...scenarios, scenario],
  };
}

/** Returns a copy of the workbook without a scenario. */
export function removeScenario(workbook: Workbook, scenarioId: string): Workbook {
  return { ...workbook, scenarios: (workbook.scenarios ?? []).filter((s) => s.id !== scenarioId) };
}
