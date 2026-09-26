import {
  type Backend,
  compile,
  evaluateCpu,
  type RunOptions,
  summarizeBatch,
} from "@fumoca/engine";
import { describe, expect, it } from "vitest";
import { CpuBackend } from "./cpu-backend";
import {
  type ProgressState,
  RAW_ITERATIONS,
  RunAbortedError,
  runProgressively,
} from "./progressive";

const PROGRAM = compile({ A1: "=NORMAL(100, 10)", A2: "=A1 * 2", A3: 5 });
const OUTPUTS = ["A1", "A2", "A3"];

/** A backend that evaluates on this thread and records the batches it was asked for. */
function recordingBackend(transform?: (samples: Map<string, Float64Array>) => void) {
  const batches: { start: number; count: number }[] = [];
  const backend: Backend = {
    name: "recording",
    run: async (program, options: RunOptions) => {
      batches.push({ start: options.iterationStart, count: options.count });
      const samples = evaluateCpu(program, options);
      transform?.(samples);
      return samples;
    },
    dispose: () => {},
  };
  return { backend, batches };
}

describe("runProgressively", () => {
  it("runs contiguous batches up to the total, with a short last batch", async () => {
    const { backend, batches } = recordingBackend();
    const final = await runProgressively(
      PROGRAM,
      { outputs: OUTPUTS, seed: 1, primary: { backend, total: 2_500, batch: 1_000 } },
      () => {},
    );
    expect(batches).toEqual([
      { start: 0, count: 1_000 },
      { start: 1_000, count: 1_000 },
      { start: 2_000, count: 500 },
    ]);
    expect(final.complete).toBe(true);
    expect(final.primary.done).toBe(2_500);
    expect(final.primary.accumulators.get("A1")?.count).toBe(2_500);
  });

  it("gives the same statistics as one big run", async () => {
    const { backend } = recordingBackend();
    const final = await runProgressively(
      PROGRAM,
      { outputs: OUTPUTS, seed: 7, primary: { backend, total: 20_000, batch: 3_000 } },
      () => {},
    );
    const all = evaluateCpu(PROGRAM, {
      seed: 7,
      iterationStart: 0,
      count: 20_000,
      outputs: ["A2"],
    });
    const samples = Array.from(all.get("A2") ?? []);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const a2 = final.primary.accumulators.get("A2");
    expect(a2?.mean).toBeCloseTo(mean, 9);
    expect(final.primary.accumulators.get("A3")?.first).toBe(5);
  });

  it("reports progress that rises to complete", async () => {
    const { backend } = recordingBackend();
    const reports: { done: number; complete: boolean }[] = [];
    await runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 1,
        primary: { backend, total: 5_000, batch: 1_000 },
        throttleMs: 0,
      },
      (state: ProgressState) =>
        reports.push({ done: state.primary.done, complete: state.complete }),
    );
    expect(reports.map((r) => r.done)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 5_000]);
    expect(reports.at(-1)?.complete).toBe(true);
  });

  it("stops when aborted, and rejects with RunAbortedError", async () => {
    const { backend, batches } = recordingBackend();
    const controller = new AbortController();
    const run = runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 1,
        primary: { backend, total: 1_000_000, batch: 1_000 },
        throttleMs: 0,
        signal: controller.signal,
      },
      (state) => {
        if (state.primary.done >= 3_000) controller.abort();
      },
    );
    await expect(run).rejects.toThrow(RunAbortedError);
    expect(batches.length).toBeLessThanOrEqual(4);
  });

  it("compares engines over their shared iterations, in batches of different sizes", async () => {
    const primary = recordingBackend();
    const secondary = recordingBackend();
    const final = await runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 3,
        primary: { backend: primary.backend, total: 30_000, batch: 7_000 },
        secondary: { backend: secondary.backend, total: 10_000, batch: 1_500 },
      },
      () => {},
    );
    expect(final.comparison).toEqual({ compared: 10_000, total: 10_000, differing: [] });
    expect(final.secondary?.done).toBe(10_000);
  });

  it("catches an engine that gets a cell wrong", async () => {
    const primary = recordingBackend((samples) => {
      const a2 = samples.get("A2");
      if (a2) for (let i = 0; i < a2.length; i++) a2[i] = (a2[i] ?? 0) + 1;
    });
    const secondary = recordingBackend();
    const final = await runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 3,
        primary: { backend: primary.backend, total: 5_000, batch: 2_000 },
        secondary: { backend: secondary.backend, total: 5_000, batch: 900 },
      },
      () => {},
    );
    expect(final.comparison?.differing).toEqual(["A2"]);
  });

  it("works with the real CPU worker pool", async () => {
    const backend = new CpuBackend({ workers: 3 });
    try {
      const final = await runProgressively(
        PROGRAM,
        { outputs: OUTPUTS, seed: 2, primary: { backend, total: 12_345, batch: 4_000 } },
        () => {},
      );
      const whole = evaluateCpu(PROGRAM, {
        seed: 2,
        iterationStart: 0,
        count: 12_345,
        outputs: ["A1"],
      });
      const samples = Array.from(whole.get("A1") ?? []);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(final.primary.accumulators.get("A1")?.mean).toBeCloseTo(mean, 9);
    } finally {
      backend.dispose();
    }
  });

  it("switches a summarizing backend to summaries after the raw iterations", async () => {
    const calls: { kind: string; start: number; count: number }[] = [];
    const backend: Backend = {
      name: "summarizing",
      run: async (program, options) => {
        calls.push({ kind: "raw", start: options.iterationStart, count: options.count });
        return evaluateCpu(program, options);
      },
      runSummary: async (program, options) => {
        calls.push({ kind: "summary", start: options.iterationStart, count: options.count });
        const samples = evaluateCpu(program, options);
        return new Map([...samples].map(([output, values]) => [output, summarizeBatch(values)]));
      },
      dispose: () => {},
    };
    const total = RAW_ITERATIONS + 300_000;
    const final = await runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 4,
        primary: { backend, total, batch: 100_000, summaryBatch: 120_000 },
      },
      () => {},
    );
    // Raw batches start small and double up to the batch size, so first results come quickly.
    expect(calls).toEqual([
      { kind: "raw", start: 0, count: 8_192 },
      { kind: "raw", start: 8_192, count: 16_384 },
      { kind: "raw", start: 24_576, count: 32_768 },
      { kind: "raw", start: 57_344, count: 65_536 },
      { kind: "raw", start: 122_880, count: 100_000 },
      { kind: "raw", start: 222_880, count: RAW_ITERATIONS - 222_880 },
      { kind: "summary", start: RAW_ITERATIONS, count: 120_000 },
      { kind: "summary", start: RAW_ITERATIONS + 120_000, count: 120_000 },
      { kind: "summary", start: RAW_ITERATIONS + 240_000, count: 60_000 },
    ]);
    // Same statistics as one run over every iteration; the histogram covers the raw samples.
    const all = evaluateCpu(PROGRAM, { seed: 4, iterationStart: 0, count: total, outputs: ["A2"] });
    const reference = summarizeBatch(all.get("A2") ?? []);
    const a2 = final.primary.accumulators.get("A2");
    expect(a2?.count).toBe(total);
    expect(a2?.mean).toBeCloseTo(reference.mean, 9);
    expect(a2?.sd).toBeCloseTo(Math.sqrt(reference.m2 / (total - 1)), 9);
    expect(a2?.histogram.total).toBe(RAW_ITERATIONS);
    expect(final.primary.accumulators.get("A3")?.first).toBe(5);
  });

  it("stops queuing summary batches when aborted", async () => {
    let summaries = 0;
    const controller = new AbortController();
    const backend: Backend = {
      name: "summarizing",
      run: async (program, options) => evaluateCpu(program, options),
      runSummary: async (program, options) => {
        summaries++;
        const samples = evaluateCpu(program, { ...options, count: 10 });
        return new Map([...samples].map(([output, values]) => [output, summarizeBatch(values)]));
      },
      dispose: () => {},
    };
    const run = runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 1,
        primary: { backend, total: 1_000_000_000, batch: RAW_ITERATIONS, summaryBatch: 1_000 },
        throttleMs: 0,
        signal: controller.signal,
      },
      (state) => {
        if (state.primary.done > RAW_ITERATIONS + 5_000) controller.abort();
      },
    );
    await expect(run).rejects.toThrow(RunAbortedError);
    expect(summaries).toBeLessThan(20);
  });

  it("keeps running raw batches while the summary path is still being prepared", async () => {
    const calls: string[] = [];
    let ready: () => void = () => {};
    const preparing = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const backend: Backend = {
      name: "compiling",
      run: async (program, options) => {
        calls.push("raw");
        // The summary path becomes ready once well past the usual raw iterations.
        if (options.iterationStart >= RAW_ITERATIONS * 2) ready();
        return evaluateCpu(program, options);
      },
      runSummary: async (program, options) => {
        calls.push("summary");
        const samples = evaluateCpu(program, options);
        return new Map([...samples].map(([output, values]) => [output, summarizeBatch(values)]));
      },
      prepare: () => preparing,
      dispose: () => {},
    };
    const total = RAW_ITERATIONS * 4;
    const final = await runProgressively(
      PROGRAM,
      {
        outputs: OUTPUTS,
        seed: 1,
        primary: { backend, total, batch: 65_536, summaryBatch: 100_000 },
      },
      () => {},
    );
    expect(final.primary.done).toBe(total);
    const firstSummary = calls.indexOf("summary");
    expect(firstSummary).toBeGreaterThan(0);
    expect(calls.slice(firstSummary).every((c) => c === "summary")).toBe(true);
    // More raw iterations than usual ran while it was preparing.
    expect(final.primary.accumulators.get("A1")?.histogram.total).toBeGreaterThan(RAW_ITERATIONS);
  });
});
