import type { Workbook } from "@fumoca/storage";
import { Center, Text, useComputedColorScheme } from "@mantine/core";
import {
  type DockviewApi,
  DockviewReact,
  type IDockviewPanelProps,
  themeDark,
  themeLight,
} from "dockview-react";
import { createContext, useContext } from "react";
import type { WorkbookResults } from "./recalc";
import { type CellEdit, SheetGrid } from "./SheetGrid";

/**
 * The tabbed, tileable sheet area. Each open sheet is a dockview panel: sheets open as tabs, and a
 * tab can be dragged to the edge of another to tile them side by side.
 */

export interface SheetAreaContextValue {
  workbook: Workbook;
  results: WorkbookResults;
  onSelect: (sheetId: string, address: string) => void;
  /** Commits edits to a sheet; returns an error message if an edit was rejected. */
  onCommit: (sheetId: string, edits: CellEdit[]) => string | null;
  onCommitError: (message: string) => void;
}

/** Dockview panels are created by dockview, so they read the live workbook from context. */
export const SheetAreaContext = createContext<SheetAreaContextValue | null>(null);

interface SheetPanelParams {
  sheetId: string;
}

function SheetPanel({ params }: IDockviewPanelProps<SheetPanelParams>) {
  const context = useContext(SheetAreaContext);
  const sheet = context?.workbook.sheets.find((s) => s.id === params.sheetId);
  if (!context || !sheet) return null;
  return (
    <SheetGrid
      sheet={sheet}
      results={context.results.get(sheet.id)}
      onSelect={(address) => context.onSelect(sheet.id, address)}
      onCommit={(edits) => context.onCommit(sheet.id, edits)}
      onCommitError={context.onCommitError}
    />
  );
}

function Watermark() {
  return (
    <Center h="100%">
      <Text c="dimmed" size="sm">
        No sheet open. Choose one from the Sheets list.
      </Text>
    </Center>
  );
}

const COMPONENTS = { sheet: SheetPanel };

/** Opens a sheet as a tab, or brings its existing tab to the front. */
export function openSheet(api: DockviewApi, workbook: Workbook, sheetId: string): void {
  const existing = api.getPanel(sheetId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const sheet = workbook.sheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  api.addPanel<SheetPanelParams>({
    id: sheet.id,
    component: "sheet",
    title: sheet.name,
    params: { sheetId: sheet.id },
  });
}

/** Closes every tab and opens all of a workbook's sheets as tabs, with the first one active. */
export function showWorkbook(api: DockviewApi, workbook: Workbook): void {
  api.clear();
  for (const sheet of workbook.sheets) openSheet(api, workbook, sheet.id);
  const first = workbook.sheets[0];
  if (first) api.getPanel(first.id)?.api.setActive();
}

export interface SheetAreaProps {
  onReady: (api: DockviewApi) => void;
}

export function SheetArea({ onReady }: SheetAreaProps) {
  const colorScheme = useComputedColorScheme("light");
  return (
    <DockviewReact
      components={COMPONENTS}
      watermarkComponent={Watermark}
      theme={colorScheme === "dark" ? themeDark : themeLight}
      onReady={(event) => onReady(event.api)}
    />
  );
}
