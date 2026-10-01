import {
  createScenario,
  createSensitivity,
  createSheet,
  type Dimension,
  type Scenario,
  type Sheet,
  type Workbook,
} from "@fumoca/storage";

/**
 * The test model we use to evaluate progress. Each sheet exercises one area of the engine.
 * The Lookups sheet reads values from the Prices series sheet (SPECS.md §5.3), and the scenarios
 * (SPECS.md §7) vary the option and deterministic inputs.
 */
export function createTestWorkbook(): Workbook {
  const sheets = createTestSheets().map((sheet) =>
    sheet.name === "Option pricing"
      ? { ...sheet, names: { Spot: "B1", Strike: "B2", Rate: "B3", Volatility: "B4", Years: "B5" } }
      : sheet,
  );
  return { sheets, scenarios: createTestScenarios(sheets) };
}

function createTestSheets(): Sheet[] {
  return [
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
      A12: "d1",
      B12: "=(LN(B1/B2) + (B3 + B4^2/2)*B5) / (B4*SQRT(B5))",
      A13: "d2",
      B13: "=B12 - B4*SQRT(B5)",
      A14: "Black–Scholes call (exact)",
      B14: "=B1*NORM.S.DIST(B12, TRUE) - B2*EXP(-B3*B5)*NORM.S.DIST(B13, TRUE)",
      A15: "Black–Scholes put (exact)",
      B15: "=B2*EXP(-B3*B5)*NORM.S.DIST(-B13, TRUE) - B1*NORM.S.DIST(-B12, TRUE)",
      A17: "Call: Monte Carlo − exact",
      B17: "=B8 - B14",
      A18: "Put: Monte Carlo − exact",
      B18: "=B9 - B15",
      A19: "Discounted stock − spot",
      B19: "=B10 - B1",
      // Uses the inputs' names (SPECS.md §4.1).
      A21: "Forward price",
      B21: "=Spot * EXP(Rate * Years)",
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
      A13: "NORM.S.DIST, NORMSDIST",
      B13: "=NORM.S.DIST((B1 - 100) / 10, TRUE) + NORM.S.DIST(B3 - 1, FALSE) + NORMSDIST(-B4)",
      // Sums of independent normals are normal: means add, variances add.
      A15: "Sums of normals",
      B15: "Simulated",
      C15: "Expected",
      A16: "X",
      B16: "=NORMAL(10, 3)",
      C16: "N(10, 3)",
      A17: "Y",
      B17: "=NORMAL(20, 4)",
      C17: "N(20, 4)",
      A18: "X + Y",
      B18: "=B16 + B17",
      C18: "N(30, 5): σ = √(3² + 4²)",
      A19: "X − Y",
      B19: "=B16 - B17",
      C19: "N(−10, 5)",
      A20: "2X + 3",
      B20: "=2*B16 + 3",
      C20: "N(23, 6)",
      A21: "X + X (same draw)",
      B21: "=B16 + B16",
      C21: "N(20, 6): the same draw twice is 2X",
      A22: "X + an independent N(10, 3)",
      B22: "=B16 + NORMAL(10, 3)",
      C22: "N(20, 4.243): σ = 3√2",
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
    createSheet(
      "Prices",
      {
        A1: "2026-01",
        B1: 100,
        C1: 101.5,
        A2: "2026-02",
        B2: 101.5,
        C2: 99.8,
        A3: "2026-03",
        B3: 99.8,
        C3: 103.2,
        A4: "2026-04",
        B4: 103.2,
        C4: 104.0,
        A5: "2026-05",
        B5: 104.0,
        C5: 102.7,
        A6: "2026-06",
        B6: 102.7,
        C6: "=NORMAL(105, 3)",
      },
      { granularity: "month", type: "level", columns: ["Open", "Close"] },
    ),
    createSheet("Lookups", {
      A1: "Lookup",
      B1: "Result",
      C1: "Expected",
      A2: "Close in 2026-03",
      B2: "=Prices[Close]@2026-03",
      C2: "103.2",
      A3: "First column (Open), 2026-02",
      B3: "=Prices@2026-02",
      C3: "101.5",
      A4: "Period in a cell",
      B4: "2026-05",
      A5: "Close at the period in B4",
      B5: "=Prices[Close]@B4",
      C5: "102.7",
      A6: "Close − Open, 2026-04",
      B6: "=Prices[Close]@2026-04 - Prices[Open]@2026-04",
      C6: "0.8",
      A7: "Uncertain close, 2026-06, × 2",
      B7: "=Prices[Close]@2026-06 * 2",
      C7: "210 ± 6",
      A8: "Period not in Prices",
      B8: "=Prices[Close]@2027-01",
      C8: "#N/A",
      A9: "Quarter in a monthly sheet",
      B9: "=Prices[Close]@2026-Q1",
      C9: "#N/A",
    }),
  ];
}

/** A single-cell dimension over `alternatives`, given as [label, input] pairs. */
const cellDimension = (
  sheet: Sheet,
  address: string,
  alternatives: [string, number | string][],
): Dimension => ({
  id: crypto.randomUUID(),
  kind: "cell",
  cell: { sheetId: sheet.id, address },
  alternatives: alternatives.map(([label, input]) => ({ label, input })),
});

/**
 * Scenarios to check the results view by eye:
 * - Option sensitivity: volatility × strike. The Monte Carlo prices sit beside the exact
 *   Black–Scholes call, which they should match within sampling error.
 * - Market regimes: a group moving spot, rate and volatility together (the stressed spot is
 *   itself a distribution), crossed with the time to expiry.
 * - Deterministic check: exact values that can be checked by hand; B2 = B1 × 1.08 − 40.
 * - Option drivers: a sensitivity analysis of the option prices to each Black–Scholes input. The
 *   exact prices' elasticities have closed forms to check the Monte Carlo ones against.
 */
function createTestScenarios(sheets: Sheet[]): Scenario[] {
  const [options, , deterministic] = sheets;
  if (!options || !deterministic) return [];
  const on = (sheet: Sheet, address: string) => ({ sheetId: sheet.id, address });
  return [
    {
      ...createScenario("Option sensitivity"),
      dimensions: [
        cellDimension(options, "B4", [
          ["Low vol", 0.1],
          ["Base vol", 0.2],
          ["High vol", 0.3],
        ]),
        cellDimension(options, "B2", [
          ["", 95],
          ["", 105],
          ["", 115],
        ]),
      ],
      outputs: [on(options, "B8"), on(options, "B14"), on(options, "B9")],
    },
    {
      ...createScenario("Market regimes"),
      dimensions: [
        {
          id: crypto.randomUUID(),
          kind: "group",
          name: "Regime",
          cells: [on(options, "B1"), on(options, "B3"), on(options, "B4")],
          variants: [
            { label: "Calm", inputs: [100, 0.03, 0.15] },
            { label: "Stressed", inputs: ["=NORMAL(90, 5)", 0.01, 0.4] },
            { label: "Boom", inputs: [110, 0.06, null] },
          ],
        },
        cellDimension(options, "B5", [
          ["6 months", 0.5],
          ["1 year", 1],
          ["2 years", 2],
        ]),
      ],
      outputs: [on(options, "B8"), on(options, "B9"), on(options, "B10")],
    },
    {
      ...createScenario("Deterministic check"),
      dimensions: [
        cellDimension(deterministic, "B1", [
          ["", 1000],
          ["", 1250],
          ["", 1500],
        ]),
      ],
      outputs: [on(deterministic, "B2"), on(deterministic, "B4")],
    },
    {
      ...createSensitivity("Option drivers"),
      inputs: ["B1", "B2", "B3", "B4", "B5"].map((address) => on(options, address)),
      outputs: [on(options, "B8"), on(options, "B9"), on(options, "B14"), on(options, "B15")],
    },
  ];
}
