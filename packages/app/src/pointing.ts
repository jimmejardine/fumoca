/**
 * Point mode (SPECS.md §6.1): while a formula is being edited, clicking a cell inserts its address
 * at the caret instead of selecting the cell, as in Excel.
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

/** The editor that receives pointed references: the focused formula input, if any. */
export interface PointTarget {
  sheetId: string | undefined;
  /** Inserts the address if a reference can go at the caret; returns whether it did. */
  insert: (address: string) => boolean;
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
