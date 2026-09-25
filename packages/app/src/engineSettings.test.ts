import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings } from "./engineSettings";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("engine settings", () => {
  it("defaults to 10,000 CPU and 100,000 GPU iterations", () => {
    expect(loadSettings(memoryStorage())).toEqual({
      cpuIterations: 10_000,
      gpuIterations: 100_000,
    });
  });

  it("saves and loads", () => {
    const storage = memoryStorage();
    saveSettings({ cpuIterations: 5_000, gpuIterations: 0 }, storage);
    expect(loadSettings(storage)).toEqual({ cpuIterations: 5_000, gpuIterations: 0 });
  });

  it("falls back to defaults for invalid saved values", () => {
    const storage = memoryStorage({
      "fumoca.engineSettings": JSON.stringify({ cpuIterations: -3, gpuIterations: "lots" }),
    });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage({ "fumoca.engineSettings": "{not json" }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("requires at least one engine to run", () => {
    expect(validateSettings({ cpuIterations: 0, gpuIterations: 100 }, true)).toBeNull();
    expect(validateSettings({ cpuIterations: 0, gpuIterations: 100 }, false)).toBe(
      "At least one engine must run",
    );
    expect(validateSettings({ cpuIterations: 0, gpuIterations: 0 }, true)).toBe(
      "At least one engine must run",
    );
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(validateSettings({ cpuIterations: 1.5, gpuIterations: 0 }, true)).toMatch(
      /CPU iterations/,
    );
    expect(validateSettings({ cpuIterations: 10, gpuIterations: 2_000_000_000 }, true)).toMatch(
      /GPU iterations/,
    );
  });
});
