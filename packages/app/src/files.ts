import { FILE_EXTENSION } from "@fumoca/storage";

/**
 * Saving and loading files on the user's machine (SPECS.md §8.2). Uses the File System Access API
 * where the browser supports it, so files are saved in place; otherwise falls back to download
 * and upload.
 */

/** The parts of a File System Access file handle this module uses. */
interface WritableFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

interface PickerOptions {
  suggestedName?: string;
  types: { description: string; accept: Record<string, string[]> }[];
}

interface FilePickerWindow {
  showSaveFilePicker?: (options: PickerOptions) => Promise<WritableFileHandle>;
  showOpenFilePicker?: (options: PickerOptions) => Promise<WritableFileHandle[]>;
}

/** A file the workbook was loaded from or saved to. */
export interface WorkbookFile {
  name: string;
  /** Null when the browser has no File System Access API, so the file can't be saved in place. */
  handle: WritableFileHandle | null;
}

const PICKER_TYPES = [
  { description: "fumoca workbook", accept: { "application/json": [FILE_EXTENSION] } },
];

const pickers = (): FilePickerWindow => window as unknown as FilePickerWindow;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/**
 * Saves text to the current file, or asks where to save it. Returns the file saved to, or null if
 * the user cancelled.
 */
export async function saveTextFile(
  text: string,
  current: WorkbookFile | null,
  suggestedName: string,
): Promise<WorkbookFile | null> {
  const { showSaveFilePicker } = pickers();
  if (showSaveFilePicker) {
    let handle = current?.handle ?? null;
    if (!handle) {
      try {
        handle = await showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
      } catch (error) {
        if (isAbort(error)) return null;
        throw error;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return { name: handle.name, handle };
  }

  const name = current?.name ?? suggestedName;
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { name, handle: null };
}

/** Asks the user for a file and reads it. Returns null if the user cancelled. */
export async function openTextFile(): Promise<{ text: string; file: WorkbookFile } | null> {
  const { showOpenFilePicker } = pickers();
  if (showOpenFilePicker) {
    try {
      const [handle] = await showOpenFilePicker({ types: PICKER_TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return { text: await file.text(), file: { name: handle.name, handle } };
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  }

  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${FILE_EXTENSION},application/json`;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
  return file ? { text: await file.text(), file: { name: file.name, handle: null } } : null;
}
