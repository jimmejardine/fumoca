import { compile, evaluateCpu, type RunOptions, summarizeBatch } from "@fumoca/engine";
import { afterEach, describe, expect, it } from "vitest";
import { CpuBackend, splitIterations } from "./cpu-backend";

const MODEL = compile({
  A1: "=NORMAL(100, 10)",
  A2: "=TRIANGULAR(1, 2, 6)",
  B1: "=A1 * A2 + IF(RAND() < 0.5, 1, -1)",
});

let backend: CpuBackend | undefined;
afterEach(() => backend?.dispose());

describe("splitIterations", () => {
  it("covers every iteration exactly once in contiguous blocks", () => {
    expect(splitIterations(10, 3)).toEqual([
      { start: 0, count: 4 },
      { start: 4, count: 3 },
      { start: 7, count: 3 },
    ]);
    expect(splitIterations(2, 4)).toEqual([
      { start: 0, count: 1 },
      { start: 1, count: 1 },
    ]);
  });
});

describe("CpuBackend", () => {
  it.each([1, 3, 4])("gives bit-identical results to one thread with %i worker(s)", async (n) => {
    backend = new CpuBackend({ workers: n });
    // An iteration count that doesn't divide evenly, starting at a non-zero iteration.
    const options: RunOptions = {
      seed: 99,
      iterationStart: 17,
      count: 10_007,
      outputs: ["A1", "B1"],
    };
    const expected = evaluateCpu(MODEL, options);
    const actual = await backend.run(MODEL, options);
    for (const address of options.outputs) {
      expect(actual.get(address)).toEqual(expected.get(address));
    }
  });

  it("runs several requests concurrently", async () => {
    backend = new CpuBackend({ workers: 2 });
    const options = (seed: number): RunOptions => ({
      seed,
      iterationStart: 0,
      count: 1000,
      outputs: ["B1"],
    });
    const [a, b] = await Promise.all([
      backend.run(MODEL, options(1)),
      backend.run(MODEL, options(2)),
    ]);
    expect(a.get("B1")).toEqual(evaluateCpu(MODEL, options(1)).get("B1"));
    expect(b.get("B1")).toEqual(evaluateCpu(MODEL, options(2)).get("B1"));
  });

  it("sends each program once, and resends one the workers have since dropped", async () => {
    backend = new CpuBackend({ workers: 2 });
    const options: RunOptions = { seed: 5, iterationStart: 0, count: 500, outputs: ["A1"] };
    const programs = Array.from({ length: 6 }, (_, i) => compile({ A1: `=NORMAL(${i}, 1)` }));
    for (const program of programs) {
      expect(await backend.run(program, options)).toEqual(evaluateCpu(program, options));
    }
    // The first program has been evicted from the workers' caches by now.
    const first = programs[0];
    if (!first) throw new Error("no program");
    expect(await backend.run(first, options)).toEqual(evaluateCpu(first, options));
  });

  it("summarizes inside the workers, matching a single-threaded summary", async () => {
    backend = new CpuBackend({ workers: 3 });
    const options: RunOptions = {
      seed: 8,
      iterationStart: 11,
      count: 20_003,
      outputs: ["A1", "B1"],
    };
    const summaries = await backend.runSummary(MODEL, options);
    const reference = evaluateCpu(MODEL, options);
    for (const output of options.outputs) {
      const expected = summarizeBatch(reference.get(output) ?? []);
      const actual = summaries.get(output);
      expect(actual?.count).toBe(expected.count);
      expect(actual?.mean).toBeCloseTo(expected.mean, 9);
      expect(actual?.m2).toBeCloseTo(expected.m2, 3);
    }
    expect(backend.maxSummaryBatch()).toBe(15_000);
  });

  it("reports errors from workers", async () => {
    backend = new CpuBackend({ workers: 2 });
    await expect(
      backend.run(MODEL, { seed: 1, iterationStart: 0, count: 10, outputs: ["Z9"] }),
    ).rejects.toThrow(/Unknown output cell Z9/);
  });

  it("defaults to all cores but one", () => {
    backend = new CpuBackend();
    expect(backend.workerCount).toBe(Math.max(1, navigator.hardwareConcurrency - 1));
  });

  it("rejects invalid worker counts and use after disposal", async () => {
    expect(() => new CpuBackend({ workers: 0 })).toThrow(RangeError);
    const disposed = new CpuBackend({ workers: 1 });
    disposed.dispose();
    await expect(
      disposed.run(MODEL, { seed: 1, iterationStart: 0, count: 1, outputs: ["A1"] }),
    ).rejects.toThrow(/disposed/);
  });
});
