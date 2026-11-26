import { settingEntry } from "./map";

/**
 * The one sheet behind "What <computer> may do on this Mac" (docs/agents/settings.md "The pages: computers"): its one
 * home, opened from Sharing's list of other computers, from Computer use's "Who may use this Mac's apps" and from a
 * computer's own page. A page asks for it here; the sheet's host (surfaces/settings/computers/MaySheet.tsx
 * `MaySheetHost`, mounted by SettingsView) hears the ask.
 */
export const MAY_SHEET_EVENT = "docket:settings-may-sheet";

/** Opens the sheet for one linked computer, by its environment id. */
export function openMaySheet(environmentId: string): void {
  window.dispatchEvent(new CustomEvent<string>(MAY_SHEET_EVENT, { detail: environmentId }));
}

/** The heading the map gives every row of the sheet. */
export const MAY_SHEET_SECTION = "What {computer} may do on {mac}";

/** A map row that is drawn in the sheet, not on Sharing. */
export const inMaySheet = (row: string): boolean => settingEntry(row).section === MAY_SHEET_SECTION;
