import { Button, Group, NumberInput, Popover, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { type EngineSettings, MAX_ITERATIONS, validateSettings } from "./engineSettings";

export interface ConfigMenuProps {
  settings: EngineSettings;
  gpuAvailable: boolean;
  onApply: (settings: EngineSettings) => void;
}

/**
 * The Config menu: iterations per recalculation for each engine, where 0 disables it. With both
 * engines running, the GPU's results are shown and compared with the CPU's (SPECS.md §6.7).
 */
export function ConfigMenu({ settings, gpuAvailable, onApply }: ConfigMenuProps) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setDraft(settings);
    setError(null);
    setOpened(true);
  };

  const apply = () => {
    const problem = validateSettings(draft, gpuAvailable);
    setError(problem);
    if (problem) return;
    onApply(draft);
    setOpened(false);
  };

  const iterations = (value: string | number) => (typeof value === "number" ? value : Number.NaN);

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" shadow="md" width={280}>
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          onClick={() => (opened ? setOpened(false) : open())}
        >
          Config
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Stack gap="sm">
            <Text size="sm" fw={600}>
              Engines
            </Text>
            <NumberInput
              label="CPU iterations"
              description="0 disables the CPU engine"
              value={draft.cpuIterations}
              min={0}
              max={MAX_ITERATIONS}
              step={1000}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=","
              onChange={(value) => setDraft((d) => ({ ...d, cpuIterations: iterations(value) }))}
            />
            <NumberInput
              label="GPU iterations"
              description={
                gpuAvailable
                  ? "0 disables the GPU engine"
                  : "WebGPU is not available in this browser"
              }
              value={draft.gpuIterations}
              disabled={!gpuAvailable}
              min={0}
              max={MAX_ITERATIONS}
              step={100_000}
              allowDecimal={false}
              allowNegative={false}
              thousandSeparator=","
              onChange={(value) => setDraft((d) => ({ ...d, gpuIterations: iterations(value) }))}
            />
            {error ? (
              <Text size="sm" c="red" role="alert">
                {error}
              </Text>
            ) : null}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" size="xs" onClick={() => setOpened(false)}>
                Cancel
              </Button>
              <Button type="submit" size="xs">
                Apply
              </Button>
            </Group>
          </Stack>
        </form>
      </Popover.Dropdown>
    </Popover>
  );
}
