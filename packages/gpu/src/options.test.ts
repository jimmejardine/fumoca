import { type CellInputs, compile, type RunOptions } from "@fumoca/engine";
import { CpuBackend } from "@fumoca/sim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GpuBackend } from "./run";

/**
 * Prices European call and put options by Monte Carlo on both backends, and checks the results
 * against the Black–Scholes closed-form prices.
 */

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (absolute error below 1.5e-7). */
function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

interface OptionParams {
  spot: number;
  strike: number;
  rate: number;
  volatility: number;
  years: number;
}

function blackScholes({ spot, strike, rate, volatility, years }: OptionParams) {
  const volRootT = volatility * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + volatility ** 2 / 2) * years) / volRootT;
  const d2 = d1 - volRootT;
  const discountedStrike = strike * Math.exp(-rate * years);
  return {
    call: spot * normalCdf(d1) - discountedStrike * normalCdf(d2),
    put: discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1),
  };
}

const PARAMS: OptionParams = { spot: 100, strike: 105, rate: 0.05, volatility: 0.2, years: 1 };

/** The option model as a spreadsheet, written the way a user would type it. */
const MODEL: CellInputs = {
  A1: PARAMS.spot,
  A2: PARAMS.strike,
  A3: PARAMS.rate,
  A4: PARAMS.volatility,
  A5: PARAMS.years,
  // Terminal stock price under geometric Brownian motion (Excel's LOGNORM parameters).
  B1: "=LOGNORMAL(LN(A1) + (A3 - A4^2/2)*A5, A4*SQRT(A5))",
  B2: "=EXP(-A3*A5) * MAX(B1 - A2, 0)", // discounted call payoff
  B3: "=EXP(-A3*A5) * MAX(A2 - B1, 0)", // discounted put payoff
  B4: "=EXP(-A3*A5) * B1", // discounted stock price: a martingale, so its mean is the spot
};
const OUTPUTS = ["B2", "B3", "B4"];

interface Estimate {
  mean: number;
  standardError: number;
}

function estimate(samples: ArrayLike<number>): Estimate {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] as number;
  const mean = sum / samples.length;
  let squares = 0;
  for (let i = 0; i < samples.length; i++) squares += ((samples[i] as number) - mean) ** 2;
  const sd = Math.sqrt(squares / (samples.length - 1));
  return { mean, standardError: sd / Math.sqrt(samples.length) };
}

/** Asserts a Monte Carlo estimate is within 4 standard errors of the exact value. */
function expectWithinStandardErrors(label: string, actual: Estimate, exact: number): void {
  const errors = Math.abs(actual.mean - exact) / actual.standardError;
  expect(
    errors,
    `${label}: ${actual.mean} vs exact ${exact} (±${actual.standardError})`,
  ).toBeLessThan(4);
}

function checkPrices(results: Map<string, ArrayLike<number>>, label: string): void {
  const exact = blackScholes(PARAMS);
  const call = estimate(results.get("B2") ?? []);
  const put = estimate(results.get("B3") ?? []);
  const stock = estimate(results.get("B4") ?? []);
  const show = (e: Estimate, exactValue: number) =>
    `${e.mean.toFixed(4)} ± ${e.standardError.toFixed(4)} (exact ${exactValue.toFixed(4)})`;
  console.log(
    `${label}: call ${show(call, exact.call)}, put ${show(put, exact.put)}, ` +
      `discounted stock ${show(stock, PARAMS.spot)}`,
  );
  expectWithinStandardErrors(`${label} call`, call, exact.call);
  expectWithinStandardErrors(`${label} put`, put, exact.put);
  expectWithinStandardErrors(`${label} discounted stock`, stock, PARAMS.spot);
  // Guard against a loose test: the estimates must be precise enough to mean something.
  expect(call.standardError).toBeLessThan(0.05);
}

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

describe("European option pricing vs Black–Scholes", () => {
  it("uses a correct closed-form reference", () => {
    // Textbook values for S=100, K=105, r=5%, σ=20%, T=1.
    const exact = blackScholes(PARAMS);
    expect(exact.call).toBeCloseTo(8.0214, 3);
    expect(exact.put).toBeCloseTo(7.9004, 3);
    // Put–call parity: C − P = S − K·e^(−rT).
    expect(exact.call - exact.put).toBeCloseTo(
      PARAMS.spot - PARAMS.strike * Math.exp(-PARAMS.rate * PARAMS.years),
      10,
    );
  });

  it("matches on the CPU", async () => {
    const options: RunOptions = { seed: 314, iterationStart: 0, count: 500_000, outputs: OUTPUTS };
    checkPrices(await cpu.run(compile(MODEL), options), "CPU");
  });

  it("matches on the GPU", async () => {
    const options: RunOptions = {
      seed: 314,
      iterationStart: 0,
      count: 4_000_000,
      outputs: OUTPUTS,
    };
    checkPrices(await gpu.run(compile(MODEL), options), "GPU");
  });
});
