import cpuWorkerUrl from "@fumoca/sim/worker?worker&url";
import type { Scenario, Workbook } from "@fumoca/storage";
import type { EngineSettings } from "../engineSettings";
import type { Recalculation } from "../recalc";
import type { ScenarioResults } from "../scenarioRun";
import type { EngineRequest, EngineResponse } from "./protocol";

export interface EngineUpdate {
  recalculation: Recalculation;
  /** Whether the shown results come from the GPU (otherwise the CPU). */
  primaryIsGpu: boolean;
}

export interface EngineRun {
  cancel(): void;
}

interface Listener {
  onUpdate?: (update: EngineUpdate) => void;
  onScenarioUpdate?: (results: ScenarioResults) => void;
  onError: (message: string) => void;
}

/**
 * The page's handle on the engine worker (SPECS.md §6.4). Recalculations run entirely in the
 * worker; this only posts the model and passes results on, so the page never blocks on a run.
 */
export class EngineClient {
  /** Resolves once the worker has started, with whether WebGPU is available to it. */
  readonly ready: Promise<{ gpuAvailable: boolean }>;
  private readonly worker: Worker;
  private readonly listeners = new Map<number, Listener>();
  private nextRunId = 0;

  constructor() {
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    // The page's bundle emits the CPU worker script; the engine worker starts its pool from it.
    this.post({ type: "init", cpuWorkerUrl: new URL(cpuWorkerUrl, location.href).href });
    let resolveReady: (value: { gpuAvailable: boolean }) => void = () => {};
    this.ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    this.worker.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
      if (data.type === "ready") {
        resolveReady({ gpuAvailable: data.gpuAvailable });
        return;
      }
      const listener = this.listeners.get(data.runId);
      if (!listener) return; // a cancelled run
      if (data.type === "error") {
        this.listeners.delete(data.runId);
        listener.onError(data.message);
        return;
      }
      if (data.type === "scenarioUpdate") {
        if (data.results.complete) this.listeners.delete(data.runId);
        listener.onScenarioUpdate?.(data.results);
        return;
      }
      if (data.recalculation.complete) this.listeners.delete(data.runId);
      listener.onUpdate?.({ recalculation: data.recalculation, primaryIsGpu: data.primaryIsGpu });
    };
  }

  /** Starts recalculating a workbook; a new run supersedes any earlier one. */
  run(
    workbook: Workbook,
    settings: EngineSettings,
    seed: number,
    onUpdate: (update: EngineUpdate) => void,
    onError: (message: string) => void,
  ): EngineRun {
    const runId = this.nextRunId++;
    this.listeners.clear(); // earlier runs are superseded
    this.listeners.set(runId, { onUpdate, onError });
    this.post({ type: "run", runId, workbook, settings, seed });
    return {
      cancel: () => {
        if (!this.listeners.delete(runId)) return;
        this.post({ type: "cancel", runId });
      },
    };
  }

  /**
   * Runs a scenario's Baseline and combinations (SPECS.md §7.3). Like `run`, it supersedes any
   * earlier run, including the grid's recalculation.
   */
  runScenario(
    workbook: Workbook,
    scenario: Scenario,
    settings: EngineSettings,
    seed: number,
    onUpdate: (results: ScenarioResults) => void,
    onError: (message: string) => void,
  ): EngineRun {
    const runId = this.nextRunId++;
    this.listeners.clear();
    this.listeners.set(runId, { onScenarioUpdate: onUpdate, onError });
    this.post({ type: "runScenario", runId, workbook, scenario, settings, seed });
    return {
      cancel: () => {
        if (!this.listeners.delete(runId)) return;
        this.post({ type: "cancel", runId });
      },
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.worker.terminate();
  }

  private post(request: EngineRequest): void {
    this.worker.postMessage(request);
  }
}
