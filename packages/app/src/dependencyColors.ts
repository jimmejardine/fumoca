import { type FormulaReference, formulaReferences } from "@fumoca/engine";
import type { Workbook } from "@fumoca/storage";

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

/**
 * The colour for each cell a formula references, by `referenceKey`: in order of first
 * appearance, so a repeated reference keeps its colour. Empty for text that isn't a formula.
 */
export function referenceColors(text: string, scheme: ColorScheme): Map<string, string> {
  const colors = new Map<string, string>();
  for (const reference of formulaReferences(text)) {
    const key = referenceKey(reference);
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
  for (const reference of formulaReferences(text)) {
    const name = reference.sheet?.toLowerCase();
    const target =
      name === undefined ? sheetId : workbook.sheets.find((s) => s.name.toLowerCase() === name)?.id;
    const color = colors.get(referenceKey(reference));
    if (!target || !color) continue;
    const cells = highlights.get(target) ?? new Map<string, string>();
    if (!cells.has(reference.address)) cells.set(reference.address, color);
    highlights.set(target, cells);
  }
  return highlights;
}
