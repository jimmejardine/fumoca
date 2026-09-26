import { GpuBackend } from "@fumoca/gpu";
import { CpuBackend } from "@fumoca/sim";
import {
  type EngineRun,
  type Engines,
  type RunningRecalculation,
  startRecalculation,
} from "../recalc";
import type { EngineRequest, EngineResponse } from "./protocol";

/**
 * The engine worker: runs recalculations off the page's main thread (SPECS.md §6.4). It creates
 * the GPU backend once, keeps a CPU worker pool while CPU iterations are enabled, and posts
 * results as batches arrive.
 */

/** The parts of a dedicated worker's global scope this module uses. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse): void;
}

const scope = self as unknown as WorkerScope;
const post = (message: EngineResponse) => scope.postMessage(message);

/** CPU iterations per worker in each raw batch: small enough that updates come often. */
const CPU_BATCH_PER_WORKER = 1_000;

const gpuReady = GpuBackend.create().catch(() => null);
let cpu: CpuBackend | null = null;
let cpuWorkerUrl: string | undefined;
let current: { runId: number; running: RunningRecalculation } | null = null;

void gpuReady.then((gpu) => post({ type: "ready", gpuAvailable: gpu !== null }));

async function run(request: Extract<EngineRequest, { type: "run" }>): Promise<void> {
  const { runId, workbook, settings, seed } = request;
  const gpu = await gpuReady;
  if (current?.runId !== runId) return; // superseded while waiting for the GPU

  if (settings.cpuIterations > 0) {
    cpu ??= new CpuBackend(cpuWorkerUrl ? { workerUrl: cpuWorkerUrl } : {});
  } else if (cpu) {
    cpu.dispose();
    cpu = null;
  }
  const gpuRun: EngineRun | null =
    gpu && settings.gpuIterations > 0
      ? { backend: gpu, count: settings.gpuIterations, f32: true }
      : null;
  const cpuRun: EngineRun | null =
    cpu && settings.cpuIterations > 0
      ? {
          backend: cpu,
          count: settings.cpuIterations,
          batch: CPU_BATCH_PER_WORKER * cpu.workerCount,
        }
      : null;
  const primary = gpuRun ?? cpuRun;
  if (!primary) {
    post({ type: "error", runId, message: "No engine is enabled" });
    return;
  }
  const engines: Engines = gpuRun && cpuRun ? { primary: gpuRun, secondary: cpuRun } : { primary };
  const primaryIsGpu = primary === gpuRun;

  const running = startRecalculation(workbook, engines, { seed }, (recalculation) =>
    post({ type: "update", runId, recalculation, primaryIsGpu }),
  );
  current = { runId, running };
  running.done.catch((error: unknown) =>
    post({ type: "error", runId, message: error instanceof Error ? error.message : String(error) }),
  );
}

scope.onmessage = ({ data: request }) => {
  if (request.type === "init") {
    cpuWorkerUrl = request.cpuWorkerUrl;
    return;
  }
  if (request.type === "cancel") {
    if (current?.runId === request.runId) {
      current.running.cancel();
      current = null;
    }
    return;
  }
  // A new run supersedes the current one.
  current?.running.cancel();
  current = { runId: request.runId, running: { cancel: () => {}, done: Promise.resolve(null) } };
  void run(request);
};
