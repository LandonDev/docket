/**
 * The one dialog behind "Add a computer…" (the foot of Other computers) and "Add…" (a computer's sign-in list): the
 * same dialog, opened one step earlier or later (docs/agents/settings.md "Add a computer"). A page asks for it here;
 * the dialog's host (surfaces/settings/computers/AddComputerHost.tsx, mounted by SettingsView) hears the ask.
 */
export type AddComputerAsk = {
  /** The way to start on; none starts at the choice of four. `device` signs a phone, a browser or a computer that
   *  already runs Docket in to `computer`; `setup` sets up a new computer; `link` links this Mac to another computer;
   *  `use-link` uses a setup link on this Mac. */
  way?: "device" | "setup" | "link" | "use-link";
  /** The environment id of the computer a device signs in to (`device`), or whose link is made again (`link`). */
  computer?: string;
};

export const ADD_COMPUTER_EVENT = "docket:settings-add-computer";

export function openAddComputer(ask: AddComputerAsk = {}): void {
  window.dispatchEvent(new CustomEvent<AddComputerAsk>(ADD_COMPUTER_EVENT, { detail: ask }));
}

/** The dialog made or took back a sign-in, a key, a setup link or a link to a computer. */
export const ADD_COMPUTER_CHANGED_EVENT = "docket:settings-add-computer-changed";

export function tellAddComputerChanged(): void {
  window.dispatchEvent(new Event(ADD_COMPUTER_CHANGED_EVENT));
}

/** A page that lists sign-ins, links or computers reads them again when the dialog changed one. */
export function onAddComputerChanged(listener: () => void): () => void {
  window.addEventListener(ADD_COMPUTER_CHANGED_EVENT, listener);
  return () => window.removeEventListener(ADD_COMPUTER_CHANGED_EVENT, listener);
}
