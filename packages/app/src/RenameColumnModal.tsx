import { columnNameError, type SeriesSettings } from "@fumoca/storage";
import { Button, Group, Modal, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";

export interface RenameColumnModalProps {
  settings: SeriesSettings;
  /** The value column being renamed, or null when the dialog is closed. */
  index: number | null;
  onRename: (index: number, name: string) => void;
  onClose: () => void;
}

/** Renames a series sheet's value column. Names are used in lookups like Sheet[Name]@2026-01. */
export function RenameColumnModal({ settings, index, onRename, onClose }: RenameColumnModalProps) {
  const current = index === null ? "" : (settings.columns[index] ?? "");
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(current);
    setError(null);
  }, [current]);

  const save = () => {
    if (index === null) return;
    const problem = columnNameError(settings, name, index);
    setError(problem);
    if (problem) return;
    onRename(index, name);
    onClose();
  };

  return (
    <Modal opened={index !== null} onClose={onClose} title="Rename column" size="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <TextInput
          label="Column name"
          description="Used in lookups, e.g. Sheet[Name]@2026-01"
          value={name}
          error={error}
          data-autofocus
          onChange={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
        />
        <Group justify="flex-end" mt="md" gap="xs">
          <Button variant="default" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="xs">
            Rename
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
