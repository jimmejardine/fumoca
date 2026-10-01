import {
  type FormulaReference,
  formulaNames,
  formulaReferences,
  rangeAddresses,
} from "@fumoca/engine";
import { findName, type Workbook } from "@fumoca/storage";

/**
 * Colours for a cell's dependencies (SPECS.md §6.5): a deterministic sequence that steps around
 * the colour wheel by the golden angle, so consecutive colours are far apart in hue and the
 * sequence never repeats. The same colour marks a referenced cell's border and its name in the
 * formula.
 */

/** 360° divided by the golden ratio squared: the golden angle. */
export const GOLDEN_ANGLE = 360 * (1 - 1 / ((1 + Math.sqrt(5)) / 2));
/** The first colour's hue: red. Blue comes late, so a border isn't mistaken for the selection. */
const START_HUE = 0;

export type ColorScheme = "light" | "dark";

/** The hue, in degrees, of the i-th colour. */
export const dependencyHue = (i: number) => (START_HUE + i * GOLDEN_ANGLE) % 360;

/** The i-th colour: darker on the light theme, lighter on the dark one, so it reads on both. */
export function dependencyColor(i: number, scheme: ColorScheme): string {
  const hue = dependencyHue(i).toFixed(1);
  return scheme === "dark" ? `hsl(${hue} 80% 65%)` : `hsl(${hue} 75% 42%)`;
}

/**
 * Identifies the cell a reference names: `B3`, or `inputs!B3` on another sheet (any case). Both
 * corners of a range share the range's key, `B3:C9`, so they share a colour.
 */
export const referenceKey = ({
  sheet,
  address,
  rangeTo,
  rangeFrom,
}: Pick<FormulaReference, "sheet" | "address" | "rangeTo" | "rangeFrom">) => {
  const cells =
    rangeTo !== undefined
      ? `${address}:${rangeTo}`
      : rangeFrom !== undefined
        ? `${rangeFrom}:${address}`
        : address;
  return sheet === undefined ? cells : `${sheet.toLowerCase()}!${cells}`;
};

/** Identifies a named cell used in a formula (any case). */
export const nameKey = (name: string) => `name:${name.toLowerCase()}`;

/** A cell reference or a name in formula text, with its span and its colour key. */
export type FormulaSpan = { key: string; start: number; end: number } & (
  | { reference: FormulaReference }
  | { name: string }
);

/** A formula's cell references and names, in the order they appear. */
export function formulaSpans(text: string): FormulaSpan[] {
  const spans: FormulaSpan[] = [
    ...formulaReferences(text).map((reference) => ({
      key: referenceKey(reference),
      start: reference.start,
      end: reference.end,
      reference,
    })),
    ...formulaNames(text).map(({ name, start, end }) => ({ key: nameKey(name), start, end, name })),
  ];
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The colour for each cell a formula references or names, by key: in order of first appearance,
 * so a repeated reference keeps its colour. Empty for text that isn't a formula.
 */
export function referenceColors(text: string, scheme: ColorScheme): Map<string, string> {
  const colors = new Map<string, string>();
  for (const { key } of formulaSpans(text)) {
    if (!colors.has(key)) colors.set(key, dependencyColor(colors.size, scheme));
  }
  return colors;
}

/** Which sides of a cell a dependency border draws, as bits: a range is outlined as a whole. */
export const SIDES = { top: 1, right: 2, bottom: 4, left: 8, all: 15 } as const;

/** A dependency border on one cell: its colour, and which of its sides to draw (`SIDES`). */
export interface DependencyMark {
  color: string;
  sides: number;
}

/** The cells of a range, each with the sides that lie on the range's outline. */
function rangeOutline(from: string, to: string): [string, number][] {
  const rows = rangeAddresses(from, to);
  return rows.flatMap((line, r) =>
    line.map((address, c): [string, number] => [
      address,
      (r === 0 ? SIDES.top : 0) |
        (c === line.length - 1 ? SIDES.right : 0) |
        (r === rows.length - 1 ? SIDES.bottom : 0) |
        (c === 0 ? SIDES.left : 0),
    ]),
  );
}

/**
 * The dependency borders to draw for a formula on a sheet (the selected cell's, or one being
 * typed): for each sheet, by id, the border of each of its cells that the formula references. A
 * range is outlined as one rectangle. References to other sheets are included, so their borders
 * show wherever those sheets are open. The first border for a cell wins.
 */
export function dependencyHighlights(
  workbook: Workbook,
  sheetId: string,
  text: number | string | undefined,
  scheme: ColorScheme,
): Map<string, Map<string, DependencyMark>> {
  const highlights = new Map<string, Map<string, DependencyMark>>();
  if (typeof text !== "string") return highlights;
  const colors = referenceColors(text, scheme);
  for (const span of formulaSpans(text)) {
    const color = colors.get(span.key);
    if (!color) continue;
    let target: { sheetId: string; cells: [string, number][] } | null = null;
    if ("name" in span) {
      const cell = findName(workbook, span.name);
      target = cell && { sheetId: cell.sheetId, cells: [[cell.address, SIDES.all]] };
    } else {
      const { reference } = span;
      // A range's second corner is outlined with its first.
      if (reference.rangeFrom !== undefined) continue;
      const sheet = reference.sheet?.toLowerCase();
      const id =
        sheet === undefined
          ? sheetId
          : workbook.sheets.find((s) => s.name.toLowerCase() === sheet)?.id;
      target = id
        ? {
            sheetId: id,
            cells:
              reference.rangeTo === undefined
                ? [[reference.address, SIDES.all]]
                : rangeOutline(reference.address, reference.rangeTo),
          }
        : null;
    }
    if (!target) continue;
    const marks = highlights.get(target.sheetId) ?? new Map<string, DependencyMark>();
    for (const [address, sides] of target.cells) {
      if (!marks.has(address)) marks.set(address, { color, sides });
    }
    highlights.set(target.sheetId, marks);
  }
  return highlights;
}
