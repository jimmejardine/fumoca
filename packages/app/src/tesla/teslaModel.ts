import {
  type CellRef,
  createCellDimension,
  createScenario,
  createSensitivity,
  createSheet,
  type Scenario,
  type Sheet,
  type Workbook,
} from "@fumoca/storage";
import { ARK_SHEETS } from "./arkTesla.generated";

/**
 * Tesla's valuation in 2029: ARK Invest's model
 * (https://github.com/ARKInvest/ARK-Invest-Tesla-Valuation-Model), restructured for fumoca by
 * scripts/ark-tesla/generate.py. The logic is ARK's; its inputs are named distributions, its
 * business lines are sheets of their own, and fumoca's continuous Monte Carlo replaces ARK's
 * single-simulation sheet and 5,000-row data table.
 */
export function createTeslaWorkbook(): Workbook {
  const sheets: Sheet[] = [
    createSheet("About", ABOUT),
    ...ARK_SHEETS.map(({ name, cells, names }) => {
      const sheet = createSheet(name, { ...cells });
      return Object.keys(names).length > 0 ? { ...sheet, names: { ...names } } : sheet;
    }),
  ];
  return { sheets, scenarios: createTeslaScenarios(sheets) };
}

const ABOUT: Record<string, string> = {
  A1: "Tesla 2029: a Monte Carlo valuation",
  A3: "Based on ARK Invest's Tesla valuation model:",
  A4: "github.com/ARKInvest/ARK-Invest-Tesla-Valuation-Model (Tesla 2029 Valuation Extract)",
  A5: "The model's logic and inputs are ARK's, restructured for fumoca. With the same draws,",
  A6: "it computes every value of ARK's saved run (a 2029 share price of $2,309.46).",
  A8: "Inputs: each is normally distributed, clamped to its minimum and maximum. Edit the",
  A9: "ranges, or the Draw formulas, and every result updates.",
  A10: "EV, Capital, Insurance, Ride-hail, Storage, Optimus: the business lines, by year.",
  A11: "Valuation: consolidated results, enterprise value, and the 2029 share price.",
  A12: "Price tables: vehicle prices by volume, ride-hail prices by miles, robotaxi adoption.",
  A14: "Scenarios and Sensitivities, in the side panel, vary the key drivers.",
  A16: "ARK's disclosure: this is for informational purposes only and is not investment advice.",
  A17: "Forecasts are inherently limited and cannot be relied on.",
};

/** A named cell's location: names are unique across the workbook. */
function named(sheets: Sheet[], name: string): CellRef {
  for (const sheet of sheets) {
    const address = sheet.names?.[name];
    if (address) return { sheetId: sheet.id, address };
  }
  throw new Error(`The Tesla model has no cell named ${name}`);
}

/**
 * A scenario of robotaxi timing against how fast production can grow, and a sensitivity analysis
 * of the share price and the business lines' values to the model's key drivers.
 */
function createTeslaScenarios(sheets: Sheet[]): Scenario[] {
  const cell = (name: string) => named(sheets, name);
  const outputs = ["SharePrice2029", "RobotaxiValue", "ElectricVehicleValue"].map(cell);
  return [
    {
      ...createScenario("Robotaxi timing × production"),
      dimensions: [
        // The launch is drawn as years after 2025 (see the Inputs sheet).
        createCellDimension(cell("RobotaxiLaunchDelay"), [
          ["2026", 1],
          ["2028", 3],
          ["2030", 5],
        ]),
        createCellDimension(cell("MaxProductionIncrease"), [
          ["Slow", 0.2],
          ["Moderate", 0.4],
          ["Fast", 0.6],
        ]),
      ],
      outputs,
    },
    {
      ...createSensitivity("Tesla drivers"),
      inputs: [
        "AutonomousEbitdaMargin",
        "MilesPerRobotaxi",
        "TakeoverTime",
        "PartnerCutPerMile",
        "MaxProductionIncrease",
        "LearningRate",
        "MaxGrossMargin",
        "SegmentPenetration",
        "SgaShare",
      ].map(cell),
      steps: [0.1],
      outputs: [...outputs, cell("StorageValue")],
    },
  ];
}
