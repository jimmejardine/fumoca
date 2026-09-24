import { type Backend, outputRegisters, type Program, type RunOptions } from "@fumoca/engine";
import { generateWgsl, WORKGROUP_SIZE } from "./wgsl";

/** The largest batch a single one-dimensional dispatch can cover. */
const MAX_COUNT = 65535 * WORKGROUP_SIZE;

/** Requests a WebGPU device, or returns null when WebGPU isn't available. */
async function requestGpuDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === "undefined" || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  return adapter ? adapter.requestDevice() : null;
}

/** Evaluates a program on the GPU in f32, returning the samples of each output cell. */
async function runGpu(
  device: GPUDevice,
  program: Program,
  options: RunOptions,
): Promise<Map<string, Float32Array>> {
  const { seed, iterationStart, count, outputs } = options;
  if (count < 1 || count > MAX_COUNT) {
    throw new RangeError(`count must be between 1 and ${MAX_COUNT}`);
  }
  const code = generateWgsl(program, outputRegisters(program, outputs));

  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    await device.popErrorScope();
    const details = errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n");
    throw new Error(`WGSL compilation failed:\n${details}\n\n${code}`);
  }
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });

  const outputBytes = outputs.length * count * Float32Array.BYTES_PER_ELEMENT;
  const params = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const out = device.createBuffer({
    size: outputBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: outputBytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  try {
    device.queue.writeBuffer(
      params,
      0,
      new Uint32Array([seed >>> 0, iterationStart >>> 0, count, 0]),
    );
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: out } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(out, 0, readback, 0, outputBytes);
    device.queue.submit([encoder.finish()]);

    const validation = await device.popErrorScope();
    if (validation) throw new Error(`WebGPU validation error: ${validation.message}`);

    await readback.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return new Map(
      outputs.map((address, k) => [address, all.subarray(k * count, (k + 1) * count)]),
    );
  } finally {
    params.destroy();
    out.destroy();
    readback.destroy();
  }
}

/**
 * The GPU backend: compiles the model to a WGSL kernel and evaluates it in f32 on WebGPU
 * (SPECS.md §6.6). It has the same signature as `CpuBackend`, so the two can be compared
 * iteration by iteration (§6.7).
 */
export class GpuBackend implements Backend {
  readonly name = "gpu";

  private constructor(readonly device: GPUDevice) {}

  /** Creates a GPU backend, or returns null when WebGPU isn't available. */
  static async create(): Promise<GpuBackend | null> {
    const device = await requestGpuDevice();
    return device ? new GpuBackend(device) : null;
  }

  run(program: Program, options: RunOptions): Promise<Map<string, Float32Array>> {
    return runGpu(this.device, program, options);
  }

  dispose(): void {
    this.device.destroy();
  }
}
