/** Cell addresses: `B7` is column 2 (B), row 7. Columns run A–Z, then AA, AB, …, as in Excel. */

/** A column's number from its letters: A → 1, Z → 26, AA → 27. */
export const columnNumber = (letters: string): number =>
  [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);

/** A column's letters from its number: 1 → A, 27 → AA. */
export function columnLetters(n: number): string {
  let letters = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** An address's column (1 = A) and row; `$` anchors are ignored. */
export function addressPosition(address: string): { column: number; row: number } {
  const [, letters = "A", row = "1"] = /^\$?([A-Za-z]+)\$?([0-9]+)$/.exec(address) ?? [];
  return { column: columnNumber(letters), row: Number(row) };
}

/** The addresses in the rectangle between two corners, row by row. */
export function rangeAddresses(from: string, to: string): string[][] {
  const a = addressPosition(from);
  const b = addressPosition(to);
  const rows: string[][] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    const line: string[] = [];
    for (
      let column = Math.min(a.column, b.column);
      column <= Math.max(a.column, b.column);
      column++
    ) {
      line.push(`${columnLetters(column)}${row}`);
    }
    rows.push(line);
  }
  return rows;
}
