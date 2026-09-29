import { Combobox, Group, InputBase, Text, useCombobox } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

/** A named cell listed in the name box's dropdown. */
export interface NamedCellEntry {
  name: string;
  sheetId: string;
  address: string;
  /** Where it is, as shown: `B3` on this sheet, `Inputs!C4` on another. */
  location: string;
}

export interface NameBoxProps {
  /** The selected cell's name, or its address if it has none; empty with nothing selected. */
  shown: string;
  /** The selected cell's address, for tests and tooltips. */
  address: string | null;
  /** The current sheet's named cells, A–Z, then the other sheets', A–Z. */
  thisSheet: NamedCellEntry[];
  otherSheets: NamedCellEntry[];
  /** Whether the selected cell has a name that can be removed. */
  canRemove: boolean;
  /**
   * Enter: jumps to an address or a name, or names the selected cell. Returns an error message if
   * the text can't be used.
   */
  onSubmit: (text: string) => string | null;
  onPick: (entry: NamedCellEntry) => void;
  onRemove: () => void;
}

const REMOVE = "~remove";
const keyOf = (entry: NamedCellEntry) => `${entry.sheetId}|${entry.address}`;

/**
 * The name box, left of the formula bar (SPECS.md §4.1), as in Excel: it shows the selected cell's
 * name or address. Typing a new name and pressing Enter names the cell; typing an address or an
 * existing name jumps there. Its dropdown lists the named cells: this sheet's first, then the
 * rest, each A–Z.
 */
export function NameBox({
  shown,
  address,
  thisSheet,
  otherSheets,
  canRemove,
  onSubmit,
  onPick,
  onRemove,
}: NameBoxProps) {
  const combobox = useCombobox();
  const inputRef = useRef<HTMLInputElement>(null);
  // After a jump or a naming, hand the keyboard back to the grid, as Excel does.
  const done = () => inputRef.current?.blur();
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [shown]);

  const entries = [...thisSheet, ...otherSheets];
  const option = (entry: NamedCellEntry) => (
    <Combobox.Option value={keyOf(entry)} key={keyOf(entry)}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" truncate>
          {entry.name}
        </Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {entry.location}
        </Text>
      </Group>
    </Combobox.Option>
  );

  return (
    <Combobox
      store={combobox}
      width={280}
      position="bottom-start"
      onOptionSubmit={(value) => {
        combobox.closeDropdown();
        if (value === REMOVE) {
          onRemove();
          return;
        }
        const entry = entries.find((e) => keyOf(e) === value);
        if (entry) {
          onPick(entry);
          done();
        }
      }}
    >
      <Combobox.Target>
        <InputBase
          ref={inputRef}
          aria-label="Cell address"
          data-address={address ?? ""}
          title={address ?? undefined}
          size="xs"
          w={140}
          value={draft}
          error={error}
          styles={{
            input: { fontFamily: "var(--mantine-font-family-monospace)" },
            error: { position: "absolute", whiteSpace: "nowrap" },
          }}
          rightSection={
            <Combobox.Chevron
              aria-label="Named cells"
              role="button"
              style={{ cursor: "pointer" }}
              onClick={() => combobox.toggleDropdown()}
            />
          }
          rightSectionPointerEvents="all"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !combobox.dropdownOpened) {
              event.preventDefault();
              if (draft.trim() === "" || draft === shown) return;
              const problem = onSubmit(draft.trim());
              setError(problem);
              if (problem === null) done();
            } else if (event.key === "Escape") {
              setDraft(shown);
              setError(null);
              combobox.closeDropdown();
            }
          }}
          // As in Excel, clicking in selects the name or address, so typing replaces it.
          onFocus={(event) => event.currentTarget.select()}
          onBlur={() => {
            combobox.closeDropdown();
            setDraft(shown);
            setError(null);
          }}
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options mah={320} style={{ overflowY: "auto" }}>
          {entries.length === 0 && <Combobox.Empty>No named cells yet</Combobox.Empty>}
          {thisSheet.length > 0 && (
            <Combobox.Group label="This sheet">{thisSheet.map(option)}</Combobox.Group>
          )}
          {otherSheets.length > 0 && (
            <Combobox.Group label="Other sheets">{otherSheets.map(option)}</Combobox.Group>
          )}
          {canRemove && (
            <Combobox.Option value={REMOVE}>
              <Group gap={6} wrap="nowrap">
                <IconTrash size={14} />
                <Text size="sm">Remove the name {shown}</Text>
              </Group>
            </Combobox.Option>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
