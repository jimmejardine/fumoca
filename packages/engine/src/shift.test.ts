import { describe, expect, it } from "vitest";
import { compileSheet } from "./compile";
import { parseFormula, shiftFormula } from "./parser";

describe("shiftFormula", () => {
  it("moves relative references with the copy", () => {
    expect(shiftFormula("=A1 + B2", 0, 1)).toBe("=A2 + B3");
    expect(shiftFormula("=A1 * 2", 2, 3)).toBe("=C4 * 2");
    expect(shiftFormula("=SUM(A1, b2)", 1, 0)).toBe("=SUM(B1, C2)");
  });

  it("keeps $-anchored columns and rows", () => {
    expect(shiftFormula("=$A$1 + $A1 + A$1", 1, 1)).toBe("=$A$1 + $A2 + B$1");
  });

  it("moves references to other sheets and lookup times, but not lookup sheets", () => {
    expect(shiftFormula("=Inputs!B3 + 'My Sheet'!$C3", 1, 1)).toBe("=Inputs!C4 + 'My Sheet'!$C4");
    expect(shiftFormula("=Q1[Rate]@A5 + Prices@2026-01", 0, 1)).toBe(
      "=Q1[Rate]@A6 + Prices@2026-01",
    );
  });

  it("carries columns past Z", () => {
    expect(shiftFormula("=Z1", 1, 0)).toBe("=AA1");
    expect(shiftFormula("=AA1", -1, 0)).toBe("=Z1");
  });

  it("turns references moved off the grid into #REF!", () => {
    expect(shiftFormula("=A1 + B2", -1, 0)).toBe("=#REF! + A2");
    expect(shiftFormula("=Inputs!A1", 0, -1)).toBe("=#REF!");
    expect(parseFormula("=#REF! + 1")).toEqual({
      type: "binary",
      operator: "+",
      left: { type: "refError" },
      right: { type: "number", value: 1 },
    });
    const { errors } = compileSheet({ A1: "=#REF! + 1", A2: "=A1" });
    expect(errors.get("A1")?.code).toBe("#REF!");
    expect(errors.get("A2")?.code).toBe("#REF!");
  });

  it("leaves values, text and unmoved formulas alone", () => {
    expect(shiftFormula("42", 1, 1)).toBe("42");
    expect(shiftFormula("A1", 1, 1)).toBe("A1");
    expect(shiftFormula("=A1", 0, 0)).toBe("=A1");
    expect(shiftFormula("=RAND()", 3, 3)).toBe("=RAND()");
  });
});
