import type { Scenario, Sheet } from "@fumoca/storage";
import {
  IconAdjustmentsHorizontal,
  IconArrowsSplit,
  IconTable,
  IconTimeline,
} from "@tabler/icons-react";

/**
 * The icon for each kind of thing the sheet area can open, used wherever it's listed or shown —
 * the side panel, the menus and the window tabs — so they always match.
 */
export type Icon = typeof IconTable;

export const SHEET_ICON: Icon = IconTable;
export const SERIES_SHEET_ICON: Icon = IconTimeline;

export const sheetIcon = (sheet: Pick<Sheet, "series">): Icon =>
  sheet.series ? SERIES_SHEET_ICON : SHEET_ICON;

export const SCENARIO_ICONS: Record<Scenario["kind"], Icon> = {
  scenario: IconArrowsSplit,
  sensitivity: IconAdjustmentsHorizontal,
};
