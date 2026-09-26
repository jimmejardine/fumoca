import {
  type Backend,
  type BatchSummary,
  mergeSummaries,
  type Program,
  type RunOptions,
} from "@fumoca/engine";
import { PROGRAM_CACHE_SIZE, type WorkerRequest, type WorkerResponse } from "./protocol";

export interface CpuBackendOptions {
  /** Number of workers. Defaults to all cores but one (SPECS.md §6.4). */
  workers?: number;
  /**
   * URL of the bundled CPU worker script (`@fumoca/sim/worker`). Needed when the backend is
   * created inside another worker, whose bundle can't emit a nested worker by itself.
   */
  workerUrl?: string | URL;
}

/** All cores but one, so the main thread stays responsive (SPECS.md §6.4). */
export function defaultWorkerCount(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, cores - 1);
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

/** Iterations per worker in a summary batch: nothing is transferred, so batches can be larger. */
const SUMMARY_ITERATIONS_PER_WORKER = 5_000;

/** Splits `count` iterations into up to `parts` contiguous, non-empty blocks of near-equal size. */
export function splitIterations(count: number, parts: number): { start: number; count: number }[] {
  const blocks: { start: number; count: number }[] = [];
  const base = Math.floor(count / parts);
  const remainder = count % parts;
  let start = 0;
  for (let i = 0; i < parts; i++) {
    const size = base + (i < remainder ? 1 : 0);
    if (size > 0) blocks.push({ start, count: size });
    start += size;
  }
  return blocks;
}

/**
 * The CPU backend: evaluates the model in f64 on a pool of Web Workers.
 *
 * Each run is split into contiguous blocks of iterations, one per worker. Random numbers depend
 * only on (seed, iteration, stream), so the result is bit-identical to a single-threaded run,
 * however many workers there are.
 */
export class CpuBackend implements Backend {
  readonly name = "cpu";
  readonly workerCount: number;
  private readonly workers: Worker[];
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private disposed = false;
  /** Programs every worker holds, oldest first, mirroring the workers' own caches. */
  private readonly sentPrograms: { program: Program; programId: number }[] = [];
  private nextProgramId = 0;

  constructor(options: CpuBackendOptions = {}) {
    const count = options.workers ?? defaultWorkerCount();
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`workers must be a positive integer, got ${count}`);
    }
    this.workerCount = count;
    this.workers = Array.from({ length: count }, () => {
      const worker = options.workerUrl
        ? new Worker(options.workerUrl, { type: "module" })
        : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.settle(event.data);
      worker.onerror = (event) => this.failAll(new Error(`CPU worker failed: ${event.message}`));
      return worker;
    });
  }

  async run(program: Program, options: RunOptions): Promise<Map<string, Float64Array>> {
    if (this.disposed) throw new Error("CpuBackend has been disposed");
    const programId = this.sendProgram(program);
    const blocks = splitIterations(options.count, this.workerCount);
    const parts = await Promise.all(
      blocks.map(async (block, w) => {
        const response = await this.request(w, {
          type: "run",
          id: this.nextId++,
          programId,
          options: {
            ...options,
            iterationStart: options.iterationStart + block.start,
            count: block.count,
          },
        });
        return "samples" in response ? response.samples : new Map<string, Float64Array>();
      }),
    );

    return new Map(
      options.outputs.map((address) => {
        const merged = new Float64Array(options.count);
        parts.forEach((part, i) => {
          const block = blocks[i];
          const samples = part.get(address);
          if (block && samples) merged.set(samples, block.start);
        });
        return [address, merged];
      }),
    );
  }

  /** The largest `runSummary` batch: a fixed number of iterations per worker. */
  maxSummaryBatch(): number {
    return SUMMARY_ITERATIONS_PER_WORKER * this.workerCount;
  }

  /**
   * Evaluates iterations and reduces them inside the workers: each worker returns only per-output
   * summaries of its block, which are merged here. Nothing large crosses to this thread.
   */
  async runSummary(program: Program, options: RunOptions): Promise<Map<string, BatchSummary>> {
    if (this.disposed) throw new Error("CpuBackend has been disposed");
    const programId = this.sendProgram(program);
    const blocks = splitIterations(options.count, this.workerCount);
    const parts = await Promise.all(
      blocks.map(async (block, w) => {
        const response = await this.request(w, {
          type: "runSummary",
          id: this.nextId++,
          programId,
          options: {
            ...options,
            iterationStart: options.iterationStart + block.start,
            count: block.count,
          },
        });
        return "summaries" in response ? response.summaries : new Map<string, BatchSummary>();
      }),
    );
    const empty: BatchSummary = { count: 0, mean: 0, m2: 0, nanCount: 0, infiniteCount: 0 };
    return new Map(
      options.outputs.map((output) => [
        output,
        parts.reduce((merged, part) => mergeSummaries(merged, part.get(output) ?? empty), empty),
      ]),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.failAll(new Error("CpuBackend has been disposed"));
  }

  /**
   * Makes sure every worker has the program, sending it once, and returns its id. Messages to a
   * worker arrive in order, so the program always arrives before the runs that use it.
   */
  private sendProgram(program: Program): number {
    const sent = this.sentPrograms.find((entry) => entry.program === program);
    if (sent) return sent.programId;
    const programId = this.nextProgramId++;
    const message: WorkerRequest = { type: "program", programId, program };
    for (const worker of this.workers) worker.postMessage(message);
    this.sentPrograms.push({ program, programId });
    if (this.sentPrograms.length > PROGRAM_CACHE_SIZE) this.sentPrograms.shift();
    return programId;
  }

  private request(
    workerIndex: number,
    request: WorkerRequest & { id: number },
  ): Promise<WorkerResponse> {
    const worker = this.workers[workerIndex];
    if (!worker) return Promise.reject(new Error(`No worker ${workerIndex}`));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  private settle(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if ("error" in response) pending.reject(new Error(response.error));
    else pending.resolve(response);
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
