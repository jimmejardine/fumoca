import { playwright } from "@vitest/browser-playwright";
import { defineProject } from "vitest/config";

// On CI runners without a GPU, fall back to Chromium's software WebGPU adapter (SwiftShader).
const softwareGpu = process.env.CI
  ? ["--use-webgpu-adapter=swiftshader", "--enable-unsafe-swiftshader"]
  : [];

// GPU tests need a real browser with WebGPU, so this project runs in Chromium (SPECS.md §9.1).
// The full Chromium build ("chromium" channel, new headless mode) is required: Playwright's default
// headless shell exposes no WebGPU adapter.
export default defineProject({
  test: {
    name: "gpu",
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { channel: "chromium", args: ["--enable-unsafe-webgpu", ...softwareGpu] },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
