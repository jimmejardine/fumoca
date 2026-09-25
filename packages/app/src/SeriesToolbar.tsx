import { GRANULARITIES, type Granularity } from "@fumoca/engine";
import { SERIES_TYPES, type SeriesSettings, type SeriesType } from "@fumoca/storage";
import { Button, Group, Select, Text } from "@mantine/core";
import { IconColumnInsertRight } from "@tabler/icons-react";

export interface SeriesToolbarProps {
  settings: SeriesSettings;
  onChange: (settings: SeriesSettings) => void;
  onAddColumn: () => void;
}

/**
 * A time-series sheet's own toolbar (SPECS.md §5): the sheet's granularity, and the type of
 * quantity its series holds.
 */
export function SeriesToolbar({ settings, onChange, onAddColumn }: SeriesToolbarProps) {
  return (
    <Group
      gap="md"
      px="xs"
      py={4}
      wrap="nowrap"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
        Series sheet
      </Text>
      <Group gap={6} wrap="nowrap">
        <Text size="xs">Granularity</Text>
        <Select
          aria-label="Granularity"
          size="xs"
          w={120}
          allowDeselect={false}
          data={GRANULARITIES.map(({ value, label }) => ({ value, label }))}
          value={settings.granularity}
          onChange={(value) =>
            value && onChange({ ...settings, granularity: value as Granularity })
          }
        />
      </Group>
      <Group gap={6} wrap="nowrap">
        <Text size="xs">Type</Text>
        <Select
          aria-label="Type"
          size="xs"
          w={100}
          allowDeselect={false}
          data={SERIES_TYPES.map(({ value, label }) => ({ value, label }))}
          value={settings.type}
          onChange={(value) => value && onChange({ ...settings, type: value as SeriesType })}
        />
      </Group>
      <Button
        variant="default"
        size="compact-xs"
        leftSection={<IconColumnInsertRight size={14} />}
        onClick={onAddColumn}
      >
        Add value column
      </Button>
    </Group>
  );
}
