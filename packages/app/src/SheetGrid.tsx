import type { Sheet } from "@fumoca/storage";
import { useComputedColorScheme } from "@mantine/core";
import {
  type CellTemplateProp,
  Editor,
  type EditorType,
  RevoGrid,
  type RowHeaders,
} from "@revolist/react-datagrid";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCellInput } from "./cellInput";
import { type CellResult, formatResult } from "./recalc";
import classes from "./SheetGrid.module.css";

const COLUMN_COUNT = 26;
const ROW_COUNT = 200;
const COLUMN_LETTERS = Array.from({ length: COLUMN_COUNT }, (_, i) => String.fromCharCode(65 + i));

/**
 * Each grid row holds, per column letter, the text the cell shows (the answer), plus hidden
 * properties with the raw input (for editors) and display metadata (for styling). RevoGrid renders
 * editors in their own React root, so they read the raw input from the row rather than context.
 */
const ROW_KEY = "_row";
const rawKey = (prop: string) => `${prop}~raw`;
const metaKey = (prop: string) => `${prop}~meta`;

interface CellMeta {
  kind: CellResult["kind"];
  root: boolean;
  message?: string;
}

type Row = Record<string, unknown> & { [ROW_KEY]: number };

export interface CellEdit {
  address: string;
  text: string;
}

const addressOf = (prop: unknown, row: Row) => `${String(prop)}${row[ROW_KEY] + 1}`;

/** Parses an address like "B7" into grid coordinates. */
export function cellPosition(address: string): { x: number; y: number } | null {
  const match = /^([A-Z])([0-9]+)$/.exec(address);
  if (!match?.[1] || !match[2]) return null;
  return { x: match[1].charCodeAt(0) - 65, y: Number(match[2]) - 1 };
}

function cellProperties({ model, prop }: CellTemplateProp) {
  const meta = model[metaKey(String(prop))] as CellMeta | undefined;
  if (!meta) return;
  const names = [classes[meta.kind], meta.root ? classes.root : undefined].filter(Boolean);
  return meta.message
    ? { class: names.join(" "), title: meta.message }
    : { class: names.join(" ") };
}

const COLUMNS = COLUMN_LETTERS.map((letter) => ({
  prop: letter,
  name: letter,
  size: 120,
  editor: "formula",
  cellProperties,
}));

/**
 * The in-grid editor (F2, double-click, or typing). It edits the cell's raw input, the formula or
 * value, not the answer the cell shows.
 */
function FormulaEditor({ column, save, close, val }: EditorType) {
  const row = column.model as Row;
  // Editing started by typing a character replaces the content; otherwise edit what's there.
  const initial =
    typeof val === "string" && val.length === 1
      ? val
      : String(row[rawKey(String(column.prop))] ?? "");
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) save(text);
    else close();
  };
  return (
    <input
      className={classes.editor}
      aria-label="Cell editor"
      // biome-ignore lint/a11y/noAutofocus: the editor opens because the user asked to edit
      autoFocus
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

const EDITORS = { formula: Editor(FormulaEditor) };

/** Grid elements by sheet id, so the formula bar can move focus back to the grid. */
const gridElements = new Map<string, HTMLRevoGridElement>();

/**
 * Moves focus to the cell below an address, as Enter does in Excel. While a filter hides rows,
 * this is the next *visible* row. RevoGrid focuses by on-screen (virtual) row index, so the
 * physical row is looked up among the visible rows.
 */
export async function focusCellBelow(sheetId: string, address: string): Promise<void> {
  const grid = gridElements.get(sheetId);
  const position = cellPosition(address);
  if (!grid || !position) return;
  const visible = (await grid.getVisibleSource()) as Row[];
  const y = visible.findIndex((row) => row[ROW_KEY] > position.y);
  if (y < 0) return;
  await grid.setCellsFocus({ x: position.x, y }, { x: position.x, y });
}

export interface SheetGridProps {
  sheet: Sheet;
  results: Map<string, CellResult> | undefined;
  onSelect: (address: string) => void;
  /** Commits edits; returns an error message if an edit was rejected. */
  onCommit: (edits: CellEdit[]) => string | null;
  onCommitError: (message: string) => void;
}

/** One worksheet's grid. Cells show calculated answers; root cells are bold (SPECS.md §6.5). */
export function SheetGrid({ sheet, results, onSelect, onCommit, onCommitError }: SheetGridProps) {
  const colorScheme = useComputedColorScheme("light");
  const gridRef = useRef<HTMLRevoGridElement>(null);
  const [filtered, setFiltered] = useState(false);

  // Row headers show the real row number, not the on-screen position, so they stay correct while
  // a filter hides rows. They turn blue while filtered, as in Excel.
  const rowHeaders = useMemo<RowHeaders>(
    () => ({
      prop: ROW_KEY,
      size: 50,
      cellTemplate: (_h: unknown, { model }: CellTemplateProp) =>
        String((model as Row)[ROW_KEY] + 1),
      cellProperties: () => (filtered ? { class: classes.filteredRowHeader ?? "" } : undefined),
    }),
    [filtered],
  );

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    gridElements.set(sheet.id, grid);

    // F2 opens the in-grid editor on the focused cell.
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      event.preventDefault();
      const focused = await grid.getFocused();
      if (focused?.column) await grid.setCellEdit(focused.cell.y, focused.column.prop);
    };
    const listener = (event: KeyboardEvent) => void handleKeyDown(event);
    grid.addEventListener("keydown", listener);
    return () => {
      grid.removeEventListener("keydown", listener);
      if (gridElements.get(sheet.id) === grid) gridElements.delete(sheet.id);
    };
  }, [sheet.id]);

  const source = useMemo(() => {
    const rows: Row[] = Array.from({ length: ROW_COUNT }, (_, i) => ({ [ROW_KEY]: i }));
    for (const [address, value] of Object.entries(sheet.cells)) {
      const position = cellPosition(address);
      const row = position ? rows[position.y] : undefined;
      const prop = COLUMN_LETTERS[position?.x ?? -1];
      if (!row || !prop) continue;
      const result = results?.get(address);
      row[rawKey(prop)] = formatCellInput(value);
      if (result) {
        row[prop] = formatResult(result);
        const meta: CellMeta = {
          kind: result.kind,
          root: result.kind !== "text" && result.root,
          ...(result.kind === "error" ? { message: result.message } : {}),
        };
        row[metaKey(prop)] = meta;
      } else {
        // Not calculated yet: show the input until results arrive.
        row[prop] = formatCellInput(value);
      }
    }
    return rows;
  }, [sheet.cells, results]);

  const commit = (edits: CellEdit[]) => {
    const error = onCommit(edits);
    if (error) onCommitError(error);
  };

  return (
    <div className={classes.wrapper}>
      <RevoGrid
        ref={gridRef}
        columns={COLUMNS}
        source={source}
        editors={EDITORS}
        range
        resize
        rowHeaders={rowHeaders}
        theme={colorScheme === "dark" ? "darkCompact" : "compact"}
        onBeforefilterapply={(event) => {
          setFiltered(Object.keys(event.detail.collection ?? {}).length > 0);
        }}
        onAfterfocus={(event) => {
          const { model, column } = event.detail;
          if (model && column) onSelect(addressOf(column.prop, model as Row));
        }}
        onBeforeedit={(event) => {
          // The workbook owns cell contents: apply the edit there and let the grid re-render.
          event.preventDefault();
          const { model, prop, val } = event.detail;
          commit([{ address: addressOf(prop, model as Row), text: String(val ?? "") }]);
        }}
        onBeforerangeedit={(event) => {
          // Range edits: paste, autofill and clearing a selection.
          event.preventDefault();
          const { data, models } = event.detail;
          const edits: CellEdit[] = [];
          for (const [rowIndex, changes] of Object.entries(data)) {
            const row = models[Number(rowIndex)] as Row | undefined;
            if (!row) continue;
            for (const [prop, value] of Object.entries(changes)) {
              if (COLUMN_LETTERS.includes(prop)) {
                edits.push({ address: addressOf(prop, row), text: String(value ?? "") });
              }
            }
          }
          if (edits.length > 0) commit(edits);
        }}
        style={{ height: "100%" }}
      />
    </div>
  );
}
