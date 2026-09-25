import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Each page runs a CPU worker pool on all cores but one, so keep parallel pages few.
  workers: 4,
  use: { baseURL: "http://localhost:4173" },
  projects: [
    // Playwright's headless shell has no WebGPU, so these tests exercise the CPU engine.
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@gpu/ },
    // Full Chromium exposes WebGPU (SwiftShader's software adapter on CI), for tests tagged @gpu.
    {
      name: "chromium-webgpu",
      grep: /@gpu/,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: {
          args: [
            "--enable-unsafe-webgpu",
            ...(process.env.CI
              ? ["--use-webgpu-adapter=swiftshader", "--enable-unsafe-swiftshader"]
              : []),
          ],
        },
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
});
