import { type FormulaReference, formulaNames, formulaReferences } from "@fumoca/engine";
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

/** Identifies the cell a reference names: `B3`, or `inputs!B3` on another sheet (any case). */
export const referenceKey = ({ sheet, address }: Pick<FormulaReference, "sheet" | "address">) =>
  sheet === undefined ? address : `${sheet.toLowerCase()}!${address}`;

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

/**
 * The dependency borders to draw for a formula on a sheet (the selected cell's, or one being
 * typed): for each sheet, by id, the colour of each of its cells that the formula references.
 * References to other sheets are included, so their borders show wherever those sheets are open.
 * The first colour for a cell wins.
 */
export function dependencyHighlights(
  workbook: Workbook,
  sheetId: string,
  text: number | string | undefined,
  scheme: ColorScheme,
): Map<string, Map<string, string>> {
  const highlights = new Map<string, Map<string, string>>();
  if (typeof text !== "string") return highlights;
  const colors = referenceColors(text, scheme);
  for (const span of formulaSpans(text)) {
    let cell: { sheetId: string; address: string } | null = null;
    if ("name" in span) {
      cell = findName(workbook, span.name);
    } else {
      const sheet = span.reference.sheet?.toLowerCase();
      const target =
        sheet === undefined
          ? sheetId
          : workbook.sheets.find((s) => s.name.toLowerCase() === sheet)?.id;
      cell = target ? { sheetId: target, address: span.reference.address } : null;
    }
    const color = colors.get(span.key);
    if (!cell || !color) continue;
    const cells = highlights.get(cell.sheetId) ?? new Map<string, string>();
    if (!cells.has(cell.address)) cells.set(cell.address, color);
    highlights.set(cell.sheetId, cells);
  }
  return highlights;
}
