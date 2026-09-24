import { describe, expect, it } from "vitest";
import { type CellInputs, CompileError, compile } from "./compile";
import { evaluateCpu } from "./cpu";

/** Evaluates a deterministic model once and returns the value of one cell. */
function evaluate(inputs: CellInputs, address: string): number {
  const samples = evaluateCpu(compile(inputs), {
    seed: 1,
    iterationStart: 0,
    count: 1,
    outputs: [address],
  });
  return samples.get(address)?.[0] ?? Number.NaN;
}

const value = (formula: string): number => evaluate({ A1: formula }, "A1");

describe("formula evaluation", () => {
  it.each([
    ["=1+2*3", 7],
    ["=(1+2)*3", 9],
    ["=10-4-3", 3],
    ["=2^3^2", 64], // ^ is left-associative in Excel
    ["=-2^2", 4], // unary minus binds tighter than ^ in Excel
    ["=2^-1", 0.5],
    ["=(-2)^3", -8],
    ["=50%", 0.5],
    ["=200*10%", 20],
    ["=1.5e2", 150],
    ["=.25*4", 1],
    ["=SQRT(16)+ABS(-3)", 7],
    ["=LN(EXP(2))", 2],
    ["=POWER(3, 2)", 9],
    ["=MIN(4, 2, 8)+MAX(1, 7, 3)", 9],
    ["=IF(2>1, 10, 20)", 10],
    ["=IF(2<1, 10, 20)", 20],
    ["=IF(0, 10)", 0],
    ["=(1=1)+(1<>1)+(2>=2)+(3<=2)", 2],
    ["=sqrt(9)", 3], // function names are case-insensitive
  ])("%s = %d", (formula, expected) => {
    expect(value(formula)).toBeCloseTo(expected, 12);
  });

  it("follows references in any order", () => {
    expect(evaluate({ C1: "=B1*2", A1: 5, B1: "=A1+1" }, "C1")).toBe(12);
  });

  it("accepts absolute and lower-case references", () => {
    expect(evaluate({ A1: 3, B1: "=$A$1+a1" }, "B1")).toBe(6);
  });

  it("reads empty cells as 0", () => {
    expect(evaluate({ A1: "=Z99+1" }, "A1")).toBe(1);
  });

  it("allows text labels but not references to them", () => {
    expect(evaluate({ A1: "Spot price", B1: 100, B2: "=B1*2" }, "B2")).toBe(200);
    expect(() => compile({ A1: "Spot price", B1: "=A1*2" })).toThrow(/refers to text in A1/);
  });

  it("reports circular references", () => {
    expect(() => compile({ A1: "=B1", B1: "=C1", C1: "=A1" })).toThrow(/Circular reference/);
  });

  it("reports unknown functions and wrong argument counts", () => {
    expect(() => compile({ A1: "=FOO(1)" })).toThrow(CompileError);
    expect(() => compile({ A1: "=NORMAL(1)" })).toThrow(/takes 2 argument/);
    expect(() => compile({ A1: "=IF(1)" })).toThrow(/takes 2–3 argument/);
  });

  it("reports syntax errors with the cell address", () => {
    expect(() => compile({ B2: "=1+" })).toThrow(/B2: Unexpected end of formula/);
    expect(() => compile({ B2: "=(1+2" })).toThrow(/Expected '\)'/);
  });
});
