import { type CellInputs, compile, evaluateCpu, summarizeBatch } from "@fumoca/engine";
import { runProgressively } from "@fumoca/sim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GpuBackend } from "./run";

let gpu: GpuBackend;

beforeAll(async () => {
  const backend = await GpuBackend.create();
  if (!backend) throw new Error("WebGPU is not available in this browser");
  gpu = backend;
});

afterAll(() => gpu?.dispose());

describe("GPU batches", () => {
  it("run 1,000,000 iterations of 60 output cells, compiling pipelines only once", async () => {
    // 60 × 1,000,000 f32 samples is 240 MB: more than one storage binding may hold, so this only
    // works in batches.
    const cells: CellInputs = { A1: "=NORMAL(0, 1)" };
    for (let i = 2; i <= 60; i++) cells[`A${i}`] = `=A${i - 1} + NORMAL(0, 1)`;
    const program = compile(cells);
    const outputs = Object.keys(cells);
    expect(gpu.maxBatch(outputs.length)).toBeLessThan(1_000_000);

    const run = () =>
      runProgressively(
        program,
        { outputs, seed: 11, primary: { backend: gpu, total: 1_000_000 } },
        () => {},
      );
    const final = await run();
    // Running the same program again reuses the raw-sample, summary and merge pipelines.
    const compiled = gpu.pipelinesCompiled;
    await run();
    expect(gpu.pipelinesCompiled).toBe(compiled);
    expect(final.primary.done).toBe(1_000_000);
    // A60 is a sum of 60 independent standard normals: mean 0, SD √60.
    const a60 = final.primary.accumulators.get("A60");
    expect(a60?.count).toBe(1_000_000);
    expect(Math.abs(a60?.mean ?? Number.NaN)).toBeLessThan(0.05);
    expect(a60?.sd).toBeCloseTo(Math.sqrt(60), 1);
  });

  it("refuses a single run larger than a batch", async () => {
    const program = compile({ A1: "=RAND()" });
    const limit = gpu.maxBatch(1);
    await expect(
      gpu.run(program, { seed: 1, iterationStart: 0, count: limit + 1, outputs: ["A1"] }),
    ).rejects.toThrow(/run larger counts in batches/);
  });

  it("reduces on the GPU to the same statistics as the CPU", async () => {
    const cells: CellInputs = {
      A1: "=NORMAL(100, 10)",
      A2: "=A1 * UNIFORM(0.9, 1.1) - 50",
      A3: "=LOGNORMAL(0, 0.5)",
      A4: "=LN(NORMAL(0.5, 1))", // NaN when the normal draw is negative
      A5: "=1 / 0", // infinite
      A6: 42, // deterministic
      A7: "=IF(RAND() < 0.3, A1, -A1)",
    };
    const program = compile(cells);
    const outputs = Object.keys(cells);
    // A count that isn't a multiple of 64, starting part-way through.
    const options = { seed: 21, iterationStart: 1_000_003, count: 500_001, outputs };
    const gpuSummaries = await gpu.runSummary(program, options);
    const cpuSamples = evaluateCpu(program, options);
    for (const output of outputs) {
      const expected = summarizeBatch(cpuSamples.get(output) ?? []);
      const actual = gpuSummaries.get(output);
      if (!actual) throw new Error(`no summary for ${output}`);
      expect(actual.count, output).toBe(expected.count);
      expect(actual.nanCount, output).toBe(expected.nanCount);
      expect(actual.infiniteCount, output).toBe(expected.infiniteCount);
      if (expected.count === 0) continue;
      const sd = Math.sqrt(expected.m2 / Math.max(1, expected.count - 1));
      const scale = Math.max(1, Math.abs(expected.mean), sd);
      expect(Math.abs(actual.mean - expected.mean) / scale, `${output} mean`).toBeLessThan(1e-5);
      const actualSd = Math.sqrt(actual.m2 / Math.max(1, actual.count - 1));
      expect(Math.abs(actualSd - sd) / scale, `${output} SD`).toBeLessThan(1e-4);
    }
  });

  it("summarizes 4 million iterations per batch", async () => {
    const program = compile({ A1: "=NORMAL(0, 1)" });
    const batch = gpu.maxSummaryBatch(1);
    expect(batch).toBe(4_194_304);
    const summary = (
      await gpu.runSummary(program, {
        seed: 1,
        iterationStart: 0,
        count: batch,
        outputs: ["A1"],
      })
    ).get("A1");
    expect(summary?.count).toBe(batch);
    expect(Math.abs(summary?.mean ?? 1)).toBeLessThan(0.002);
    expect(Math.sqrt((summary?.m2 ?? 0) / batch)).toBeCloseTo(1, 2);
  });
});
