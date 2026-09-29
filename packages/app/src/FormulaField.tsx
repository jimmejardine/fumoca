import { Box, Text } from "@mantine/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { boxedFormulaInput, FormulaInput } from "./FormulaInput";

export interface FormulaFieldProps {
  value: string;
  /** Commits the text. Returning an error message rejects it; anything else accepts it. */
  onCommit: (text: string) => unknown;
  "aria-label": string;
  placeholder?: string | undefined;
  /** The sheet the formula belongs to, for point mode and outlining (see `FormulaInput`). */
  sheetId?: string | undefined;
  /**
   * The field holds a single cell reference or name (a cell picker): clicking a cell while it has
   * focus takes that cell at once.
   */
  reference?: boolean | undefined;
  /** An error from outside the field, shown when the field has none of its own. */
  error?: ReactNode;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A formula field that edits like the formula bar (SPECS.md §6.1, §6.5): references and names are
 * coloured and their cells outlined as it's typed, and cells can be clicked to insert them. It
 * edits locally and commits on Enter or when it loses focus; Escape reverts.
 */
export function FormulaField({
  value,
  onCommit,
  reference = false,
  error,
  className,
  ...props
}: FormulaFieldProps) {
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  const committed = useRef(value);
  useEffect(() => {
    setDraft(value);
    setProblem(null);
    committed.current = value;
  }, [value]);

  const commit = (text: string) => {
    if (text === committed.current) return;
    const result = onCommit(text);
    const rejected = typeof result === "string" ? result : null;
    setProblem(rejected);
    if (rejected === null) committed.current = text;
  };

  const shown = problem ?? error;
  return (
    <Box className={className}>
      <FormulaInput
        {...props}
        className={boxedFormulaInput}
        value={draft}
        reference={reference}
        aria-invalid={shown ? true : undefined}
        onChange={(text) => {
          setDraft(text);
          setProblem(null);
        }}
        // A cell picker takes a clicked cell whole, and commits it straight away.
        onPoint={
          reference
            ? (clicked) => {
                setDraft(clicked);
                commit(clicked);
                return true;
              }
            : undefined
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          } else if (event.key === "Escape") {
            setDraft(committed.current);
            setProblem(null);
          }
        }}
        onBlur={() => {
          if (draft.trim() === "" && reference) setDraft(committed.current);
          else commit(draft);
        }}
      />
      {shown && (
        <Text size="xs" c="red" mt={2}>
          {shown}
        </Text>
      )}
    </Box>
  );
}
