import { type Backend, FormulaSyntaxError, parseFormula } from "@fumoca/engine";
import { GpuBackend } from "@fumoca/gpu";
import { CpuBackend } from "@fumoca/sim";
import {
  createWorkbook,
  FILE_EXTENSION,
  parseWorkbook,
  serializeWorkbook,
  setCell,
  type Workbook,
} from "@fumoca/storage";
import { AppShell, Box, Divider, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCellInput, parseCellInput } from "./cellInput";
import { FormulaBar } from "./FormulaBar";
import { openTextFile, saveTextFile, type WorkbookFile } from "./files";
import { MenuBar } from "./MenuBar";
import { recalculate, type WorkbookResults } from "./recalc";
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

/** The simulation backend and how many iterations to run per recalculation. */
interface Engine {
  backend: Backend;
  count: number;
  label: string;
}

const untitled = (workbook: Workbook, title = "Untitled"): Document => ({
  workbook,
  file: null,
  title,
  dirty: false,
});

function showError(title: string, error: unknown): void {
  notifications.show({
    color: "red",
    title,
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Uses the GPU when WebGPU is available, otherwise the CPU worker pool (SPECS.md §6.7). */
async function createEngine(): Promise<Engine> {
  const gpu = await GpuBackend.create().catch(() => null);
  if (gpu) return { backend: gpu, count: 100_000, label: "GPU" };
  return { backend: new CpuBackend(), count: 10_000, label: "CPU" };
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
  const [engine, setEngine] = useState<Engine | null>(null);
  const [results, setResults] = useState<WorkbookResults>(new Map());
  const [status, setStatus] = useState("Starting…");
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Map<string, string>>(new Map());
  const apiRef = useRef<DockviewApi | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    document.title = `${doc.title}${doc.dirty ? " •" : ""} — fumoca`;
  }, [doc.title, doc.dirty]);

  useEffect(() => {
    let cancelled = false;
    let created: Engine | null = null;
    void createEngine().then((e) => {
      created = e;
      if (cancelled) e.backend.dispose();
      else setEngine(e);
    });
    return () => {
      cancelled = true;
      created?.backend.dispose();
    };
  }, []);

  // Recalculate whenever the model changes. A newer recalculation supersedes an older one.
  const generation = useRef(0);
  useEffect(() => {
    if (!engine) return;
    const current = ++generation.current;
    setStatus("Calculating…");
    recalculate(doc.workbook, engine.backend, { seed: SEED, count: engine.count })
      .then((next) => {
        if (current !== generation.current) return;
        setResults(next);
        setStatus(`${engine.label} · ${engine.count.toLocaleString("en-US")} samples`);
      })
      .catch((error: unknown) => {
        if (current !== generation.current) return;
        setStatus("Calculation failed");
        showError("Calculation failed", error);
      });
  }, [doc.workbook, engine]);

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

  const handleSelect = useCallback((sheetId: string, address: string) => {
    setSelections((current) => new Map(current).set(sheetId, address));
  }, []);

  const handleCommitError = useCallback((message: string) => {
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
    }),
    [doc.workbook, results, handleSelect, handleCommit, handleCommitError],
  );

  const activeSheet = doc.workbook.sheets.find((s) => s.id === activeSheetId);
  const selectedAddress = activeSheet ? (selections.get(activeSheet.id) ?? null) : null;
  const selectedContent =
    activeSheet && selectedAddress ? formatCellInput(activeSheet.cells[selectedAddress]) : "";

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} navbar={{ width: 200, breakpoint: 0 }} padding={0}>
      <AppShell.Header>
        <MenuBar
          title={doc.title}
          dirty={doc.dirty}
          onNew={handleNew}
          onSave={() => void handleSave()}
          onLoad={handleLoad}
        />
        <Divider />
        <Toolbar onLoadTestModel={handleLoadTestModel} />
        <Divider />
        <FormulaBar
          address={selectedAddress}
          content={selectedContent}
          status={status}
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
