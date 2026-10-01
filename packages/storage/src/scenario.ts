/**
 * Scenarios (SPECS.md §7): "what if?" questions across combinations of alternative cell inputs.
 * A scenario never changes the workbook; its alternatives override cells only while it runs.
 */

/** A cell on a sheet of the workbook. */
export interface CellRef {
  sheetId: string;
  address: string;
}

/** A cell input: a number, or text (a formula when it starts with "="). */
export type CellInput = number | string;

/** One alternative of a single-cell dimension. The label is optional ("" for none). */
export interface Alternative {
  label: string;
  input: CellInput;
}

/** A dimension that varies one cell over a list of alternatives. */
export interface CellDimension {
  id: string;
  kind: "cell";
  /** The cell, or null until one is picked. */
  cell: CellRef | null;
  alternatives: Alternative[];
}

/**
 * A variant of a group dimension: a named set of inputs, one per cell of the group, in order.
 * A null input leaves that cell as it is in the workbook.
 */
export interface Variant {
  label: string;
  inputs: (CellInput | null)[];
}

/** A dimension that changes several cells together, one named variant at a time. */
export interface GroupDimension {
  id: string;
  kind: "group";
  name: string;
  cells: CellRef[];
  variants: Variant[];
}

export type Dimension = CellDimension | GroupDimension;

/** What every kind of scenario has: a name, the output cells it reports, and its run size. */
export interface ScenarioBase {
  id: string;
  name: string;
  outputs: CellRef[];
  /** Monte Carlo iterations per combination. */
  samples: number;
}

/** A what-if scenario (SPECS.md §7.1): the combinations of its dimensions' alternatives. */
export interface WhatIfScenario extends ScenarioBase {
  kind: "scenario";
  dimensions: Dimension[];
}

/**
 * A sensitivity analysis (SPECS.md §7.5): each input in turn scaled down and up by each step (for
 * example ±1%), with every other input left as it is.
 */
export interface SensitivityAnalysis extends ScenarioBase {
  kind: "sensitivity";
  inputs: CellRef[];
  /** The changes to test, as fractions: 0.01 tests −1% and +1%. */
  steps: number[];
}

/** Any kind of scenario. Each kind generates its own combinations (see `combinations`). */
export type Scenario = WhatIfScenario | SensitivityAnalysis;

export const DEFAULT_SCENARIO_SAMPLES = 10_000;

export function createScenario(name: string): WhatIfScenario {
  return {
    id: crypto.randomUUID(),
    kind: "scenario",
    name,
    dimensions: [],
    outputs: [],
    samples: DEFAULT_SCENARIO_SAMPLES,
  };
}

export const DEFAULT_SENSITIVITY_STEP = 0.01;

export function createSensitivity(name: string): SensitivityAnalysis {
  return {
    id: crypto.randomUUID(),
    kind: "sensitivity",
    name,
    inputs: [],
    outputs: [],
    steps: [DEFAULT_SENSITIVITY_STEP],
    samples: DEFAULT_SCENARIO_SAMPLES,
  };
}

export const createCellDimension = (): CellDimension => ({
  id: crypto.randomUUID(),
  kind: "cell",
  cell: null,
  alternatives: [],
});

export const createGroupDimension = (name: string): GroupDimension => ({
  id: crypto.randomUUID(),
  kind: "group",
  name,
  cells: [],
  variants: [],
});

/** The number of alternatives a dimension contributes to the combinations. */
export const dimensionSize = (dimension: Dimension) =>
  dimension.kind === "cell" ? dimension.alternatives.length : dimension.variants.length;

/** The number of combinations a scenario runs (not counting the Baseline). */
export function combinationCount(scenario: Scenario): number {
  return scenario.kind === "scenario"
    ? whatIfCount(scenario)
    : 2 * scenario.inputs.length * scenario.steps.length;
}

function whatIfCount(scenario: WhatIfScenario): number {
  const sized = scenario.dimensions.filter((d) => dimensionSize(d) > 0);
  return sized.length === 0 ? 0 : sized.reduce((n, d) => n * dimensionSize(d), 1);
}

/** The label shown for alternative `index` of a dimension: its label, or its input. */
export function alternativeLabel(dimension: Dimension, index: number): string {
  if (dimension.kind === "group") return dimension.variants[index]?.label ?? "";
  const alternative = dimension.alternatives[index];
  return alternative ? alternative.label || String(alternative.input) : "";
}

/**
 * A cell's input replaced while a combination runs: by another input, or by its own input scaled
 * by a factor (`=(its formula) * scale`, which scales a distribution's every sample).
 */
export type Override = { cell: CellRef; input: CellInput } | { cell: CellRef; scale: number };

/** One combination of a scenario: an alternative index per dimension, and its cell overrides. */
export interface Combination {
  /** The chosen alternative of each dimension, by dimension id. */
  choices: Map<string, number>;
  overrides: Override[];
}

/**
 * Every combination of a scenario's alternatives: the Cartesian product over its dimensions, in
 * order, with the last dimension varying fastest. Dimensions without alternatives (or a cell) are
 * skipped.
 */
export function combinations(scenario: Scenario): Combination[] {
  return scenario.kind === "scenario"
    ? whatIfCombinations(scenario)
    : sensitivityCombinations(scenario);
}

/** Where a sensitivity analysis's run is in `combinations`: input-major, then step, then −/+. */
export const sensitivityIndex = (
  analysis: Pick<SensitivityAnalysis, "steps">,
  input: number,
  step: number,
  sign: -1 | 1,
) => (input * analysis.steps.length + step) * 2 + (sign > 0 ? 1 : 0);

/**
 * A sensitivity analysis's runs: each input scaled by 1 − h and 1 + h for each step h, in the
 * order of `sensitivityIndex`. Choices record the input, step and sign (−1 or 1).
 */
function sensitivityCombinations(analysis: SensitivityAnalysis): Combination[] {
  return analysis.inputs.flatMap((cell, input) =>
    analysis.steps.flatMap((h, step) =>
      ([-1, 1] as const).map((sign) => ({
        choices: new Map([
          ["input", input],
          ["step", step],
          ["sign", sign],
        ]),
        overrides: [{ cell, scale: 1 + sign * h }],
      })),
    ),
  );
}

function whatIfCombinations(scenario: WhatIfScenario): Combination[] {
  const dimensions = scenario.dimensions.filter(
    (d) => dimensionSize(d) > 0 && (d.kind === "group" || d.cell !== null),
  );
  if (dimensions.length === 0) return [];
  let result: Combination[] = [{ choices: new Map(), overrides: [] }];
  for (const dimension of dimensions) {
    const next: Combination[] = [];
    for (const partial of result) {
      for (let i = 0; i < dimensionSize(dimension); i++) {
        const overrides = [...partial.overrides];
        if (dimension.kind === "cell") {
          const input = dimension.alternatives[i]?.input;
          if (dimension.cell && input !== undefined)
            overrides.push({ cell: dimension.cell, input });
        } else {
          dimension.cells.forEach((cell, c) => {
            const input = dimension.variants[i]?.inputs[c];
            if (input !== undefined && input !== null) overrides.push({ cell, input });
          });
        }
        next.push({ choices: new Map([...partial.choices, [dimension.id, i]]), overrides });
      }
    }
    result = next;
  }
  return result;
}

const sameCell = (a: CellRef, b: CellRef) => a.sheetId === b.sheetId && a.address === b.address;

/** The cells a scenario's dimensions override, each with the dimension it belongs to. */
function dimensionCells(scenario: WhatIfScenario): { cell: CellRef; dimension: Dimension }[] {
  return scenario.dimensions.flatMap((dimension): { cell: CellRef; dimension: Dimension }[] =>
    dimension.kind === "cell"
      ? dimension.cell
        ? [{ cell: dimension.cell, dimension }]
        : []
      : dimension.cells.map((cell) => ({ cell, dimension })),
  );
}

/** Whether a cell already belongs to one of the scenario's dimensions (other than `except`). */
export function cellInDimension(scenario: WhatIfScenario, cell: CellRef, except?: string): boolean {
  return dimensionCells(scenario).some(
    (entry) => entry.dimension.id !== except && sameCell(entry.cell, cell),
  );
}
