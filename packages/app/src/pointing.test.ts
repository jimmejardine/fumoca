import { describe, expect, it } from "vitest";
import { insertReference, moveReference } from "./pointing";

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

describe("moveReference", () => {
  const bounds = { columns: 26, rows: 200 };
  it("moves by whole cells", () => {
    expect(moveReference("B3", 0, -1, bounds)).toBe("B2");
    expect(moveReference("B3", 1, 0, bounds)).toBe("C3");
    expect(moveReference("B3", -1, 2, bounds)).toBe("A5");
  });

  it("stays within the grid", () => {
    expect(moveReference("A1", -1, -1, bounds)).toBe("A1");
    expect(moveReference("Z200", 1, 1, bounds)).toBe("Z200");
  });

  it("keeps the sheet of a cross-sheet reference", () => {
    expect(moveReference("Inputs!B3", 0, 1, bounds)).toBe("Inputs!B4");
    expect(moveReference("'My Sheet'!B3", 1, 0, bounds)).toBe("'My Sheet'!C3");
  });

  it("ignores text that isn't a reference", () => {
    expect(moveReference("SUM", 0, 1, bounds)).toBeNull();
  });
});
