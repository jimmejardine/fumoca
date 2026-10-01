import { Group, Paper, Text, useComputedColorScheme } from "@mantine/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/esm/core";
import { type BinnedPart, histogramRange, rebin } from "./pivot";
import { formatNumber } from "./recalc";
import type { OutputSummary } from "./scenarioRun";
import type { TornadoBar } from "./sensitivity";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

/**
 * The charts for a sensitivity analysis's selected cell (SPECS.md §7.5): the tornado and spider
 * for its output, and the output's distribution with its input down, at the Baseline, and up.
 * Loaded on demand, so the charting library stays out of the main bundle.
 */

const UP = "rgb(64, 192, 87)";
const DOWN = "rgb(250, 82, 82)";
const BASE = "rgb(34, 139, 230)";

const round = (value: number) => formatNumber(Number(value.toPrecision(4)));
/** Axis labels: 3 significant digits. */
const short = (value: number) => formatNumber(Number(value.toPrecision(3)));

function Chart({
  title,
  option,
  height = 220,
}: {
  title: string;
  option: object;
  height?: number;
}) {
  const scheme = useComputedColorScheme("light");
  return (
    <Paper withBorder p="xs" w={380}>
      <Text size="sm" fw={600}>
        {title}
      </Text>
      <ReactEChartsCore
        echarts={echarts}
        option={{ backgroundColor: "transparent", animation: false, ...option }}
        {...(scheme === "dark" ? { theme: "dark" } : {})}
        notMerge
        style={{ height }}
        opts={{ renderer: "svg" }}
      />
    </Paper>
  );
}

export interface SensitivityChartsProps {
  output: string;
  input: string;
  /** The step the tornado and distributions are for: "±1%". */
  stepLabel: string;
  /** Every input's name, by index. */
  inputs: string[];
  /** The output's Baseline value (of the chosen statistic) and each input's swing about it. */
  base: number;
  bars: TornadoBar[];
  /** The output's results with the selected input down, at the Baseline, and up. */
  distributions: {
    down: OutputSummary | null;
    base: OutputSummary | null;
    up: OutputSummary | null;
  };
  /** Spider lines by input: the output's % change against the input's (null where undefined). */
  spider: ([number, number][] | null)[] | null;
}

export default function SensitivityCharts(props: SensitivityChartsProps) {
  return (
    <Group align="flex-start" gap="sm" data-testid="sensitivity-charts">
      <TornadoChart {...props} />
      <ShiftChart {...props} />
      {props.spider && <SpiderChart {...props} spider={props.spider} />}
    </Group>
  );
}

/** Each input's swing in the output, largest at the top: the down bar and the up bar. */
function TornadoChart({ output, input, inputs, stepLabel, base, bars }: SensitivityChartsProps) {
  // ECharts draws categories bottom to top, so the largest swing goes last.
  const order = [...bars].reverse();
  const name = (bar: TornadoBar) => inputs[bar.input] ?? "";
  const bold = (bar: TornadoBar) => (name(bar) === input ? 1 : 0.55);
  return (
    <Chart
      title={`${output}: tornado, ${stepLabel} (Baseline ${round(base)})`}
      height={Math.max(160, 40 + 28 * bars.length)}
      option={{
        grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
        legend: { top: 0, data: ["Input down", "Input up"] },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: round },
        xAxis: {
          type: "value",
          splitNumber: 3,
          axisLabel: { hideOverlap: true, formatter: (v: number) => short(base + v) },
        },
        yAxis: { type: "category", data: order.map(name) },
        series: [
          {
            name: "Input down",
            type: "bar",
            stack: "swing",
            data: order.map((bar) => ({ value: bar.down, itemStyle: { opacity: bold(bar) } })),
            itemStyle: { color: DOWN },
          },
          {
            name: "Input up",
            type: "bar",
            stack: "swing",
            data: order.map((bar) => ({ value: bar.up, itemStyle: { opacity: bold(bar) } })),
            itemStyle: { color: UP },
          },
        ],
      }}
    />
  );
}

/** The output's distribution with the input down, at the Baseline, and up, on one axis. */
function ShiftChart({ output, input, stepLabel, distributions }: SensitivityChartsProps) {
  const entries = [
    { name: `${input} down`, summary: distributions.down, color: DOWN },
    { name: "Baseline", summary: distributions.base, color: BASE },
    { name: `${input} up`, summary: distributions.up, color: UP },
  ];
  const parts = entries.map(({ summary }): BinnedPart | null =>
    summary?.kind === "uncertain"
      ? { count: summary.count, mean: summary.mean, histogram: summary.histogram }
      : summary?.kind === "number"
        ? { count: 1, mean: summary.value, histogram: null }
        : null,
  );
  const title = `${output} with ${input} ${stepLabel}`;
  if (parts.some((p) => p === null)) {
    return <Chart title={title} height={60} option={{ title: { text: "No distribution yet" } }} />;
  }
  if (entries.every(({ summary }) => summary?.kind === "number")) {
    return (
      <Paper withBorder p="xs" w={380}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <Text size="sm" c="dimmed">
          {output} is exact (the same in every iteration):{" "}
          {entries
            .map(({ name, summary }) =>
              summary?.kind === "number" ? `${name} ${round(summary.value)}` : "",
            )
            .join(" · ")}
        </Text>
      </Paper>
    );
  }
  const known = parts.filter((p): p is BinnedPart => p !== null);
  const { lo, hi } = histogramRange(known);
  const bins = 48;
  const width = (hi - lo) / bins;
  return (
    <Chart
      title={title}
      option={{
        grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
        legend: { top: 0 },
        tooltip: { trigger: "axis", valueFormatter: (v: number) => `${(v * 100).toFixed(1)}%` },
        xAxis: {
          type: "value",
          min: lo,
          max: hi,
          axisLabel: { hideOverlap: true, formatter: short },
        },
        yAxis: { type: "value", show: false },
        series: known.map((part, i) => {
          const counts = rebin([part], lo, hi, bins);
          const total = counts.reduce((a, b) => a + b, 0) || 1;
          return {
            name: entries[i]?.name,
            type: "line",
            step: "middle",
            symbol: "none",
            lineStyle: { color: entries[i]?.color, width: i === 1 ? 2 : 1.5 },
            itemStyle: { color: entries[i]?.color },
            areaStyle: i === 1 ? { opacity: 0.12 } : undefined,
            data: counts.map((n, b) => [lo + (b + 0.5) * width, n / total]),
          };
        }),
      }}
    />
  );
}

/** The output's % change against each input's % change, one line per input. */
function SpiderChart({
  output,
  input,
  inputs,
  spider,
}: SensitivityChartsProps & { spider: ([number, number][] | null)[] }) {
  const percent = (v: number) => `${Number(v.toPrecision(3))}%`;
  return (
    <Chart
      title={`${output}: spider (% change)`}
      option={{
        grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
        legend: { top: 0, type: "scroll" },
        tooltip: { trigger: "axis", valueFormatter: percent },
        xAxis: { type: "value", axisLabel: { formatter: percent } },
        yAxis: { type: "value", axisLabel: { formatter: percent } },
        series: spider.flatMap((points, i) =>
          points
            ? [
                {
                  name: inputs[i],
                  type: "line",
                  data: points,
                  symbolSize: 5,
                  lineStyle: { width: inputs[i] === input ? 3 : 1.5 },
                },
              ]
            : [],
        ),
      }}
    />
  );
}
