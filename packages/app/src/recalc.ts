import { type Backend, compileSheet, uncertainCells } from "@fumoca/engine";
import type { Workbook } from "@fumoca/storage";

/** The calculated result of one cell, as the grid shows it (SPECS.md §6.5). */
export type CellResult =
  | { kind: "number"; value: number; root: boolean }
  | { kind: "uncertain"; mean: number; sd: number; root: boolean }
  | { kind: "text"; text: string }
  | { kind: "error"; code: string; message: string; root: boolean };

/** Results per sheet id, then per cell address. */
export type WorkbookResults = Map<string, Map<string, CellResult>>;

export interface RecalcOptions {
  seed: number;
  /** Iterations per recalculation. */
  count: number;
}

function summarize(samples: ArrayLike<number>, uncertain: boolean, root: boolean): CellResult {
  let sum = 0;
  let nan = false;
  let infinite = false;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] as number;
    if (Number.isNaN(x)) nan = true;
    else if (!Number.isFinite(x)) infinite = true;
    sum += x;
  }
  if (nan) return { kind: "error", code: "#NUM!", message: "The result is not a number", root };
  if (infinite) return { kind: "error", code: "#DIV/0!", message: "The result is infinite", root };
  if (!uncertain) return { kind: "number", value: samples[0] ?? 0, root };

  const mean = sum / samples.length;
  let squares = 0;
  for (let i = 0; i < samples.length; i++) squares += ((samples[i] as number) - mean) ** 2;
  const sd = samples.length > 1 ? Math.sqrt(squares / (samples.length - 1)) : 0;
  return { kind: "uncertain", mean, sd, root };
}

/** Recalculates every sheet of a workbook on a backend. */
export async function recalculate(
  workbook: Workbook,
  backend: Backend,
  { seed, count }: RecalcOptions,
): Promise<WorkbookResults> {
  const results: WorkbookResults = new Map();
  for (const sheet of workbook.sheets) {
    const { program, errors, roots, labels } = compileSheet(sheet.cells);
    const sheetResults = new Map<string, CellResult>();

    for (const address of labels) {
      const value = sheet.cells[address];
      sheetResults.set(address, { kind: "text", text: String(value ?? "") });
    }
    for (const [address, { code, message }] of errors) {
      sheetResults.set(address, { kind: "error", code, message, root: roots.has(address) });
    }

    const outputs = [...program.cells.keys()];
    if (outputs.length > 0) {
      const samples = await backend.run(program, { seed, iterationStart: 0, count, outputs });
      const uncertain = uncertainCells(program);
      for (const address of outputs) {
        const cellSamples = samples.get(address) ?? [];
        sheetResults.set(
          address,
          summarize(cellSamples, uncertain.has(address), roots.has(address)),
        );
      }
    }
    results.set(sheet.id, sheetResults);
  }
  return results;
}

/** Formats a number like Excel's "General" format: up to 10 significant digits, no grouping. */
export function formatNumber(value: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (Number.isInteger(value) && abs < 1e15) return String(value);
  const text = abs >= 1e-9 && abs < 1e15 ? value.toPrecision(10) : value.toExponential(5);
  const [mantissa = "", exponent] = text.split("e");
  const trimmed = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

/**
 * Formats a mean and standard deviation as "mean ± SD", with the SD to 2 significant digits and
 * the mean rounded to the same decimal place.
 */
export function formatUncertain(mean: number, sd: number): string {
  if (!(sd > 0)) return formatNumber(mean);
  const decimals = Math.min(10, Math.max(0, 1 - Math.floor(Math.log10(sd))));
  // A small negative mean can round to "-0"; show it as "0".
  const shownMean = mean.toFixed(decimals).replace(/^-(0\.?0*)$/, "$1");
  return `${shownMean} ± ${sd.toFixed(decimals)}`;
}

/** The text a cell shows for a result. */
export function formatResult(result: CellResult): string {
  switch (result.kind) {
    case "number":
      return formatNumber(result.value);
    case "uncertain":
      return formatUncertain(result.mean, result.sd);
    case "text":
      return result.text;
    case "error":
      return result.code;
  }
}
