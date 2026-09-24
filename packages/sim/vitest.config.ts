import { playwright } from "@vitest/browser-playwright";
import { defineProject } from "vitest/config";

// The CPU backend uses Web Workers, so its tests run in Chromium.
export default defineProject({
  test: {
    name: "sim",
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: "chromium" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
