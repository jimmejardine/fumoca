import type { BatchSummary, Program, RunOptions } from "@fumoca/engine";

/**
 * Messages between `CpuBackend` and its workers. A program is sent to each worker once, then run
 * many times by id, so batches don't copy the whole program every time. `runSummary` asks the
 * worker to reduce its samples to per-output summaries before replying.
 */
export type WorkerRequest =
  | { type: "program"; programId: number; program: Program }
  | { type: "run"; id: number; programId: number; options: RunOptions }
  | { type: "runSummary"; id: number; programId: number; options: RunOptions };

export type WorkerResponse =
  | { id: number; samples: Map<string, Float64Array> }
  | { id: number; summaries: Map<string, BatchSummary> }
  | { id: number; error: string };

/**
 * How many programs each worker keeps. Main thread and workers evict the oldest in the same
 * order, so the main thread always knows which programs a worker still has.
 */
export const PROGRAM_CACHE_SIZE = 4;
