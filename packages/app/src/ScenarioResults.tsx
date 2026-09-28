import {
  alternativeLabel,
  combinationCount,
  createScenario,
  dimensionSize,
  type Scenario,
  type Sheet,
  type Workbook,
} from "@fumoca/storage";
import {
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Popover,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  useComputedColorScheme,
} from "@mantine/core";
import {
  IconArrowsSort,
  IconPlayerPlay,
  IconPlayerStop,
  IconSortAscending,
  IconSortDescending,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import {
  buildPivot,
  defaultLayout,
  type FilterValue,
  histogramQuantile,
  moveField,
  OUTPUTS_FIELD,
  type PivotField,
  type PivotLayout,
  type PivotZone,
  reconcileLayout,
  summaryMean,
} from "./pivot";
import { formatNumber, formatUncertain } from "./recalc";
import { cellRefText } from "./ScenarioPanel";
import classes from "./ScenarioResults.module.css";
import { histogramBackground } from "./SheetGrid";
import type { OutputSummary, ScenarioResults } from "./scenarioRun";

/** A scenario's latest run: the definition and sheets it ran with, and its results so far. */
export interface ScenarioRunState {
  definition: Scenario;
  sheets: Sheet[];
  results: ScenarioResults | null;
  running: boolean;
  error?: string;
}

export const emptyRun = (): ScenarioRunState => ({
  definition: createScenario(""),
  sheets: [],
  results: null,
  running: false,
});

/** Whether the model or the scenario has changed since a run. */
const isStale = (run: ScenarioRunState, scenario: Scenario, workbook: Workbook) =>
  run.sheets !== workbook.sheets || JSON.stringify(run.definition) !== JSON.stringify(scenario);

export interface ScenarioControlsProps {
  scenario: Scenario;
  workbook: Workbook;
  run: ScenarioRunState | undefined;
  onRun: () => void;
  onStop: () => void;
}

/** Run and Stop, with the run's progress. */
export function ScenarioControls({
  scenario,
  workbook,
  run,
  onRun,
  onStop,
}: ScenarioControlsProps) {
  const ready = combinationCount(scenario) > 0 && scenario.outputs.length > 0;
  const progress = run?.results?.progress;
  return (
    <Stack gap={4} mt="xs">
      {run?.running ? (
        <Button
          size="xs"
          color="red"
          variant="light"
          leftSection={<IconPlayerStop size={14} />}
          onClick={onStop}
        >
          Stop
        </Button>
      ) : (
        <Button
          size="xs"
          leftSection={<IconPlayerPlay size={14} />}
          disabled={!ready}
          onClick={onRun}
        >
          Run scenario
        </Button>
      )}
      {!ready && (
        <Text size="xs" c="dimmed">
          Add a dimension with alternatives, and an output, to run it.
        </Text>
      )}
      {progress && (
        <Text size="xs" c="dimmed" data-testid="scenario-progress">
          {progress.done === progress.total
            ? `Ran the Baseline and ${progress.total - 1} combination${progress.total === 2 ? "" : "s"}`
            : `Running ${progress.done + 1} of ${progress.total}…`}
        </Text>
      )}
      {run && !run.running && isStale(run, scenario, workbook) && (
        <Text size="xs" c="orange">
          The model or the scenario has changed since this run.
        </Text>
      )}
      {run?.error && (
        <Text size="xs" c="red">
          {run.error}
        </Text>
      )}
    </Stack>
  );
}

/** Histogram fills, as in the grid's cells. */
const HISTOGRAM_COLORS = { light: "rgba(34, 139, 230, 0.18)", dark: "rgba(77, 171, 247, 0.22)" };

const normalized = (counts: number[]) => {
  const max = Math.max(...counts);
  return counts.map((c) => (max > 0 ? c / max : 0));
};

function summaryText(summary: OutputSummary | null): string {
  if (!summary) return "…";
  if (summary.kind === "number") return formatNumber(summary.value);
  if (summary.kind === "uncertain") return formatUncertain(summary.mean, summary.sd);
  return summary.code;
}

/** A change from the Baseline: "+12.5 (+4.1%)". */
function deltaText(value: number, baseline: number): string {
  const delta = value - baseline;
  const sign = delta > 0 ? "+" : "";
  const percent =
    baseline !== 0 ? ` (${sign}${((delta / Math.abs(baseline)) * 100).toFixed(1)}%)` : "";
  return `${sign}${formatNumber(Number(delta.toPrecision(4)))}${percent}`;
}

/** A diverging shade for a change: green up, red down, stronger for larger changes. */
function deltaShade(delta: number, largest: number): string | undefined {
  if (!(largest > 0) || delta === 0) return undefined;
  const strength = Math.min(1, Math.abs(delta) / largest) * 0.35;
  return delta > 0 ? `rgba(64, 192, 87, ${strength})` : `rgba(250, 82, 82, ${strength})`;
}

/** A larger histogram with summary statistics, shown when a pivot cell is clicked. */
function CellDetail({ summary, label }: { summary: OutputSummary | null; label: string }) {
  const scheme = useComputedColorScheme("light");
  if (!summary) return <Text size="sm">Still to run.</Text>;
  if (summary.kind === "error") {
    return (
      <Text size="sm">
        {summary.code}: {summary.message}
      </Text>
    );
  }
  if (summary.kind === "number") {
    return (
      <Text size="sm">
        {label}: {formatNumber(summary.value)} (the same in every iteration)
      </Text>
    );
  }
  const { histogram } = summary;
  const quantile = (p: number) =>
    formatNumber(Number(histogramQuantile(histogram, p).toPrecision(4)));
  return (
    <Stack gap={4} w={300}>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      <Box
        h={110}
        className={classes.detailHistogram}
        style={{
          backgroundImage: histogramBackground(
            normalized(histogram.counts),
            HISTOGRAM_COLORS[scheme],
          ),
        }}
      />
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {formatNumber(Number(histogram.lo.toPrecision(4)))}
        </Text>
        <Text size="xs" c="dimmed">
          {formatNumber(Number(histogram.hi.toPrecision(4)))}
        </Text>
      </Group>
      <Table verticalSpacing={0} fz="xs">
        <Table.Tbody>
          {[
            ["Mean", formatNumber(Number(summary.mean.toPrecision(6)))],
            ["SD", formatNumber(Number(summary.sd.toPrecision(4)))],
            ["P10", quantile(0.1)],
            ["P50", quantile(0.5)],
            ["P90", quantile(0.9)],
            ["Samples", summary.count.toLocaleString()],
          ].map(([name, value]) => (
            <Table.Tr key={name}>
              <Table.Td>{name}</Table.Td>
              <Table.Td ta="right">{value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

const ZONES: { zone: PivotZone; label: string }[] = [
  { zone: "rows", label: "Rows" },
  { zone: "columns", label: "Columns" },
  { zone: "filters", label: "Filters" },
];

/** A field in the layout bar: drag it to another zone, or move it with its menu. */
function FieldChip({
  field,
  zone,
  layout,
  onLayout,
}: {
  field: PivotField;
  zone: PivotZone;
  layout: PivotLayout;
  onLayout: (layout: PivotLayout) => void;
}) {
  const filter = layout.filters[field.id];
  return (
    <Group
      gap={4}
      wrap="nowrap"
      className={classes.chip}
      draggable
      data-field={field.name}
      onDragStart={(event) => event.dataTransfer.setData("text/x-pivot-field", field.id)}
    >
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Badge
            variant="light"
            className={classes.chipLabel}
            rightSection={<IconArrowsSort size={10} />}
          >
            {field.name}
          </Badge>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Move to</Menu.Label>
          {ZONES.filter((z) => z.zone !== zone).map((z) => (
            <Menu.Item key={z.zone} onClick={() => onLayout(moveField(layout, field.id, z.zone))}>
              {z.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      {zone === "filters" && (
        <Select
          size="xs"
          w={130}
          aria-label={`${field.name} filter`}
          allowDeselect={false}
          value={String(filter ?? 0)}
          data={[
            ...field.values.map((value, i) => ({ value: String(i), label: value })),
            ...(field.id === OUTPUTS_FIELD ? [] : [{ value: "all", label: "All (pooled)" }]),
          ]}
          onChange={(value) =>
            onLayout({
              ...layout,
              filters: {
                ...layout.filters,
                [field.id]: (value === "all" ? "all" : Number(value)) as FilterValue,
              },
            })
          }
        />
      )}
    </Group>
  );
}

export interface ScenarioResultsViewProps {
  workbook: Workbook;
  run: ScenarioRunState;
  results: ScenarioResults;
}

/**
 * A scenario's results as a pivot of distributions (SPECS.md §7.4): each cell shows one output
 * for the combinations its row, column and filters select, as mean ± SD over a histogram.
 */
export function ScenarioResultsView({ workbook, run, results }: ScenarioResultsViewProps) {
  const scheme = useComputedColorScheme("light");
  const { definition } = run;

  // The fields: the dimensions that ran, in combination order, and the outputs.
  const dimensions = useMemo<PivotField[]>(
    () =>
      definition.dimensions
        .filter((d) => dimensionSize(d) > 0 && (d.kind === "group" || d.cell !== null))
        .map((d) => ({
          id: d.id,
          name: d.kind === "group" ? d.name || "Group" : cellRefText(workbook, d.cell),
          values: Array.from({ length: dimensionSize(d) }, (_, i) => alternativeLabel(d, i)),
        })),
    [definition, workbook],
  );
  const outputs = useMemo<PivotField>(
    () => ({
      id: OUTPUTS_FIELD,
      name: "Output",
      values: definition.outputs.map((ref) => cellRefText(workbook, ref)),
    }),
    [definition, workbook],
  );
  const fields = useMemo(() => [...dimensions, outputs], [dimensions, outputs]);
  const [chosenLayout, setLayout] = useState<PivotLayout | null>(null);
  const layout = reconcileLayout(chosenLayout ?? defaultLayout(fields), fields);
  const [compare, setCompare] = useState(false);
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);

  const pivot = useMemo(
    () => buildPivot(dimensions, outputs, layout, results.combinations, definition.samples),
    [dimensions, outputs, layout, results, definition.samples],
  );
  const rows = pivot.rowKeys.map((_, r) => r);
  const columnCount = Math.max(1, pivot.columnKeys.length);
  const cells = rows.map((r) => Array.from({ length: columnCount }, (_, c) => pivot.cell(r, c)));
  const baselineMean = (output: number) => summaryMean(results.baseline[output] ?? null);
  const deltas = cells.flat().map((cell) => {
    const mean = summaryMean(cell.summary);
    const base = baselineMean(cell.output);
    return mean === null || base === null ? 0 : mean - base;
  });
  const largestDelta = Math.max(0, ...deltas.map(Math.abs));

  if (sort) {
    rows.sort((a, b) => {
      const x = summaryMean(cells[a]?.[sort.column]?.summary ?? null) ?? Number.NEGATIVE_INFINITY;
      const y = summaryMean(cells[b]?.[sort.column]?.summary ?? null) ?? Number.NEGATIVE_INFINITY;
      return sort.descending ? y - x : x - y;
    });
  }

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const zoneFields = (zone: PivotZone) =>
    (zone === "filters" ? Object.keys(layout.filters) : layout[zone]).flatMap(
      (id) => fieldById.get(id) ?? [],
    );

  // Column header rows: one per column field, spanning the fields below it.
  const headerRows = pivot.columnFields.map((field, level) => {
    const span = pivot.columnFields.slice(level + 1).reduce((n, f) => n * f.values.length, 1);
    const groups = pivot.columnKeys.filter((_, c) => c % span === 0);
    return { field, span, labels: groups.map((key) => field.values[key[level] ?? 0] ?? "") };
  });

  const cellLabel = (row: number, column: number) => {
    const parts = [
      ...pivot.rowFields.map((f, i) => f.values[pivot.rowKeys[row]?.[i] ?? 0]),
      ...pivot.columnFields.map((f, i) => f.values[pivot.columnKeys[column]?.[i] ?? 0]),
    ];
    const output = outputs.values[cells[row]?.[column]?.output ?? 0];
    return [output, ...parts.filter((p) => p !== output)].join(" · ");
  };

  return (
    <Stack gap="xs" p="sm" className={classes.view}>
      <Group gap="xs" align="flex-start" className={classes.zones}>
        {ZONES.map(({ zone, label }) => (
          <Box
            key={zone}
            className={classes.zone}
            data-zone={zone}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const id = event.dataTransfer.getData("text/x-pivot-field");
              if (id) setLayout(moveField(layout, id, zone));
            }}
          >
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">
              {label}
            </Text>
            <Group gap={4}>
              {zoneFields(zone).map((field) => (
                <FieldChip
                  key={field.id}
                  field={field}
                  zone={zone}
                  layout={layout}
                  onLayout={setLayout}
                />
              ))}
            </Group>
          </Box>
        ))}
        <Switch
          size="xs"
          label="Compare with Baseline"
          checked={compare}
          onChange={(event) => setCompare(event.currentTarget.checked)}
          mt="md"
        />
      </Group>

      <Text size="xs" c="dimmed">
        Baseline:{" "}
        {outputs.values
          .map((name, o) => `${name} = ${summaryText(results.baseline[o] ?? null)}`)
          .join(" · ")}
      </Text>

      <Box className={classes.tableWrap}>
        <Table
          withTableBorder
          withColumnBorders
          className={classes.table}
          data-testid="scenario-pivot"
        >
          <Table.Thead>
            {headerRows.map(({ field, span, labels }, level) => (
              <Table.Tr key={field.id}>
                {level === 0 &&
                  pivot.rowFields.map((rowField) => (
                    <Table.Th
                      key={rowField.id}
                      rowSpan={headerRows.length + 1}
                      className={classes.rowHeader}
                    >
                      {rowField.name}
                    </Table.Th>
                  ))}
                {labels.map((text, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: header cells are positional
                  <Table.Th key={i} colSpan={span} ta="center">
                    <Text size="xs" c="dimmed">
                      {field.name}
                    </Text>
                    {text}
                  </Table.Th>
                ))}
              </Table.Tr>
            ))}
            <Table.Tr>
              {headerRows.length === 0 &&
                pivot.rowFields.map((rowField) => (
                  <Table.Th key={rowField.id} className={classes.rowHeader}>
                    {rowField.name}
                  </Table.Th>
                ))}
              {Array.from({ length: columnCount }, (_, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <Table.Th key={c} ta="center" className={classes.sortHeader}>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    aria-label={`Sort by column ${c + 1}`}
                    onClick={() =>
                      setSort((current) =>
                        current?.column === c
                          ? current.descending
                            ? null
                            : { column: c, descending: true }
                          : { column: c, descending: false },
                      )
                    }
                  >
                    {sort?.column === c ? (
                      sort.descending ? (
                        <IconSortDescending size={14} />
                      ) : (
                        <IconSortAscending size={14} />
                      )
                    ) : (
                      <IconArrowsSort size={14} />
                    )}
                  </Button>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r}>
                {pivot.rowFields.map((field, i) => (
                  <Table.Th key={field.id} className={classes.rowHeader}>
                    {field.values[pivot.rowKeys[r]?.[i] ?? 0]}
                  </Table.Th>
                ))}
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = cells[r]?.[c];
                  const summary = cell?.summary ?? null;
                  const mean = summaryMean(summary);
                  const base = baselineMean(cell?.output ?? 0);
                  const showDelta = compare && mean !== null && base !== null;
                  const background = showDelta
                    ? undefined
                    : summary?.kind === "uncertain"
                      ? histogramBackground(
                          normalized(summary.histogram.counts),
                          HISTOGRAM_COLORS[scheme],
                        )
                      : undefined;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    <Table.Td key={c} p={0}>
                      <Popover position="bottom" withArrow shadow="md" withinPortal>
                        <Popover.Target>
                          <button
                            type="button"
                            className={classes.cell}
                            data-kind={summary?.kind ?? "pending"}
                            style={{
                              ...(background ? { backgroundImage: background } : {}),
                              ...(showDelta
                                ? { backgroundColor: deltaShade(mean - base, largestDelta) }
                                : {}),
                            }}
                          >
                            {showDelta ? deltaText(mean, base) : summaryText(summary)}
                          </button>
                        </Popover.Target>
                        <Popover.Dropdown>
                          <CellDetail summary={summary} label={cellLabel(r, c)} />
                        </Popover.Dropdown>
                      </Popover>
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    </Stack>
  );
}
