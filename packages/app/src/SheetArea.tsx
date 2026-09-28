import type { Scenario, SeriesSettings, Workbook } from "@fumoca/storage";
import { Box, Center, Stack, Text, useComputedColorScheme } from "@mantine/core";
import {
  type DockviewApi,
  DockviewReact,
  type IDockviewPanelProps,
  themeDark,
  themeLight,
} from "dockview-react";
import { createContext, useContext, useState } from "react";
import { RenameColumnModal } from "./RenameColumnModal";
import type { WorkbookResults } from "./recalc";
import { ScenarioPanel } from "./ScenarioPanel";
import { ScenarioControls, ScenarioResultsView, type ScenarioRunState } from "./ScenarioResults";
import { SeriesIssuesBar } from "./SeriesIssuesBar";
import { SeriesToolbar } from "./SeriesToolbar";
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
  onSeriesSettingsChange: (sheetId: string, settings: SeriesSettings) => void;
  onAddSeriesColumn: (sheetId: string) => void;
  onRenameSeriesColumn: (sheetId: string, index: number, name: string) => void;
  onSortSeries: (sheetId: string) => void;
  /** Saves changes to a scenario's definition. */
  onScenarioChange: (scenario: Scenario) => void;
  /** Each scenario's latest run, by scenario id. */
  scenarioRuns: Map<string, ScenarioRunState>;
  onRunScenario: (scenarioId: string) => void;
  onStopScenario: () => void;
  /** The selected cell's dependencies to outline, by sheet id: colour by address. */
  dependencies: Map<string, Map<string, string>>;
}

/** Dockview panels are created by dockview, so they read the live workbook from context. */
export const SheetAreaContext = createContext<SheetAreaContextValue | null>(null);

interface SheetPanelParams {
  sheetId: string;
}

function SheetPanel({ params }: IDockviewPanelProps<SheetPanelParams>) {
  const context = useContext(SheetAreaContext);
  const sheet = context?.workbook.sheets.find((s) => s.id === params.sheetId);
  const [renaming, setRenaming] = useState<number | null>(null);
  if (!context || !sheet) return null;
  const grid = (
    <SheetGrid
      sheet={sheet}
      results={context.results.get(sheet.id)}
      onSelect={(address) => context.onSelect(sheet.id, address)}
      onCommit={(edits) => context.onCommit(sheet.id, edits)}
      onCommitError={context.onCommitError}
      onRenameColumn={setRenaming}
      dependencies={context.dependencies.get(sheet.id)}
    />
  );
  if (!sheet.series) return grid;
  return (
    <Stack gap={0} h="100%">
      <SeriesToolbar
        settings={sheet.series}
        onChange={(settings) => context.onSeriesSettingsChange(sheet.id, settings)}
        onAddColumn={() => context.onAddSeriesColumn(sheet.id)}
      />
      <RenameColumnModal
        settings={sheet.series}
        index={renaming}
        onRename={(index, name) => context.onRenameSeriesColumn(sheet.id, index, name)}
        onClose={() => setRenaming(null)}
      />
      <Box style={{ flex: 1, minHeight: 0 }}>{grid}</Box>
      <SeriesIssuesBar sheet={sheet} onSort={() => context.onSortSeries(sheet.id)} />
    </Stack>
  );
}

function Watermark() {
  return (
    <Center h="100%">
      <Text c="dimmed" size="sm">
        Nothing open. Choose a sheet or a scenario from the side panel.
      </Text>
    </Center>
  );
}

interface ScenarioPanelParams {
  scenarioId: string;
}

function ScenarioTab({ params }: IDockviewPanelProps<ScenarioPanelParams>) {
  const context = useContext(SheetAreaContext);
  const scenario = context?.workbook.scenarios?.find((s) => s.id === params.scenarioId);
  if (!context || !scenario) return null;
  const run = context.scenarioRuns.get(scenario.id);
  return (
    <ScenarioPanel
      scenario={scenario}
      workbook={context.workbook}
      onChange={context.onScenarioChange}
      controls={
        <ScenarioControls
          scenario={scenario}
          workbook={context.workbook}
          run={run}
          onRun={() => context.onRunScenario(scenario.id)}
          onStop={context.onStopScenario}
        />
      }
      results={
        run?.results ? (
          <ScenarioResultsView workbook={context.workbook} run={run} results={run.results} />
        ) : undefined
      }
    />
  );
}

const COMPONENTS = { sheet: SheetPanel, scenario: ScenarioTab };

/** Opens a scenario as a tab, or brings its existing tab to the front (SPECS.md §7). */
export function openScenario(api: DockviewApi, scenario: Scenario): void {
  const existing = api.getPanel(scenario.id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  // Beside the sheets, so cells can be clicked to pick them; with other scenarios, if any are open.
  const other = api.panels.find((panel) => panel.api.component === "scenario");
  api.addPanel<ScenarioPanelParams>({
    id: scenario.id,
    component: "scenario",
    title: scenario.name,
    params: { scenarioId: scenario.id },
    position: other ? { referencePanel: other.id } : { direction: "right" },
  });
}

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
