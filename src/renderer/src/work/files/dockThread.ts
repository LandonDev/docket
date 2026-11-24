import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem, CanvasSource, ContextChip } from "@shared/work";
import { chipsOf, fileChipOf, TOO_MANY_FILES, type FileEntry, type FilePlace } from "@shared/work/files";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { addContextChip, CHIPS_MAX, contextChipsOf } from "../canvas/chips";
import { openItem } from "../canvas/store";
import { fileOf, heldBy, type OpenFrom } from "./open";
import { dockKey } from "./store";
import { dockThread as dockThreadOf, type DockThread } from "../dock/dockThread";
import type { DockSubject } from "../dock/subject";

/**
 * The chat docked beside a file (docs/agents/work-files.md "Ask"): a file tab as the subject of the shared dock
 * (work/dock). Opening a file makes no thread, and neither does Ask: the dock shows the newest thread of the
 * workspace that holds the file, else a draft that is on no host and in no rail. A draft becomes a thread by the
 * composer's own send, and in that send, between the create and the message, the new thread opens the file as an
 * item of its own, so the first turn holds it. A dock closed with nothing sent leaves nothing behind.
 */

type Workspace = OpenFrom["workspace"];

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
export function dockThread(workspace: Workspace, tab: FileTab, item: CanvasItem): Promise<DockThread> {
  return dockThreadOf(workspace, fileSubject(workspace, tab, item));
}

/** A file tab as a dock's subject: its file's chip in the composer, the thread that holds the file, and the file opened in the new thread. */
export function fileSubject(workspace: Workspace, tab: FileTab, item: CanvasItem): DockSubject {
  const chip = fileChip(tab, item);
  return {
    key: dockKey(workspace.id, tab.id),
    title: tab.name || item.title,
    chips: chip ? [chip] : [],
    chipIn: "composer",
    find: async () => {
      const file = fileOf(tab, item);
      return file ? ((await heldBy(workspace, file, true))?.sessionId ?? null) : null;
    },
    hold: (sessionId) => holdFile(workspace, tab, item, sessionId),
  };
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

export { enterDock, leaveDock, resetDocks, type DockThread } from "../dock/dockThread";
