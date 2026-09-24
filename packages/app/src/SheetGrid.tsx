import type { Sheet } from "@fumoca/storage";
import { useComputedColorScheme } from "@mantine/core";
import {
  type BeforeRangeSaveDataDetails,
  type BeforeSaveDataDetails,
  RevoGrid,
} from "@revolist/react-datagrid";
import { useMemo } from "react";

const COLUMN_COUNT = 26;
const ROW_COUNT = 200;
const COLUMN_LETTERS = Array.from({ length: COLUMN_COUNT }, (_, i) => String.fromCharCode(65 + i));
const COLUMNS = COLUMN_LETTERS.map((letter) => ({ prop: letter, name: letter, size: 120 }));

/** Row property holding the row's 0-based index, so edits map to addresses reliably. */
const ROW_KEY = "_row";

type Row = Record<string, unknown> & { [ROW_KEY]: number };

export interface CellChange {
  address: string;
  value: number | string;
}

/** Converts what the user typed into a cell value: a number where possible, otherwise text. */
export function parseCellInput(input: unknown): number | string {
  if (input === null || input === undefined) return "";
  if (typeof input === "number") return input;
  const text = String(input);
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const number = Number(trimmed);
  return Number.isNaN(number) || trimmed.startsWith("=") ? text : number;
}

/** A RevoGrid `afteredit` detail: a single cell edit, or a range edit (paste, autofill). */
type EditDetail = BeforeRangeSaveDataDetails | BeforeSaveDataDetails;

/** Extracts the changed cells from a RevoGrid edit. */
function changesFromEdit(detail: EditDetail): CellChange[] {
  const addressOf = (prop: unknown, model: Row | undefined, fallbackRow: number): string =>
    `${String(prop)}${(model?.[ROW_KEY] ?? fallbackRow) + 1}`;

  if ("models" in detail) {
    const changes: CellChange[] = [];
    for (const [rowIndex, row] of Object.entries(detail.data)) {
      const model = detail.models[Number(rowIndex)] as Row | undefined;
      for (const [prop, value] of Object.entries(row)) {
        if (COLUMN_LETTERS.includes(prop)) {
          changes.push({
            address: addressOf(prop, model, Number(rowIndex)),
            value: parseCellInput(value),
          });
        }
      }
    }
    return changes;
  }
  return [
    {
      address: addressOf(detail.prop, detail.model as Row, detail.rowIndex),
      value: parseCellInput(detail.val),
    },
  ];
}

export interface SheetGridProps {
  sheet: Sheet;
  onCellsChange: (changes: CellChange[]) => void;
}

/**
 * One worksheet's grid. Cells currently show their contents as entered; calculated values and
 * in-cell histograms (SPECS.md §6.5) come later.
 */
export function SheetGrid({ sheet, onCellsChange }: SheetGridProps) {
  const colorScheme = useComputedColorScheme("light");

  const source = useMemo(() => {
    const rows: Row[] = Array.from({ length: ROW_COUNT }, (_, i) => ({ [ROW_KEY]: i }));
    for (const [address, value] of Object.entries(sheet.cells)) {
      const match = /^([A-Z]+)([0-9]+)$/.exec(address);
      const row = match ? rows[Number(match[2]) - 1] : undefined;
      if (match?.[1] && row) row[match[1]] = value;
    }
    return rows;
  }, [sheet.cells]);

  return (
    <RevoGrid
      columns={COLUMNS}
      source={source}
      range
      resize
      rowHeaders
      theme={colorScheme === "dark" ? "darkCompact" : "compact"}
      onAfteredit={(event) => {
        const changes = changesFromEdit(event.detail as EditDetail);
        if (changes.length > 0) onCellsChange(changes);
      }}
      style={{ height: "100%" }}
    />
  );
}
