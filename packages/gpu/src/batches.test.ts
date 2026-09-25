import { type CellInputs, compile } from "@fumoca/engine";
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
  it("run 1,000,000 iterations of 60 output cells, compiling the pipeline once", async () => {
    // 60 × 1,000,000 f32 samples is 240 MB: more than one storage binding may hold, so this only
    // works in batches.
    const cells: CellInputs = { A1: "=NORMAL(0, 1)" };
    for (let i = 2; i <= 60; i++) cells[`A${i}`] = `=A${i - 1} + NORMAL(0, 1)`;
    const program = compile(cells);
    const outputs = Object.keys(cells);
    expect(gpu.maxBatch(outputs.length)).toBeLessThan(1_000_000);

    const before = gpu.pipelinesCompiled;
    const final = await runProgressively(
      program,
      { outputs, seed: 11, primary: { backend: gpu, total: 1_000_000 } },
      () => {},
    );
    expect(gpu.pipelinesCompiled - before).toBe(1);
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
});
