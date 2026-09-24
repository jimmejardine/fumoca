/**
 * @fumoca/engine: the formula engine. See SPECS.md §3–§5 and §9.
 *
 * This package must stay free of DOM and UI dependencies (its tsconfig has no DOM lib).
 */

export { uncertainCells } from "./analysis";
export type { Backend, Samples } from "./backend";
export {
  type CellError,
  type CellInputs,
  CompileError,
  compile,
  compileSheet,
  type ErrorCode,
  type SheetCompilation,
} from "./compile";
export { evaluateCpu, outputRegisters, type RunOptions } from "./cpu";
export { StreamingHistogram } from "./histogram";
export type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
export { type BinaryOperator, type Expr, FormulaSyntaxError, parseFormula } from "./parser";
export { hash32, randomU32, standardNormal, toUnit, uniformUnit } from "./random";
export { normalCdf, normalPdf } from "./special";
