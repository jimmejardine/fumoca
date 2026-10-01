import {
  combinationCount,
  createScenario,
  createSensitivity,
  type Scenario,
  type SensitivityAnalysis,
  type WhatIfScenario,
  type Workbook,
} from "@fumoca/storage";
import type { ReactNode } from "react";
import { ScenarioResultsView, type ScenarioRunState } from "./ScenarioResults";
import { describeSensitivityCount, SensitivityDefinition } from "./SensitivityDefinition";
import { SensitivityResultsView } from "./SensitivityResults";
import type { ScenarioResults } from "./scenarioRun";
import { describeWhatIfCount, WhatIfDefinition } from "./WhatIfDefinition";

/** Above this many combinations, running is flagged as a lot of work (SPECS.md §7.3). */
export const MANY_COMBINATIONS = 1000;

/**
 * What differs between kinds of scenario. Everything else — the window, its name and outputs, the
 * run controls, running, saving and the side panel's list — is shared, and works for every kind.
 */
export interface ScenarioKind<S extends Scenario> {
  /** What one is called in messages: "scenario". */
  noun: string;
  /** New ones are named this, numbered: "Scenario1". */
  namePrefix: string;
  /** What each run after the Baseline is called: "combination". */
  unit: string;
  runLabel: string;
  samplesLabel: string;
  /** Shown in place of results before the first run. */
  placeholder: string;
  /** What's missing when it can't run yet. */
  hint: string;
  create: (name: string) => S;
  ready: (scenario: S) => boolean;
  count: (scenario: S) => { text: string; warn: boolean };
  Definition: (props: {
    scenario: S;
    workbook: Workbook;
    onChange: (scenario: Scenario) => void;
  }) => ReactNode;
  Results: (props: {
    workbook: Workbook;
    run: ScenarioRunState<S>;
    results: ScenarioResults;
  }) => ReactNode;
}

const whatIf: ScenarioKind<WhatIfScenario> = {
  noun: "scenario",
  namePrefix: "Scenario",
  unit: "combination",
  runLabel: "Run scenario",
  samplesLabel: "Samples per combination",
  placeholder: "Define dimensions and outputs, then run the scenario to see its results here.",
  hint: "Add a dimension with alternatives, and an output, to run it.",
  create: createScenario,
  ready: (scenario) => combinationCount(scenario) > 0 && scenario.outputs.length > 0,
  count: (scenario) => ({
    text: describeWhatIfCount(scenario),
    warn: combinationCount(scenario) > MANY_COMBINATIONS,
  }),
  Definition: WhatIfDefinition,
  Results: ScenarioResultsView,
};

const sensitivity: ScenarioKind<SensitivityAnalysis> = {
  noun: "analysis",
  namePrefix: "Sensitivity",
  unit: "run",
  runLabel: "Run analysis",
  samplesLabel: "Samples per run",
  placeholder: "Pick inputs and outputs, then run the analysis to see its results here.",
  hint: "Add an input and an output to run it.",
  create: createSensitivity,
  ready: (analysis) => analysis.inputs.length > 0 && analysis.outputs.length > 0,
  count: (analysis) => ({
    text: describeSensitivityCount(analysis),
    warn: combinationCount(analysis) > MANY_COMBINATIONS,
  }),
  Definition: SensitivityDefinition,
  Results: SensitivityResultsView,
};

type Kinds = { [K in Scenario["kind"]]: ScenarioKind<Extract<Scenario, { kind: K }>> };

export const SCENARIO_KINDS: Kinds = { scenario: whatIf, sensitivity };

/** The kind of a scenario, typed for it. */
export const kindOf = <S extends Scenario>(scenario: S) =>
  SCENARIO_KINDS[scenario.kind] as unknown as ScenarioKind<S>;
