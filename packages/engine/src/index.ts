/**
 * @fumoca/engine: the formula engine. See SPECS.md §3–§5 and §9.
 *
 * This package must stay free of DOM and UI dependencies (its tsconfig has no DOM lib).
 */

export type { Backend, Samples } from "./backend";
export { type CellInputs, CompileError, compile } from "./compile";
export { evaluateCpu, outputRegisters, type RunOptions } from "./cpu";
export type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
export { type BinaryOperator, type Expr, FormulaSyntaxError, parseFormula } from "./parser";
export { hash32, randomU32, standardNormal, toUnit, uniformUnit } from "./random";
