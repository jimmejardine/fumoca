import type { Op, Program } from "./ir";

function operands(op: Op): number[] {
  switch (op.kind) {
    case "const":
      return [];
    case "unary":
      return [op.a];
    case "binary":
      return [op.a, op.b];
    case "select":
      return [op.cond, op.then, op.otherwise];
    case "dist":
      return op.args;
  }
}

/**
 * The cells whose value depends on a distribution (SPECS.md §6.1). Every other cell is
 * deterministic: it has the same value in every iteration.
 */
export function uncertainCells(program: Program): Set<string> {
  const uncertain = new Array<boolean>(program.ops.length).fill(false);
  program.ops.forEach((op, reg) => {
    uncertain[reg] = op.kind === "dist" || operands(op).some((r) => uncertain[r]);
  });
  return new Set(
    [...program.cells].filter(([, reg]) => uncertain[reg]).map(([address]) => address),
  );
}
