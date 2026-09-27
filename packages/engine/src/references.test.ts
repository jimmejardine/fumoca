import { describe, expect, it } from "vitest";
import { formulaReferences } from "./parser";

const addresses = (text: string) => formulaReferences(text).map((r) => r.address);

describe("formulaReferences", () => {
  it("finds cell references with their spans in the text", () => {
    const text = "=A1 + b22 * $C$3";
    const references = formulaReferences(text);
    expect(references.map((r) => r.address)).toEqual(["A1", "B22", "C3"]);
    expect(references.map((r) => text.slice(r.start, r.end))).toEqual(["A1", "b22", "$C$3"]);
  });

  it("keeps repeats, in order", () => {
    expect(addresses("=A1 * A2 + A1")).toEqual(["A1", "A2", "A1"]);
  });

  it("finds references inside function calls", () => {
    expect(addresses("=NORMAL(B1, B2 / 10)")).toEqual(["B1", "B2"]);
  });

  it("has none for values, text and names", () => {
    expect(addresses("42")).toEqual([]);
    expect(addresses("A1")).toEqual([]);
    expect(addresses("=RAND() + PI()")).toEqual([]);
  });

  it("skips a series lookup's sheet name but keeps its time cell", () => {
    expect(addresses("=Q1[Rate]@2027 + Prices@A5")).toEqual(["A5"]);
    expect(addresses("=Q1@B2")).toEqual(["B2"]);
  });

  it("works on partly typed formulas", () => {
    expect(addresses("=A1 + ")).toEqual(["A1"]);
    expect(addresses("=SUM(A1, B")).toEqual(["A1"]);
    expect(addresses("=A1 + B2 # C3")).toEqual(["A1", "B2"]);
  });
});
