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
 */

export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { type: "number"; value: number }
  | { type: "ref"; address: string; sheet?: string }
  | { type: "negate"; operand: Expr }
  | { type: "binary"; operator: BinaryOperator; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] }
  | { type: "lookup"; sheet: string; column?: string; when: LookupTime };

/** The time in a series lookup: a period literal (`2026-10`) or a cell holding one. */
export type LookupTime = { kind: "period"; text: string } | { kind: "ref"; address: string };

export class FormulaSyntaxError extends Error {
  override name = "FormulaSyntaxError";
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "ref"; address: string; text: string; start: number; sheet?: string }
  | { kind: "name"; name: string; text: string }
  | { kind: "sheet"; name: string }
  | { kind: "column"; name: string }
  | { kind: "at" }
  | { kind: "period"; text: string }
  | { kind: "op"; op: string }
  | { kind: "end" };

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([0-9]+)(?![A-Za-z0-9_.(])/;
const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/;
const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "%", "=", "<", ">", "(", ")", ","];
const QUOTED_SHEET = /^'((?:[^']|'')+)'/;
/** A reference to a cell on another sheet: `Inputs!B3` or `'Interest Rates'!$B$3`. */
const SHEET_REF =
  /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!\$?([A-Za-z]{1,3})\$?([0-9]+)(?![A-Za-z0-9_.(])/;
/** Sheet names that can be written without quotes in a reference. */
const PLAIN_SHEET_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const COLUMN = /^\[([^\]]*)\]/;
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
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      pos += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: "name", name: name[0].toUpperCase(), text: name[0] });
      pos += name[0].length;
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
    const time = this.next();
    const when: LookupTime | undefined =
      time.kind === "period"
        ? { kind: "period", text: time.text }
        : time.kind === "ref"
          ? { kind: "ref", address: time.address }
          : undefined;
    if (!when) {
      throw new FormulaSyntaxError(
        `Expected a period (like 2026-10) or a cell after '@', found ${describe(time)}`,
      );
    }
    return column === undefined
      ? { type: "lookup", sheet, when }
      : { type: "lookup", sheet, column, when };
  }

  private primary(): Expr {
    const token = this.next();
    switch (token.kind) {
      case "number":
        return { type: "number", value: token.value };
      case "ref":
        // A sheet whose name looks like a cell reference, e.g. Q1[Rate]@2027.
        if (token.sheet !== undefined) {
          return { type: "ref", address: token.address, sheet: token.sheet };
        }
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

/** A cell reference in formula text, with its span (offsets into the text as given). */
export interface FormulaReference {
  address: string;
  /** The sheet named in the reference (`Inputs!B3`), or undefined for the formula's own sheet. */
  sheet?: string;
  start: number;
  end: number;
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
  tokens.forEach((token, i) => {
    if (token.kind !== "ref") return;
    const next = tokens[i + 1]?.kind;
    if (next === "column" || next === "at") return;
    const start = token.start + 1;
    const end = start + token.text.length;
    references.push(
      token.sheet === undefined
        ? { address: token.address, start, end }
        : { address: token.address, sheet: token.sheet, start, end },
    );
  });
  return references;
}
