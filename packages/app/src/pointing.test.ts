import { describe, expect, it } from "vitest";
import { insertReference } from "./pointing";

const at = (value: string, address: string, caret = value.length) =>
  insertReference(value, caret, caret, address)?.value ?? null;

describe("insertReference", () => {
  it("inserts where a reference can go", () => {
    expect(at("=", "B1")).toBe("=B1");
    expect(at("=B1*", "A1")).toBe("=B1*A1");
    expect(at("=SUM(", "A1")).toBe("=SUM(A1");
    expect(at("=MAX(A1, ", "A2")).toBe("=MAX(A1, A2");
    expect(at("=1 + ", "C3")).toBe("=1 + C3");
    expect(at("=A1 > ", "C3")).toBe("=A1 > C3");
  });

  it("inserts at the caret, not just at the end", () => {
    expect(at("=(+A1)", "B2", 2)).toBe("=(B2+A1)");
  });

  it("doesn't insert after a number or a reference, or into a value", () => {
    expect(at("=12", "A1")).toBeNull();
    expect(at("=A1", "B1")).toBeNull();
    expect(at("=SUM(A1)", "B1")).toBeNull();
    expect(at("hello", "A1")).toBeNull();
    expect(at("", "A1")).toBeNull();
  });

  it("replaces a selection", () => {
    expect(insertReference("=A1*B9", 4, 6, "C3")?.value).toBe("=A1*C3");
  });

  it("replaces the reference it just inserted on another click", () => {
    const first = insertReference("=B1*", 4, 4, "A1");
    expect(first?.value).toBe("=B1*A1");
    expect(first?.caret).toBe(6);
    const second = insertReference("=B1*A1", 6, 6, "A2", first?.inserted);
    expect(second?.value).toBe("=B1*A2");
    expect(second?.caret).toBe(6);
  });

  it("doesn't replace it once the text has changed", () => {
    const first = insertReference("=", 1, 1, "A1");
    expect(insertReference("=A1*", 4, 4, "B1", first?.inserted)?.value).toBe("=A1*B1");
    expect(insertReference("=A1", 3, 3, "B1", { start: 1, end: 3, value: "=A2" })).toBeNull();
  });
});
