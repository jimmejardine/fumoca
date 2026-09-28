import type { Scenario, Sheet } from "@fumoca/storage";
import { ActionIcon, Button, Menu, NavLink, ScrollArea, Stack, Tabs } from "@mantine/core";
import {
  IconArrowsSplit,
  IconDots,
  IconPlus,
  IconTable,
  IconTablePlus,
  IconTimeline,
  IconTrash,
} from "@tabler/icons-react";
import { SheetList } from "./SheetList";
import classes from "./SidePanel.module.css";

export interface SidePanelProps {
  sheets: Sheet[];
  scenarios: Scenario[];
  /** The id of the active tab in the sheet area: a sheet's or a scenario's. */
  activePanelId: string | null;
  onOpenSheet: (sheetId: string) => void;
  onNewSheet: () => void;
  onNewSeriesSheet: () => void;
  onOpenScenario: (scenarioId: string) => void;
  onNewScenario: () => void;
  onDeleteScenario: (scenarioId: string) => void;
}

/**
 * The left-hand panel: tabs for the model's sheets and its scenarios (SPECS.md §7), each with
 * buttons to add one. More tabs can join them later.
 */
export function SidePanel({
  sheets,
  scenarios,
  activePanelId,
  onOpenSheet,
  onNewSheet,
  onNewSeriesSheet,
  onOpenScenario,
  onNewScenario,
  onDeleteScenario,
}: SidePanelProps) {
  return (
    <Tabs
      defaultValue="sheets"
      orientation="vertical"
      placement="left"
      classNames={{ root: classes.tabs, list: classes.list, tab: classes.tab }}
    >
      <Tabs.List>
        <Tabs.Tab value="sheets" leftSection={<IconTable size={16} />}>
          Sheets
        </Tabs.Tab>
        <Tabs.Tab value="scenarios" leftSection={<IconArrowsSplit size={16} />}>
          Scenarios
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="sheets" className={classes.panel}>
        <Stack gap={4} p="xs">
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<IconTablePlus size={16} />}
            onClick={onNewSheet}
          >
            New sheet
          </Button>
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<IconTimeline size={16} />}
            onClick={onNewSeriesSheet}
          >
            New series sheet
          </Button>
        </Stack>
        <SheetList sheets={sheets} activeSheetId={activePanelId} onOpen={onOpenSheet} />
      </Tabs.Panel>

      <Tabs.Panel value="scenarios" className={classes.panel}>
        <Stack gap={4} p="xs">
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={onNewScenario}
          >
            New scenario
          </Button>
        </Stack>
        <ScrollArea>
          <nav aria-label="Scenarios">
            {scenarios.map((scenario) => (
              <NavLink
                key={scenario.id}
                component="button"
                label={scenario.name}
                leftSection={<IconArrowsSplit size={16} />}
                active={scenario.id === activePanelId}
                onClick={() => onOpenScenario(scenario.id)}
                rightSection={
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        component="span"
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={`${scenario.name} actions`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <IconDots size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteScenario(scenario.id);
                        }}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                }
              />
            ))}
          </nav>
        </ScrollArea>
      </Tabs.Panel>
    </Tabs>
  );
}
