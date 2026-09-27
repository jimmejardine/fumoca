import { granularityOf, normalizePeriod } from "@fumoca/engine";
import {
  addSeriesColumn,
  addSheet,
  createSeriesSheet,
  createWorkbook,
  FILE_EXTENSION,
  hasNoPeriods,
  nextSheetName,
  parseWorkbook,
  renameSeriesColumn,
  type SeriesSettings,
  serializeWorkbook,
  setCell,
  setSeriesSettings,
  sortSeriesSheet,
  suggestPeriod,
  type Workbook,
} from "@fumoca/storage";
import { AppShell, Box, Divider, Text, useComputedColorScheme } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatCellInput, parseCellInput } from "./cellInput";
import { dependencyHighlights } from "./dependencyColors";
import { EngineClient } from "./engine/client";
import {
  DEFAULT_SETTINGS,
  type EngineSettings,
  loadSettings,
  saveSettings,
} from "./engineSettings";
import { FormulaBar } from "./FormulaBar";
import { openTextFile, saveTextFile, type WorkbookFile } from "./files";
import { MenuBar } from "./MenuBar";
import { currentDraft, subscribeDraft } from "./pointing";
import type { Recalculation, WorkbookResults } from "./recalc";
import { openSheet, SheetArea, SheetAreaContext, showWorkbook } from "./SheetArea";
import { type CellEdit, focusCellBelow } from "./SheetGrid";
import { SheetList } from "./SheetList";
import { Toolbar } from "./Toolbar";
import { createTestWorkbook } from "./testModel";

// Menu bar (36) + divider + toolbar (40) + divider + formula bar (38).
const HEADER_HEIGHT = 116;

/** Fixed seed, so recalculating the same model always gives the same results. */
const SEED = 1;
/** How long after a cell edit the recalculation waits, so a burst of edits runs once. */
const EDIT_DEBOUNCE_MS = 500;

/** The single open model (SPECS.md §2), where it was loaded from, and whether it has changed. */
interface Document {
  workbook: Workbook;
  file: WorkbookFile | null;
  title: string;
  dirty: boolean;
}

const untitled = (workbook: Workbook, title = "Untitled"): Document => ({
  workbook,
  file: null,
  title,
  dirty: false,
});

function showError(title: string, error: unknown): void {
  console.error(`${title}:`, error);
  notifications.show({
    color: "red",
    title,
    message: error instanceof Error ? error.message : String(error),
  });
}

const runs = (count: number) => count.toLocaleString("en-US");

/**
 * The status line for a recalculation: progress while it runs (`GPU 350,000 / 1,000,000`), then
 * the totals, and whether the CPU and GPU agree (SPECS.md §6.7), with detail for the tooltip.
 */
function describeStatus(
  update: Recalculation,
  workbook: Workbook,
  primaryIsGpu: boolean,
): { status: string; detail: string | undefined } {
  const { primary, secondary } = update.progress;
  const gpu = primaryIsGpu ? primary : undefined;
  const cpu = primaryIsGpu ? secondary : primary;
  const engines = [
    gpu ? { name: "GPU", ...gpu } : undefined,
    cpu ? { name: "CPU", ...cpu } : undefined,
  ].filter((e) => e !== undefined);

  if (!update.complete) {
    const progress = engines.map((e) => `${e.name} ${runs(e.done)} / ${runs(e.total)}`).join(" · ");
    const differing = update.comparison?.differing.length ?? 0;
    const agreement = !update.comparison ? "" : differing > 0 ? " · differ" : " · agree so far";
    return {
      status: `${progress}${agreement}`,
      detail: "Calculating: results sharpen as batches arrive",
    };
  }
  if (engines.length === 1) {
    const [only] = engines;
    return { status: `${only?.name} · ${runs(only?.total ?? 0)} runs`, detail: undefined };
  }
  const both = `GPU ${runs(gpu?.total ?? 0)} + CPU ${runs(cpu?.total ?? 0)}`;
  const differing = update.comparison?.differing ?? [];
  if (differing.length === 0) {
    return {
      status: `${both} · agree`,
      detail: `CPU and GPU agree over the first ${runs(update.comparison?.compared ?? 0)} runs`,
    };
  }
  const names = new Map(workbook.sheets.map((sheet) => [sheet.id, sheet.name]));
  const cells = differing.map((d) => `${names.get(d.sheetId)}!${d.address}`).join(", ");
  return {
    status: `${both} · ${differing.length} ${differing.length === 1 ? "cell differs" : "cells differ"}`,
    detail: `CPU and GPU differ in: ${cells}`,
  };
}

export function App() {
  const [doc, setDoc] = useState<Document>(() => untitled(createWorkbook()));
  const [settings, setSettings] = useState<EngineSettings>(() => loadSettings());
  const [engine, setEngine] = useState<EngineClient | null>(null);
  // undefined while the engine worker starts; then whether WebGPU is available to it.
  const [gpuAvailable, setGpuAvailable] = useState<boolean | undefined>(undefined);
  const [results, setResults] = useState<WorkbookResults>(new Map());
  const [status, setStatus] = useState("Starting…");
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Map<string, string>>(new Map());
  const apiRef = useRef<DockviewApi | null>(null);
  const docRef = useRef(doc);
  // Workbooks produced by cell edits: their recalculation is debounced (SPECS.md §6.3).
  const editedWorkbooks = useRef(new WeakSet<Workbook>());
  docRef.current = doc;

  useEffect(() => {
    document.title = `${doc.title}${doc.dirty ? " •" : ""} — fumoca`;
  }, [doc.title, doc.dirty]);

  // The engine runs in its own worker for the whole session (SPECS.md §6.4), so the page stays
  // responsive while it calculates.
  useEffect(() => {
    const client = new EngineClient();
    setEngine(client);
    let disposed = false;
    void client.ready.then(({ gpuAvailable: available }) => {
      if (!disposed) setGpuAvailable(available);
    });
    return () => {
      disposed = true;
      client.dispose();
    };
  }, []);

  // What actually runs: without WebGPU the GPU is off, and the CPU must run (SPECS.md §6.7).
  const effective = useMemo<EngineSettings | null>(() => {
    if (gpuAvailable === undefined) return null;
    if (gpuAvailable) return settings;
    return {
      gpuIterations: 0,
      cpuIterations: settings.cpuIterations || DEFAULT_SETTINGS.cpuIterations,
    };
  }, [gpuAvailable, settings]);

  // Recalculate whenever the model or settings change. The run goes in batches, and the grid
  // updates as they arrive (SPECS.md §6.3); a newer run cancels the one before.
  useEffect(() => {
    if (!engine || !effective) return;
    setStatus("Calculating…");
    setStatusDetail(undefined);
    const workbook = doc.workbook;
    let run: { cancel: () => void } | undefined;
    const start = () => {
      editedWorkbooks.current.delete(workbook);
      run = engine.run(
        workbook,
        effective,
        SEED,
        ({ recalculation, primaryIsGpu }) => {
          setResults(recalculation.results);
          const { status: text, detail } = describeStatus(recalculation, workbook, primaryIsGpu);
          setStatus(text);
          setStatusDetail(detail);
        },
        (message) => {
          setStatus("Calculation failed");
          showError("Calculation failed", new Error(message));
        },
      );
    };
    // After a cell edit, wait for a pause in typing; a newer edit restarts the wait. Anything else
    // (loading a model, changing settings) recalculates at once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (editedWorkbooks.current.has(workbook)) timer = setTimeout(start, EDIT_DEBOUNCE_MS);
    else start();
    return () => {
      clearTimeout(timer);
      run?.cancel();
    };
  }, [doc.workbook, effective, engine]);

  const handleApplySettings = useCallback((next: EngineSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  /** Replaces the open model, asking first if there are unsaved changes. */
  const replaceDocument = useCallback((next: () => Document | Promise<Document | null>) => {
    const replace = async () => {
      try {
        const replacement = await next();
        if (!replacement) return;
        setDoc(replacement);
        setSelections(new Map());
        if (apiRef.current) showWorkbook(apiRef.current, replacement.workbook);
      } catch (error) {
        showError("Couldn't load the model", error);
      }
    };
    if (!docRef.current.dirty) {
      void replace();
      return;
    }
    modals.openConfirmModal({
      title: "Discard unsaved changes?",
      children: <Text size="sm">The current model has changes that haven't been saved.</Text>,
      labels: { confirm: "Discard changes", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => void replace(),
    });
  }, []);

  const handleNew = useCallback(
    () => replaceDocument(() => untitled(createWorkbook())),
    [replaceDocument],
  );

  const handleLoadTestModel = useCallback(
    () => replaceDocument(() => untitled(createTestWorkbook(), "Test model")),
    [replaceDocument],
  );

  const handleLoad = useCallback(
    () =>
      replaceDocument(async () => {
        const opened = await openTextFile();
        if (!opened) return null;
        return {
          workbook: parseWorkbook(opened.text),
          file: opened.file,
          title: opened.file.name,
          dirty: false,
        };
      }),
    [replaceDocument],
  );

  const handleSave = useCallback(async () => {
    const current = docRef.current;
    try {
      const suggestedName = current.file?.name ?? `${current.title}${FILE_EXTENSION}`;
      const file = await saveTextFile(
        serializeWorkbook(current.workbook),
        current.file,
        suggestedName,
      );
      if (!file) return;
      setDoc((d) => ({ ...d, file, title: file.name, dirty: d.workbook !== current.workbook }));
    } catch (error) {
      showError("Couldn't save the model", error);
    }
  }, []);

  /**
   * Commits edits to a sheet. Unchanged cells are ignored. A formula with a syntax error is
   * committed as typed, so it can be fixed rather than retyped; the cell shows #ERROR! with the
   * reason in its tooltip.
   */
  const handleCommit = useCallback((sheetId: string, typed: CellEdit[]): string | null => {
    // In a series sheet's time column, loosely typed periods are written properly (2026-7 →
    // 2026-07), so they match the sheet's granularity and sort correctly.
    const isSeries = docRef.current.workbook.sheets.find((s) => s.id === sheetId)?.series;
    const edits = isSeries
      ? typed.map((edit) =>
          /^A[0-9]+$/.test(edit.address) ? { ...edit, text: normalizePeriod(edit.text) } : edit,
        )
      : typed;
    const sheet = docRef.current.workbook.sheets.find((s) => s.id === sheetId);
    const changed = edits.filter(({ address, text }) => {
      const previous = sheet?.cells[address];
      const next = parseCellInput(text);
      return next === "" ? previous !== undefined : previous !== next;
    });
    if (changed.length === 0) return null;
    setDoc((d) => {
      const before = d.workbook.sheets.find((s) => s.id === sheetId);
      let workbook = changed.reduce(
        (wb, { address, text }) => setCell(wb, sheetId, address, parseCellInput(text)),
        d.workbook,
      );
      // The first period typed into an empty series sheet sets its granularity.
      if (before?.series && hasNoPeriods(before)) {
        const first = changed.find(({ address }) => /^A[0-9]+$/.test(address));
        const granularity = first ? granularityOf(parseCellInput(first.text)) : null;
        if (granularity && granularity !== before.series.granularity) {
          workbook = setSeriesSettings(workbook, sheetId, { ...before.series, granularity });
        }
      }
      editedWorkbooks.current.add(workbook);
      return { ...d, workbook, dirty: true };
    });
    // Show what was typed straight away: the edited cells drop their stale results (the grid then
    // shows their input) until the new run reports.
    setResults((current) => {
      const sheetResults = current.get(sheetId);
      if (!sheetResults) return current;
      const next = new Map(current);
      const trimmed = new Map(sheetResults);
      for (const { address } of changed) trimmed.delete(address);
      next.set(sheetId, trimmed);
      return next;
    });
    return null;
  }, []);

  /** Adds a sheet to the model and opens it as a tab. */
  const addAndOpen = useCallback((create: (workbook: Workbook) => ReturnType<typeof addSheet>) => {
    const { workbook, sheet } = create(docRef.current.workbook);
    setDoc((d) => ({ ...d, workbook, dirty: true }));
    if (apiRef.current) openSheet(apiRef.current, workbook, sheet.id);
  }, []);

  const handleNewSheet = useCallback(() => addAndOpen((wb) => addSheet(wb)), [addAndOpen]);

  const handleNewSeriesSheet = useCallback(
    () => addAndOpen((wb) => addSheet(wb, createSeriesSheet(nextSheetName(wb, "Series")))),
    [addAndOpen],
  );

  const handleSeriesSettingsChange = useCallback((sheetId: string, series: SeriesSettings) => {
    setDoc((d) => ({
      ...d,
      workbook: setSeriesSettings(d.workbook, sheetId, series),
      dirty: true,
    }));
  }, []);

  const handleSortSeries = useCallback((sheetId: string) => {
    setDoc((d) => ({ ...d, workbook: sortSeriesSheet(d.workbook, sheetId), dirty: true }));
  }, []);

  const handleAddSeriesColumn = useCallback((sheetId: string) => {
    setDoc((d) => ({ ...d, workbook: addSeriesColumn(d.workbook, sheetId), dirty: true }));
  }, []);

  const handleRenameSeriesColumn = useCallback((sheetId: string, index: number, name: string) => {
    setDoc((d) => ({
      ...d,
      workbook: renameSeriesColumn(d.workbook, sheetId, index, name),
      dirty: true,
    }));
  }, []);

  const handleSelect = useCallback((sheetId: string, address: string) => {
    setSelections((current) => new Map(current).set(sheetId, address));
  }, []);

  const handleCommitError = useCallback((message: string) => {
    console.error("The formula has a syntax error:", message);
    notifications.show({ color: "red", title: "The formula has a syntax error", message });
  }, []);

  const handleReady = useCallback((api: DockviewApi) => {
    apiRef.current = api;
    api.onDidActivePanelChange((event) => setActiveSheetId(event.panel?.id ?? null));
    showWorkbook(api, docRef.current.workbook);
  }, []);

  const handleOpenSheet = useCallback((sheetId: string) => {
    if (apiRef.current) openSheet(apiRef.current, docRef.current.workbook, sheetId);
  }, []);

  // The dependencies of the formula being edited, or else of the selected cell, outlined in every
  // open sheet they're on (SPECS.md §6.5).
  const colorScheme = useComputedColorScheme("light");
  const draft = useSyncExternalStore(subscribeDraft, currentDraft);
  const selectedInActive = activeSheetId ? selections.get(activeSheetId) : undefined;
  const dependencies = useMemo(() => {
    if (draft) return dependencyHighlights(doc.workbook, draft.sheetId, draft.text, colorScheme);
    const sheet = doc.workbook.sheets.find((s) => s.id === activeSheetId);
    return sheet && selectedInActive
      ? dependencyHighlights(doc.workbook, sheet.id, sheet.cells[selectedInActive], colorScheme)
      : new Map<string, Map<string, string>>();
  }, [doc.workbook, activeSheetId, selectedInActive, colorScheme, draft]);

  const context = useMemo(
    () => ({
      workbook: doc.workbook,
      results,
      onSelect: handleSelect,
      onCommit: handleCommit,
      onCommitError: handleCommitError,
      onSeriesSettingsChange: handleSeriesSettingsChange,
      onAddSeriesColumn: handleAddSeriesColumn,
      onRenameSeriesColumn: handleRenameSeriesColumn,
      onSortSeries: handleSortSeries,
      dependencies,
    }),
    [
      dependencies,
      doc.workbook,
      results,
      handleSelect,
      handleCommit,
      handleCommitError,
      handleSeriesSettingsChange,
      handleAddSeriesColumn,
      handleRenameSeriesColumn,
      handleSortSeries,
    ],
  );

  const activeSheet = doc.workbook.sheets.find((s) => s.id === activeSheetId);
  const selectedAddress = activeSheet ? (selections.get(activeSheet.id) ?? null) : null;
  const selectedContent =
    activeSheet && selectedAddress ? formatCellInput(activeSheet.cells[selectedAddress]) : "";

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} navbar={{ width: 200, breakpoint: 0 }} padding={0}>
      <AppShell.Header>
        <MenuBar
          config={{ settings, gpuAvailable: gpuAvailable === true, onApply: handleApplySettings }}
          title={doc.title}
          dirty={doc.dirty}
          onNew={handleNew}
          onSave={() => void handleSave()}
          onLoad={handleLoad}
          onNewSheet={handleNewSheet}
          onNewSeriesSheet={handleNewSeriesSheet}
        />
        <Divider />
        <Toolbar onLoadTestModel={handleLoadTestModel} />
        <Divider />
        <FormulaBar
          address={selectedAddress}
          sheetId={activeSheet?.id}
          content={selectedContent}
          status={status}
          statusDetail={statusDetail}
          onCommit={(text) =>
            activeSheet && selectedAddress
              ? handleCommit(activeSheet.id, [{ address: selectedAddress, text }])
              : null
          }
          onDone={() => {
            if (activeSheet && selectedAddress) {
              void focusCellBelow(activeSheet.id, selectedAddress);
            }
          }}
          onFillPeriod={() => {
            // Series sheets: Ctrl+; in a time cell suggests the next period (SPECS.md §5.2.1).
            const row = /^A([0-9]+)$/.exec(selectedAddress ?? "")?.[1];
            return activeSheet?.series && row ? suggestPeriod(activeSheet, Number(row)) : null;
          }}
        />
      </AppShell.Header>
      <AppShell.Navbar>
        <SheetList
          sheets={doc.workbook.sheets}
          activeSheetId={activeSheetId}
          onOpen={handleOpenSheet}
        />
      </AppShell.Navbar>
      <AppShell.Main>
        <Box h={`calc(100dvh - ${HEADER_HEIGHT}px)`}>
          <SheetAreaContext.Provider value={context}>
            <SheetArea onReady={handleReady} />
          </SheetAreaContext.Provider>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
