/**
 * Window events from the editor chunk to the app shell. The debugger now
 * lives in the thread panel's Debug section (`lib/rightPanel.ts`); OPEN_DEBUG_EVENT is
 * no longer fired and stays only because App.tsx still listens for it —
 * M8e can drop the listener and this constant together.
 */
export const OPEN_DEBUG_EVENT = "docket:open-debug";
export const OPEN_SETTINGS_EVENT = "docket:open-settings";

/** The row a request for Settings asked to be shown, until the page that draws it takes it (lib/settings/reveal.ts). */
let wantedRow: string | null = null;
export const takeSettingsRow = (): string | null => {
  const row = wantedRow;
  wantedRow = null;
  return row;
};
/** The row asked for, left in place (a test's look). */
export const peekSettingsRow = (): string | null => wantedRow;
/** Fired on `window` when a row is asked for, so a page already open goes to it. */
export const SETTINGS_ROW_EVENT = "docket:settings-row";

/** Opens Settings on a page; with `row` (a setting's id in lib/settings/map.ts) the page scrolls to that row and holds a fill on it. */
export function requestSettings(section: string, row?: string): void {
  wantedRow = row ?? null;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
  if (row) window.dispatchEvent(new CustomEvent(SETTINGS_ROW_EVENT));
}
