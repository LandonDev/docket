import { ctrlOnly, modOrCtrl } from "../../lib/keys";
import type { AppCommandId } from "../../lib/appCommands";
import type { FilesCommand, FilesKeys } from "../../lib/filesKeys";

/**
 * The chord's Files command, or null. The same physical chords tabKeys.ts reads
 * for the thread tabs (either command key, as `tabCommand` takes them): mod+T a
 * new tab, mod+W close, mod+[ and mod+] back and forward, Ctrl+Tab and
 * Ctrl+Shift+Tab (and mod+Shift+] and mod+Shift+[, the menu's Next and Previous
 * Tab) the next and previous tab; mod+Shift+T opens the tab last closed again; mod+P is Go to and mod+F
 * Search, in the Files place's own bar; mod+Shift+N makes a folder, as in Finder (the app's New Window elsewhere).
 * mod+1–9, mod+N, mod+K and the rest stay the app's.
 */
export function filesChord(e: KeyboardEvent): FilesCommand | null {
  if (e.isComposing) return null;
  if (e.key === "Tab" && ctrlOnly(e) && !e.altKey) return e.shiftKey ? "prev-tab" : "next-tab";
  if (!modOrCtrl(e) || e.altKey) return null;
  if (e.shiftKey) {
    if (e.key === "]" || e.key === "}") return "next-tab";
    if (e.key === "[" || e.key === "{") return "prev-tab";
    if (e.key.toLowerCase() === "t") return "reopen-tab";
    if (e.key.toLowerCase() === "n") return "new-folder";
    return null;
  }
  const key = e.key.toLowerCase();
  if (key === "t") return "new-tab";
  if (key === "w") return "close-tab";
  if (key === "p") return "go-to";
  if (key === "f") return "search";
  if (e.key === "[" || e.code === "BracketLeft") return "back";
  if (e.key === "]" || e.code === "BracketRight") return "forward";
  return null;
}

/** The element the Files view marks itself with: focus inside it sends these chords to Files. */
export const FILES_VIEW = "[data-files-view]";

/** Where a key stays with what holds it, even inside the Files view. */
const NOT_FILES = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"]';

type Closest = { closest?: (selector: string) => unknown };
const within = (target: EventTarget | null, selector: string): boolean => {
  const el = target as Closest | null;
  return typeof el?.closest === "function" && !!el.closest(selector);
};

/**
 * Whether focus is inside the Files view, and not inside a dialog or a menu there. A canvas item's editor
 * (Monaco, CodeMirror) keeps the chords the resolver's earlier guards already leave it; the rest are the view's.
 */
export const filesOwnsFocus = (target: EventTarget | null): boolean => within(target, FILES_VIEW) && !within(target, NOT_FILES);

/**
 * The focus on nothing (the page's body) while a Files view is on screen: a click on the list's empty part or an Escape
 * from search leaves it there, and ⌘P is still the view's Go to (decision 11), never the app's code picker.
 */
export const filesIdle = (target: EventTarget | null, doc: Pick<Document, "body" | "documentElement" | "querySelector"> | null = typeof document === "undefined" ? null : document): boolean => {
  if (!doc || (target && target !== doc.body && target !== doc.documentElement)) return false;
  const view = doc.querySelector<HTMLElement>(FILES_VIEW);
  if (!view || view.closest("[inert], [hidden]")) return false;
  return typeof view.checkVisibility !== "function" || view.checkVisibility();
};

/**
 * What the close key closes: the file at a tab's side (SideFile.tsx) while the focus is in it, as its own × does;
 * anywhere else in the view, the tab, and the side with it.
 */
export const closeOf = (target: EventTarget | null): "side" | "tab" => (within(target, "[data-files-side]") ? "side" : "tab");

/**
 * After a close the focus lands on what is left, never on nothing: the tab's own file (its text where it has
 * some), else the chat that lies over it, else the tab shown.
 */
export function landFocus(root: ParentNode): void {
  const file = root.querySelector<HTMLElement>("[data-files-main]:not([inert])");
  const to =
    (file && (file.querySelector<HTMLElement>('[contenteditable="true"], textarea') ?? file)) ??
    root.querySelector<HTMLElement>("[data-files-dock] [data-composer-input]") ??
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  to?.focus({ preventScroll: true });
}

/** The menu rows whose keys are the Files place's chords, each with the Files command it runs there (⌘T is Type Hierarchy's row). */
export const FILES_MENU: Partial<Record<AppCommandId, FilesCommand>> = {
  close_tab: "close-tab",
  next_tab: "next-tab",
  prev_tab: "prev-tab",
  back_tab: "back",
  forward_tab: "forward",
  show_hierarchy: "new-tab",
  go_to_file: "go-to",
  find: "search",
  new_window: "new-folder",
};

/** What the view gives the port while it is mounted (lib/filesKeys.ts). */
export const FILES_KEYS: FilesKeys = { owns: filesOwnsFocus, idle: filesIdle, chord: filesChord, menu: FILES_MENU as Readonly<Record<string, FilesCommand>> };
