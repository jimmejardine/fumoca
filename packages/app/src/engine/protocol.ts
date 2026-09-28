import type { Scenario, Workbook } from "@fumoca/storage";
import type { EngineSettings } from "../engineSettings";
import type { Recalculation } from "../recalc";
import type { ScenarioResults } from "../scenarioRun";

/**
 * Messages between the page and the engine worker (SPECS.md §6.4). The worker owns the GPU and the
 * CPU worker pool, compiles and runs the model, and folds every batch; the page only sends the
 * model and receives compact results to display, so it stays responsive while a run goes on.
 */
export type EngineRequest =
  /** Sent first: where the bundled CPU worker script is, for the worker pool. */
  | { type: "init"; cpuWorkerUrl: string }
  | { type: "run"; runId: number; workbook: Workbook; settings: EngineSettings; seed: number }
  /** Runs a scenario's Baseline and combinations (SPECS.md §7.3), superseding any other run. */
  | {
      type: "runScenario";
      runId: number;
      workbook: Workbook;
      scenario: Scenario;
      settings: EngineSettings;
      seed: number;
    }
  | { type: "cancel"; runId: number };

export type EngineResponse =
  /** Sent once when the worker has started, saying whether WebGPU is available to it. */
  | { type: "ready"; gpuAvailable: boolean }
  /** Results so far; `recalculation.complete` marks the last update of a run. */
  | { type: "update"; runId: number; recalculation: Recalculation; primaryIsGpu: boolean }
  /** A scenario's results so far; `results.complete` marks the last update. */
  | { type: "scenarioUpdate"; runId: number; results: ScenarioResults }
  | { type: "error"; runId: number; message: string };
