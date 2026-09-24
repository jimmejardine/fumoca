import { Button, Group, Menu, Text } from "@mantine/core";
import { IconDeviceFloppy, IconFile, IconFolderOpen } from "@tabler/icons-react";

export interface MenuBarProps {
  title: string;
  dirty: boolean;
  onNew: () => void;
  onSave: () => void;
  onLoad: () => void;
}

export function MenuBar({ title, dirty, onNew, onSave, onLoad }: MenuBarProps) {
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
      </Group>
      <Text size="sm" c="dimmed" truncate data-testid="model-title">
        {title}
        {dirty ? " •" : ""}
      </Text>
    </Group>
  );
}
