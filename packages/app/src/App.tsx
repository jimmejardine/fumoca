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
import { openTextFile, saveTextFile, type WorkbookFile } from "./files";
import { MenuBar } from "./MenuBar";
import { openSheet, SheetArea, SheetAreaContext, showWorkbook } from "./SheetArea";
import type { CellChange } from "./SheetGrid";
import { SheetList } from "./SheetList";
import { Toolbar } from "./Toolbar";
import { createTestWorkbook } from "./testModel";

const HEADER_HEIGHT = 77; // menu bar (36) + divider (1) + toolbar (40)

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
  notifications.show({
    color: "red",
    title,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function App() {
  const [doc, setDoc] = useState<Document>(() => untitled(createWorkbook()));
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  useEffect(() => {
    document.title = `${doc.title}${doc.dirty ? " •" : ""} — fumoca`;
  }, [doc.title, doc.dirty]);

  /** Replaces the open model, asking first if there are unsaved changes. */
  const replaceDocument = useCallback((next: () => Document | Promise<Document | null>) => {
    const replace = async () => {
      try {
        const replacement = await next();
        if (!replacement) return;
        setDoc(replacement);
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

  const handleCellsChange = useCallback((sheetId: string, changes: CellChange[]) => {
    setDoc((d) => ({
      ...d,
      workbook: changes.reduce((wb, c) => setCell(wb, sheetId, c.address, c.value), d.workbook),
      dirty: true,
    }));
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
    () => ({ workbook: doc.workbook, onCellsChange: handleCellsChange }),
    [doc.workbook, handleCellsChange],
  );

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
