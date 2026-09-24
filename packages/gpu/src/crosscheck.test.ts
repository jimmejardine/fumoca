import { type CellInputs, compile, type RunOptions } from "@fumoca/engine";
import { CpuBackend } from "@fumoca/sim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GpuBackend } from "./run";

/**
 * Runs the same model on the CPU (f64) and the GPU (f32) with the same seed, and compares them
 * iteration by iteration (SPECS.md §6.7). Both backends draw identical random inputs, so any
 * difference beyond f32 rounding is a bug in one of them.
 */

let cpu: CpuBackend;
let gpu: GpuBackend;

beforeAll(async () => {
  const backend = await GpuBackend.create();
  if (!backend) throw new Error("WebGPU is not available in this browser");
  gpu = backend;
  cpu = new CpuBackend();
});

afterAll(() => {
  cpu?.dispose();
  gpu?.dispose();
});

interface CellComparison {
  cell: string;
  maxRelativeError: number;
  mismatches: number;
  cpuMean: number;
  gpuMean: number;
}

/** Relative error with an absolute floor, so values near 0 aren't judged on relative error alone. */
function relativeError(cpu: number, gpu: number): number {
  return Math.abs(cpu - gpu) / Math.max(Math.abs(cpu), 1);
}

async function crossCheck(
  inputs: CellInputs,
  options: RunOptions,
  tolerance: number,
): Promise<CellComparison[]> {
  const program = compile(inputs);
  const cpuSamples = await cpu.run(program, options);
  const gpuSamples = await gpu.run(program, options);
  return options.outputs.map((cell) => {
    const c = cpuSamples.get(cell) ?? new Float64Array();
    const g = gpuSamples.get(cell) ?? new Float32Array();
    let maxRelativeError = 0;
    let mismatches = 0;
    let cpuSum = 0;
    let gpuSum = 0;
    for (let i = 0; i < options.count; i++) {
      const a = c[i] ?? Number.NaN;
      const b = g[i] ?? Number.NaN;
      const error = relativeError(a, b);
      if (!(error <= tolerance)) mismatches++;
      if (error > maxRelativeError) maxRelativeError = error;
      cpuSum += a;
      gpuSum += b;
    }
    return {
      cell,
      maxRelativeError,
      mismatches,
      cpuMean: cpuSum / options.count,
      gpuMean: gpuSum / options.count,
    };
  });
}

describe("CPU and GPU backends", () => {
  it("draw bit-identical uniform random numbers", async () => {
    const options = { seed: 12345, iterationStart: 0, count: 65536, outputs: ["A1", "A2"] };
    const program = compile({ A1: "=RAND()", A2: "=UNIFORM(0, 1)" });
    const cpuSamples = await cpu.run(program, options);
    const gpuSamples = await gpu.run(program, options);
    for (const cell of options.outputs) {
      expect(Array.from(gpuSamples.get(cell) ?? [])).toEqual(
        Array.from(cpuSamples.get(cell) ?? []),
      );
    }
  });

  it("agree iteration by iteration on a model using every supported function", async () => {
    const model: CellInputs = {
      A1: "=NORMAL(100, 10)",
      A2: "=UNIFORM(0.9, 1.1)",
      A3: "=LOGNORMAL(0, 0.25)",
      A4: "=TRIANGULAR(1, 2, 6)",
      A5: "=RAND()",
      B1: "=A1 * A2 - 5",
      B2: "=SQRT(ABS(B1)) + EXP(A3) - LN(A4)",
      B3: "=MAX(A1, 105) - MIN(A4, 3) + POWER(A2, 2) + A4^-1",
      B4: "=IF(A5 < 0.3, B1, B2 * 10)",
      B5: "=-A4^2 + 50%",
      B6: "=(A1 > 100) + (A4 <= 2) * 2 + (A5 = A5) * 4",
    };
    const outputs = Object.keys(model);
    const tolerance = 1e-4;
    const results = await crossCheck(
      model,
      { seed: 2026, iterationStart: 1000, count: 65536, outputs },
      tolerance,
    );
    console.log(
      results
        .map(
          (r) =>
            `${r.cell}: max relative error ${r.maxRelativeError.toExponential(2)}, ` +
            `mean CPU ${r.cpuMean.toFixed(6)} / GPU ${r.gpuMean.toFixed(6)}`,
        )
        .join("\n"),
    );

    for (const result of results) {
      expect(result.mismatches, `${result.cell} mismatches`).toBe(0);
      expect(result.maxRelativeError, `${result.cell} max relative error`).toBeLessThan(tolerance);
    }
  });

  it("evaluate deterministic cells on the GPU in every iteration", async () => {
    // No distributions: every iteration must produce the same value, on both backends.
    const model: CellInputs = {
      A1: 1250,
      A2: "=A1 * 1.08 - 40",
      A3: "=SQRT(A2) + LN(A1) - EXP(0.5)",
      A4: "=IF(A2 > 1000, MAX(A2, A3), MIN(A2, A3)) + 2^10 + 12.5%",
    };
    const outputs = Object.keys(model);
    const options = { seed: 1, iterationStart: 0, count: 1024, outputs };
    const program = compile(model);
    const cpuSamples = await cpu.run(program, options);
    const gpuSamples = await gpu.run(program, options);
    for (const cell of outputs) {
      const expected = cpuSamples.get(cell)?.[0] ?? Number.NaN;
      const values = gpuSamples.get(cell) ?? new Float32Array();
      expect(values.length).toBe(options.count);
      for (const value of values) {
        expect(value).toBe(values[0]);
        expect(relativeError(expected, value)).toBeLessThan(1e-6);
      }
    }
  });

  it("agree at iteration indices beyond 2^31", async () => {
    const [result] = await crossCheck(
      { A1: "=NORMAL(0, 1) * UNIFORM(1, 2)" },
      { seed: 7, iterationStart: 2 ** 31 + 5, count: 4096, outputs: ["A1"] },
      1e-4,
    );
    expect(result?.mismatches).toBe(0);
  });
});
