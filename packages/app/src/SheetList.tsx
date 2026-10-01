import type { Sheet } from "@fumoca/storage";
import { NavLink, ScrollArea } from "@mantine/core";
import { sheetIcon } from "./icons";

export interface SheetListProps {
  sheets: Sheet[];
  activeSheetId: string | null;
  onOpen: (sheetId: string) => void;
}

/**
 * The model's sheets. Clicking one opens it as a tab, or brings its tab to the front. Series
 * sheets get the same icon as Model → New series sheet.
 */
export function SheetList({ sheets, activeSheetId, onOpen }: SheetListProps) {
  return (
    <ScrollArea>
      <nav aria-label="Sheets">
        {sheets.map((sheet) => {
          const Icon = sheetIcon(sheet);
          return (
            <NavLink
              key={sheet.id}
              component="button"
              label={sheet.name}
              leftSection={<Icon size={16} />}
              active={sheet.id === activeSheetId}
              onClick={() => onOpen(sheet.id)}
            />
          );
        })}
      </nav>
    </ScrollArea>
  );
}
