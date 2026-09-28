import { type CellInputs, granularityOf, nextPeriod, periodContaining } from "@fumoca/engine";
import type { Sheet, Workbook } from "./workbook";

/**
 * Checks and edits specific to time-series sheets (SPECS.md §5.2): column A holds the periods, one
 * row per period, from row 1.
 */

const ROW_ADDRESS = /^([A-Z]+)([1-9][0-9]*)$/;

/** The key a period is compared by: its text, trimmed (a typed year may be stored as a number). */
const periodKey = (value: number | string) => String(value).trim();

/** The highest row number with any content (0 for an empty sheet). */
export function lastUsedRow(cells: CellInputs): number {
  let last = 0;
  for (const address of Object.keys(cells)) {
    const row = Number(ROW_ADDRESS.exec(address)?.[2] ?? 0);
    if (row > last) last = row;
  }
  return last;
}

/** Whether a series sheet's time column is empty. */
export function hasNoPeriods(sheet: Sheet): boolean {
  return !Object.keys(sheet.cells).some((address) => ROW_ADDRESS.exec(address)?.[1] === "A");
}

export interface SeriesIssues {
  /** Periods that appear in more than one row, with those rows (1-based). */
  duplicates: { period: string; rows: number[] }[];
  /** Whether valid periods are not in ascending order down the sheet. */
  outOfOrder: boolean;
}

/**
 * Finds duplicate and out-of-order periods among the rows whose period matches the sheet's
 * granularity. (Rows with a missing or wrong period are shown red in the grid instead.)
 */
export function seriesIssues(sheet: Sheet): SeriesIssues {
  const granularity = sheet.series?.granularity;
  const rows = new Map<string, number[]>();
  let previous: string | undefined;
  let outOfOrder = false;
  for (let row = 1; row <= lastUsedRow(sheet.cells); row++) {
    const value = sheet.cells[`A${row}`];
    if (value === undefined || granularityOf(value) !== granularity) continue;
    const key = periodKey(value);
    rows.set(key, [...(rows.get(key) ?? []), row]);
    if (previous !== undefined && key < previous) outOfOrder = true;
    previous = key;
  }
  const duplicates = [...rows]
    .filter(([, found]) => found.length > 1)
    .map(([period, found]) => ({ period, rows: found }));
  return { duplicates, outOfOrder };
}

/**
 * Returns a copy of the workbook with a series sheet's rows sorted by period, ascending. Rows with
 * a valid period come first, in order; rows without one follow, in their original order. Empty
 * rows are dropped. Period literals of one granularity sort correctly as text (2026-02 < 2026-10).
 */
export function sortSeriesSheet(workbook: Workbook, sheetId: string): Workbook {
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => {
      if (sheet.id !== sheetId || !sheet.series) return sheet;
      const granularity = sheet.series.granularity;
      const rows = new Map<number, CellInputs>();
      for (const [address, value] of Object.entries(sheet.cells)) {
        const match = ROW_ADDRESS.exec(address);
        if (!match?.[1] || !match[2]) continue;
        const row = Number(match[2]);
        rows.set(row, { ...rows.get(row), [match[1]]: value });
      }
      const withPeriod: { key: string; row: CellInputs }[] = [];
      const without: CellInputs[] = [];
      for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
        const period = row.A;
        if (period !== undefined && granularityOf(period) === granularity) {
          withPeriod.push({ key: periodKey(period), row });
        } else {
          without.push(row);
        }
      }
      withPeriod.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // stable
      const cells: CellInputs = {};
      [...withPeriod.map((entry) => entry.row), ...without].forEach((row, i) => {
        for (const [column, value] of Object.entries(row)) cells[`${column}${i + 1}`] = value;
      });
      return { ...sheet, cells };
    }),
  };
}

/**
 * The period to fill into row `row` (1-based) of a series sheet, as Ctrl+; does: the latest period
 * in the rows above, plus one; or, with no periods above, the current period (today, truncated to
 * the sheet's granularity).
 */
export function suggestPeriod(sheet: Sheet, row: number, today = new Date()): string | null {
  const granularity = sheet.series?.granularity;
  if (!granularity) return null;
  let latest: string | undefined;
  for (let above = 1; above < row; above++) {
    const value = sheet.cells[`A${above}`];
    if (value === undefined || granularityOf(value) !== granularity) continue;
    const key = periodKey(value);
    if (latest === undefined || key > latest) latest = key;
  }
  return latest === undefined ? periodContaining(today, granularity) : nextPeriod(latest);
}
