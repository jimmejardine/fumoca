import {
  type Alternative,
  type CellDimension,
  type CellRef,
  cellInDimension,
  combinationCount,
  createCellDimension,
  createGroupDimension,
  type Dimension,
  dimensionSize,
  type GroupDimension,
  type Scenario,
  type WhatIfScenario,
  type Workbook,
} from "@fumoca/storage";
import {
  ActionIcon,
  Button,
  Card,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { CellPicker, CommitField } from "./CellPicker";
import { formatCellInput, parseCellInput } from "./cellInput";
import { FormulaField } from "./FormulaField";
import classes from "./ScenarioPanel.module.css";

/** A cell's contents in the workbook: what a dimension's alternatives replace. */
function baselineOf(workbook: Workbook, ref: CellRef | null): string {
  if (!ref) return "";
  const sheet = workbook.sheets.find((s) => s.id === ref.sheetId);
  return formatCellInput(sheet?.cells[ref.address]);
}

const inDimensionError = (scenario: WhatIfScenario, ref: CellRef | null, dimensionId: string) =>
  ref && cellInDimension(scenario, ref, dimensionId) ? "Already in another dimension" : null;

interface DimensionProps<D extends Dimension> {
  scenario: WhatIfScenario;
  workbook: Workbook;
  dimension: D;
  onChange: (dimension: D) => void;
  onRemove: () => void;
}

function CellDimensionCard({
  scenario,
  workbook,
  dimension,
  onChange,
  onRemove,
}: DimensionProps<CellDimension>) {
  const setAlternative = (i: number, alternative: Alternative) =>
    onChange({
      ...dimension,
      alternatives: dimension.alternatives.map((a, j) => (j === i ? alternative : a)),
    });
  const baseline = baselineOf(workbook, dimension.cell);
  return (
    <Card withBorder padding="xs" data-testid="dimension">
      <Group justify="space-between" wrap="nowrap" mb={4}>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          Single cell
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Remove dimension"
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </ActionIcon>
      </Group>
      <CellPicker
        workbook={workbook}
        label="Dimension cell"
        value={dimension.cell}
        autoFocus={dimension.cell === null}
        error={inDimensionError(scenario, dimension.cell, dimension.id)}
        onPick={(cell) => onChange({ ...dimension, cell })}
      />
      {dimension.cell && (
        <Text size="xs" c="dimmed" mt={4} ff="monospace" truncate>
          Baseline: {baseline === "" ? "(empty)" : baseline}
        </Text>
      )}
      <Stack gap={4} mt="xs">
        {dimension.alternatives.map((alternative, i) => (
          // Alternatives have no ids; their position is their identity while editing.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Group key={i} gap={4} wrap="nowrap">
            <CommitField
              aria-label={`Alternative ${i + 1} label`}
              placeholder="Label"
              className={classes.label}
              value={alternative.label}
              onCommit={(label) => setAlternative(i, { ...alternative, label })}
            />
            <FormulaField
              aria-label={`Alternative ${i + 1}`}
              placeholder="Value or =formula"
              className={classes.input}
              sheetId={dimension.cell?.sheetId}
              value={formatCellInput(alternative.input)}
              onCommit={(text) =>
                setAlternative(i, { ...alternative, input: parseCellInput(text) })
              }
            />
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Remove alternative ${i + 1}`}
              onClick={() =>
                onChange({
                  ...dimension,
                  alternatives: dimension.alternatives.filter((_, j) => j !== i),
                })
              }
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
      <Button
        size="compact-xs"
        variant="subtle"
        leftSection={<IconPlus size={12} />}
        mt={4}
        onClick={() =>
          onChange({
            ...dimension,
            alternatives: [...dimension.alternatives, { label: "", input: "" }],
          })
        }
      >
        Alternative
      </Button>
    </Card>
  );
}

function GroupDimensionCard({
  scenario,
  workbook,
  dimension,
  onChange,
  onRemove,
}: DimensionProps<GroupDimension>) {
  const [newCell, setNewCell] = useState(false);
  const setInput = (variant: number, cell: number, text: string) =>
    onChange({
      ...dimension,
      variants: dimension.variants.map((v, i) =>
        i === variant
          ? {
              ...v,
              inputs: v.inputs.map((input, c) =>
                c === cell ? (text.trim() === "" ? null : parseCellInput(text)) : input,
              ),
            }
          : v,
      ),
    });
  const removeCell = (cell: number) =>
    onChange({
      ...dimension,
      cells: dimension.cells.filter((_, c) => c !== cell),
      variants: dimension.variants.map((v) => ({
        ...v,
        inputs: v.inputs.filter((_, c) => c !== cell),
      })),
    });
  return (
    <Card withBorder padding="xs" data-testid="dimension">
      <Group justify="space-between" wrap="nowrap" mb={4}>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          Group
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Remove dimension"
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </ActionIcon>
      </Group>
      <CommitField
        aria-label="Group name"
        placeholder="Group name"
        value={dimension.name}
        onCommit={(name) => onChange({ ...dimension, name })}
      />
      <ScrollArea type="auto" mt="xs">
        <Table
          withColumnBorders={false}
          verticalSpacing={2}
          horizontalSpacing={4}
          className={classes.group}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Cell</Table.Th>
              {dimension.variants.map((variant, v) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: variants are identified by position
                <Table.Th key={v}>
                  <Group gap={2} wrap="nowrap">
                    <CommitField
                      aria-label={`Variant ${v + 1} name`}
                      placeholder="Variant name"
                      value={variant.label}
                      error={variant.label.trim() === "" ? " " : undefined}
                      onCommit={(label) =>
                        onChange({
                          ...dimension,
                          variants: dimension.variants.map((x, i) =>
                            i === v ? { ...x, label } : x,
                          ),
                        })
                      }
                    />
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label={`Remove variant ${v + 1}`}
                      onClick={() =>
                        onChange({
                          ...dimension,
                          variants: dimension.variants.filter((_, i) => i !== v),
                        })
                      }
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dimension.cells.map((cell, c) => (
              <Table.Tr key={`${cell.sheetId}!${cell.address}`}>
                <Table.Td>
                  <Group gap={2} wrap="nowrap">
                    <CellPicker
                      workbook={workbook}
                      label={`Group cell ${c + 1}`}
                      value={cell}
                      error={
                        inDimensionError(scenario, cell, dimension.id) ??
                        (dimension.cells.filter(
                          (x) => x.sheetId === cell.sheetId && x.address === cell.address,
                        ).length > 1
                          ? "Listed twice"
                          : null)
                      }
                      onPick={(picked) =>
                        onChange({
                          ...dimension,
                          cells: dimension.cells.map((x, i) => (i === c ? picked : x)),
                        })
                      }
                    />
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label={`Remove group cell ${c + 1}`}
                      onClick={() => removeCell(c)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {baselineOf(workbook, cell) || "(empty)"}
                  </Text>
                </Table.Td>
                {dimension.variants.map((variant, v) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: variants are identified by position
                  <Table.Td key={v}>
                    <FormulaField
                      aria-label={`Variant ${v + 1} cell ${c + 1}`}
                      placeholder="unchanged"
                      sheetId={cell.sheetId}
                      value={
                        variant.inputs[c] === null || variant.inputs[c] === undefined
                          ? ""
                          : formatCellInput(variant.inputs[c])
                      }
                      onCommit={(text) => setInput(v, c, text)}
                    />
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
            {newCell && (
              <Table.Tr>
                <Table.Td colSpan={dimension.variants.length + 1}>
                  <CellPicker
                    workbook={workbook}
                    label={`Group cell ${dimension.cells.length + 1}`}
                    value={null}
                    autoFocus
                    onPick={(picked) => {
                      setNewCell(false);
                      onChange({
                        ...dimension,
                        cells: [...dimension.cells, picked],
                        variants: dimension.variants.map((v) => ({
                          ...v,
                          inputs: [...v.inputs, null],
                        })),
                      });
                    }}
                  />
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Group gap={4} mt={4}>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          onClick={() => setNewCell(true)}
        >
          Cell
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          onClick={() =>
            onChange({
              ...dimension,
              variants: [
                ...dimension.variants,
                {
                  label: `Variant ${dimension.variants.length + 1}`,
                  inputs: dimension.cells.map(() => null),
                },
              ],
            })
          }
        >
          Variant
        </Button>
      </Group>
    </Card>
  );
}

/** The combination count as a product: "3 × 2 = 6 combinations". */
export function describeWhatIfCount(scenario: WhatIfScenario): string {
  const sizes = scenario.dimensions.map(dimensionSize).filter((n) => n > 0);
  const count = combinationCount(scenario);
  if (count === 0) return "No combinations yet: add a dimension with alternatives";
  const product = sizes.length > 1 ? `${sizes.join(" × ")} = ` : "";
  return `${product}${count.toLocaleString()} combination${count === 1 ? "" : "s"}, plus the Baseline`;
}

export interface WhatIfDefinitionProps {
  scenario: WhatIfScenario;
  workbook: Workbook;
  onChange: (scenario: Scenario) => void;
}

/** A what-if scenario's dimensions (SPECS.md §7.2): single cells and groups, and their alternatives. */
export function WhatIfDefinition({ scenario, workbook, onChange }: WhatIfDefinitionProps) {
  const setDimension = (dimension: Dimension) =>
    onChange({
      ...scenario,
      dimensions: scenario.dimensions.map((d) => (d.id === dimension.id ? dimension : d)),
    });
  const removeDimension = (id: string) =>
    onChange({ ...scenario, dimensions: scenario.dimensions.filter((d) => d.id !== id) });
  return (
    <>
      <Title order={6}>Dimensions</Title>
      {scenario.dimensions.map((dimension) =>
        dimension.kind === "cell" ? (
          <CellDimensionCard
            key={dimension.id}
            scenario={scenario}
            workbook={workbook}
            dimension={dimension}
            onChange={setDimension}
            onRemove={() => removeDimension(dimension.id)}
          />
        ) : (
          <GroupDimensionCard
            key={dimension.id}
            scenario={scenario}
            workbook={workbook}
            dimension={dimension}
            onChange={setDimension}
            onRemove={() => removeDimension(dimension.id)}
          />
        ),
      )}
      <Group gap={4}>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            onChange({ ...scenario, dimensions: [...scenario.dimensions, createCellDimension()] })
          }
        >
          Single cell
        </Button>
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            onChange({
              ...scenario,
              dimensions: [
                ...scenario.dimensions,
                createGroupDimension(
                  `Group${scenario.dimensions.filter((d) => d.kind === "group").length + 1}`,
                ),
              ],
            })
          }
        >
          Group
        </Button>
      </Group>
    </>
  );
}
