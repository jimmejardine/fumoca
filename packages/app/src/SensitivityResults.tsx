import { type SensitivityAnalysis, sensitivityIndex, type Workbook } from "@fumoca/storage";
import {
  Box,
  Center,
  Group,
  Loader,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconArrowsSort, IconSortAscending, IconSortDescending } from "@tabler/icons-react";
import { lazy, Suspense, useState } from "react";
import { cellRefText } from "./CellPicker";
import { formatNumber } from "./recalc";
import type { ScenarioRunState } from "./ScenarioResults";
import classes from "./ScenarioResults.module.css";
import own from "./SensitivityResults.module.css";
import type { ScenarioResults } from "./scenarioRun";
import {
  effectOf,
  lopsided,
  type MatrixSort,
  MEASURES,
  type Measure,
  matrixOrder,
  measure,
  nextSort,
  STATISTICS,
  type Statistic,
  spiderLine,
  tornado,
} from "./sensitivity";
import { deltaShade, summaryText } from "./summaryView";

const SensitivityCharts = lazy(() => import("./SensitivityCharts"));

/** A measure's value as text: elasticities as numbers, %Δy as a percentage, Δy signed. */
function measureText(value: number | null, how: Measure): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  if (how === "percent") return `${sign}${Number((value * 100).toPrecision(3))}%`;
  if (how === "elasticity") return formatNumber(Number(value.toPrecision(3)));
  return `${sign}${formatNumber(Number(value.toPrecision(4)))}`;
}

const stepLabel = (h: number) => `±${Number((h * 100).toPrecision(6))}%`;

function SortIcon({ active }: { active: MatrixSort | false }) {
  if (!active) return <IconArrowsSort size={12} opacity={0.5} />;
  return active.descending ? <IconSortDescending size={12} /> : <IconSortAscending size={12} />;
}

export interface SensitivityResultsViewProps {
  workbook: Workbook;
  run: ScenarioRunState<SensitivityAnalysis>;
  results: ScenarioResults;
}

/**
 * A sensitivity analysis's results (SPECS.md §7.5): a matrix of each input's effect (rows) on each
 * output (columns), sortable by clicking a header, and charts for the clicked cell's output.
 */
export function SensitivityResultsView({ workbook, run, results }: SensitivityResultsViewProps) {
  const { definition: analysis } = run;
  const [how, setHow] = useState<Measure>("elasticity");
  const [stat, setStat] = useState<Statistic>("mean");
  const [step, setStep] = useState(0);
  const [sort, setSort] = useState<MatrixSort>(null);
  const [selected, setSelected] = useState<{ input: number; output: number } | null>(null);

  const h = analysis.steps[step] ?? analysis.steps[0] ?? 0.01;
  const inputNames = analysis.inputs.map((ref) => cellRefText(workbook, ref));
  const outputNames = analysis.outputs.map((ref) => cellRefText(workbook, ref));
  const effects = analysis.inputs.map((_, i) =>
    analysis.outputs.map((_, o) => effectOf(analysis, results, i, step, o, stat)),
  );
  const values = effects.map((row) => row.map((e) => (e ? measure(e, h, how) : null)));
  const largest = Math.max(0, ...values.flat().map((v) => Math.abs(v ?? 0)));
  const order = matrixOrder(values, outputNames.length, sort);

  const chosen = selected && {
    ...selected,
    effects: analysis.inputs.map((_, i) =>
      effectOf(analysis, results, i, step, selected.output, stat),
    ),
  };
  const summaryAt = (input: number, sign: -1 | 1) =>
    results.combinations[sensitivityIndex(analysis, input, step, sign)]?.[chosen?.output ?? 0] ??
    null;

  return (
    <Stack gap="xs" p="sm" className={own.view}>
      <Group gap="sm" align="flex-end">
        <SegmentedControl
          size="xs"
          aria-label="Show"
          value={how}
          onChange={(value) => setHow(value as Measure)}
          data={MEASURES}
        />
        <Select
          size="xs"
          w={100}
          label="Of the"
          aria-label="Statistic"
          allowDeselect={false}
          value={stat}
          onChange={(value) => value && setStat(value as Statistic)}
          data={STATISTICS}
        />
        {analysis.steps.length > 1 && (
          <Select
            size="xs"
            w={110}
            label="Step"
            aria-label="Step"
            allowDeselect={false}
            value={String(step)}
            onChange={(value) => value && setStep(Number(value))}
            data={analysis.steps.map((x, i) => ({ value: String(i), label: stepLabel(x) }))}
          />
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {how === "elasticity"
          ? `Each cell: the % change in the output's ${stat === "mean" ? "mean" : STATISTICS.find((s) => s.value === stat)?.label} for a 1% change in the input, measured over ${stepLabel(h)}.`
          : `Each cell: the change in the output for a ${stepLabel(h).slice(1)} change in the input.`}{" "}
        Baseline:{" "}
        {outputNames
          .map((name, o) => `${name} = ${summaryText(results.baseline[o] ?? null)}`)
          .join(" · ")}
      </Text>

      <Box className={own.matrix}>
        <Table
          withTableBorder
          withColumnBorders
          className={classes.table}
          data-testid="sensitivity-matrix"
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th className={classes.rowHeader}>
                <Text size="xs" c="dimmed">
                  Input ↓ · Output →
                </Text>
              </Table.Th>
              {order.outputs.map((o) => (
                <Table.Th key={o} ta="center">
                  <UnstyledButton
                    className={own.header}
                    aria-label={`Sort inputs by ${outputNames[o]}`}
                    onClick={() => setSort((s) => nextSort(s, "output", o))}
                  >
                    <Group gap={4} wrap="nowrap" justify="center">
                      {outputNames[o]}
                      <SortIcon active={sort?.by === "output" && sort.index === o && sort} />
                    </Group>
                  </UnstyledButton>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {order.inputs.map((i) => (
              <Table.Tr key={i}>
                <Table.Th className={classes.rowHeader}>
                  <UnstyledButton
                    className={own.header}
                    aria-label={`Sort outputs by ${inputNames[i]}`}
                    onClick={() => setSort((s) => nextSort(s, "input", i))}
                  >
                    <Group gap={4} wrap="nowrap">
                      {inputNames[i]}
                      <SortIcon active={sort?.by === "input" && sort.index === i && sort} />
                    </Group>
                  </UnstyledButton>
                </Table.Th>
                {order.outputs.map((o) => {
                  const effect = effects[i]?.[o] ?? null;
                  const value = values[i]?.[o] ?? null;
                  const isSelected = selected?.input === i && selected.output === o;
                  return (
                    <Table.Td key={o} p={0}>
                      <button
                        type="button"
                        className={classes.cell}
                        data-kind={effect ? "uncertain" : "pending"}
                        data-selected={isSelected || undefined}
                        aria-label={`${inputNames[i]} on ${outputNames[o]}`}
                        style={{
                          backgroundColor: value === null ? undefined : deltaShade(value, largest),
                          ...(isSelected
                            ? { outline: "2px solid var(--mantine-primary-color-filled)" }
                            : {}),
                        }}
                        onClick={() => setSelected({ input: i, output: o })}
                      >
                        {effect ? measureText(value, how) : "…"}
                        {effect && lopsided(effect) && (
                          <Text
                            span
                            c="orange"
                            fw={700}
                            ml={4}
                            title="The effects of going down and up differ by more than 10%: the response isn't linear here"
                          >
                            ~
                          </Text>
                        )}
                      </button>
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>

      {chosen ? (
        <Suspense fallback={<Loader size="sm" />}>
          <SensitivityCharts
            output={outputNames[chosen.output] ?? ""}
            input={inputNames[chosen.input] ?? ""}
            stepLabel={stepLabel(h)}
            inputs={inputNames}
            base={chosen.effects.find((e) => e)?.base ?? 0}
            bars={tornado(chosen.effects)}
            distributions={{
              down: summaryAt(chosen.input, -1),
              base: results.baseline[chosen.output] ?? null,
              up: summaryAt(chosen.input, 1),
            }}
            spider={
              analysis.steps.length > 1
                ? analysis.inputs.map((_, i) =>
                    spiderLine(
                      analysis.steps,
                      analysis.steps.map((_, s) =>
                        effectOf(analysis, results, i, s, chosen.output, stat),
                      ),
                    ),
                  )
                : null
            }
          />
          {analysis.steps.length === 1 && (
            <Text size="xs" c="dimmed">
              Add another step to see a spider chart of how each effect bends.
            </Text>
          )}
        </Suspense>
      ) : (
        <Center p="md">
          <Text size="sm" c="dimmed">
            Click a cell for the tornado of its output, and how the input moves the output's
            distribution.
          </Text>
        </Center>
      )}
    </Stack>
  );
}
