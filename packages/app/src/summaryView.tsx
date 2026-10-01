import { Box, Group, Stack, Table, Text, useComputedColorScheme } from "@mantine/core";
import { histogramQuantile } from "./pivot";
import { formatNumber, formatUncertain } from "./recalc";
import { HISTOGRAM_COLORS, histogramBackground } from "./SheetGrid";
import type { OutputSummary } from "./scenarioRun";
import classes from "./summaryView.module.css";

/**
 * Displaying a run's result for one output (an `OutputSummary`): as text, as a change from the
 * Baseline, and in detail with its histogram. Shared by every kind of scenario's results.
 */

/** Histogram bar heights, scaled so the tallest is 1. */
export const normalized = (counts: number[]) => {
  const max = Math.max(...counts);
  return counts.map((c) => (max > 0 ? c / max : 0));
};

export function summaryText(summary: OutputSummary | null): string {
  if (!summary) return "…";
  if (summary.kind === "number") return formatNumber(summary.value);
  if (summary.kind === "uncertain") return formatUncertain(summary.mean, summary.sd);
  return summary.code;
}

/** A change from the Baseline: "+12.5 (+4.1%)". */
export function deltaText(value: number, baseline: number): string {
  const delta = value - baseline;
  const sign = delta > 0 ? "+" : "";
  const percent =
    baseline !== 0 ? ` (${sign}${((delta / Math.abs(baseline)) * 100).toFixed(1)}%)` : "";
  return `${sign}${formatNumber(Number(delta.toPrecision(4)))}${percent}`;
}

/** A diverging shade for a change: green up, red down, stronger for larger changes. */
export function deltaShade(delta: number, largest: number): string | undefined {
  if (!(largest > 0) || delta === 0) return undefined;
  const strength = Math.min(1, Math.abs(delta) / largest) * 0.35;
  return delta > 0 ? `rgba(64, 192, 87, ${strength})` : `rgba(250, 82, 82, ${strength})`;
}

/** A share as a percentage, to 2 significant digits: "0.42%". */
export const percent = (share: number) => `${Number((share * 100).toPrecision(2))}%`;

/** A larger histogram with summary statistics, shown when a pivot cell is clicked. */
export function CellDetail({ summary, label }: { summary: OutputSummary | null; label: string }) {
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
        className={classes.histogram}
        style={{
          backgroundImage: histogramBackground(
            normalized(histogram.counts),
            HISTOGRAM_COLORS[scheme],
            histogram,
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
      {(histogram.below > 0 || histogram.above > 0) && (
        <Text size="xs" c="dimmed">
          {[
            histogram.below > 0 &&
              `${percent(histogram.below)} below ${formatNumber(Number(histogram.lo.toPrecision(4)))}`,
            histogram.above > 0 &&
              `${percent(histogram.above)} above ${formatNumber(Number(histogram.hi.toPrecision(4)))}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
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
