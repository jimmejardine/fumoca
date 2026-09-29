import { type Backend, CellAccumulator, compareSamples, type Program } from "@fumoca/engine";

/**
 * Progressive runs (SPECS.md §6.3, §6.4): each engine evaluates the model in batches of
 * iterations, and every batch is folded into per-cell running statistics. Progress is reported a
 * few times a second, so results sharpen while the run continues. Memory stays bounded by the
 * batch size, however many iterations are asked for.
 *
 * A backend that can reduce on the device (`runSummary`, the GPU) returns raw samples only for
 * the first `RAW_ITERATIONS` iterations, which feed the histograms and the CPU/GPU comparison.
 * After that it returns per-batch summaries, with the next batch queued before the current one is
 * read back, so the device stays busy.
 */

export interface EngineSpec {
  backend: Backend;
  /** Total iterations to run on this engine. */
  total: number;
  /** Iterations per raw-sample batch. Defaults to the backend's `maxBatch`, or 10,000. */
  batch?: number;
  /** Iterations per summary batch. Defaults to the backend's `maxSummaryBatch`. */
  summaryBatch?: number;
}

/**
 * Iterations read back as raw samples from a backend that can also summarize: enough for smooth
 * histograms, and more than the comparison needs (`MAX_COMPARED`).
 */
export const RAW_ITERATIONS = 262_144;

export interface ProgressiveOptions {
  outputs: string[];
  seed: number;
  /** The engine whose results are shown. */
  primary: EngineSpec;
  /** An engine to compare with the primary, iteration by iteration (SPECS.md §6.7). */
  secondary?: EngineSpec;
  /** Minimum time between progress reports, in milliseconds. */
  throttleMs?: number;
  signal?: AbortSignal;
}

export interface EngineProgress {
  done: number;
  total: number;
  accumulators: Map<string, CellAccumulator>;
}

export interface ComparisonProgress {
  /** Iterations compared so far. */
  compared: number;
  /** Iterations that will be compared in all. */
  total: number;
  /** Outputs whose mismatches exceed the allowed fraction of the iterations compared so far. */
  differing: string[];
}

export interface ProgressState {
  primary: EngineProgress;
  secondary?: EngineProgress;
  comparison?: ComparisonProgress;
  /** All iterations have run on every engine. */
  complete: boolean;
}

/** The most iterations compared between engines, to bound the memory the comparison needs. */
export const MAX_COMPARED = 100_000;

const DEFAULT_BATCH = 10_000;
/** The first raw batch: small, so a run's first results arrive within a few milliseconds. */
export const FIRST_BATCH = 8_192;
/** Raw batches while waiting for the summary path: small, so progress keeps updating smoothly. */
const WAITING_BATCH = 65_536;
/** Mismatches allowed, as a fraction of iterations compared (see `compareSamples`). */
const ALLOWED_MISMATCH_FRACTION = 0.001;

export class RunAbortedError extends Error {
  override name = "RunAbortedError";
}

/**
 * Runs a program progressively on one or two engines. Resolves with the final state, or rejects
 * with `RunAbortedError` if `signal` aborts first.
 */
export async function runProgressively(
  program: Program,
  options: ProgressiveOptions,
  onProgress: (state: ProgressState) => void,
): Promise<ProgressState> {
  const { outputs, seed, primary, secondary, throttleMs = 200 } = options;
  const stop = new AbortController();
  const abort = () => stop.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) stop.abort();

  const accumulators = () => new Map(outputs.map((output) => [output, new CellAccumulator()]));
  const state: ProgressState = {
    primary: { done: 0, total: primary.total, accumulators: accumulators() },
    complete: false,
  };
  if (secondary) {
    state.secondary = { done: 0, total: secondary.total, accumulators: accumulators() };
  }

  // Iteration-by-iteration comparison over the iterations both engines run (up to MAX_COMPARED).
  const compareTotal = secondary ? Math.min(primary.total, secondary.total, MAX_COMPARED) : 0;
  const kept = [new Map<string, Float64Array>(), new Map<string, Float64Array>()];
  const covered = [0, 0];
  let compared = 0;
  const mismatches = new Map<string, number>(outputs.map((output) => [output, 0]));
  const updateComparison = () => {
    if (!secondary) return;
    const upTo = Math.min(covered[0] ?? 0, covered[1] ?? 0);
    if (upTo > compared) {
      for (const output of outputs) {
        const expected = kept[1]?.get(output)?.subarray(compared, upTo);
        const actual = kept[0]?.get(output)?.subarray(compared, upTo);
        if (!expected || !actual) continue;
        const { mismatches: found } = compareSamples(expected, actual, upTo - compared);
        mismatches.set(output, (mismatches.get(output) ?? 0) + found);
      }
      compared = upTo;
    }
    if (compared >= compareTotal) for (const store of kept) store.clear(); // no longer needed
    const allowed = Math.floor(compared * ALLOWED_MISMATCH_FRACTION);
    state.comparison = {
      compared,
      total: compareTotal,
      differing: outputs.filter((output) => (mismatches.get(output) ?? 0) > allowed),
    };
  };
  updateComparison();

  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < throttleMs) return;
    lastReport = now;
    onProgress(state);
  };

  const runEngine = async (spec: EngineSpec, progress: EngineProgress, which: 0 | 1) => {
    const { backend } = spec;
    const batch = Math.max(
      1,
      Math.floor(spec.batch ?? backend.maxBatch?.(outputs.length) ?? DEFAULT_BATCH),
    );
    const rawTotal = backend.runSummary ? Math.min(spec.total, RAW_ITERATIONS) : spec.total;

    // Start any slow preparation (the GPU compiling its summary shaders) straight away, in the
    // background. Until it's ready, keep running raw batches, so progress never stalls on it.
    let summaryReady = !backend.prepare;
    backend
      .prepare?.(program, outputs)
      .then(() => {
        summaryReady = true;
      })
      .catch(() => {
        summaryReady = true; // runSummary will surface the error
      });

    // Raw samples: every batch for plain backends, the first RAW_ITERATIONS for summarizing ones
    // (longer if the summary path isn't ready yet). Batches start small and double, so the first
    // results arrive quickly after a change.
    let size = Math.min(batch, FIRST_BATCH);
    while (
      progress.done < spec.total &&
      (progress.done < rawTotal || (backend.runSummary !== undefined && !summaryReady))
    ) {
      if (stop.signal.aborted) return;
      const start = progress.done;
      const waiting = start >= rawTotal; // only still raw because the summary path isn't ready
      const rawEnd = waiting ? spec.total : rawTotal;
      const count = Math.min(waiting ? Math.min(size, WAITING_BATCH) : size, rawEnd - start);
      size = Math.min(batch, size * 2);
      const samples = await spec.backend.run(program, {
        seed,
        iterationStart: start,
        count,
        outputs,
      });
      if (stop.signal.aborted) return;
      for (const output of outputs) {
        const cellSamples = samples.get(output);
        if (cellSamples) progress.accumulators.get(output)?.add(cellSamples);
      }
      // Keep the part of the batch that falls in the compared range.
      const keepTo = Math.min(start + count, compareTotal);
      if (keepTo > start) {
        const store = kept[which];
        for (const output of outputs) {
          const cellSamples = samples.get(output);
          if (!store || !cellSamples) continue;
          let array = store.get(output);
          if (!array) {
            array = new Float64Array(compareTotal);
            store.set(output, array);
          }
          array.set(cellSamples.subarray(0, keepTo - start), start);
        }
        covered[which] = keepTo;
        updateComparison();
      }
      progress.done = start + count;
      report();
    }

    // Summaries reduced on the device, one batch queued ahead of the one being read back.
    const runSummary = backend.runSummary?.bind(backend);
    if (!runSummary || progress.done >= spec.total) return;
    const summaryBatch = Math.max(
      1,
      Math.floor(spec.summaryBatch ?? backend.maxSummaryBatch?.(outputs.length) ?? batch),
    );
    let next = progress.done;
    const launch = () => {
      const start = next;
      const count = Math.min(summaryBatch, spec.total - start);
      next += count;
      const summaries = runSummary(program, { seed, iterationStart: start, count, outputs });
      summaries.catch(() => {}); // handled when awaited; avoids an unhandled rejection meanwhile
      return { end: start + count, summaries };
    };
    let inFlight: ReturnType<typeof launch> | undefined = launch();
    while (inFlight) {
      const queued: ReturnType<typeof launch> | undefined =
        next < spec.total && !stop.signal.aborted ? launch() : undefined;
      const summaries = await inFlight.summaries;
      if (stop.signal.aborted) return;
      for (const output of outputs) {
        const summary = summaries.get(output);
        if (summary) progress.accumulators.get(output)?.addSummary(summary);
      }
      progress.done = inFlight.end;
      report();
      inFlight = queued;
    }
  };

  try {
    const loops = [runEngine(primary, state.primary, 0)];
    if (secondary && state.secondary) loops.push(runEngine(secondary, state.secondary, 1));
    await Promise.all(
      loops.map((loop) =>
        loop.catch((error: unknown) => {
          stop.abort(); // one engine failing stops the other
          throw error;
        }),
      ),
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (stop.signal.aborted) throw new RunAbortedError("The run was cancelled");
  state.complete = true;
  updateComparison();
  report(true);
  return state;
}
