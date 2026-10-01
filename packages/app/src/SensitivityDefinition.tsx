import type { CellRef, Scenario, SensitivityAnalysis, Workbook } from "@fumoca/storage";
import { ActionIcon, Button, Group, NumberInput, Stack, Text, Title } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { CellListEditor } from "./CellPicker";

/** A step as a percentage: 0.01 → "1". */
const asPercent = (h: number) => Number((h * 100).toPrecision(6));

/** Steps in increasing order, without repeats. */
const tidy = (steps: number[]) => [...new Set(steps)].sort((a, b) => a - b);

/** The run count as a product: "2 inputs × 1 step × (− and +) = 4 runs, plus the Baseline". */
export function describeSensitivityCount(analysis: SensitivityAnalysis): string {
  const inputs = analysis.inputs.length;
  if (inputs === 0) return "No runs yet: add an input";
  const steps = analysis.steps.length;
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const runs = 2 * inputs * steps;
  return `${plural(inputs, "input")} × ${plural(steps, "step")} × (− and +) = ${runs.toLocaleString()} runs, plus the Baseline`;
}

export interface SensitivityDefinitionProps {
  scenario: SensitivityAnalysis;
  workbook: Workbook;
  onChange: (scenario: Scenario) => void;
}

/**
 * A sensitivity analysis's inputs and steps (SPECS.md §7.5): each input is scaled down and up by
 * each step in turn, with the others left as they are.
 */
export function SensitivityDefinition({
  scenario,
  workbook,
  onChange,
}: SensitivityDefinitionProps) {
  const same = (a: CellRef, b: CellRef) => a.sheetId === b.sheetId && a.address === b.address;
  const setSteps = (steps: number[]) => onChange({ ...scenario, steps: tidy(steps) });
  return (
    <>
      <Title order={6}>Inputs</Title>
      <CellListEditor
        workbook={workbook}
        cells={scenario.inputs}
        noun="Input"
        onChange={(inputs) => onChange({ ...scenario, inputs })}
        error={(cell) =>
          scenario.inputs.filter((c) => same(c, cell)).length > 1 ? "Listed twice" : null
        }
      />

      <Title order={6}>Steps</Title>
      <Text size="xs" c="dimmed">
        Each input is scaled down and up by each step, in turn. A distribution is scaled as a whole.
      </Text>
      <Stack gap={4}>
        {scenario.steps.map((h, i) => (
          <Group key={h} gap={4} wrap="nowrap">
            <Text size="sm" w={16} ta="right">
              ±
            </Text>
            <NumberInput
              size="xs"
              aria-label={`Step ${i + 1}`}
              suffix="%"
              min={0.0001}
              max={99}
              decimalScale={4}
              defaultValue={asPercent(h)}
              style={{ flex: 1 }}
              onBlur={(event) => {
                const percent = Number.parseFloat(event.currentTarget.value);
                if (percent > 0 && percent < 100 && percent / 100 !== h) {
                  setSteps(scenario.steps.map((x, j) => (j === i ? percent / 100 : x)));
                }
              }}
            />
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Remove step ${i + 1}`}
              disabled={scenario.steps.length === 1}
              onClick={() => setSteps(scenario.steps.filter((_, j) => j !== i))}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
      <Group gap={4}>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            // The next step up: twice the largest, as far as 50%.
            const largest = Math.max(...scenario.steps, 0.005);
            setSteps([...scenario.steps, Math.min(0.5, largest * 2)]);
          }}
        >
          Step
        </Button>
      </Group>
    </>
  );
}
