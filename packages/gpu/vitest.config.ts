import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "gpu",
    passWithNoTests: true,
  },
});
