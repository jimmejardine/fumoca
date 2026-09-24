import { evaluateCpu } from "@fumoca/engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/** The parts of a dedicated worker's global scope this module uses. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = ({ data: { id, program, options } }) => {
  try {
    const samples = evaluateCpu(program, options);
    // Transfer the sample buffers rather than copying them (SPECS.md §6.4).
    const buffers = [...samples.values()].map((array) => array.buffer);
    scope.postMessage({ id, samples }, buffers);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
