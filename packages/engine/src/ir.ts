/**
 * The compiled intermediate representation (IR) shared by the CPU evaluator and the GPU compiler
 * (SPECS.md §9, "Shared IR").
 *
 * A program is a flat, topologically ordered list of operations in SSA form: operation `i` writes
 * register `i`, and only reads registers with a lower index. Every value is a number.
 */

export type Reg = number;

export type UnaryFn = "neg" | "sqrt" | "exp" | "ln" | "abs";

export type BinaryFn =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "pow"
  | "min"
  | "max"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge";

export type DistKind = "uniform" | "normal" | "lognormal" | "triangular";

export type Op =
  | { kind: "const"; value: number }
  | { kind: "unary"; fn: UnaryFn; a: Reg }
  | { kind: "binary"; fn: BinaryFn; a: Reg; b: Reg }
  /** IF: `cond != 0 ? then : otherwise`. Both branches are always evaluated. */
  | { kind: "select"; cond: Reg; then: Reg; otherwise: Reg }
  /**
   * A distribution sample. `stream` identifies this call site, and keys its random numbers
   * together with the seed and iteration (SPECS.md §6.6), so every backend draws identical inputs.
   */
  | { kind: "dist"; dist: DistKind; args: Reg[]; stream: number };

export interface Program {
  ops: Op[];
  /** The register holding each cell's value, keyed by address (for example "B4"). */
  cells: Map<string, Reg>;
  /** Number of distribution call sites (streams) in the program. */
  streamCount: number;
}
