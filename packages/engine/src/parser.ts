/**
 * Formula parser: turns formula text (without the leading "=") into an AST.
 *
 * Operator precedence follows Excel (SPECS.md §4.4), from lowest to highest:
 *   comparison (= <> < > <= >=)  <  + -  <  * /  <  ^  <  postfix %  <  unary - +
 * Unary minus binds tighter than ^, so -2^2 = 4, and ^ is left-associative, so 2^3^2 = 64.
 */

export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { type: "number"; value: number }
  | { type: "ref"; address: string }
  | { type: "negate"; operand: Expr }
  | { type: "binary"; operator: BinaryOperator; left: Expr; right: Expr }
  | { type: "call"; name: string; args: Expr[] };

export class FormulaSyntaxError extends Error {
  override name = "FormulaSyntaxError";
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "ref"; address: string }
  | { kind: "name"; name: string }
  | { kind: "op"; op: string }
  | { kind: "end" };

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([0-9]+)(?![A-Za-z0-9_.(])/;
const NUMBER = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/;
const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "%", "=", "<", ">", "(", ")", ","];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    const rest = text.slice(pos);
    const space = /^\s+/.exec(rest);
    if (space) {
      pos += space[0].length;
      continue;
    }
    const ref = CELL_REF.exec(rest);
    if (ref) {
      tokens.push({ kind: "ref", address: `${ref[1]?.toUpperCase()}${ref[2]}` });
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
      tokens.push({ kind: "name", name: name[0].toUpperCase() });
      pos += name[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (op) {
      tokens.push({ kind: "op", op });
      pos += op.length;
      continue;
    }
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

  private primary(): Expr {
    const token = this.next();
    switch (token.kind) {
      case "number":
        return { type: "number", value: token.value };
      case "ref":
        return { type: "ref", address: token.address };
      case "name": {
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
      return `reference ${token.address}`;
    case "name":
      return `name ${token.name}`;
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
