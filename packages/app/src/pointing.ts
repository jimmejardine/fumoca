import { addressPosition, columnLetters, formatReference, formulaReferences } from "@fumoca/engine";

/**
 * Point mode (SPECS.md §6.1): while a formula is being edited, clicking a cell inserts its address
 * at the caret instead of selecting the cell, as in Excel. In the cell editor, arrow keys point
 * too, starting from the edited cell.
 */

/** Characters after which a reference can go: the formula's start, a bracket, a comma, an operator. */
const REFERENCE_FOLLOWS = new Set(["=", "(", ",", "+", "-", "*", "/", "^", "<", ">"]);

/** A reference inserted by pointing, so a second click can replace it. */
export interface Insertion {
  start: number;
  end: number;
  /** The text right after the insertion; the insertion is only replaced if it's unchanged. */
  value: string;
}

/**
 * Inserts `address` into formula text at the selection, if a reference can go there. A click
 * right after pointing (text unchanged, caret still after the inserted reference) replaces that
 * reference instead. Returns null when pointing doesn't apply.
 */
export function insertReference(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  address: string,
  last?: Insertion | null,
): { value: string; caret: number; inserted: Insertion } | null {
  if (!value.startsWith("=")) return null;
  let start = selectionStart;
  const end = selectionEnd;
  if (last && last.value === value && start === last.end && end === last.end) {
    start = last.start;
  } else {
    const before = value.slice(0, start).trimEnd();
    if (!REFERENCE_FOLLOWS.has(before.at(-1) ?? "")) return null;
  }
  const next = value.slice(0, start) + address + value.slice(end);
  const caret = start + address.length;
  return { value: next, caret, inserted: { start, end: caret, value: next } };
}

/**
 * Moves a reference (`B3`, or `Inputs!B3`) by whole cells, staying within the grid's bounds.
 * Returns null if the text isn't a single reference.
 */
export function moveReference(
  reference: string,
  dx: number,
  dy: number,
  bounds: { columns: number; rows: number },
): string | null {
  const [parsed] = formulaReferences(`=${reference}`);
  if (!parsed) return null;
  const { column, row } = addressPosition(parsed.address);
  const x = Math.min(Math.max(column - 1 + dx, 0), bounds.columns - 1);
  const y = Math.min(Math.max(row - 1 + dy, 0), bounds.rows - 1);
  const address = `${columnLetters(x + 1)}${y + 1}`;
  return parsed.sheet === undefined ? address : formatReference(parsed.sheet, address);
}

/** The editor that receives pointed references: the focused formula input, if any. */
export interface PointTarget {
  sheetId: string | undefined;
  /** Inserts the address if a reference can go at the caret; returns whether it did. */
  insert: (address: string) => boolean;
  /**
   * The reference pointing just inserted, while pointing continues (the text is unchanged and the
   * caret still right after it); null otherwise.
   */
  pointed: () => string | null;
}

let target: PointTarget | null = null;

export const pointTarget = () => target;

export function setPointTarget(next: PointTarget | null) {
  target = next;
}

/** Clears the point target, if it's still the given one. */
export function clearPointTarget(previous: PointTarget) {
  if (target === previous) target = null;
}

/** The formula being edited, so the grids can outline its references as it's typed. */
export interface Draft {
  sheetId: string;
  text: string;
}

let draft: Draft | null = null;
const draftListeners = new Set<() => void>();

export const currentDraft = () => draft;

export function publishDraft(next: Draft | null) {
  if (draft?.sheetId === next?.sheetId && draft?.text === next?.text) return;
  draft = next;
  for (const listener of draftListeners) listener();
}

export function subscribeDraft(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}
