import type { Program, RunOptions } from "@fumoca/engine";

/** Messages between `CpuBackend` and its workers. */
export interface WorkerRequest {
  id: number;
  program: Program;
  options: RunOptions;
}

export type WorkerResponse =
  | { id: number; samples: Map<string, Float64Array> }
  | { id: number; error: string };
