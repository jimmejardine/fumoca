import { describe, expect, it } from "vitest";
import { cellKey, compileWorkbook, type SheetInput } from "./compile";
import { evaluateCpu } from "./cpu";
import { formatReference, formulaReferences, parseFormula } from "./parser";

const others: SheetInput[] = [
  { name: "Inputs", cells: { A1: 2, B3: "=A1 * 10" } },
  { name: "Interest Rates", cells: { A1: 0.05 } },
  { name: "Q1", cells: { A1: 7 } },
  { name: "It's", cells: { A1: 9 } },
];

/** Compiles `formulas` on a Model sheet after the others; returns each cell's value or error. */
function evaluate(formulas: Record<string, number | string>, sheets = others) {
  const model = sheets.length;
  const { program, sheets: outcomes } = compileWorkbook([
    ...sheets,
    { name: "Model", cells: formulas },
  ]);
  const outputs = Object.keys(formulas)
    .map((address) => cellKey(model, address))
    .filter((key) => program.cells.has(key));
  const samples = evaluateCpu(program, { seed: 1, iterationStart: 0, count: 1, outputs });
  return Object.fromEntries(
    Object.keys(formulas).map((address) => {
      const error = outcomes[model]?.errors.get(address);
      return [address, error ? error.code : samples.get(cellKey(model, address))?.[0]];
    }),
  );
}

describe("cross-sheet references", () => {
  it("parse as Excel writes them", () => {
    expect(parseFormula("=Inputs!B3")).toEqual({ type: "ref", address: "B3", sheet: "Inputs" });
    expect(parseFormula("='Interest Rates'!$a$1")).toEqual({
      type: "ref",
      address: "A1",
      sheet: "Interest Rates",
    });
    expect(parseFormula("='It''s'!A1")).toEqual({ type: "ref", address: "A1", sheet: "It's" });
    // A sheet whose name looks like a cell.
    expect(parseFormula("=Q1!A1")).toEqual({ type: "ref", address: "A1", sheet: "Q1" });
  });

  it("read cells on other sheets, including calculated ones", () => {
    expect(
      evaluate({
        A1: "=Inputs!A1 + 1",
        A2: "=Inputs!B3",
        A3: "='Interest Rates'!A1 * 100",
        A4: "=Q1!A1 + inputs!a1",
        A5: "='It''s'!A1",
      }),
    ).toEqual({ A1: 3, A2: 20, A3: 5, A4: 9, A5: 9 });
  });

  it("gives #REF! for a sheet that doesn't exist, and chains across sheets", () => {
    const result = evaluate({ A1: "=Nowhere!A1", A2: "=A1 + 1", A3: "=Model!A4 * 2", A4: 21 });
    expect(result).toEqual({ A1: "#REF!", A2: "#REF!", A3: 42, A4: 21 });
  });

  it("detect cycles across sheets", () => {
    const loop: SheetInput[] = [{ name: "Other", cells: { A1: "=Model!A1 + 1" } }];
    expect(evaluate({ A1: "=Other!A1 + 1" }, loop)).toEqual({ A1: "#CIRC!" });
  });

  it("are found for highlighting, with their sheet", () => {
    const text = "=A1 + Inputs!B3 * 'Interest Rates'!A1";
    const references = formulaReferences(text);
    expect(references.map((r) => [r.sheet, r.address, text.slice(r.start, r.end)])).toEqual([
      [undefined, "A1", "A1"],
      ["Inputs", "B3", "Inputs!B3"],
      ["Interest Rates", "A1", "'Interest Rates'!A1"],
    ]);
  });

  it("are written with quotes only where a sheet name needs them", () => {
    expect(formatReference("Inputs", "B3")).toBe("Inputs!B3");
    expect(formatReference("Interest Rates", "A1")).toBe("'Interest Rates'!A1");
    expect(formatReference("It's", "A1")).toBe("'It''s'!A1");
    expect(parseFormula(`=${formatReference("It's", "A1")}`)).toMatchObject({ sheet: "It's" });
  });
});
