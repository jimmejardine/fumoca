import { describe, expect, it } from "vitest";
import { uncertainCells } from "./analysis";
import { compileSheet } from "./compile";
import { evaluateCpu } from "./cpu";

const codes = (inputs: Parameters<typeof compileSheet>[0]) =>
  Object.fromEntries([...compileSheet(inputs).errors].map(([address, e]) => [address, e.code]));

describe("compileSheet", () => {
  it("gives each failing cell an error code and still compiles the rest", () => {
    const { program, errors } = compileSheet({
      A1: 2,
      A2: "=A1*3",
      B1: "=FOO(1)",
      B2: "=NORMAL(1)",
      B3: "=1+",
      B4: "Label",
      B5: "=B4*2",
    });
    expect(Object.fromEntries([...errors].map(([a, e]) => [a, e.code]))).toEqual({
      B1: "#NAME?",
      B2: "#NAME?",
      B3: "#ERROR!",
      B5: "#VALUE!",
    });
    expect(errors.get("B1")?.message).toBe("Unknown function FOO");
    const result = evaluateCpu(program, { seed: 1, iterationStart: 0, count: 1, outputs: ["A2"] });
    expect(result.get("A2")?.[0]).toBe(6);
  });

  it("propagates errors to dependent cells", () => {
    expect(codes({ A1: "=FOO()", A2: "=A1+1", A3: "=A2*2", A4: 5 })).toEqual({
      A1: "#NAME?",
      A2: "#NAME?",
      A3: "#NAME?",
    });
    expect(compileSheet({ A1: "=FOO()", A2: "=A1+1" }).errors.get("A2")?.message).toBe(
      "Depends on A1, which has an error",
    );
  });

  it("marks every cell in a cycle, and cells that depend on it, without blocking the rest", () => {
    expect(codes({ A1: "=B1", B1: "=C1", C1: "=A1", D1: "=A1+1", E1: 7, F1: "=F1" })).toEqual({
      A1: "#CIRC!",
      B1: "#CIRC!",
      C1: "#CIRC!",
      D1: "#CIRC!",
      F1: "#CIRC!",
    });
    expect(compileSheet({ A1: "=B1", B1: "=A1" }).errors.get("A1")?.message).toMatch(
      /Circular reference: (A1 → B1 → A1|B1 → A1 → B1)/,
    );
  });

  it("identifies root cells as those that refer to no other cell", () => {
    const { roots } = compileSheet({
      A1: 100,
      A2: "=NORMAL(100, 10)",
      A3: "=1+2",
      A4: "=NORMAL(A1, 10)",
      A5: "=A1*2",
      A6: "Label",
    });
    expect([...roots].sort()).toEqual(["A1", "A2", "A3"]);
  });

  it("keeps the program free of operations from failed cells", () => {
    const clean = compileSheet({ A1: "=NORMAL(0, 1)" }).program;
    const withError = compileSheet({ A1: "=NORMAL(0, 1)", B1: "=NORMAL(0, 1) + FOO()" }).program;
    expect(withError.ops).toEqual(clean.ops);
    expect(withError.streamCount).toBe(clean.streamCount);
  });
});

describe("uncertainCells", () => {
  it("finds the cells that depend on a distribution", () => {
    const { program } = compileSheet({
      A1: 5,
      A2: "=A1*2",
      B1: "=NORMAL(A1, 1)",
      B2: "=B1 + A2",
      B3: "=IF(RAND() < 0.5, A1, A2)",
      C1: "=A2 + 1",
    });
    expect([...uncertainCells(program)].sort()).toEqual(["B1", "B2", "B3"]);
  });
});
