import { describe, expect, it } from "vitest";
import { ENGINE_NAME } from "./index";

describe("engine package", () => {
  it("is importable", () => {
    expect(ENGINE_NAME).toBe("fumoca-engine");
  });
});
