import { evaluateCpu, type Program, summarizeBatch } from "@fumoca/engine";
import { PROGRAM_CACHE_SIZE, type WorkerRequest, type WorkerResponse } from "./protocol";

/** The parts of a dedicated worker's global scope this module uses. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Programs received from the main thread, oldest first. */
const programs = new Map<number, Program>();

scope.onmessage = ({ data: request }) => {
  if (request.type === "program") {
    programs.set(request.programId, request.program);
    while (programs.size > PROGRAM_CACHE_SIZE) {
      const oldest = programs.keys().next().value;
      if (oldest === undefined) break;
      programs.delete(oldest);
    }
    return;
  }

  const { id, programId, options } = request;
  try {
    const program = programs.get(programId);
    if (!program) throw new Error(`Worker has no program ${programId}`);
    const samples = evaluateCpu(program, options);
    if (request.type === "runSummary") {
      // Reduce here, so only a few numbers per output go back.
      const summaries = new Map(
        [...samples].map(([output, values]) => [output, summarizeBatch(values)]),
      );
      scope.postMessage({ id, summaries }, []);
      return;
    }
    // Transfer the sample buffers rather than copying them (SPECS.md §6.4).
    const buffers = [...samples.values()].map((array) => array.buffer);
    scope.postMessage({ id, samples }, buffers);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
