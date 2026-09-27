import { Box, Group, Text, TextInput, useComputedColorScheme } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import classes from "./FormulaBar.module.css";
import { FormulaInput } from "./FormulaInput";

export interface FormulaBarProps {
  /** The selected cell's address, or null if no cell is selected. */
  address: string | null;
  /** The selected cell's sheet: clicking its cells while editing a formula inserts references. */
  sheetId?: string | undefined;
  /** The selected cell's raw content: its formula or value. */
  content: string;
  status: string;
  /** More detail about the status, shown as a tooltip. */
  statusDetail?: string | undefined;
  /** Commits the text; returns an error message if it was rejected. */
  onCommit: (text: string) => string | null;
  /** Called after Enter commits, so focus can return to the grid. */
  onDone: () => void;
  /** Ctrl+;: a period to fill in (series sheets' time cells), or null if there's nothing to fill. */
  onFillPeriod?: (() => string | null) | undefined;
}

/**
 * The formula bar: shows the selected cell's formula or value and lets the user edit it.
 * Enter or Tab commits, Escape reverts, and leaving the bar with changes commits (as in Excel).
 */
export function FormulaBar({
  address,
  sheetId,
  content,
  status,
  statusDetail,
  onCommit,
  onDone,
  onFillPeriod,
}: FormulaBarProps) {
  const scheme = useComputedColorScheme("light");
  const [draft, setDraft] = useState(content);
  const [error, setError] = useState<string | null>(null);
  // The last text committed, so leaving the bar right after Enter doesn't commit it again.
  const committed = useRef(content);

  // Reset when a different cell is selected, even if it has the same content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: address is a deliberate trigger
  useEffect(() => {
    setDraft(content);
    setError(null);
    committed.current = content;
  }, [address, content]);

  const commit = (): boolean => {
    if (draft === committed.current) return true;
    const rejected = onCommit(draft);
    setError(rejected);
    if (rejected === null) committed.current = draft;
    return rejected === null;
  };

  return (
    <Group h={38} px="xs" gap="xs" wrap="nowrap">
      <TextInput
        aria-label="Cell address"
        value={address ?? ""}
        readOnly
        size="xs"
        w={70}
        styles={{
          input: { textAlign: "center", fontFamily: "var(--mantine-font-family-monospace)" },
        }}
      />
      <Text size="sm" fs="italic" c="dimmed" ff="serif">
        fx
      </Text>
      <Box className={classes.field}>
        <FormulaInput
          aria-label="Formula bar"
          aria-invalid={error !== null}
          value={draft}
          disabled={address === null}
          scheme={scheme}
          sheetId={sheetId}
          className={classes.input}
          onChange={(value) => {
            setDraft(value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              if (commit()) onDone();
            } else if (event.key === "Escape") {
              setDraft(content);
              setError(null);
            } else if (event.key === ";" && (event.ctrlKey || event.metaKey)) {
              const period = onFillPeriod?.();
              if (period) {
                event.preventDefault();
                setDraft(period);
                setError(null);
              }
            }
          }}
          onBlur={() => commit()}
        />
        {error && (
          <Text size="xs" c="red" className={classes.error}>
            {error}
          </Text>
        )}
      </Box>
      <Text
        size="xs"
        c="dimmed"
        miw={170}
        ta="right"
        data-testid="calc-status"
        title={statusDetail}
      >
        {status}
      </Text>
    </Group>
  );
}
