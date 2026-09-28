import { Button, Group, Menu, Text } from "@mantine/core";
import {
  IconArrowsSplit,
  IconDeviceFloppy,
  IconFile,
  IconFolderOpen,
  IconTablePlus,
  IconTimeline,
} from "@tabler/icons-react";
import { ConfigMenu, type ConfigMenuProps } from "./ConfigMenu";

export interface MenuBarProps {
  config: ConfigMenuProps;
  title: string;
  dirty: boolean;
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
  onNewSheet: () => void;
  onNewSeriesSheet: () => void;
  onNewScenario: () => void;
}

export function MenuBar({
  config,
  title,
  dirty,
  onNew,
  onSave,
  onLoad,
  onNewSheet,
  onNewSeriesSheet,
  onNewScenario,
}: MenuBarProps) {
  return (
    <Group h={36} px="xs" gap="xs" wrap="nowrap" justify="space-between">
      <Group gap={4} wrap="nowrap">
        <Text fw={700} size="sm" px="xs">
          fumoca
        </Text>
        <Menu position="bottom-start" shadow="md" width={180}>
          <Menu.Target>
            <Button variant="subtle" color="gray" size="compact-sm">
              File
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconFile size={16} />} onClick={onNew}>
              New
            </Menu.Item>
            <Menu.Item leftSection={<IconDeviceFloppy size={16} />} onClick={onSave}>
              Save
            </Menu.Item>
            <Menu.Item leftSection={<IconFolderOpen size={16} />} onClick={onLoad}>
              Load
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu position="bottom-start" shadow="md" width={200}>
          <Menu.Target>
            <Button variant="subtle" color="gray" size="compact-sm">
              Model
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconTablePlus size={16} />} onClick={onNewSheet}>
              New sheet
            </Menu.Item>
            <Menu.Item leftSection={<IconTimeline size={16} />} onClick={onNewSeriesSheet}>
              New series sheet
            </Menu.Item>
            <Menu.Item leftSection={<IconArrowsSplit size={16} />} onClick={onNewScenario}>
              New scenario
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <ConfigMenu {...config} />
      </Group>
      <Text size="sm" c="dimmed" truncate data-testid="model-title">
        {title}
        {dirty ? " •" : ""}
      </Text>
    </Group>
  );
}
