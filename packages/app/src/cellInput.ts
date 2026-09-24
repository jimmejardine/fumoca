/** Converting between what the user types into a cell and the value stored in the workbook. */

/**
 * Converts typed input into a cell value: a number where possible, a formula if it starts with
 * "=", otherwise text. Returns "" (clear the cell) for empty input.
 */
export function parseCellInput(input: unknown): number | string {
  if (input === null || input === undefined) return "";
  if (typeof input === "number") return input;
  const text = String(input);
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("=")) return trimmed;
  const number = Number(trimmed);
  return Number.isNaN(number) ? text : number;
}

/** The text an editor shows for a stored cell value. */
export function formatCellInput(value: number | string | undefined): string {
  return value === undefined ? "" : String(value);
}
