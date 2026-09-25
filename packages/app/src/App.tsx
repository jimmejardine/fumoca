import { FormulaSyntaxError, parseFormula } from "@fumoca/engine";
import { GpuBackend } from "@fumoca/gpu";
import { CpuBackend } from "@fumoca/sim";
import {
  addSeriesColumn,
  addSheet,
  createSeriesSheet,
  createWorkbook,
  FILE_EXTENSION,
  nextSheetName,
  parseWorkbook,
  renameSeriesColumn,
  type SeriesSettings,
  serializeWorkbook,
  setCell,
  setSeriesSettings,
  type Workbook,
} from "@fumoca/storage";
import { AppShell, Box, Divider, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCellInput, parseCellInput } from "./cellInput";
import {
  DEFAULT_SETTINGS,
  type EngineSettings,
  loadSettings,
  saveSettings,
} from "./engineSettings";
import { FormulaBar } from "./FormulaBar";
import { openTextFile, saveTextFile, type WorkbookFile } from "./files";
import { MenuBar } from "./MenuBar";
import {
  type Engines,
  type Recalculation,
  startRecalculation,
  type WorkbookResults,
} from "./recalc";
import { openSheet, SheetArea, SheetAreaContext, showWorkbook } from "./SheetArea";
import { type CellEdit, focusCellBelow } from "./SheetGrid";
import { SheetList } from "./SheetList";
import { Toolbar } from "./Toolbar";
import { createTestWorkbook } from "./testModel";

// Menu bar (36) + divider + toolbar (40) + divider + formula bar (38).
const HEADER_HEIGHT = 116;

/** Fixed seed, so recalculating the same model always gives the same results. */
const SEED = 1;

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

/** CPU iterations per worker in each batch: small enough that updates come often. */
const CPU_BATCH_PER_WORKER = 1_000;

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

/** Returns an error message if the text is a formula with a syntax error. */
function syntaxError(text: string): string | null {
  const value = parseCellInput(text);
  if (typeof value !== "string" || !value.startsWith("=")) return null;
  try {
    parseFormula(value);
    return null;
  } catch (error) {
    return error instanceof FormulaSyntaxError ? error.message : String(error);
  }
}

export function App() {
  const [doc, setDoc] = useState<Document>(() => untitled(createWorkbook()));
  const [settings, setSettings] = useState<EngineSettings>(() => loadSettings());
  // undefined while WebGPU is being detected; null if it isn't available.
  const [gpu, setGpu] = useState<GpuBackend | null | undefined>(undefined);
  const [cpu, setCpu] = useState<CpuBackend | null>(null);
  const [results, setResults] = useState<WorkbookResults>(new Map());
  const [status, setStatus] = useState("Starting…");
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Map<string, string>>(new Map());
  const apiRef = useRef<DockviewApi | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    document.title = `${doc.title}${doc.dirty ? " •" : ""} — fumoca`;
  }, [doc.title, doc.dirty]);

  // Detect WebGPU once. The GPU backend lives for the whole session.
  useEffect(() => {
    let cancelled = false;
    let created: GpuBackend | null = null;
    void GpuBackend.create()
      .catch(() => null)
      .then((backend) => {
        created = backend;
        if (cancelled) backend?.dispose();
        else setGpu(backend);
      });
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, []);

  // What actually runs: without WebGPU the GPU is off, and the CPU must run (SPECS.md §6.7).
  const effective = useMemo<EngineSettings | null>(() => {
    if (gpu === undefined) return null;
    if (gpu) return settings;
    return {
      gpuIterations: 0,
      cpuIterations: settings.cpuIterations || DEFAULT_SETTINGS.cpuIterations,
    };
  }, [gpu, settings]);

  // The CPU worker pool exists only while CPU iterations are enabled.
  const cpuEnabled = (effective?.cpuIterations ?? 0) > 0;
  useEffect(() => {
    if (!cpuEnabled) return;
    const backend = new CpuBackend();
    setCpu(backend);
    return () => {
      backend.dispose();
      setCpu(null);
    };
  }, [cpuEnabled]);

  // Recalculate whenever the model or engines change. The run goes in batches, and the grid
  // updates as they arrive (SPECS.md §6.3); a newer run cancels the one before.
  useEffect(() => {
    if (!effective) return;
    const gpuRun =
      gpu && effective.gpuIterations > 0
        ? { backend: gpu, count: effective.gpuIterations, f32: true }
        : null;
    const cpuRun =
      cpu && effective.cpuIterations > 0
        ? {
            backend: cpu,
            count: effective.cpuIterations,
            batch: CPU_BATCH_PER_WORKER * cpu.workerCount,
          }
        : null;
    const primary = gpuRun ?? cpuRun;
    if (!primary) return; // The CPU pool is still starting.
    const engines: Engines =
      gpuRun && cpuRun ? { primary: gpuRun, secondary: cpuRun } : { primary };

    setStatus("Calculating…");
    setStatusDetail(undefined);
    const workbook = doc.workbook;
    const running = startRecalculation(workbook, engines, { seed: SEED }, (update) => {
      setResults(update.results);
      const { status: text, detail } = describeStatus(update, workbook, Boolean(gpuRun));
      setStatus(text);
      setStatusDetail(detail);
    });
    running.done.catch((error: unknown) => {
      setStatus("Calculation failed");
      showError("Calculation failed", error);
    });
    return () => running.cancel();
  }, [doc.workbook, effective, gpu, cpu]);

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
   * Commits edits to a sheet. Rejects the whole commit if any formula has a syntax error (as
   * Excel does), returning the error message. Unchanged cells are ignored.
   */
  const handleCommit = useCallback((sheetId: string, edits: CellEdit[]): string | null => {
    for (const { address, text } of edits) {
      const error = syntaxError(text);
      if (error) return edits.length === 1 ? error : `${address}: ${error}`;
    }
    const sheet = docRef.current.workbook.sheets.find((s) => s.id === sheetId);
    const changed = edits.filter(({ address, text }) => {
      const previous = sheet?.cells[address];
      const next = parseCellInput(text);
      return next === "" ? previous !== undefined : previous !== next;
    });
    if (changed.length === 0) return null;
    setDoc((d) => ({
      ...d,
      workbook: changed.reduce(
        (wb, { address, text }) => setCell(wb, sheetId, address, parseCellInput(text)),
        d.workbook,
      ),
      dirty: true,
    }));
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
    }),
    [
      doc.workbook,
      results,
      handleSelect,
      handleCommit,
      handleCommitError,
      handleSeriesSettingsChange,
      handleAddSeriesColumn,
      handleRenameSeriesColumn,
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
          config={{ settings, gpuAvailable: Boolean(gpu), onApply: handleApplySettings }}
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
