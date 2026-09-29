import { formatReference, granularityOf } from "@fumoca/engine";
import { cellName, lastUsedRow, PERIOD_COLUMN, type Sheet, suggestPeriod } from "@fumoca/storage";
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
import {
  type CopiedCells,
  fillFromSource,
  pasteFromCopy,
  type RangeTarget,
  type ScreenRange,
  type SourceCell,
} from "./copyPaste";
import { FormulaInput } from "./FormulaInput";
import { moveReference, pointTarget } from "./pointing";
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
/** Row flag: on a series sheet, the row's time value is missing or of the wrong granularity. */
const INVALID_KEY = "~invalid";

interface CellMeta {
  kind: CellResult["kind"];
  root: boolean;
  message?: string;
  /** CSS background image: the cell's histogram, for uncertain cells. */
  background?: string;
}

/** Histogram fill colours: faint, so the text on top stays readable in both themes. */
const HISTOGRAM_COLORS = { light: "rgba(34, 139, 230, 0.18)", dark: "rgba(77, 171, 247, 0.22)" };

/**
 * An uncertain cell's histogram as an inline SVG data URI, stretched to fill the cell as its
 * background (SPECS.md §6.5). Each bin is a bar whose height is its normalized count.
 */
export function histogramBackground(bins: readonly number[], color: string): string {
  const bars = bins
    .map((height, i) =>
      height > 0 ? `M${i},100V${(100 - height * 100).toFixed(1)}H${i + 1}V100Z` : "",
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bins.length} 100" ` +
    `preserveAspectRatio="none"><path d="${bars}" fill="${color}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
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
  const invalidRow = model[INVALID_KEY] === true;
  // The cell's address, so dependency borders find it whatever rows a filter hides.
  const address = { "data-address": addressOf(prop, model as Row) };
  if (!meta) return invalidRow ? { ...address, class: classes.invalidRow ?? "" } : address;
  const names = [
    classes[meta.kind],
    meta.root ? classes.root : undefined,
    invalidRow ? classes.invalidRow : undefined,
  ].filter(Boolean);
  return {
    ...address,
    class: names.join(" "),
    ...(meta.message ? { title: meta.message } : {}),
    ...(meta.background
      ? {
          style: {
            backgroundImage: meta.background,
            backgroundSize: "100% 100%",
            backgroundRepeat: "no-repeat",
          },
        }
      : {}),
  };
}

const column = (letter: string, name: string, size = 120) => ({
  prop: letter,
  name,
  size,
  editor: "formula",
  cellProperties,
});

/** Standard sheets: columns A–Z. */
const COLUMNS = COLUMN_LETTERS.map((letter) => column(letter, letter));

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
  // Arrow Up commits like Enter, then moves up instead of down.
  const finishUp = async (input: HTMLInputElement) => {
    if (done.current) return;
    done.current = true;
    const grid = input.closest("revo-grid");
    save(text, true); // save without RevoGrid moving focus down
    close();
    const focused = await grid?.getFocused();
    if (!grid || !focused || focused.cell.y === 0) return;
    const above = { x: focused.cell.x, y: focused.cell.y - 1 }; // on-screen rows, so filter-aware
    await grid.setCellsFocus(above, above);
  };
  // Point mode with the arrow keys, as in Excel: where a reference can go, an arrow inserts the
  // cell next to the edited one, and further arrows move that reference.
  const pointWithArrow = (key: string): boolean => {
    const step = ARROW_STEPS[key];
    const target = pointTarget();
    if (!step || !target) return false;
    const from = target.pointed() ?? addressOf(column.prop, row);
    const moved = moveReference(from, step.dx, step.dy, {
      columns: COLUMN_COUNT,
      rows: ROW_COUNT,
    });
    return moved !== null && target.insert(moved);
  };
  return (
    <FormulaInput
      className={classes.editor}
      aria-label="Cell editor"
      autoFocus
      value={text}
      onChange={setText}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
        if (!modified && pointWithArrow(event.key)) {
          event.preventDefault();
          return;
        }
        // Otherwise Arrow Down commits as Enter does, moving to the cell below.
        if (event.key === "Enter" || event.key === "ArrowDown") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          void finishUp(event.currentTarget);
        } else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

const ARROW_STEPS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

const EDITORS = { formula: Editor(FormulaEditor) };

/**
 * What was last copied from any grid, so pasting it (on any sheet) pastes formulas rather than the
 * answers the clipboard holds. The cells behind the copy are looked up once the copy is made.
 */
let lastCopy: { shown: string[][]; cells: Promise<SourceCell[][]> } | null = null;

/** Grid elements by sheet id, so the formula bar can move focus back to the grid. */
const gridElements = new Map<string, HTMLRevoGridElement>();

/**
 * Moves focus to the cell below an address, as Enter does in Excel. While a filter hides rows,
 * this is the next *visible* row. RevoGrid focuses by on-screen (virtual) row index, so the
 * physical row is looked up among the visible rows.
 */
/**
 * Selects a cell, as the name box does when it jumps to one. The sheet's grid may still be
 * appearing (a sheet just opened), so this waits a little for it. A cell in a row a filter hides
 * can't be selected.
 */
export async function focusCell(sheetId: string, address: string): Promise<void> {
  const position = cellPosition(address);
  if (!position) return;
  let grid = gridElements.get(sheetId);
  for (let tries = 0; !grid && tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    grid = gridElements.get(sheetId);
  }
  if (!grid) return;
  const visible = (await grid.getVisibleSource()) as Row[];
  const y = visible.findIndex((row) => row[ROW_KEY] === position.y);
  if (y < 0) return;
  await grid.setCellsFocus({ x: position.x, y }, { x: position.x, y });
  // Focusing scrolls the cells but not the row numbers beside them; scrolling the grid to the row
  // moves both.
  await grid.scrollToRow(y);
}

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
  /** Series sheets: a value column's header was double-clicked (0 = the first value column). */
  onRenameColumn?: (index: number) => void;
  /** Cells to outline as dependencies of the selected cell: colour by address. */
  dependencies?: Map<string, string> | undefined;
}

/** One worksheet's grid. Cells show calculated answers; root cells are bold (SPECS.md §6.5). */
export function SheetGrid({
  sheet,
  results,
  onSelect,
  onCommit,
  onCommitError,
  onRenameColumn,
  dependencies,
}: SheetGridProps) {
  const colorScheme = useComputedColorScheme("light");
  const gridRef = useRef<HTMLRevoGridElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [filtered, setFiltered] = useState(false);

  // Dependency borders (SPECS.md §6.5): each cell the selected cell's formula references gets an
  // outline in its colour, the same colour as its name in the formula. A style rule per cell,
  // matched by address, so moving the selection doesn't re-render the grid's rows.
  const dependencyStyles = useMemo(() => {
    const scope = `[data-sheet="${CSS.escape(sheet.id)}"]`;
    return [...(dependencies ?? [])]
      .map(
        ([address, color]) =>
          `${scope} .rgCell[data-address="${address}"] { outline: 2px solid ${color}; outline-offset: -2px; }`,
      )
      .join("\n");
  }, [dependencies, sheet.id]);

  // Series sheets show only the time column and their value columns, headed by name (SPECS.md §5).
  const seriesColumns = sheet.series?.columns;
  const columns = useMemo(
    () =>
      seriesColumns
        ? [PERIOD_COLUMN, ...seriesColumns].map((name, i) =>
            column(COLUMN_LETTERS[i] ?? "A", name, i === 0 ? 110 : 120),
          )
        : COLUMNS,
    [seriesColumns],
  );

  // Double-clicking a value column's header renames it.
  const renameRef = useRef(onRenameColumn);
  renameRef.current = onRenameColumn;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !seriesColumns) return;
    const listener = (event: MouseEvent) => {
      const header = (event.target as Element | null)?.closest?.("revogr-header .rgHeaderCell");
      const index = Number(header?.getAttribute("data-rgcol"));
      if (header && index >= 1) renameRef.current?.(index - 1);
    };
    grid.addEventListener("dblclick", listener);
    return () => grid.removeEventListener("dblclick", listener);
  }, [seriesColumns]);

  // Point mode (SPECS.md §6.1): while a formula is being edited, in the formula bar or in a cell,
  // clicking a cell inserts its address instead of selecting it. The listener captures the press
  // before RevoGrid sees it, and preventing the default keeps focus in the editor.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // The press is handled at pointerdown; the mouse events that follow it are swallowed too, and
    // mousedown's default (focusing the grid) is prevented.
    let pointing = false;
    const onPointerDown = (event: PointerEvent) => {
      pointing = false;
      if (event.button !== 0) return;
      const cell = (event.target as Element | null)?.closest?.("revogr-data .rgCell[data-address]");
      const address = cell?.getAttribute("data-address");
      const target = pointTarget();
      if (!address || !target) return;
      // A named cell is written by its name, as in Excel; another cell on another sheet than the
      // formula's is written with its sheet: Inputs!B3.
      const name = cellName(sheetRef.current, address);
      const reference =
        name ?? (target.sheetId === sheet.id ? address : formatReference(sheet.name, address));
      if (!target.insert(reference)) return;
      pointing = true;
      event.stopPropagation();
    };
    const swallow = (event: Event) => {
      if (!pointing) return;
      event.stopPropagation();
      if (event.type === "mousedown") event.preventDefault();
      if (event.type === "click") pointing = false;
    };
    const swallowed = ["pointerup", "mousedown", "mouseup", "click"] as const;
    wrapper.addEventListener("pointerdown", onPointerDown, true);
    for (const type of swallowed) wrapper.addEventListener(type, swallow, true);
    return () => {
      wrapper.removeEventListener("pointerdown", onPointerDown, true);
      for (const type of swallowed) wrapper.removeEventListener(type, swallow, true);
    };
  }, [sheet.id, sheet.name]);

  // Row headers show the real row number, not the on-screen position, so they stay correct while
  // a filter hides rows. They turn blue while filtered, as in Excel.
  const rowHeaders = useMemo<RowHeaders>(
    () => ({
      prop: ROW_KEY,
      size: 50,
      cellTemplate: (_h: unknown, { model }: CellTemplateProp) =>
        String((model as Row)[ROW_KEY] + 1),
      cellProperties: ({ model }: CellTemplateProp) => {
        const names = [
          filtered ? classes.filteredRowHeader : undefined,
          model[INVALID_KEY] === true ? classes.invalidRow : undefined,
        ].filter(Boolean);
        return names.length > 0 ? { class: names.join(" ") } : undefined;
      },
    }),
    [filtered],
  );

  // The key handler is set up once per sheet; it reads the latest sheet and commit through refs.
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    gridElements.set(sheet.id, grid);

    const handleKeyDown = async (event: KeyboardEvent) => {
      // F2 opens the in-grid editor on the focused cell.
      if (event.key === "F2") {
        event.preventDefault();
        const focused = await grid.getFocused();
        if (focused?.column) await grid.setCellEdit(focused.cell.y, focused.column.prop);
        return;
      }
      // Ctrl+; on a series sheet fills the focused row's period: the latest period above plus
      // one, or the current period.
      if (event.key === ";" && (event.ctrlKey || event.metaKey) && sheetRef.current.series) {
        event.preventDefault();
        const focused = await grid.getFocused();
        const row = (focused?.model as Row | undefined)?.[ROW_KEY];
        if (row === undefined) return;
        const period = suggestPeriod(sheetRef.current, row + 1);
        if (period) commitRef.current([{ address: `A${row + 1}`, text: period }]);
      }
    };
    const listener = (event: KeyboardEvent) => void handleKeyDown(event);
    grid.addEventListener("keydown", listener);
    return () => {
      grid.removeEventListener("keydown", listener);
      if (gridElements.get(sheet.id) === grid) gridElements.delete(sheet.id);
    };
  }, [sheet.id]);

  const granularity = sheet.series?.granularity;
  const source = useMemo(() => {
    // Series sheets show their rows plus one empty row to type the next period into.
    const rowCount = granularity ? lastUsedRow(sheet.cells) + 1 : ROW_COUNT;
    const rows: Row[] = Array.from({ length: rowCount }, (_, i) => ({ [ROW_KEY]: i }));
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
          ...(result.kind === "uncertain"
            ? { background: histogramBackground(result.histogram, HISTOGRAM_COLORS[colorScheme]) }
            : {}),
        };
        row[metaKey(prop)] = meta;
      } else {
        // Not calculated yet: show the input until results arrive.
        row[prop] = formatCellInput(value);
      }
    }
    // Series sheets: every row with content needs a time value of the sheet's granularity
    // in column A (SPECS.md §5.2). Rows where it's missing or wrong show red.
    if (granularity) {
      const rowsWithContent = new Set<number>();
      for (const address of Object.keys(sheet.cells)) {
        const position = cellPosition(address);
        if (position) rowsWithContent.add(position.y);
      }
      for (const y of rowsWithContent) {
        const row = rows[y];
        if (row && granularityOf(sheet.cells[`A${y + 1}`]) !== granularity) row[INVALID_KEY] = true;
      }
    }
    return rows;
  }, [sheet.cells, granularity, results, colorScheme]);

  const commit = (edits: CellEdit[]) => {
    const error = onCommit(edits);
    if (error) onCommitError(error);
  };

  // Copy: remember the copied cells' inputs and positions (SPECS.md §6.1).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const listener = (event: Event) => {
      const { range, data } = (event as CustomEvent<{ range: ScreenRange; data: unknown[][] }>)
        .detail;
      if (!range) return;
      const shown = data.map((row) => row.map((value) => String(value ?? "")));
      const cells = grid.getVisibleSource().then((visible) =>
        (visible as Row[]).slice(range.y, range.y1 + 1).map((row) =>
          COLUMN_LETTERS.slice(range.x, range.x1 + 1).map((letter, j) => ({
            text: formatCellInput(sheetRef.current.cells[addressOf(letter, row)]),
            x: range.x + j,
            y: row[ROW_KEY],
          })),
        ),
      );
      lastCopy = { shown, cells };
    };
    grid.addEventListener("clipboardrangecopy", listener);
    return () => grid.removeEventListener("clipboardrangecopy", listener);
  }, []);

  /**
   * Range edits: paste, the fill handle, and clearing a selection. Pasting what was copied from a
   * grid, and filling, write the source cells' inputs with formulas shifted as in Excel.
   */
  const applyRangeEdit = async (detail: {
    data: Record<string, Record<string, unknown>>;
    models: Record<string, unknown>;
    oldRange?: ScreenRange | null;
    newRange?: ScreenRange | null;
  }) => {
    const { data, models, oldRange, newRange } = detail;
    const targets: (RangeTarget & { address: string })[] = [];
    for (const [rowIndex, changes] of Object.entries(data)) {
      const row = models[Number(rowIndex)] as Row | undefined;
      if (!row) continue;
      for (const [prop, value] of Object.entries(changes)) {
        const x = COLUMN_LETTERS.indexOf(prop);
        if (x < 0) continue;
        targets.push({
          address: addressOf(prop, row),
          screenX: x,
          screenY: Number(rowIndex),
          x,
          y: row[ROW_KEY],
          value: String(value ?? ""),
        });
      }
    }
    if (targets.length === 0) return;
    let texts: string[] | null = null;
    const filling =
      oldRange &&
      newRange &&
      (oldRange.x !== newRange.x ||
        oldRange.y !== newRange.y ||
        oldRange.x1 !== newRange.x1 ||
        oldRange.y1 !== newRange.y1);
    if (filling) {
      const visible = ((await gridRef.current?.getVisibleSource()) ?? []) as Row[];
      texts = fillFromSource(targets, oldRange, newRange, (screenX, screenY) => {
        const row = visible[screenY];
        const letter = COLUMN_LETTERS[screenX];
        if (!row || !letter) return undefined;
        const text = formatCellInput(sheetRef.current.cells[addressOf(letter, row)]);
        return { text, x: screenX, y: row[ROW_KEY] };
      });
    } else if (newRange && lastCopy) {
      const copied: CopiedCells = { shown: lastCopy.shown, cells: await lastCopy.cells };
      texts = pasteFromCopy(copied, targets, newRange);
    }
    commit(
      targets.map((target, i) => ({ address: target.address, text: texts?.[i] ?? target.value })),
    );
  };

  return (
    <div ref={wrapperRef} className={classes.wrapper} data-sheet={sheet.id}>
      {dependencyStyles && <style>{dependencyStyles}</style>}
      <RevoGrid
        ref={gridRef}
        columns={columns}
        source={source}
        editors={EDITORS}
        range
        resize
        rowHeaders={sheet.series ? false : rowHeaders}
        theme={colorScheme === "dark" ? "darkCompact" : "compact"}
        onBeforefilterapply={(event) => {
          setFiltered(Object.keys(event.detail.collection ?? {}).length > 0);
        }}
        onAfterfocus={(event) => {
          const { model, column } = event.detail;
          if (!model || !column) return;
          const address = addressOf(column.prop, model as Row);
          onSelect(address);
        }}
        onBeforeedit={(event) => {
          // The workbook owns cell contents: apply the edit there and let the grid re-render.
          event.preventDefault();
          const { model, prop, val } = event.detail;
          commit([{ address: addressOf(prop, model as Row), text: String(val ?? "") }]);
        }}
        onBeforerangeedit={(event) => {
          // The workbook owns cell contents: apply the edit there and let the grid re-render.
          event.preventDefault();
          void applyRangeEdit(event.detail);
        }}
        style={{ height: "100%" }}
      />
    </div>
  );
}
