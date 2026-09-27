import { type Sheet, seriesIssues } from "@fumoca/storage";
import { Button, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconSortAscending } from "@tabler/icons-react";
import { useMemo } from "react";
import classes from "./SeriesIssuesBar.module.css";

export interface SeriesIssuesBarProps {
  sheet: Sheet;
  onSort: () => void;
}

/**
 * Problems with a series sheet's periods, shown at the bottom of the sheet: duplicate periods as
 * an error, and periods out of order as a warning with a button to sort them.
 */
export function SeriesIssuesBar({ sheet, onSort }: SeriesIssuesBarProps) {
  const { duplicates, outOfOrder } = useMemo(() => seriesIssues(sheet), [sheet]);
  if (duplicates.length === 0 && !outOfOrder) return null;
  return (
    <Stack gap={0}>
      {duplicates.length > 0 ? (
        <Group gap="xs" px="sm" py={6} className={classes.error} role="alert">
          <IconAlertTriangle size={16} />
          <Text size="sm">
            {duplicates.length === 1 ? "Duplicate period: " : "Duplicate periods: "}
            {duplicates.map(({ period, rows }) => `${period} (rows ${rows.join(", ")})`).join("; ")}
          </Text>
        </Group>
      ) : null}
      {outOfOrder ? (
        <Group gap="xs" px="sm" py={6} className={classes.warning} role="status">
          <IconAlertTriangle size={16} />
          <Text size="sm">Warning: your dates are out of order</Text>
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconSortAscending size={14} />}
            onClick={onSort}
          >
            Sort now
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}
