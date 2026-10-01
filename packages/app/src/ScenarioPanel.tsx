import type { Scenario, Workbook } from "@fumoca/storage";
import {
  ActionIcon,
  Box,
  Center,
  Group,
  NumberInput,
  ScrollArea,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { CellListEditor, CommitField } from "./CellPicker";
import classes from "./ScenarioPanel.module.css";

export interface ScenarioPanelProps {
  scenario: Scenario;
  workbook: Workbook;
  onChange: (scenario: Scenario) => void;
  /** The definition particular to the scenario's kind, between its name and its outputs. */
  definition: ReactNode;
  /** The number of runs, described ("3 × 2 = 6 combinations, plus the Baseline"). */
  count: { text: string; warn: boolean };
  samplesLabel: string;
  /** Shown in place of results before the first run. */
  placeholder: string;
  /** The results pane. */
  results?: ReactNode;
  /** Run and Stop controls, and progress. */
  controls?: ReactNode;
}

/**
 * A scenario's window (SPECS.md §7): its definition down the left — its name, what it varies, and
 * the output cells — and its results on the right. Each kind of scenario supplies the part of the
 * definition that's particular to it.
 */
export function ScenarioPanel({
  scenario,
  workbook,
  onChange,
  definition,
  count,
  samplesLabel,
  placeholder,
  results,
  controls,
}: ScenarioPanelProps) {
  // The definition can fold away, leaving the results the whole width.
  const [collapsed, setCollapsed] = useState(false);
  const resultsPane = (
    <div className={classes.results}>
      {results ?? (
        <Center h="100%" p="md">
          <Text c="dimmed" size="sm" ta="center">
            {placeholder}
          </Text>
        </Center>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <div className={classes.panel}>
        <div className={classes.collapsed}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Show the definition"
            onClick={() => setCollapsed(false)}
          >
            <IconLayoutSidebarLeftExpand size={18} />
          </ActionIcon>
        </div>
        {resultsPane}
      </div>
    );
  }

  return (
    <div className={classes.panel}>
      <ScrollArea className={classes.definition} type="auto">
        <Stack gap="sm" p="sm">
          <Group gap={4} wrap="nowrap">
            <Box style={{ flex: 1 }}>
              <CommitField
                aria-label="Scenario name"
                placeholder="Scenario name"
                value={scenario.name}
                onCommit={(name) => name.trim() && onChange({ ...scenario, name: name.trim() })}
              />
            </Box>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Hide the definition"
              onClick={() => setCollapsed(true)}
            >
              <IconLayoutSidebarLeftCollapse size={18} />
            </ActionIcon>
          </Group>

          {definition}

          <Title order={6}>Outputs</Title>
          <CellListEditor
            workbook={workbook}
            cells={scenario.outputs}
            noun="Output"
            onChange={(outputs) => onChange({ ...scenario, outputs })}
          />

          <Box className={classes.footer}>
            <Text
              size="sm"
              {...(count.warn ? { c: "orange" } : {})}
              data-testid="combination-count"
            >
              {count.text}
            </Text>
            <NumberInput
              size="xs"
              label={samplesLabel}
              min={100}
              max={10_000_000}
              step={1000}
              thousandSeparator=","
              value={scenario.samples}
              onChange={(value) => {
                if (typeof value === "number" && value >= 100)
                  onChange({ ...scenario, samples: Math.floor(value) });
              }}
              mt={4}
            />
            {controls}
          </Box>
        </Stack>
      </ScrollArea>
      {resultsPane}
    </div>
  );
}
