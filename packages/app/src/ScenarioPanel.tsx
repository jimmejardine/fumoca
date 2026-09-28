import { formatReference, formulaReferences } from "@fumoca/engine";
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
  type Workbook,
} from "@fumoca/storage";
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Group,
  NumberInput,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatCellInput, parseCellInput } from "./cellInput";
import { clearPointTarget, type PointTarget, setPointTarget } from "./pointing";
import classes from "./ScenarioPanel.module.css";

/** A cell reference as text, always with its sheet: `Inputs!B3`. */
export function cellRefText(workbook: Workbook, ref: CellRef | null): string {
  const sheet = ref && workbook.sheets.find((s) => s.id === ref.sheetId);
  return ref && sheet ? formatReference(sheet.name, ref.address) : "";
}

/** Parses a typed reference such as `Inputs!B3`; returns an error message if it isn't one. */
export function parseCellRef(workbook: Workbook, text: string): CellRef | string {
  const trimmed = text.trim();
  const [reference, ...rest] = formulaReferences(`=${trimmed}`);
  if (!reference || rest.length > 0 || reference.end !== trimmed.length + 1) {
    return "Type a cell such as Sheet1!B3, or click one";
  }
  if (reference.sheet === undefined) return `Name its sheet, as in Sheet1!${reference.address}`;
  const name = reference.sheet.toLowerCase();
  const sheet = workbook.sheets.find((s) => s.name.toLowerCase() === name);
  if (!sheet) return `There is no sheet named ${reference.sheet}`;
  return { sheetId: sheet.id, address: reference.address };
}

/**
 * A text field that edits locally and commits on Enter or when it loses focus, so typing doesn't
 * rewrite the workbook on every keystroke.
 */
function CommitField({
  value,
  onCommit,
  placeholder,
  error,
  className,
  ff,
  "aria-label": label,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
  "aria-label": string;
  error?: ReactNode;
  className?: string | undefined;
  ff?: "monospace";
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <TextInput
      aria-label={label}
      placeholder={placeholder}
      error={error}
      className={className}
      size="xs"
      value={text}
      styles={ff ? { input: { fontFamily: "var(--mantine-font-family-monospace)" } } : {}}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setText(value);
      }}
    />
  );
}

/**
 * A field for choosing a cell: type `Sheet1!B3`, or focus the field and click a cell in any open
 * sheet (point mode, SPECS.md §6.1).
 */
function CellPicker({
  workbook,
  value,
  onPick,
  label,
  error,
  autoFocus,
}: {
  workbook: Workbook;
  value: CellRef | null;
  onPick: (ref: CellRef) => void;
  label: string;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const shown = cellRefText(workbook, value);
  const [text, setText] = useState(shown);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(shown), [shown]);
  const latest = useRef({ workbook, onPick });
  latest.current = { workbook, onPick };
  const target = useRef<PointTarget | null>(null);

  const accept = (typed: string): boolean => {
    const parsed = parseCellRef(latest.current.workbook, typed);
    if (typeof parsed === "string") {
      setProblem(parsed);
      return false;
    }
    setProblem(null);
    setText(cellRefText(latest.current.workbook, parsed));
    latest.current.onPick(parsed);
    return true;
  };
  const register = () => {
    // No sheet of its own: every clicked cell arrives with its sheet name.
    const next: PointTarget = { sheetId: undefined, insert: accept, pointed: () => null };
    target.current = next;
    setPointTarget(next);
  };
  const unregister = () => {
    if (target.current) clearPointTarget(target.current);
    target.current = null;
  };
  // Stop pointing when the picker goes away while focused.
  useEffect(
    () => () => {
      if (target.current) clearPointTarget(target.current);
    },
    [],
  );

  return (
    <TextInput
      size="xs"
      aria-label={label}
      placeholder="Click a cell, or type Sheet1!B3"
      autoFocus={autoFocus}
      value={text}
      error={problem ?? error}
      styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
      onChange={(event) => {
        setText(event.currentTarget.value);
        setProblem(null);
      }}
      onFocus={register}
      onBlur={() => {
        unregister();
        if (text.trim() === "") setText(shown);
        else if (text !== shown) accept(text);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && text !== shown) accept(text);
        if (event.key === "Escape") {
          setText(shown);
          setProblem(null);
        }
      }}
    />
  );
}

/** A cell's contents in the workbook: what a dimension's alternatives replace. */
function baselineOf(workbook: Workbook, ref: CellRef | null): string {
  if (!ref) return "";
  const sheet = workbook.sheets.find((s) => s.id === ref.sheetId);
  return formatCellInput(sheet?.cells[ref.address]);
}

const inDimensionError = (scenario: Scenario, ref: CellRef | null, dimensionId: string) =>
  ref && cellInDimension(scenario, ref, dimensionId) ? "Already in another dimension" : null;

interface DimensionProps<D extends Dimension> {
  scenario: Scenario;
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
            <CommitField
              aria-label={`Alternative ${i + 1}`}
              placeholder="Value or =formula"
              className={classes.input}
              ff="monospace"
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
                    <CommitField
                      aria-label={`Variant ${v + 1} cell ${c + 1}`}
                      placeholder="unchanged"
                      ff="monospace"
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
function describeCount(scenario: Scenario): string {
  const sizes = scenario.dimensions.map(dimensionSize).filter((n) => n > 0);
  const count = combinationCount(scenario);
  if (count === 0) return "No combinations yet: add a dimension with alternatives";
  const product = sizes.length > 1 ? `${sizes.join(" × ")} = ` : "";
  return `${product}${count.toLocaleString()} combination${count === 1 ? "" : "s"}, plus the Baseline`;
}

const placeholder = (
  <Center h="100%" p="md">
    <Text c="dimmed" size="sm" ta="center">
      Define dimensions and outputs, then run the scenario to see its results here.
    </Text>
  </Center>
);

/** Above this many combinations, running is flagged as a lot of work (SPECS.md §7.3). */
export const MANY_COMBINATIONS = 1000;

export interface ScenarioPanelProps {
  scenario: Scenario;
  workbook: Workbook;
  onChange: (scenario: Scenario) => void;
  /** The results pane. */
  results?: ReactNode;
  /** Run and Stop controls, and progress. */
  controls?: ReactNode;
}

/**
 * A scenario's window (SPECS.md §7): its definition down the left — dimensions, their
 * alternatives, and the output cells — and its results on the right.
 */
export function ScenarioPanel({
  scenario,
  workbook,
  onChange,
  results,
  controls,
}: ScenarioPanelProps) {
  const [newOutput, setNewOutput] = useState(false);
  // The definition can fold away, leaving the results the whole width.
  const [collapsed, setCollapsed] = useState(false);
  const setDimension = (dimension: Dimension) =>
    onChange({
      ...scenario,
      dimensions: scenario.dimensions.map((d) => (d.id === dimension.id ? dimension : d)),
    });
  const removeDimension = (id: string) =>
    onChange({ ...scenario, dimensions: scenario.dimensions.filter((d) => d.id !== id) });
  const count = combinationCount(scenario);

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
        <div className={classes.results}>{results ?? placeholder}</div>
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
                onChange({
                  ...scenario,
                  dimensions: [...scenario.dimensions, createCellDimension()],
                })
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

          <Title order={6}>Outputs</Title>
          {scenario.outputs.map((output, i) => (
            <Group key={`${output.sheetId}!${output.address}`} gap={4} wrap="nowrap">
              <Box style={{ flex: 1 }}>
                <CellPicker
                  workbook={workbook}
                  label={`Output ${i + 1}`}
                  value={output}
                  onPick={(picked) =>
                    onChange({
                      ...scenario,
                      outputs: scenario.outputs.map((o, j) => (j === i ? picked : o)),
                    })
                  }
                />
              </Box>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`Remove output ${i + 1}`}
                onClick={() =>
                  onChange({ ...scenario, outputs: scenario.outputs.filter((_, j) => j !== i) })
                }
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          ))}
          {newOutput && (
            <CellPicker
              workbook={workbook}
              label={`Output ${scenario.outputs.length + 1}`}
              value={null}
              autoFocus
              onPick={(picked) => {
                setNewOutput(false);
                onChange({ ...scenario, outputs: [...scenario.outputs, picked] });
              }}
            />
          )}
          <Group gap={4}>
            <Button
              size="compact-sm"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setNewOutput(true)}
            >
              Output
            </Button>
          </Group>

          <Box className={classes.footer}>
            <Text
              size="sm"
              {...(count > MANY_COMBINATIONS ? { c: "orange" } : {})}
              data-testid="combination-count"
            >
              {describeCount(scenario)}
            </Text>
            <NumberInput
              size="xs"
              label="Samples per combination"
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
      <div className={classes.results}>{results ?? placeholder}</div>
    </div>
  );
}
