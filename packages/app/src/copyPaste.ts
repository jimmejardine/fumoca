import { shiftFormula } from "@fumoca/engine";

/**
 * Copying and filling formulas as Excel does (SPECS.md §6.1): a pasted or filled formula's
 * relative references move by the distance from the cell it came from; `$`-anchored parts stay.
 */

/** A copied cell: its input as typed, and its position on its sheet (0-based column and row). */
export interface SourceCell {
  text: string;
  x: number;
  y: number;
}

/** What was last copied from a grid: the text it put on the clipboard, and the cells behind it. */
export interface CopiedCells {
  /** The copied range as the clipboard holds it: each cell's shown answer. */
  shown: string[][];
  cells: SourceCell[][];
}

/**
 * A cell a range edit writes to: its on-screen position in the grid (which skips rows a filter
 * hides), its position on the sheet, and the value the grid would write.
 */
export interface RangeTarget {
  screenX: number;
  screenY: number;
  x: number;
  y: number;
  value: string;
}

/** A rectangle of on-screen grid positions, inclusive. */
export interface ScreenRange {
  x: number;
  y: number;
  x1: number;
  y1: number;
}

const tile = (target: RangeTarget, origin: ScreenRange, width: number, height: number) => ({
  i: (((target.screenY - origin.y) % height) + height) % height,
  j: (((target.screenX - origin.x) % width) + width) % width,
});

const shifted = (source: SourceCell, target: RangeTarget) =>
  shiftFormula(source.text, target.x - source.x, target.y - source.y);

/**
 * The texts to paste into `targets`, a paste starting at `range`. If the clipboard holds what was
 * last copied from the grid (every value matches the copied cell it tiles from), each target
 * gets that cell's input, its formula shifted; otherwise null, and the plain values paste.
 */
export function pasteFromCopy(
  copied: CopiedCells | null,
  targets: RangeTarget[],
  range: ScreenRange,
): string[] | null {
  const height = copied?.shown.length ?? 0;
  const width = copied?.shown[0]?.length ?? 0;
  if (!copied || height === 0 || width === 0) return null;
  const texts: string[] = [];
  for (const target of targets) {
    const { i, j } = tile(target, range, width, height);
    const source = copied.cells[i]?.[j];
    if (!source || copied.shown[i]?.[j] !== target.value) return null;
    texts.push(shifted(source, target));
  }
  return texts;
}

/**
 * The texts the fill handle writes into `targets`, filling `fillRange` from the cells of
 * `sourceRange`, repeated as needed. `source` finds a cell of the source range by its on-screen
 * position.
 */
export function fillFromSource(
  targets: RangeTarget[],
  sourceRange: ScreenRange,
  fillRange: ScreenRange,
  source: (screenX: number, screenY: number) => SourceCell | undefined,
): string[] {
  const width = sourceRange.x1 - sourceRange.x + 1;
  const height = sourceRange.y1 - sourceRange.y + 1;
  return targets.map((target) => {
    const { i, j } = tile(target, fillRange, width, height);
    const from = source(sourceRange.x + j, sourceRange.y + i);
    return from ? shifted(from, target) : target.value;
  });
}
