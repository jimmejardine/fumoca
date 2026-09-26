/** @fumoca/sim: worker pool, scheduler and settling. See SPECS.md §6.3, §6.4 and §7.3. */
export {
  CpuBackend,
  type CpuBackendOptions,
  defaultWorkerCount,
  splitIterations,
} from "./cpu-backend";
export {
  type ComparisonProgress,
  type EngineProgress,
  type EngineSpec,
  FIRST_BATCH,
  MAX_COMPARED,
  type ProgressiveOptions,
  type ProgressState,
  RAW_ITERATIONS,
  RunAbortedError,
  runProgressively,
} from "./progressive";
