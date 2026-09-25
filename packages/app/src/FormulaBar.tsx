import { Group, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";

export interface FormulaBarProps {
  /** The selected cell's address, or null if no cell is selected. */
  address: string | null;
  /** The selected cell's raw content: its formula or value. */
  content: string;
  status: string;
  /** More detail about the status, shown as a tooltip. */
  statusDetail?: string | undefined;
  /** Commits the text; returns an error message if it was rejected. */
  onCommit: (text: string) => string | null;
  /** Called after Enter commits, so focus can return to the grid. */
  onDone: () => void;
}

/**
 * The formula bar: shows the selected cell's formula or value and lets the user edit it.
 * Enter or Tab commits, Escape reverts, and leaving the bar with changes commits (as in Excel).
 */
export function FormulaBar({
  address,
  content,
  status,
  statusDetail,
  onCommit,
  onDone,
}: FormulaBarProps) {
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
      <TextInput
        aria-label="Formula bar"
        value={draft}
        disabled={address === null}
        error={error}
        size="xs"
        style={{ flex: 1 }}
        styles={{
          input: { fontFamily: "var(--mantine-font-family-monospace)" },
          error: { position: "absolute" },
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            if (commit()) onDone();
          } else if (event.key === "Escape") {
            setDraft(content);
            setError(null);
          }
        }}
        onBlur={() => commit()}
      />
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
