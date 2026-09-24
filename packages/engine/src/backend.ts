import type { RunOptions } from "./cpu";
import type { Program } from "./ir";

/** Samples of each output cell, keyed by address. The CPU produces f64 and the GPU f32. */
export type Samples = Map<string, Float32Array | Float64Array>;

/**
 * A simulation backend (SPECS.md §6.4, §6.6). Every backend has the same asynchronous signature,
 * so the CPU and GPU can be run side by side and compared (§6.7).
 */
export interface Backend {
  readonly name: string;
  /** Evaluates iterations `[iterationStart, iterationStart + count)` of the program. */
  run(program: Program, options: RunOptions): Promise<Samples>;
  /** Releases the backend's workers or device. The backend can't be used afterwards. */
  dispose(): void;
}
