import { createSheet, type Workbook } from "@fumoca/storage";

/**
 * The test model we use to evaluate progress. Each sheet exercises one area of the engine.
 * Sheets don't refer to each other yet, because cross-sheet references aren't supported.
 */
export function createTestWorkbook(): Workbook {
  return {
    sheets: [
      createSheet("Option pricing", {
        A1: "Spot",
        B1: 100,
        A2: "Strike",
        B2: 105,
        A3: "Rate",
        B3: 0.05,
        A4: "Volatility",
        B4: 0.2,
        A5: "Years",
        B5: 1,
        A7: "Terminal price",
        B7: "=LOGNORMAL(LN(B1) + (B3 - B4^2/2)*B5, B4*SQRT(B5))",
        A8: "Call (discounted payoff)",
        B8: "=EXP(-B3*B5) * MAX(B7 - B2, 0)",
        A9: "Put (discounted payoff)",
        B9: "=EXP(-B3*B5) * MAX(B2 - B7, 0)",
        A10: "Discounted stock",
        B10: "=EXP(-B3*B5) * B7",
        A12: "Black–Scholes call (exact)",
        B12: 8.0214,
        A13: "Black–Scholes put (exact)",
        B13: 7.9004,
      }),
      createSheet("Functions", {
        A1: "Normal",
        B1: "=NORMAL(100, 10)",
        A2: "Uniform",
        B2: "=UNIFORM(0.9, 1.1)",
        A3: "Lognormal",
        B3: "=LOGNORMAL(0, 0.25)",
        A4: "Triangular",
        B4: "=TRIANGULAR(1, 2, 6)",
        A5: "Rand",
        B5: "=RAND()",
        A7: "Arithmetic",
        B7: "=B1 * B2 - 5",
        A8: "SQRT, ABS, EXP, LN",
        B8: "=SQRT(ABS(B7)) + EXP(B3) - LN(B4)",
        A9: "MAX, MIN, POWER, ^",
        B9: "=MAX(B1, 105) - MIN(B4, 3) + POWER(B2, 2) + B4^-1",
        A10: "IF",
        B10: "=IF(B5 < 0.3, B7, B8 * 10)",
        A11: "Unary minus, %",
        B11: "=-B4^2 + 50%",
        A12: "Comparisons",
        B12: "=(B1 > 100) + (B4 <= 2) * 2 + (B5 = B5) * 4",
      }),
      createSheet("Deterministic", {
        A1: "Base",
        B1: 1250,
        A2: "Adjusted",
        B2: "=B1 * 1.08 - 40",
        A3: "Functions",
        B3: "=SQRT(B2) + LN(B1) - EXP(0.5)",
        A4: "IF and powers",
        B4: "=IF(B2 > 1000, MAX(B2, B3), MIN(B2, B3)) + 2^10 + 12.5%",
      }),
    ],
  };
}
