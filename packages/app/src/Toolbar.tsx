import { Button, Group, Tooltip } from "@mantine/core";
import { IconFlask } from "@tabler/icons-react";

export interface ToolbarProps {
  onLoadTestModel: () => void;
}

export function Toolbar({ onLoadTestModel }: ToolbarProps) {
  return (
    <Group h={40} px="xs" gap="xs" wrap="nowrap">
      <Tooltip label="Replace the current model with the test model">
        <Button
          variant="default"
          size="compact-sm"
          leftSection={<IconFlask size={16} />}
          onClick={onLoadTestModel}
        >
          Test model
        </Button>
      </Tooltip>
    </Group>
  );
}
