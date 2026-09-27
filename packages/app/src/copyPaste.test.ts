import { describe, expect, it } from "vitest";
import { type CopiedCells, fillFromSource, pasteFromCopy, type RangeTarget } from "./copyPaste";

/** A target with no hidden rows: on-screen and sheet positions are the same. */
const at = (x: number, y: number, value: string): RangeTarget => ({
  screenX: x,
  screenY: y,
  x,
  y,
  value,
});

// B1 = 3, B2 = =B1*2 (shown as 6), copied together.
const copied: CopiedCells = {
  shown: [["3"], ["6"]],
  cells: [[{ text: "3", x: 1, y: 0 }], [{ text: "=B1*2", x: 1, y: 1 }]],
};

describe("pasteFromCopy", () => {
  it("pastes the copied inputs, with formulas shifted to where they land", () => {
    const targets = [at(3, 4, "3"), at(3, 5, "6")];
    expect(pasteFromCopy(copied, targets, { x: 3, y: 4, x1: 3, y1: 5 })).toEqual(["3", "=D5*2"]);
  });

  it("repeats the copy over a larger paste range, shifting each tile", () => {
    const targets = [at(2, 0, "3"), at(2, 1, "6"), at(2, 2, "3"), at(2, 3, "6")];
    expect(pasteFromCopy(copied, targets, { x: 2, y: 0, x1: 2, y1: 3 })).toEqual([
      "3",
      "=C1*2",
      "3",
      "=C3*2",
    ]);
  });

  it("uses the sheet position of targets, not the on-screen one, when rows are hidden", () => {
    const targets = [
      { screenX: 1, screenY: 3, x: 1, y: 7, value: "3" },
      { screenX: 1, screenY: 4, x: 1, y: 9, value: "6" },
    ];
    expect(pasteFromCopy(copied, targets, { x: 1, y: 3, x1: 1, y1: 4 })).toEqual(["3", "=B9*2"]);
  });

  it("pastes plain values when the clipboard holds something else", () => {
    expect(pasteFromCopy(copied, [at(3, 4, "hello")], { x: 3, y: 4, x1: 3, y1: 4 })).toBeNull();
    expect(pasteFromCopy(null, [at(3, 4, "3")], { x: 3, y: 4, x1: 3, y1: 4 })).toBeNull();
  });
});

describe("fillFromSource", () => {
  const sheet: Record<string, { text: string; x: number; y: number }> = {
    "1,0": { text: "=A1*2", x: 1, y: 0 },
    "2,0": { text: "=$A$1+A1", x: 2, y: 0 },
  };
  const source = (x: number, y: number) => sheet[`${x},${y}`];

  it("fills down, shifting relative references by the rows moved", () => {
    const targets = [at(1, 1, "6"), at(1, 2, "6")];
    expect(
      fillFromSource(targets, { x: 1, y: 0, x1: 1, y1: 0 }, { x: 1, y: 0, x1: 1, y1: 2 }, source),
    ).toEqual(["=A2*2", "=A3*2"]);
  });

  it("fills across, keeping anchored references", () => {
    const targets = [at(3, 0, "x")];
    expect(
      fillFromSource(targets, { x: 2, y: 0, x1: 2, y1: 0 }, { x: 2, y: 0, x1: 3, y1: 0 }, source),
    ).toEqual(["=$A$1+B1"]);
  });

  it("fills up, into #REF! where a reference leaves the grid", () => {
    const targets = [at(1, 0, "x")];
    const fromRow2 = (x: number, y: number) =>
      x === 1 && y === 1 ? { text: "=A1", x: 1, y: 1 } : undefined;
    expect(
      fillFromSource(targets, { x: 1, y: 1, x1: 1, y1: 1 }, { x: 1, y: 0, x1: 1, y1: 1 }, fromRow2),
    ).toEqual(["=#REF!"]);
  });
});
