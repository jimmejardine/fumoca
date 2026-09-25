import type { Backend, Program, RunOptions } from "@fumoca/engine";
import { PROGRAM_CACHE_SIZE, type WorkerRequest, type WorkerResponse } from "./protocol";

export interface CpuBackendOptions {
  /** Number of workers. Defaults to all cores but one (SPECS.md §6.4). */
  workers?: number;
}

/** All cores but one, so the main thread stays responsive (SPECS.md §6.4). */
export function defaultWorkerCount(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, cores - 1);
}

interface Pending {
  resolve: (samples: Map<string, Float64Array>) => void;
  reject: (error: Error) => void;
}

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
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
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
      blocks.map((block, w) =>
        this.request(w, programId, {
          ...options,
          iterationStart: options.iterationStart + block.start,
          count: block.count,
        }),
      ),
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
    programId: number,
    options: RunOptions,
  ): Promise<Map<string, Float64Array>> {
    const worker = this.workers[workerIndex];
    if (!worker) return Promise.reject(new Error(`No worker ${workerIndex}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: WorkerRequest = { type: "run", id, programId, options };
      worker.postMessage(request);
    });
  }

  private settle(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if ("error" in response) pending.reject(new Error(response.error));
    else pending.resolve(response.samples);
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
