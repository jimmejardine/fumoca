import type { Scenario, Sheet } from "@fumoca/storage";
import { ActionIcon, Button, Menu, NavLink, ScrollArea, Stack, Tabs } from "@mantine/core";
import { IconChevronLeft, IconDots, IconPlus, IconTablePlus, IconTrash } from "@tabler/icons-react";
import { SCENARIO_ICONS, SERIES_SHEET_ICON, SHEET_ICON } from "./icons";
import { SheetList } from "./SheetList";
import classes from "./SidePanel.module.css";

const TABS = ["sheets", "scenarios", "sensitivity"] as const;

/** The open tab, or null when the panel is collapsed to its tab strip. */
export type SideTab = (typeof TABS)[number] | null;

const asTab = (value: unknown): SideTab => TABS.find((tab) => tab === value) ?? null;

/** The panel's width when open, and when collapsed to its tab strip. */
export const SIDE_PANEL_WIDTH = 240;
export const SIDE_TABS_WIDTH = 34;

const STORAGE_KEY = "fumoca.sideTab";

/** The tab open when the app last closed, saved per browser. Starts collapsed the first time. */
export function loadSideTab(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): SideTab {
  try {
    return asTab(storage?.getItem(STORAGE_KEY));
  } catch {
    // Storage can be unavailable (private browsing, blocked site data).
  }
  return null;
}

export function saveSideTab(
  tab: SideTab,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, tab ?? "collapsed");
  } catch {
    // The panel still works; it just starts collapsed next time.
  }
}

/**
 * A list of scenarios of one kind, each opened by clicking it and deleted from its menu, under a
 * button that adds one.
 */
function ScenarioList({
  scenarios,
  label,
  newLabel,
  activePanelId,
  onOpen,
  onNew,
  onDelete,
}: {
  scenarios: Scenario[];
  /** The list's accessible name: "Scenarios". */
  label: string;
  newLabel: string;
  activePanelId: string | null;
  onOpen: (scenarioId: string) => void;
  onNew: () => void;
  onDelete: (scenarioId: string) => void;
}) {
  return (
    <>
      <Stack gap={4} p="xs">
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={16} />}
          onClick={onNew}
        >
          {newLabel}
        </Button>
      </Stack>
      <ScrollArea>
        <nav aria-label={label}>
          {scenarios.map((scenario) => {
            const Icon = SCENARIO_ICONS[scenario.kind];
            return (
              <NavLink
                key={scenario.id}
                component="button"
                label={scenario.name}
                leftSection={<Icon size={16} />}
                active={scenario.id === activePanelId}
                onClick={() => onOpen(scenario.id)}
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
                          onDelete(scenario.id);
                        }}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                }
              />
            );
          })}
        </nav>
      </ScrollArea>
    </>
  );
}

const { scenario: ScenarioIcon, sensitivity: SensitivityIcon } = SCENARIO_ICONS;

export interface SidePanelProps {
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  sheets: Sheet[];
  scenarios: Scenario[];
  /** The id of the active tab in the sheet area: a sheet's or a scenario's. */
  activePanelId: string | null;
  onOpenSheet: (sheetId: string) => void;
  onNewSheet: () => void;
  onNewSeriesSheet: () => void;
  onOpenScenario: (scenarioId: string) => void;
  onNewScenario: (kind: Scenario["kind"]) => void;
  onDeleteScenario: (scenarioId: string) => void;
}

/**
 * The left-hand panel: tabs for the model's sheets, its scenarios (SPECS.md §7) and its
 * sensitivity analyses (§7.5), each with buttons to add one. More tabs can join them later. It collapses to its tab strip, from the handle
 * on its edge or by clicking the open tab, and clicking a tab opens it again.
 */
export function SidePanel({
  tab,
  onTabChange,
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
      value={tab}
      onChange={(value) => onTabChange(asTab(value))}
      allowTabDeactivation
      orientation="vertical"
      placement="left"
      classNames={{ root: classes.tabs, list: classes.list, tab: classes.tab }}
    >
      {tab && (
        <ActionIcon
          className={classes.collapse}
          variant="default"
          radius="xl"
          size="sm"
          aria-label="Collapse side panel"
          title="Collapse side panel"
          onClick={() => onTabChange(null)}
        >
          <IconChevronLeft size={14} />
        </ActionIcon>
      )}
      <Tabs.List>
        <Tabs.Tab value="sheets" leftSection={<SHEET_ICON size={16} />}>
          Sheets
        </Tabs.Tab>
        <Tabs.Tab value="scenarios" leftSection={<ScenarioIcon size={16} />}>
          Scenarios
        </Tabs.Tab>
        <Tabs.Tab value="sensitivity" leftSection={<SensitivityIcon size={16} />}>
          Sensitivities
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
            leftSection={<SERIES_SHEET_ICON size={16} />}
            onClick={onNewSeriesSheet}
          >
            New series sheet
          </Button>
        </Stack>
        <SheetList sheets={sheets} activeSheetId={activePanelId} onOpen={onOpenSheet} />
      </Tabs.Panel>

      <Tabs.Panel value="scenarios" className={classes.panel}>
        <ScenarioList
          scenarios={scenarios.filter((s) => s.kind === "scenario")}
          label="Scenarios"
          newLabel="New scenario"
          activePanelId={activePanelId}
          onOpen={onOpenScenario}
          onNew={() => onNewScenario("scenario")}
          onDelete={onDeleteScenario}
        />
      </Tabs.Panel>

      <Tabs.Panel value="sensitivity" className={classes.panel}>
        <ScenarioList
          scenarios={scenarios.filter((s) => s.kind === "sensitivity")}
          label="Sensitivity analyses"
          newLabel="New analysis"
          activePanelId={activePanelId}
          onOpen={onOpenScenario}
          onNew={() => onNewScenario("sensitivity")}
          onDelete={onDeleteScenario}
        />
      </Tabs.Panel>
    </Tabs>
  );
}
