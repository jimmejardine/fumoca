import { formulaReferences } from "@fumoca/engine";

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
 * The colour for each cell a formula references, by address: in order of first appearance, so a
 * repeated reference keeps its colour. Empty for text that isn't a formula.
 */
export function referenceColors(text: string, scheme: ColorScheme): Map<string, string> {
  const colors = new Map<string, string>();
  for (const { address } of formulaReferences(text)) {
    if (!colors.has(address)) colors.set(address, dependencyColor(colors.size, scheme));
  }
  return colors;
}
