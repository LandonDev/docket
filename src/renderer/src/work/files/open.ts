import type { FilesOpened, FileTab } from "@shared/contract-work-files";
import { canvasSourcePath, type CanvasItem, type CanvasKind, type CanvasSource } from "@shared/work";
import { kindOfEntry, openingTag, type FileEntry } from "@shared/work/files";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { platformOf } from "../../lib/hostPlatform";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import { sessionStore } from "../../lib/tcserver/store";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workOpenPort } from "../../lib/workSwitch";
import { openItem, setFolded } from "../canvas/store";
import { CANVAS } from "../canvas/registry";
import { importAhead } from "../formats/importOnce";
import { noteSlidesOpenedByHand } from "../slides/openShow";
import { appOpens, openWay, type PlaceCopy } from "./model";
import { openingWords, rowMarks, type MarkBusy } from "./busy";
import { openFileTab } from "./store";

/**
 * How a file opens from the Files place (docs/agents/work-files.md "A tab"): in a tab of its own on the workspace's
 * host, with no thread; a file of another computer as a copy he allowed; a file no canvas shows, in its own app
 * where it lies. A workspace whose host is a release behind keeps no tabs: there a file opens in its own app where
 * it lies, and no thread is made for it.
 */


export interface OpenFrom {
  workspace: Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
  /** the workspace's host keeps tabs */
  tabs: boolean;
  /** the workspace may copy Teams files from his other computers */
  copy: boolean;
  /** the tab the file is opened from */
  opener?: string;
  busy: MarkBusy;
  /** the copy switch was just turned on for this open */
  allowed?(): void;
}

const failed = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: workErrorWords(err) || undefined }));
const readMs = (copy: PlaceCopy, ms: number): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: ms } : {});

/** A thread's item on screen: opened and shown in its pane, the thread folded away or beside it. */
async function showInThread(environmentId: string, sessionId: string, what: { itemId: string } | { kind: CanvasKind; source: CanvasSource; title: string }, folded: boolean): Promise<void> {
  await openItem(environmentId, sessionId, what);
  setFolded(sessionId, folded);
  workOpenPort.get()?.(sessionId);
}

/** The newest thread of the workspace this window knows, and has not archived, whose open items show the file. */
export async function heldBy(workspace: OpenFrom["workspace"], file: CanvasSource, tabs: boolean): Promise<{ sessionId: string; itemId: string; source: CanvasSource } | null> {
  const link = registry.linkOf(workspace.environmentId);
  const answer = await (tabs
    ? link.request<{ threads: { sessionId: string; itemId: string; source: CanvasSource }[] }>("work.files.threads", { workspaceId: workspace.id, ref: file })
    : link.request<{ threads: { sessionId: string; itemId: string; source: CanvasSource }[] }>("work.office.filesThreads", { workspaceId: workspace.id, source: file })
  ).catch(() => null);
  return answer?.threads.find((t) => sessionStore.metaOf(t.sessionId)?.archived === false) ?? null;
}

/** Whether a file of this place can open in its own app from this window (`appOpens`): its computer linked directly, a Mac or a PC. */
export function opensInApp(copy: { link: string; place: Pick<PlaceCopy["place"], "kind" | "vm"> }): boolean {
  const far = !registry.has(copy.link);
  return appOpens(copy, { far, ...(far ? {} : { platform: platformOf(copy.link) }) });
}

/** Opens a file in its own app on the computer it lies on. Only a library's file has one to ask for. */
export async function openInApp(entry: Pick<FileEntry, "name" | "key" | "ref">, copy: PlaceCopy, from: Pick<OpenFrom, "busy">): Promise<void> {
  if (!entry.ref) return;
  if (copy.place.kind !== "teams" && copy.place.kind !== "onedrive") return void loadToast().then((toast) => toast.message(`${entry.name} has no viewer here yet`));
  if (!opensInApp(copy)) {
    const computer = copy.place.vm ? "the Windows VM" : nameInLine(copy.host);
    const verb = kindOfEntry(entry.name).kind === "audio" ? "Play" : "Open";
    return void loadToast().then((toast) => toast.message(`${verb} ${entry.name} on ${computer}.`));
  }
  const marks = rowMarks(from.busy, [entry.key]);
  try {
    marks.say({ word: "Opening…" });
    await registry.linkOf(copy.link).request("work.office.filesOpen", { source: entry.ref }, readMs(copy, 120_000));
  } catch (err) {
    failed(`${entry.name} did not open`, err);
  } finally {
    marks.done();
  }
}

/** The file as it is once its bytes are here: its place downloads one it keeps in the cloud, on its own host. */
async function fetched(entry: FileEntry, copy: PlaceCopy, from: OpenFrom, marks: ReturnType<typeof rowMarks>): Promise<void> {
  if (entry.local !== false || !entry.ref) return;
  marks.say({ word: "Downloading…" });
  if (copy.wire === "files") await registry.linkOf(copy.link).request("work.files.fetch", { workspaceId: from.workspace.id, ref: entry.ref }, readMs(copy, 660_000));
  else await registry.linkOf(copy.link).request("work.office.filesFetch", { source: entry.ref }, readMs(copy, 660_000));
}

/** Download and look: a file its place keeps in the cloud is brought onto its own computer, on his press alone. */
export async function fetchHere(entry: FileEntry, copy: PlaceCopy, workspaceId: string): Promise<void> {
  if (!entry.ref) return;
  if (copy.wire === "files") await registry.linkOf(copy.link).request("work.files.fetch", { workspaceId, ref: entry.ref }, readMs(copy, 660_000));
  else await registry.linkOf(copy.link).request("work.office.filesFetch", { source: entry.ref }, readMs(copy, 660_000));
}

/**
 * Opens a file from a row. Answers the tab that holds it now (null when it opened elsewhere: a thread, its app, or
 * not at all, which is said in one toast).
 */
export async function openEntry(entry: FileEntry, copy: PlaceCopy, from: OpenFrom): Promise<string | null> {
  if (!entry.ref) return null;
  const workspaceLink = from.workspace.environmentId;
  const here = copy.link === workspaceLink && !copy.place.vm;
  const route = { link: workspaceLink, tabs: from.tabs, copy: from.copy };
  const way = openWay(entry, copy, route);
  if (way === "app") {
    // A switch that decides what he sees is never only in Settings: where the copy being off is why, the refusal turns it on.
    const shown = kindOfEntry(entry.name).canvas !== null;
    if (!here && !from.copy && shown && from.allowed && openWay(entry, copy, { ...route, copy: true }) === "tab") {
      const where = copy.place.vm ? "the Windows VM" : copy.host;
      void loadToast().then((toast) =>
        toast.message(`Teams files open on ${where} for this workspace.`, {
          action: {
            label: "Open copies here",
            onClick: () => {
              void registry
                .linkOf(workspaceLink)
                .request("work.office.filesCopySet", { workspaceId: from.workspace.id, on: true })
                .then(
                  () => (from.allowed!(), void openEntry(entry, copy, { ...from, copy: true })),
                  (err: unknown) => failed("Copies could not be turned on", err),
                );
            },
          },
          ...(opensInApp(copy) ? { cancel: { label: `Open on ${copy.place.vm ? "the VM" : copy.host}`, onClick: () => void openInApp(entry, copy, from) } } : {}),
        }),
      );
      return null;
    }
    await openInApp(entry, copy, from);
    return null;
  }
  // The kind's code loads beside the open (and a download before it), not after: the tab draws its body once the host has answered.
  preloadKind(entry.name);
  let stopHearing: (() => void) | null = null;
  const marks = rowMarks(from.busy, [entry.key]);
  try {
    if (here) {
      await fetched(entry, copy, from, marks);
      marks.say({ word: "Opening…" });
    } else marks.say({ word: entry.local === false ? "Downloading…" : "Opening…" });
    const ref = entry.ref;
    // A file of another computer is copied to the workspace's host a piece at a time: the row says how far it has got.
    const tag = openingTag(entry.key);
    stopHearing = here
      ? null
      : registry.linkOf(workspaceLink).onPush((push) => {
          if (push.push === "work.files" && push.workspaceId === from.workspace.id && push.opening?.of === tag) marks.say({ word: openingWords(push.opening.done, push.opening.total) });
        });
    const answer: FilesOpened = await openFileTab(workspaceLink, from.workspace.id, { ref, name: entry.name, key: entry.key }, from.opener, {
      ...(here ? {} : { timeoutMs: 660_000 }),
      // Excel, Word or PowerPoint is started only where the host seated the file on its app (`microsoft`): a form an
      // editor of ours edits in place (an .xlsx in the sheet editor) opens as the file it is, and no app is started.
      seated: async (opened) => {
        if (here && opened.item?.source.at === "microsoft") await registry.linkOf(copy.link).request("work.office.filesOpen", { source: ref });
      },
    });
    // A Word file's import into a document starts as soon as the item is there, beside the editor's code.
    if (answer.item) importAhead(workspaceLink, answer.item);
    // A show file (.pps, .ppsx) he opened by his own press starts its show once the deck is ready, as PowerPoint does.
    if (answer.item) noteSlidesOpenedByHand(workspaceLink, answer.item);
    // A thread already holds it and its kind keeps its marks by item: that thread's item is shown, and no second seat is made.
    if (answer.held) await showInThread(workspaceLink, answer.held.sessionId, { itemId: answer.held.itemId }, true);
    return answer.tabId ?? null;
  } catch (err) {
    failed(`${entry.name} did not open`, err);
    return null;
  } finally {
    stopHearing?.();
    marks.done();
  }
}

/** Starts loading the code of the kind a file opens in (its chunk loads once, whoever asks). */
export function preloadKind(name: string): void {
  const kind = kindOfEntry(name).canvas;
  if (kind && Object.hasOwn(CANVAS, kind)) CANVAS[kind].chunk.load().catch(() => undefined);
}


/** The file a tab shows, as its place names it: the item's own source, or for a copy the file it was made of. */
export function fileOf(tab: Pick<FileTab, "copyOf">, item: Pick<CanvasItem, "source">): CanvasSource | null {
  if (tab.copyOf) return { at: "file", host: tab.copyOf.host, path: tab.copyOf.path };
  const path = canvasSourcePath(item.source);
  if (path === null) return item.source.at === "thread" ? null : item.source;
  return { at: "file", host: (item.source as { host: string }).host, path };
}

export { openingWords };
