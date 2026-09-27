import { describe, expect, it } from "vitest";
import { dependencyColor, dependencyHue, GOLDEN_ANGLE, referenceColors } from "./dependencyColors";

describe("dependency colours", () => {
  it("step around the colour wheel by the golden angle", () => {
    expect(GOLDEN_ANGLE).toBeCloseTo(137.508, 3);
    for (let i = 0; i < 20; i++) {
      const step = (dependencyHue(i + 1) - dependencyHue(i) + 360) % 360;
      expect(step).toBeCloseTo(GOLDEN_ANGLE, 6);
    }
  });

  it("are deterministic", () => {
    expect(dependencyColor(3, "light")).toBe(dependencyColor(3, "light"));
    expect(dependencyColor(0, "light")).toBe("hsl(0.0 75% 42%)");
    expect(dependencyColor(0, "dark")).toBe("hsl(0.0 80% 65%)");
  });

  it("keep the selection's blue out of the first eight", () => {
    for (let i = 0; i < 8; i++) expect(Math.abs(dependencyHue(i) - 210)).toBeGreaterThan(15);
  });

  it("keep the first eight hues well apart", () => {
    const hues = Array.from({ length: 8 }, (_, i) => dependencyHue(i));
    for (const [i, a] of hues.entries()) {
      for (const b of hues.slice(i + 1)) {
        const distance = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
        expect(distance).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it("colour each referenced cell once, in order of first appearance", () => {
    const colors = referenceColors("=B2 * A1 + B2", "light");
    expect([...colors.keys()]).toEqual(["B2", "A1"]);
    expect(colors.get("B2")).toBe(dependencyColor(0, "light"));
    expect(colors.get("A1")).toBe(dependencyColor(1, "light"));
    expect(referenceColors("42", "light").size).toBe(0);
  });
});
