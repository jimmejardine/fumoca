import {
  type Backend,
  type BatchSummary,
  outputRegisters,
  type Program,
  type RunOptions,
} from "@fumoca/engine";
import {
  constantValues,
  generateSummaryWgsl,
  generateWgsl,
  ITERATIONS_PER_THREAD,
  REDUCE_WGSL,
  SUMMARY_FIELDS,
  WORKGROUP_SIZE,
} from "./wgsl";

/** The largest batch a single one-dimensional dispatch can cover. */
const MAX_DISPATCH = 65535 * WORKGROUP_SIZE;

/** Raw-sample batches bigger than this gain little and make progress updates less frequent. */
const MAX_BATCH = 262_144;

/** Threads per summary batch: 65,536 threads × 64 iterations = 4,194,304 iterations. */
const MAX_SUMMARY_THREADS = 65_536;

/**
 * Requests a WebGPU device, or returns null when WebGPU isn't available. Asks for the adapter's
 * full storage-buffer limits: the defaults (128 MB bindings) are far below what most GPUs allow.
 */
async function requestGpuDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  return adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
}

/** Compiled pipelines kept, most recently used last. */
const PIPELINE_CACHE_SIZE = 16;

interface Prepared {
  rawCode: string;
  summaryCode: string;
  consts: Float32Array;
}

/**
 * The GPU backend: compiles the model to a WGSL kernel and evaluates it in f32 on WebGPU
 * (SPECS.md §6.6). It has the same signature as `CpuBackend`, so the two can be compared
 * iteration by iteration (§6.7).
 *
 * Two ways to run a batch:
 * - `run` returns every raw sample (needed for histograms and the CPU/GPU comparison);
 * - `runSummary` reduces on the GPU and returns only each output's count, mean, M2 and NaN and
 *   infinity counts, so almost nothing crosses back to the host and the GPU stays busy.
 *
 * Compiled pipelines are cached per program and output list, so repeated batches skip WGSL
 * generation and shader compilation.
 */
export class GpuBackend implements Backend {
  readonly name = "gpu";
  /** How many pipelines have been compiled (for tests and diagnostics). */
  pipelinesCompiled = 0;
  private readonly pipelines = new Map<string, Promise<GPUComputePipeline>>();
  private readonly prepared = new WeakMap<Program, Map<string, Prepared>>();
  private reducePipeline: Promise<GPUComputePipeline> | undefined;

  private constructor(readonly device: GPUDevice) {}

  /** Creates a GPU backend, or returns null when WebGPU isn't available. */
  static async create(): Promise<GpuBackend | null> {
    const device = await requestGpuDevice();
    return device ? new GpuBackend(device) : null;
  }

  /** The largest `run` batch whose output (outputs × iterations × 4 bytes) fits one binding. */
  maxBatch(outputCount: number): number {
    const bytesPerIteration = Math.max(1, outputCount) * Float32Array.BYTES_PER_ELEMENT;
    const fits = Math.floor(this.device.limits.maxStorageBufferBindingSize / bytesPerIteration);
    return Math.max(1, Math.min(MAX_DISPATCH, MAX_BATCH, fits));
  }

  /** The largest `runSummary` batch whose partial summaries fit one storage binding. */
  maxSummaryBatch(outputCount: number): number {
    const bytesPerThread =
      Math.max(1, outputCount) * SUMMARY_FIELDS * Float32Array.BYTES_PER_ELEMENT;
    const threads = Math.min(
      MAX_SUMMARY_THREADS,
      Math.floor(this.device.limits.maxStorageBufferBindingSize / bytesPerThread),
    );
    return Math.max(1, threads) * ITERATIONS_PER_THREAD;
  }

  /**
   * Starts compiling a program's pipelines in the background, and resolves when the summary path
   * (summary and merge kernels) is ready. Runs call this first, so the summary kernel compiles
   * while raw batches are already going.
   */
  async prepare(program: Program, outputs: string[]): Promise<void> {
    const prepared = this.shaders(program, outputs);
    void this.pipelineFor(prepared.rawCode);
    await Promise.all([this.pipelineFor(prepared.summaryCode), this.reduce()]);
  }

  /** Evaluates iterations of a program in f32, returning the samples of each output cell. */
  async run(program: Program, options: RunOptions): Promise<Map<string, Float32Array>> {
    const { device } = this;
    const { seed, iterationStart, count, outputs } = options;
    const limit = this.maxBatch(outputs.length);
    if (count < 1 || count > limit) {
      throw new RangeError(
        `count must be between 1 and ${limit} for ${outputs.length} outputs; run larger counts in batches`,
      );
    }
    const prepared = this.shaders(program, outputs);
    const pipeline = await this.pipelineFor(prepared.rawCode);

    const outputBytes = outputs.length * count * Float32Array.BYTES_PER_ELEMENT;
    const params = this.uniform(new Uint32Array([seed >>> 0, iterationStart >>> 0, count, 0]));
    const consts = this.constantsBuffer(prepared.consts);
    const out = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: outputBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    try {
      device.pushErrorScope("validation");
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bindGroup(pipeline, [params, out, consts]));
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(out, 0, readback, 0, outputBytes);
      device.queue.submit([encoder.finish()]);
      await this.checkValidation();

      await readback.mapAsync(GPUMapMode.READ);
      const all = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return new Map(
        outputs.map((address, k) => [address, all.subarray(k * count, (k + 1) * count)]),
      );
    } finally {
      consts.destroy();
      params.destroy();
      out.destroy();
      readback.destroy();
    }
  }

  /**
   * Evaluates iterations and reduces them on the GPU (SPECS.md §6.6): each thread folds 64
   * iterations into per-output running statistics, then a second pass merges all threads'
   * partials. Only outputs × 5 floats are read back, however many iterations ran.
   */
  async runSummary(program: Program, options: RunOptions): Promise<Map<string, BatchSummary>> {
    const { device } = this;
    const { seed, iterationStart, count, outputs } = options;
    const limit = this.maxSummaryBatch(outputs.length);
    if (count < 1 || count > limit || outputs.length === 0) {
      throw new RangeError(
        `count must be between 1 and ${limit} for ${outputs.length} outputs; run larger counts in batches`,
      );
    }
    const prepared = this.shaders(program, outputs);
    const [summaryPipeline, reducePipeline] = await Promise.all([
      this.pipelineFor(prepared.summaryCode),
      this.reduce(),
    ]);
    const consts = this.constantsBuffer(prepared.consts);

    const threads = Math.ceil(count / ITERATIONS_PER_THREAD);
    const partialBytes = outputs.length * threads * SUMMARY_FIELDS * Float32Array.BYTES_PER_ELEMENT;
    const resultBytes = outputs.length * SUMMARY_FIELDS * Float32Array.BYTES_PER_ELEMENT;
    const summaryParams = this.uniform(
      new Uint32Array([seed >>> 0, iterationStart >>> 0, count, threads]),
    );
    const reduceParams = this.uniform(new Uint32Array([threads, 0, 0, 0]));
    const partials = device.createBuffer({ size: partialBytes, usage: GPUBufferUsage.STORAGE });
    const result = device.createBuffer({
      size: resultBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: resultBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    try {
      device.pushErrorScope("validation");
      const encoder = device.createCommandEncoder();
      const summaryPass = encoder.beginComputePass();
      summaryPass.setPipeline(summaryPipeline);
      summaryPass.setBindGroup(
        0,
        this.bindGroup(summaryPipeline, [summaryParams, partials, consts]),
      );
      summaryPass.dispatchWorkgroups(Math.ceil(threads / WORKGROUP_SIZE));
      summaryPass.end();
      const reducePass = encoder.beginComputePass();
      reducePass.setPipeline(reducePipeline);
      reducePass.setBindGroup(0, this.bindGroup(reducePipeline, [reduceParams, partials, result]));
      reducePass.dispatchWorkgroups(outputs.length);
      reducePass.end();
      encoder.copyBufferToBuffer(result, 0, readback, 0, resultBytes);
      device.queue.submit([encoder.finish()]);
      await this.checkValidation();

      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return new Map(
        outputs.map((address, k) => {
          const base = k * SUMMARY_FIELDS;
          return [
            address,
            {
              count: values[base] ?? 0,
              mean: values[base + 1] ?? 0,
              m2: values[base + 2] ?? 0,
              nanCount: values[base + 3] ?? 0,
              infiniteCount: values[base + 4] ?? 0,
            },
          ];
        }),
      );
    } finally {
      consts.destroy();
      summaryParams.destroy();
      reduceParams.destroy();
      partials.destroy();
      result.destroy();
      readback.destroy();
    }
  }

  dispose(): void {
    this.device.destroy();
  }

  /** The merge pipeline for summary partials; the same for every program. */
  private reduce(): Promise<GPUComputePipeline> {
    if (!this.reducePipeline) this.reducePipeline = this.compile(REDUCE_WGSL, "reduce");
    return this.reducePipeline;
  }

  private uniform(data: Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private bindGroup(pipeline: GPUComputePipeline, buffers: GPUBuffer[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  private async checkValidation(): Promise<void> {
    const validation = await this.device.popErrorScope();
    if (validation) throw new Error(`WebGPU validation error: ${validation.message}`);
  }

  /** A program's generated shaders and constants for an output list, prepared once. */
  private shaders(program: Program, outputs: string[]): Prepared {
    let byOutputs = this.prepared.get(program);
    if (!byOutputs) {
      byOutputs = new Map();
      this.prepared.set(program, byOutputs);
    }
    const key = outputs.join("\u0000");
    let prepared = byOutputs.get(key);
    if (!prepared) {
      const regs = outputRegisters(program, outputs);
      prepared = {
        rawCode: generateWgsl(program, regs),
        summaryCode: generateSummaryWgsl(program, regs),
        consts: constantValues(program),
      };
      byOutputs.set(key, prepared);
    }
    return prepared;
  }

  /**
   * The compiled pipeline for a shader, keyed by its source. Constants aren't part of the source,
   * so editing a value reuses the pipeline; only structural edits compile a new one.
   */
  private pipelineFor(code: string): Promise<GPUComputePipeline> {
    let pipeline = this.pipelines.get(code);
    if (pipeline) {
      // Most recently used goes last.
      this.pipelines.delete(code);
      this.pipelines.set(code, pipeline);
      return pipeline;
    }
    pipeline = this.compile(code, "main");
    this.pipelines.set(code, pipeline);
    pipeline.catch(() => this.pipelines.delete(code)); // a failed compile isn't cached
    while (this.pipelines.size > PIPELINE_CACHE_SIZE) {
      const oldest = this.pipelines.keys().next().value;
      if (oldest === undefined) break;
      this.pipelines.delete(oldest);
    }
    return pipeline;
  }

  private constantsBuffer(values: Float32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, values);
    return buffer;
  }

  /**
   * Compiles a pipeline in the background (`createComputePipelineAsync`), so a compile never
   * blocks the thread running batches. Error scopes aren't used here: they form a stack, and
   * compiles overlap with batches.
   */
  private async compile(code: string, entryPoint: string): Promise<GPUComputePipeline> {
    const module = this.device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      const details = errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n");
      throw new Error(`WGSL compilation failed:\n${details}\n\n${code}`);
    }
    const pipeline = await this.device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint },
    });
    this.pipelinesCompiled++;
    return pipeline;
  }
}
