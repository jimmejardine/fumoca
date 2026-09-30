import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // Each page runs a CPU worker pool on all cores but one, so keep parallel pages few.
  workers: 4,
  // Playwright defaults to the terse "dot" reporter on CI. List each test with its time instead,
  // annotate failures on the run, and write an HTML report that CI uploads.
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
  // Stop before CI's job timeout (30 minutes), so a hang still ends with a report saying where.
  globalTimeout: process.env.CI ? 20 * 60_000 : undefined,
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
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
    // Vite runs directly, not through pnpm: on Linux CI the stop signal didn't reach a server behind
    // pnpm, so Playwright waited for it forever after the tests had passed.
    command: "vite build && vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
