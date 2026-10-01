import { formatReference, formulaReferences } from "@fumoca/engine";
import { type CellRef, cellName, findName, type Workbook } from "@fumoca/storage";
import { ActionIcon, Box, Button, Group, TextInput } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import { FormulaField } from "./FormulaField";

/** A cell as text: its name if it has one (`Volatility`), otherwise with its sheet (`Inputs!B3`). */
export function cellRefText(workbook: Workbook, ref: CellRef | null): string {
  const sheet = ref && workbook.sheets.find((s) => s.id === ref.sheetId);
  if (!ref || !sheet) return "";
  return cellName(sheet, ref.address) ?? formatReference(sheet.name, ref.address);
}

/** Parses a typed reference such as `Inputs!B3`; returns an error message if it isn't one. */
export function parseCellRef(workbook: Workbook, text: string): CellRef | string {
  const trimmed = text.trim();
  // A named cell (point mode inserts a clicked cell's name, SPECS.md §4.1).
  const named = findName(workbook, trimmed);
  if (named) return named;
  const [reference, ...rest] = formulaReferences(`=${trimmed}`);
  if (!reference || rest.length > 0 || reference.end !== trimmed.length + 1) {
    return "Type a cell such as Sheet1!B3 or a name, or click one";
  }
  if (reference.sheet === undefined) return `Name its sheet, as in Sheet1!${reference.address}`;
  const name = reference.sheet.toLowerCase();
  const sheet = workbook.sheets.find((s) => s.name.toLowerCase() === name);
  if (!sheet) return `There is no sheet named ${reference.sheet}`;
  return { sheetId: sheet.id, address: reference.address };
}

/**
 * A text field that edits locally and commits on Enter or when it loses focus, so typing doesn't
 * rewrite the workbook on every keystroke.
 */
export function CommitField({
  value,
  onCommit,
  placeholder,
  error,
  className,
  ff,
  "aria-label": label,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  "aria-label": string;
  error?: ReactNode;
  className?: string | undefined;
  ff?: "monospace";
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <TextInput
      aria-label={label}
      placeholder={placeholder}
      error={error}
      className={className}
      size="xs"
      value={text}
      styles={ff ? { input: { fontFamily: "var(--mantine-font-family-monospace)" } } : {}}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setText(value);
      }}
    />
  );
}

/**
 * A field for choosing a cell, edited like a formula (coloured, outlined): type `Sheet1!B3` or a
 * name, or focus the field and click a cell in any open sheet (point mode, SPECS.md §6.1).
 */
export function CellPicker({
  workbook,
  value,
  onPick,
  label,
  error,
  autoFocus,
}: {
  workbook: Workbook;
  value: CellRef | null;
  onPick: (ref: CellRef) => void;
  label: string;
  error?: string | null;
  autoFocus?: boolean;
}) {
  return (
    <FormulaField
      reference
      aria-label={label}
      placeholder="Click a cell, or type Sheet1!B3 or a name"
      autoFocus={autoFocus}
      value={cellRefText(workbook, value)}
      error={error ?? undefined}
      onCommit={(text) => {
        if (text.trim() === "") return null;
        const parsed = parseCellRef(workbook, text);
        if (typeof parsed === "string") return parsed;
        onPick(parsed);
        return null;
      }}
    />
  );
}

/**
 * A list of cells, each changed by picking another cell and removed with its button, plus a button
 * that adds one by picking it. `noun` names the fields: "Output 1", "Remove output 1", "+ Output".
 */
export function CellListEditor({
  workbook,
  cells,
  noun,
  onChange,
  error,
}: {
  workbook: Workbook;
  cells: CellRef[];
  noun: string;
  onChange: (cells: CellRef[]) => void;
  /** An error to show against a cell, if any. */
  error?: (cell: CellRef) => string | null;
}) {
  const [adding, setAdding] = useState(false);
  const lower = noun.toLowerCase();
  return (
    <>
      {cells.map((cell, i) => (
        <Group key={`${cell.sheetId}!${cell.address}`} gap={4} wrap="nowrap">
          <Box style={{ flex: 1 }}>
            <CellPicker
              workbook={workbook}
              label={`${noun} ${i + 1}`}
              value={cell}
              error={error?.(cell) ?? null}
              onPick={(picked) => onChange(cells.map((c, j) => (j === i ? picked : c)))}
            />
          </Box>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Remove ${lower} ${i + 1}`}
            onClick={() => onChange(cells.filter((_, j) => j !== i))}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      {adding && (
        <CellPicker
          workbook={workbook}
          label={`${noun} ${cells.length + 1}`}
          value={null}
          autoFocus
          onPick={(picked) => {
            setAdding(false);
            onChange([...cells, picked]);
          }}
        />
      )}
      <Group gap={4}>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => setAdding(true)}
        >
          {noun}
        </Button>
      </Group>
    </>
  );
}
