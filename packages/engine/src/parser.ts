/**
 * Formula parser: turns formula text (without the leading "=") into an AST.
 *
 * Operator precedence follows Excel (SPECS.md §4.4), from lowest to highest:
 *   comparison (= <> < > <= >=)  <  + -  <  * /  <  ^  <  postfix %  <  unary - +
 * Unary minus binds tighter than ^, so -2^2 = 4, and ^ is left-associative, so 2^3^2 = 64.
 *
 * Series lookups use structured references (SPECS.md §5.3): `Prices[Close]@2026-10`, or
 * `Prices@2026-10` for the sheet's first value column. The time after `@` is a period literal or
 * a cell reference. Sheet names with spaces are quoted: `'Interest Rates'[Rate]@2027`.
 *
 * Cells on other sheets are referenced as in Excel: `Inputs!B3`, or `'Interest Rates'!B3`.
 * Ranges are two corners, as in Excel: `A1:B5`, `Inputs!$B$3:$B$9`. They're only valid as function
 * arguments (SUM, INDEX, …); there are no whole-column or whole-row ranges yet.
 */

import { columnLetters, columnNumber } from "./addresses";
import { granularityOf, normalizePeriod } from "./periods";

export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { type: "number"; value: number }
  | { type: "ref"; address: string; sheet?: string }
  /** A rectangle of cells, from one corner to the other, on the formula's sheet or `sheet`. */
  | { type: "range"; from: string; to: string; sheet?: string }
  | { type: "negate"; operand: Expr }
  | { type: "binary"; operator: BinaryOperator; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] }
  /**
   * A series lookup (SPECS.md §5.3): `Sheet[Column]@when`, where `when` is any period: a literal,
   * a cell, a name or a bracketed expression. With `until`, a range of periods (`@2027-01:2027-12`)
   * for functions such as SUM.
   */
  | { type: "lookup"; sheet: string; column?: string; when: Expr; until?: Expr }
  /** `#REF!`: a reference that was moved off the grid by copying or filling. */
  | { type: "refError" }
  /** A named cell (SPECS.md §4.1), as written; names match regardless of case. */
  | { type: "name"; name: string }
  /** A period literal (SPECS.md §3.1), in its standard form: `2027-Q1`, `2027-01`, `2027-01-15`. */
  | { type: "period"; text: string };

export class FormulaSyntaxError extends Error {
  override name = "FormulaSyntaxError";
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "ref"; address: string; text: string; start: number; sheet?: string }
  | { kind: "name"; name: string; text: string; start: number }
  | { kind: "sheet"; name: string }
  | { kind: "column"; name: string }
  | { kind: "at" }
  | { kind: "period"; text: string }
  /** A period written in a formula: `2027-01`, not after `@`. */
  | { kind: "periodValue"; text: string }
  | { kind: "op"; op: string }
  | { kind: "refError" }
  | { kind: "end" };

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([0-9]+)(?![A-Za-z0-9_.(])/;
const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/;
const OPERATORS = [
  "<>",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "^",
  "%",
  "=",
  "<",
  ">",
  "(",
  ")",
  ",",
  ":",
];
const QUOTED_SHEET = /^'((?:[^']|'')+)'/;
/** A reference to a cell on another sheet: `Inputs!B3` or `'Interest Rates'!$B$3`. */
const SHEET_REF =
  /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!\$?([A-Za-z]{1,3})\$?([0-9]+)(?![A-Za-z0-9_.(])/;
/** Sheet names that can be written without quotes in a reference. */
const PLAIN_SHEET_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const COLUMN = /^\[([^\]]*)\]/;
/**
 * A period in a formula: a year joined by a hyphen to a quarter, week, month, day or hour (not a
 * year alone, which is a number). Loose forms are fixed up: `2027-1` is `2027-01`.
 */
const PERIOD_VALUE =
  /^(\d{4}-(?:[qQ][1-4]|[wW]\d{1,2}|\d{1,2}(?:-\d{1,2}(?:[tT]\d{1,2})?)?))(?![\w.$])/;
/** Period literals, longest first (SPECS.md §3.1). */
const PERIOD =
  /^(\d{4}-\d{2}-\d{2}T\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-Q[1-4]|\d{4}-\d{2}|\d{4})(?![\w.])/;

/** Splits formula text into tokens. Leniently, it stops at a bad character instead of throwing. */
function tokenize(text: string, lenient = false): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    const rest = text.slice(pos);
    const space = /^\s+/.exec(rest);
    if (space) {
      pos += space[0].length;
      continue;
    }
    const sheetRef = SHEET_REF.exec(rest);
    if (sheetRef) {
      tokens.push({
        kind: "ref",
        address: `${sheetRef[3]?.toUpperCase()}${sheetRef[4]}`,
        text: sheetRef[0],
        start: pos,
        sheet: sheetRef[1] !== undefined ? sheetRef[1].replaceAll("''", "'") : (sheetRef[2] ?? ""),
      });
      pos += sheetRef[0].length;
      continue;
    }
    const quoted = QUOTED_SHEET.exec(rest);
    if (quoted) {
      tokens.push({ kind: "sheet", name: (quoted[1] ?? "").replaceAll("''", "'") });
      pos += quoted[0].length;
      continue;
    }
    const column = COLUMN.exec(rest);
    if (column) {
      tokens.push({ kind: "column", name: (column[1] ?? "").trim() });
      pos += column[0].length;
      continue;
    }
    if (rest.startsWith("@")) {
      tokens.push({ kind: "at" });
      pos += 1;
      const period = PERIOD.exec(text.slice(pos));
      if (period?.[1]) {
        tokens.push({ kind: "period", text: period[1] });
        pos += period[0].length;
      }
      continue;
    }
    const ref = CELL_REF.exec(rest);
    if (ref) {
      tokens.push({
        kind: "ref",
        address: `${ref[1]?.toUpperCase()}${ref[2]}`,
        text: ref[0],
        start: pos,
      });
      pos += ref[0].length;
      continue;
    }
    // A period written without spaces is a period, not a subtraction: `2027-01` is January 2027,
    // `2027 - 01` is 2026 (SPECS.md §3.1). Only valid periods count: `2027-13` subtracts.
    const period = PERIOD_VALUE.exec(rest);
    const periodText = period?.[1] && normalizePeriod(period[1]);
    if (period && periodText && granularityOf(periodText)) {
      tokens.push({ kind: "periodValue", text: periodText });
      pos += period[0].length;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      pos += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: "name", name: name[0].toUpperCase(), text: name[0], start: pos });
      pos += name[0].length;
      continue;
    }
    if (rest.toUpperCase().startsWith("#REF!")) {
      tokens.push({ kind: "refError" });
      pos += 5;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (op) {
      tokens.push({ kind: "op", op });
      pos += op.length;
      continue;
    }
    if (lenient) break;
    throw new FormulaSyntaxError(`Unexpected character '${rest[0]}' at position ${pos}`);
  }
  tokens.push({ kind: "end" });
  return tokens;
}

const COMPARISON_OPERATORS = new Set(["=", "<>", "<", ">", "<=", ">="]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.comparison();
    const next = this.peek();
    if (next.kind !== "end") {
      throw new FormulaSyntaxError(`Unexpected ${describe(next)}`);
    }
    return expr;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: "end" };
  }

  private next(): Token {
    const token = this.peek();
    this.pos++;
    return token;
  }

  private peekOp(): string | undefined {
    const token = this.peek();
    return token.kind === "op" ? token.op : undefined;
  }

  private expectOp(op: string): void {
    const token = this.next();
    if (token.kind !== "op" || token.op !== op) {
      throw new FormulaSyntaxError(`Expected '${op}' but found ${describe(token)}`);
    }
  }

  private comparison(): Expr {
    let left = this.additive();
    for (let op = this.peekOp(); op && COMPARISON_OPERATORS.has(op); op = this.peekOp()) {
      this.pos++;
      left = { type: "binary", operator: op as BinaryOperator, left, right: this.additive() };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    for (let op = this.peekOp(); op === "+" || op === "-"; op = this.peekOp()) {
      this.pos++;
      left = { type: "binary", operator: op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.power();
    for (let op = this.peekOp(); op === "*" || op === "/"; op = this.peekOp()) {
      this.pos++;
      left = { type: "binary", operator: op, left, right: this.power() };
    }
    return left;
  }

  private power(): Expr {
    let left = this.percent();
    while (this.peekOp() === "^") {
      this.pos++;
      left = { type: "binary", operator: "^", left, right: this.percent() };
    }
    return left;
  }

  private percent(): Expr {
    let expr = this.unary();
    while (this.peekOp() === "%") {
      this.pos++;
      expr = { type: "binary", operator: "/", left: expr, right: { type: "number", value: 100 } };
    }
    return expr;
  }

  private unary(): Expr {
    const op = this.peekOp();
    if (op === "-") {
      this.pos++;
      return { type: "negate", operand: this.unary() };
    }
    if (op === "+") {
      this.pos++;
      return this.unary();
    }
    return this.primary();
  }

  /** Whether the next token continues a series lookup (`[Column]` or `@`). */
  private startsLookup(): boolean {
    const next = this.peek().kind;
    return next === "column" || next === "at";
  }

  /** Parses the rest of a series lookup, after the sheet name: `[Column]@Time` or `@Time`. */
  private lookup(sheet: string): Expr {
    let column: string | undefined;
    const bracket = this.peek();
    if (bracket.kind === "column") {
      this.pos++;
      column = bracket.name;
    }
    const at = this.next();
    if (at.kind !== "at") {
      throw new FormulaSyntaxError(`Expected '@' and a time after ${sheet}, found ${describe(at)}`);
    }
    const when = this.lookupTime();
    // A range of periods: `@2027-01:2027-12`.
    let until: Expr | undefined;
    if (when.type === "period" && this.peekOp() === ":") {
      this.pos++;
      until = this.lookupTime();
      if (until.type !== "period") {
        throw new FormulaSyntaxError(
          "A range of periods needs a period after ':', as in @2027-01:2027-12",
        );
      }
    }
    const lookup: Expr =
      column === undefined
        ? { type: "lookup", sheet, when }
        : { type: "lookup", sheet, column, when };
    return until ? { ...lookup, until } : lookup;
  }

  /** The time after `@`: a period literal, a cell, a name, or an expression in brackets. */
  private lookupTime(): Expr {
    const time = this.next();
    switch (time.kind) {
      case "period":
      case "periodValue":
        return { type: "period", text: time.text };
      case "number":
        // A year after ':' (the tokenizer reads it as a number).
        if (Number.isInteger(time.value) && time.value >= 1000 && time.value <= 9999) {
          return { type: "period", text: String(time.value) };
        }
        break;
      case "ref":
        if (time.sheet === undefined) return { type: "ref", address: time.address };
        break;
      case "name":
        // A function call, such as @PERIOD.MONTH(2027, 6), or a named cell.
        if (this.peekOp() === "(") {
          this.pos--;
          return this.primary();
        }
        return { type: "name", name: time.text };
      case "op":
        if (time.op === "(") {
          const expr = this.comparison();
          this.expectOp(")");
          return expr;
        }
        break;
      default:
        break;
    }
    throw new FormulaSyntaxError(
      `Expected a period (like 2026-10), a cell, a name or (an expression) after '@', found ${describe(time)}`,
    );
  }

  /** Parses the rest of a range, after its first corner: `:B5`. */
  private range(from: string, sheet: string | undefined): Expr {
    this.expectOp(":");
    const corner = this.next();
    if (corner.kind !== "ref" || corner.sheet !== undefined) {
      throw new FormulaSyntaxError(
        `Expected a cell after ':', as in A1:B5, but found ${describe(corner)}`,
      );
    }
    return sheet === undefined
      ? { type: "range", from, to: corner.address }
      : { type: "range", from, to: corner.address, sheet };
  }

  private primary(): Expr {
    const token = this.next();
    switch (token.kind) {
      case "number":
        return { type: "number", value: token.value };
      case "periodValue":
        return { type: "period", text: token.text };
      case "refError":
        return { type: "refError" };
      case "ref":
        if (this.peekOp() === ":") return this.range(token.address, token.sheet);
        if (token.sheet !== undefined) {
          return { type: "ref", address: token.address, sheet: token.sheet };
        }
        // A sheet whose name looks like a cell reference, e.g. Q1[Rate]@2027.
        if (this.startsLookup()) return this.lookup(token.text);
        return { type: "ref", address: token.address };
      case "sheet":
        return this.lookup(token.name);
      case "name": {
        if (this.startsLookup()) return this.lookup(token.text);
        // TRUE and FALSE are Excel's boolean literals; as numbers they are 1 and 0.
        if (this.peekOp() !== "(" && (token.name === "TRUE" || token.name === "FALSE")) {
          return { type: "number", value: token.name === "TRUE" ? 1 : 0 };
        }
        // A name without a bracket after it is a named cell; with one, a function call.
        if (this.peekOp() !== "(") return { type: "name", name: token.text };
        this.expectOp("(");
        const args: Expr[] = [];
        if (this.peekOp() !== ")") {
          args.push(this.comparison());
          while (this.peekOp() === ",") {
            this.pos++;
            args.push(this.comparison());
          }
        }
        this.expectOp(")");
        return { type: "call", name: token.name, args };
      }
      case "op":
        if (token.op === "(") {
          const expr = this.comparison();
          this.expectOp(")");
          return expr;
        }
        break;
      case "end":
        break;
    }
    throw new FormulaSyntaxError(`Unexpected ${describe(token)}`);
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case "number":
      return `number ${token.value}`;
    case "periodValue":
      return `period ${token.text}`;
    case "refError":
      return "#REF!";
    case "ref":
      return `reference ${token.text}`;
    case "name":
      return `name ${token.name}`;
    case "sheet":
      return `sheet '${token.name}'`;
    case "column":
      return `[${token.name}]`;
    case "at":
      return "'@'";
    case "period":
      return `period ${token.text}`;
    case "op":
      return `'${token.op}'`;
    case "end":
      return "end of formula";
  }
}

/** Parses formula text, with or without the leading "=". */
export function parseFormula(text: string): Expr {
  const body = text.startsWith("=") ? text.slice(1) : text;
  return new Parser(tokenize(body)).parse();
}

/**
 * A cell reference in formula text, with its span (offsets into the text as given). Each corner
 * of a range is a reference of its own, so the corners move independently when a formula is
 * copied; each corner names the other, in `rangeTo` and `rangeFrom`.
 */
export interface FormulaReference {
  address: string;
  /** The sheet named in the reference (`Inputs!B3`), or undefined for the formula's own sheet. */
  sheet?: string;
  start: number;
  end: number;
  /** For a range's first corner, the address of its opposite corner. */
  rangeTo?: string;
  /** For a range's second corner, the address of its first corner. */
  rangeFrom?: string;
}

/** Writes a reference to a cell on a sheet, quoting the sheet name if it needs it. */
export function formatReference(sheet: string, address: string): string {
  const name = PLAIN_SHEET_NAME.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`;
  return `${name}!${address}`;
}

/**
 * The cell references in formula text, in order, for highlighting a cell's dependencies. Works on
 * partly typed formulas: it stops at a character it can't read. A name that looks like a cell but
 * is a series lookup's sheet (`Q1[Rate]@2027`) isn't a reference; a lookup's time cell is.
 * Text that isn't a formula (no leading "=") has no references.
 */
export function formulaReferences(text: string): FormulaReference[] {
  if (!text.startsWith("=")) return [];
  const tokens = tokenize(text.slice(1), true);
  const references: FormulaReference[] = [];
  const isColon = (token: Token | undefined) => token?.kind === "op" && token.op === ":";
  tokens.forEach((token, i) => {
    if (token.kind !== "ref") return;
    const next = tokens[i + 1];
    if (next?.kind === "column" || next?.kind === "at") return;
    const start = token.start + 1;
    const end = start + token.text.length;
    const reference: FormulaReference = { address: token.address, start, end };
    if (token.sheet !== undefined) reference.sheet = token.sheet;
    const corner = tokens[i + 2];
    if (isColon(next) && corner?.kind === "ref" && corner.sheet === undefined) {
      reference.rangeTo = corner.address;
    }
    const previous = tokens[i - 2];
    if (isColon(tokens[i - 1]) && previous?.kind === "ref" && token.sheet === undefined) {
      reference.rangeFrom = previous.address;
      // The second corner is on the first corner's sheet.
      if (previous.sheet !== undefined) reference.sheet = previous.sheet;
    }
    references.push(reference);
  });
  return references;
}

/** A cell reference's parts: an optional sheet prefix, and `$` anchors on column and row. */
const REFERENCE_PARTS =
  /^((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]+)$/;

/**
 * Adjusts a formula copied `dx` columns and `dy` rows away, as Excel does: relative references
 * move with it, and the `$`-anchored column or row of a reference stays put. A reference that
 * would move off the grid becomes `#REF!`. Text that isn't a formula is returned unchanged.
 */
export function shiftFormula(text: string, dx: number, dy: number): string {
  if ((dx === 0 && dy === 0) || !text.startsWith("=")) return text;
  let shifted = text;
  for (const { start, end } of formulaReferences(text).reverse()) {
    const parts = REFERENCE_PARTS.exec(text.slice(start, end));
    if (!parts) continue;
    const [, sheet = "", columnAnchor, letters = "A", rowAnchor, row = "1"] = parts;
    const column = columnNumber(letters) + (columnAnchor ? 0 : dx);
    const rowNumber = Number(row) + (rowAnchor ? 0 : dy);
    const moved =
      column < 1 || rowNumber < 1
        ? "#REF!"
        : `${sheet}${columnAnchor}${columnLetters(column)}${rowAnchor}${rowNumber}`;
    shifted = shifted.slice(0, start) + moved + shifted.slice(end);
  }
  return shifted;
}

/** A named cell used in formula text, with its span (offsets into the text as given). */
export interface FormulaName {
  name: string;
  start: number;
  end: number;
}

/**
 * The named cells a formula uses, in order (SPECS.md §4.1): names not followed by a bracket (which
 * would make them function calls), other than TRUE and FALSE and series lookups' sheet names.
 * Works on partly typed formulas, as `formulaReferences` does.
 */
export function formulaNames(text: string): FormulaName[] {
  if (!text.startsWith("=")) return [];
  const tokens = tokenize(text.slice(1), true);
  const names: FormulaName[] = [];
  tokens.forEach((token, i) => {
    if (token.kind !== "name" || token.name === "TRUE" || token.name === "FALSE") return;
    const next = tokens[i + 1];
    if (next?.kind === "column" || next?.kind === "at") return;
    if (next?.kind === "op" && next.op === "(") return;
    const start = token.start + 1;
    names.push({ name: token.text, start, end: start + token.text.length });
  });
  return names;
}

/** Rewrites a formula's uses of the name `from` (any case) as `to`, for renaming a cell. */
export function renameInFormula(text: string, from: string, to: string): string {
  let renamed = text;
  const target = from.toLowerCase();
  for (const { name, start, end } of formulaNames(text).reverse()) {
    if (name.toLowerCase() === target) renamed = renamed.slice(0, start) + to + renamed.slice(end);
  }
  return renamed;
}

/**
 * Why a name can't name a cell, or null if it can (Excel's rules): it starts with a letter or an
 * underscore, then letters, digits, underscores or full stops; it doesn't look like a cell
 * reference; and it isn't TRUE or FALSE.
 */
export function nameError(name: string): string | null {
  if (name === "") return "A name can't be empty";
  if (name.length > 255) return "A name can have at most 255 characters";
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
    return "A name starts with a letter or _, then letters, digits, _ or .";
  }
  if (/^[A-Za-z]{1,3}[0-9]+$/.test(name)) return `${name} is a cell reference`;
  if (/^(true|false)$/i.test(name)) return `${name} is reserved`;
  return null;
}
