import { Button, Group, Tooltip } from "@mantine/core";
import { IconCar, IconFlask } from "@tabler/icons-react";

export interface ToolbarProps {
  onLoadTestModel: () => void;
  onLoadTeslaModel: () => void;
}

export function Toolbar({ onLoadTestModel, onLoadTeslaModel }: ToolbarProps) {
  const models = [
    {
      label: "Test model",
      tooltip: "Replace the current model with the test model",
      icon: IconFlask,
      onClick: onLoadTestModel,
    },
    {
      label: "Tesla model",
      tooltip: "Replace the current model with ARK Invest's Tesla 2029 valuation",
      icon: IconCar,
      onClick: onLoadTeslaModel,
    },
  ];
  return (
    <Group h={40} px="xs" gap="xs" wrap="nowrap">
      {models.map(({ label, tooltip, icon: Icon, onClick }) => (
        <Tooltip key={label} label={tooltip}>
          <Button
            variant="default"
            size="compact-sm"
            leftSection={<Icon size={16} />}
            onClick={onClick}
          >
            {label}
          </Button>
        </Tooltip>
      ))}
    </Group>
  );
}
