/**
 * @fumoca/engine: the formula engine. See SPECS.md §3–§5 and §9.
 *
 * This package must stay free of DOM and UI dependencies (its tsconfig has no DOM lib).
 */

export { CellAccumulator, mergeSummaries, summarizeBatch } from "./accumulator";
export { uncertainCells } from "./analysis";
export type { Backend, BatchSummary, Samples } from "./backend";
export {
  type CellError,
  type CellInputs,
  CompileError,
  cellKey,
  compile,
  compileSheet,
  compileWorkbook,
  type ErrorCode,
  type SheetCompilation,
  type SheetInput,
  type SheetOutcome,
  splitCellKey,
  type WorkbookCompilation,
} from "./compile";
export { evaluateCpu, outputRegisters, type RunOptions } from "./cpu";
export { compareSamples, relativeError, type SampleComparison } from "./crosscheck";
export { StreamingHistogram } from "./histogram";
export type { BinaryFn, DistKind, Op, Program, Reg, UnaryFn } from "./ir";
export {
  type BinaryOperator,
  type Expr,
  type FormulaReference,
  FormulaSyntaxError,
  formatReference,
  formulaReferences,
  type LookupTime,
  parseFormula,
} from "./parser";
export {
  GRANULARITIES,
  type Granularity,
  granularityOf,
  nextPeriod,
  normalizePeriod,
  periodContaining,
} from "./periods";
export { hash32, randomU32, standardNormal, toUnit, uniformUnit } from "./random";
export { normalCdf, normalPdf } from "./special";
