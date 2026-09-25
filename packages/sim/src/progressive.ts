import { type Backend, CellAccumulator, compareSamples, type Program } from "@fumoca/engine";

/**
 * Progressive runs (SPECS.md §6.3, §6.4): each engine evaluates the model in batches of
 * iterations, and every batch is folded into per-cell running statistics. Progress is reported a
 * few times a second, so results sharpen while the run continues. Memory stays bounded by the
 * batch size, however many iterations are asked for.
 */

export interface EngineSpec {
  backend: Backend;
  /** Total iterations to run on this engine. */
  total: number;
  /** Iterations per batch. Defaults to the backend's `maxBatch`, or 10,000. */
  batch?: number;
}

export interface ProgressiveOptions {
  outputs: string[];
  seed: number;
  /** The engine whose results are shown. */
  primary: EngineSpec;
  /** An engine to compare with the primary, iteration by iteration (SPECS.md §6.7). */
  secondary?: EngineSpec;
  histogramBins?: number;
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
  const { outputs, seed, primary, secondary, histogramBins = 64, throttleMs = 200 } = options;
  const stop = new AbortController();
  const abort = () => stop.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) stop.abort();

  const accumulators = () =>
    new Map(outputs.map((output) => [output, new CellAccumulator(histogramBins)]));
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
    const batch = Math.max(
      1,
      Math.floor(spec.batch ?? spec.backend.maxBatch?.(outputs.length) ?? DEFAULT_BATCH),
    );
    while (progress.done < spec.total) {
      if (stop.signal.aborted) return;
      const start = progress.done;
      const count = Math.min(batch, spec.total - start);
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
