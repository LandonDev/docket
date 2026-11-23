import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem, CanvasSource, ContextChip } from "@shared/work";
import { chipsOf, fileChipOf, TOO_MANY_FILES, type FileEntry, type FilePlace } from "@shared/work/files";
import type { Session } from "../../lib/session";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { chipPort } from "../../lib/contextChips";
import { refusalWords } from "../../lib/settingsHome";
import { afterCreate } from "../../lib/tcserver/commands";
import { sessionStore } from "../../lib/tcserver/store";
import { workDockPort } from "../../lib/workSwitch";
import { aboutFor, addContextChip, CHIPS_MAX, contextChipsOf } from "../canvas/chips";
import { openItem } from "../canvas/store";
import { fileOf, heldBy, type OpenFrom } from "./open";
import { dockKey } from "./store";

/**
 * The chat docked beside a file (docs/agents/work-files.md "Ask"). Opening a file makes no thread, and neither does
 * Ask: the dock shows the newest thread of the workspace that holds the file, else a draft that is on no host and in
 * no rail. A draft becomes a thread by the composer's own send, and in that send, between the create and the
 * message, the new thread opens the file as an item of its own (`afterCreate`), so the first turn holds it. A dock
 * closed with nothing sent leaves nothing behind.
 */

type Workspace = OpenFrom["workspace"];

/** What a tab's dock showed this run, by `dockKey`: a draft's id (opened again, its composer keeps what he typed) or the thread it became. */
const shown = new Map<string, string>();

/** The thread a dock shows: a thread of the host's, or a draft not made yet. */
export interface DockThread {
  id: string;
  draft: boolean;
}

const say = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: refusalWords(err) || undefined }));

/** The `file` chip a draft starts with, so the first message says which file it is about; he may take it off. */
export const fileChip = (tab: Pick<FileTab, "name" | "copyOf">, item: Pick<CanvasItem, "source" | "title">): ContextChip | null => {
  const file = fileOf(tab, item);
  return file ? fileChipOf({ key: "", ref: file, folder: null, name: tab.name || item.title, kind: "other" }) : null;
};

/**
 * Files rows dropped on the docked composer (`ROWS_MIME`, the rows `dragging()` holds): a `file` chip each, beside
 * what the composer holds. Eight at most in all: past that none is added and one toast says why, as it does for a
 * drop of folders alone (`chipsOf`).
 */
export function addRowChips(sessionId: string, entries: readonly FileEntry[], place?: Pick<FilePlace, "id" | "name" | "shared" | "root"> | null): void {
  const got = chipsOf(entries, place);
  const refused = "refused" in got ? got.refused : contextChipsOf(sessionId).length + got.chips.length > CHIPS_MAX ? TOO_MANY_FILES : null;
  if (refused) return void loadToast().then((toast) => toast.message(refused));
  if ("chips" in got) for (const chip of got.chips) addContextChip(sessionId, chip);
}

/**
 * Which thread the tab's dock shows: the one it showed before, while it is a live thread; else the newest unarchived
 * thread of the workspace that holds the file; else a draft (the one from before, so what he typed is still there).
 */
export async function dockThread(workspace: Workspace, tab: FileTab, item: CanvasItem): Promise<DockThread> {
  const key = dockKey(workspace.id, tab.id);
  const known = shown.get(key);
  const meta = known ? sessionStore.metaOf(known) : null;
  if (known && meta && !meta.archived) return { id: known, draft: false };
  const file = fileOf(tab, item);
  const held = file ? await heldBy(workspace, file, true) : null;
  if (held) {
    shown.set(key, held.sessionId);
    return { id: held.sessionId, draft: false };
  }
  // A thread from before that is now archived is not reopened as a draft: a new draft takes its place.
  const id = draftFor(workspace, tab, item, known && !meta ? known : undefined);
  shown.set(key, id);
  return { id, draft: true };
}

/** The drafts the docks made this run: the session to put back in the open set, its file's chip, and its first send's step. */
const drafts = new Map<string, { session: Session; chip: ContextChip | null; hold: () => Promise<void> }>();
/** Drafts whose composer has held the file's chip, and those he took it off: a chip he took off is not put back. */
const chipSeen = new Set<string>();
const chipTaken = new Set<string>();

const sameChip = (a: ContextChip, b: ContextChip): boolean => a.kind === b.kind && JSON.stringify(a.ref) === JSON.stringify(b.ref);

/**
 * Follows each dock draft's chips as he changes them. The file's chip gone from a composer that still has a draft is
 * his doing, unless the composer is sending: a send takes every chip at once and keeps the first for the create
 * (`aboutFor`), and then the chip went with the message.
 */
function heedChips(): void {
  for (const [id, draft] of drafts) {
    if (!draft.chip || chipTaken.has(id) || !sessionStore.isDraft(id)) continue;
    const have = contextChipsOf(id);
    if (have.some((c) => sameChip(c, draft.chip!))) chipSeen.add(id);
    else if (chipSeen.has(id) && !(have.length === 0 && aboutFor(id))) chipTaken.add(id);
  }
}
let heeding = false;

/** A draft for the tab, in the store's open set (no host has it, so no rail lists it), its file's chip on it. */
function draftFor(workspace: Workspace, tab: FileTab, item: CanvasItem, again: string | undefined): string {
  const port = workDockPort.get();
  if (!port) throw new Error("This window cannot start a chat here");
  if (!heeding) {
    heeding = true;
    chipPort.subscribe(heedChips);
  }
  // The draft from before as it last stood (his picks kept), else a new one seeded as New thread seeds one.
  const session = (again ? sessionStore.get(again) : undefined) ?? port.draft(workspace, again);
  const chip = fileChip(tab, item);
  // The first send opens the file in the new thread only while its chip is still on the composer.
  drafts.set(session.id, { session, chip, hold: () => (chipTaken.has(session.id) ? Promise.resolve() : holdFile(workspace, tab, item, session.id)) });
  // In the store before the dock draws it, so nothing asks a host for an id no host has.
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== session.id), session]);
  putChip(session.id);
  return session.id;
}

/** The file's chip on a draft's composer, unless he took it off. */
function putChip(id: string): void {
  const chip = drafts.get(id)?.chip;
  if (chip && !chipTaken.has(id)) addContextChip(id, chip);
}

/**
 * The dock shows `id`. A draft goes into the session store's open set (as it last stood there, its picks kept), its
 * file's chip is on its composer (each time it is shown, the first Ask of a tab included, unless he took it off), and
 * its first send's step is set: the new thread opens the file before the message goes. A thread is left as it is.
 */
export function enterDock(id: string): void {
  const draft = drafts.get(id);
  if (!draft || !sessionStore.isDraft(id) || sessionStore.isProvisional(id)) return;
  if (!sessionStore.isOpen(id)) {
    const session = sessionStore.get(id) ?? draft.session;
    sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), session]);
  }
  putChip(id);
  afterCreate.set(id, draft.hold);
}

/**
 * The new thread holds the file: its own item on the same source, or for a copy of a file on another computer a copy
 * of its own (the tab's copy goes with the tab). Run by the first send, after `session.create` and before
 * `session.send`. The item is the thread's, shown when the thread is opened in its own tab; here the file is beside it.
 */
export async function holdFile(workspace: Workspace, tab: Pick<FileTab, "copyOf" | "name">, item: CanvasItem, sessionId: string): Promise<void> {
  try {
    let source: CanvasSource = item.source;
    const file = fileOf(tab, item);
    if (tab.copyOf && file) source = (await registry.linkOf(workspace.environmentId).request<{ source: CanvasSource }>("work.office.filesCopy", { sessionId, source: file })).source;
    await openItem(workspace.environmentId, sessionId, { kind: item.kind, source, title: item.title });
  } catch (err) {
    say(`${tab.name || item.title} did not open in the chat`, err);
  }
}

/**
 * The dock let go of what it showed. A draft he sent nothing in leaves the open set (it was never on a host) and its
 * step is cleared; its composer's words and chips stay with its id, for the next time the tab's dock opens this run,
 * or for the same dock mounted again (`enterDock` puts it back). A draft whose first send is under way is left to it.
 */
export function leaveDock(id: string): void {
  if (!sessionStore.isDraft(id) || sessionStore.isProvisional(id)) return;
  if ((sessionStore.get(id)?.blocks.length ?? 0) > 0) return;
  afterCreate.clear(id);
  sessionStore.mutate((prev) => prev.filter((s) => s.id !== id));
}

/** Test seam: forget what the docks showed. */
export function resetDocks(): void {
  shown.clear();
  drafts.clear();
  chipSeen.clear();
  chipTaken.clear();
}
