import type { RunOptions } from "./cpu";
import type { Program } from "./ir";

/** Samples of each output cell, keyed by address. The CPU produces f64 and the GPU f32. */
export type Samples = Map<string, Float32Array | Float64Array>;

/**
 * Summary statistics of one cell over a batch of iterations: what a backend returns instead of
 * raw samples when it can reduce on the device (SPECS.md §6.6).
 */
export interface BatchSummary {
  /** Finite samples, which `mean` and `m2` are over. */
  count: number;
  mean: number;
  /** Sum of squared deviations from the mean. */
  m2: number;
  nanCount: number;
  infiniteCount: number;
}

/**
 * A simulation backend (SPECS.md §6.4, §6.6). Every backend has the same asynchronous signature,
 * so the CPU and GPU can be run side by side and compared (§6.7).
 */
export interface Backend {
  readonly name: string;
  /** Evaluates iterations `[iterationStart, iterationStart + count)` of the program. */
  run(program: Program, options: RunOptions): Promise<Samples>;
  /**
   * The largest number of iterations one `run` call can handle for this many output cells, if the
   * backend has such a limit (the GPU's storage buffer size does). Larger runs go in batches.
   */
  maxBatch?(outputCount: number): number;
  /**
   * Evaluates iterations and returns only each output's summary statistics, computed on the
   * device, so no raw samples cross to the host. Backends that can't do this leave it out.
   */
  runSummary?(program: Program, options: RunOptions): Promise<Map<string, BatchSummary>>;
  /** The largest `runSummary` batch for this many output cells. */
  maxSummaryBatch?(outputCount: number): number;
  /**
   * Starts any slow preparation for a program (the GPU compiles its shaders) in the background,
   * resolving when `runSummary` is ready to run without waiting. Runs keep using `run` meanwhile.
   */
  prepare?(program: Program, outputs: string[]): Promise<void>;
  /** Releases the backend's workers or device. The backend can't be used afterwards. */
  dispose(): void;
}
