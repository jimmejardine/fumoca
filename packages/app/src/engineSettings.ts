/**
 * Engine settings from the Config menu: iterations per recalculation on each engine, where 0
 * disables that engine. Saved per browser, not in the workbook.
 */
export interface EngineSettings {
  cpuIterations: number;
  gpuIterations: number;
}

export const DEFAULT_SETTINGS: EngineSettings = { cpuIterations: 10_000, gpuIterations: 100_000 };

/**
 * Runs go in batches, so memory no longer limits the total. Iteration numbers are 32-bit, and
 * random numbers would repeat beyond 2^32 iterations; one billion stays well clear of that.
 */
export const MAX_ITERATIONS = 1_000_000_000;

const STORAGE_KEY = "fumoca.engineSettings";

const isIterations = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_ITERATIONS;

/** Loads saved settings, falling back to the defaults for anything missing or invalid. */
export function loadSettings(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): EngineSettings {
  try {
    const saved = JSON.parse(
      storage?.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<EngineSettings> | null;
    return {
      cpuIterations: isIterations(saved?.cpuIterations)
        ? saved.cpuIterations
        : DEFAULT_SETTINGS.cpuIterations,
      gpuIterations: isIterations(saved?.gpuIterations)
        ? saved.gpuIterations
        : DEFAULT_SETTINGS.gpuIterations,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  settings: EngineSettings,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private browsing, blocked site data); settings still apply.
  }
}

/** Returns an error message if the settings can't be used, or null if they're fine. */
export function validateSettings(settings: EngineSettings, gpuAvailable: boolean): string | null {
  for (const [name, value] of [
    ["CPU", settings.cpuIterations],
    ["GPU", settings.gpuIterations],
  ] as const) {
    if (!isIterations(value)) {
      return `${name} iterations must be a whole number from 0 to ${MAX_ITERATIONS.toLocaleString("en-US")}`;
    }
  }
  const gpuRuns = gpuAvailable && settings.gpuIterations > 0;
  if (settings.cpuIterations === 0 && !gpuRuns) return "At least one engine must run";
  return null;
}
