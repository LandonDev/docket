import type { FilesOpened, FileTab } from "@shared/contract-work-files";
import { canvasSourcePath, type CanvasItem, type CanvasKind, type CanvasSource } from "@shared/work";
import { kindOfEntry, threadCanvasOf, type FileEntry } from "@shared/work/files";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { bridgeNewThread } from "../../lib/macBridge";
import { refusalWords } from "../../lib/settingsHome";
import { sessionStore } from "../../lib/tcserver/store";
import type { WireSessionMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { workOpenPort } from "../../lib/workSwitch";
import { openItem, setFolded } from "../canvas/store";
import { openWay, type PlaceCopy } from "./model";
import { openFileTab } from "./store";

/**
 * How a file opens from the Files place (docs/agents/work-files.md "A tab"): in a tab of its own on the workspace's
 * host, with no thread; a file of another computer as a copy he allowed; a file no canvas shows, in its own app
 * where it lies. A workspace whose host is a release behind keeps no tabs: there a file opens as it always did, in
 * a new thread's canvas with the thread folded away.
 */

/** What a row says while its file is on its way: the one word beside its spinner. */
export type Busy = { key: string; word: string } | null;

export interface OpenFrom {
  workspace: Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
  /** the workspace's host keeps tabs */
  tabs: boolean;
  /** the workspace may copy Teams files from his other computers */
  copy: boolean;
  /** the tab the file is opened from */
  opener?: string;
  busy(next: Busy): void;
  /** the copy switch was just turned on for this open */
  allowed?(): void;
}

const failed = (title: string, err: unknown): void => void loadToast().then((toast) => toast.error(title, { description: refusalWords(err) || undefined }));
const readMs = (copy: PlaceCopy, ms: number): { timeoutMs?: number } => (copy.place.vm ? { timeoutMs: ms } : {});
const isOffice = (name: string): boolean => /\.(xlsx|xlsm|xlsb|xls|docx|docm|doc|rtf|odt|pptx|pptm|ppt|odp)$/i.test(name);

/** A new thread in the workspace, titled for the file. Nothing runs until he writes. */
async function newThread(workspace: OpenFrom["workspace"], title: string): Promise<string> {
  const link = registry.linkOf(workspace.environmentId);
  const wire = await link.request<WireSessionMeta>("session.create", { workspaceId: workspace.id, cwd: workspace.path, threadType: "chat", title });
  sessionStore.adopt({ ...wire, environmentId: link.environmentId }, { created: true });
  await bridgeNewThread(link.environmentId, wire.id).catch(() => {});
  return wire.id;
}

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

/** Opens a file in its own app on the computer it lies on. Only a library's file has one to ask for. */
export async function openInApp(entry: Pick<FileEntry, "name" | "key" | "ref">, copy: PlaceCopy, from: Pick<OpenFrom, "busy">): Promise<void> {
  if (!entry.ref) return;
  if (copy.place.kind !== "teams" && copy.place.kind !== "onedrive") return void loadToast().then((toast) => toast.message(`${entry.name} has no viewer here yet`));
  try {
    from.busy({ key: entry.key, word: "Opening…" });
    await registry.linkOf(copy.link).request("work.office.filesOpen", { source: entry.ref }, readMs(copy, 120_000));
  } catch (err) {
    failed(`${entry.name} did not open`, err);
  } finally {
    from.busy(null);
  }
}

/** The file as it is once its bytes are here: its place downloads one it keeps in the cloud, on its own host. */
async function fetched(entry: FileEntry, copy: PlaceCopy, from: OpenFrom): Promise<void> {
  if (entry.local !== false || !entry.ref) return;
  from.busy({ key: entry.key, word: "Downloading…" });
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
  const way = openWay(entry, copy, { link: workspaceLink, tabs: from.tabs, copy: from.copy });
  if (way === "app") {
    // A switch that decides what he sees is never only in Settings: where the copy being off is why, the refusal turns it on.
    const shown = kindOfEntry(entry.name).canvas !== null;
    if (!here && !from.copy && shown && from.allowed) {
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
          cancel: { label: `Open on ${copy.place.vm ? "the VM" : copy.host}`, onClick: () => void openInApp(entry, copy, from) },
        }),
      );
      return null;
    }
    await openInApp(entry, copy, from);
    return null;
  }
  try {
    if (way === "thread") return await openInThread(entry, copy, from, here);
    if (here) {
      await fetched(entry, copy, from);
      from.busy({ key: entry.key, word: "Opening…" });
      // Excel, Word or PowerPoint stands behind a library's Office file: it opens there too.
      if ((copy.place.kind === "teams" || copy.place.kind === "onedrive") && isOffice(entry.name)) await registry.linkOf(copy.link).request("work.office.filesOpen", { source: entry.ref });
    } else from.busy({ key: entry.key, word: entry.local === false ? "Downloading…" : "Opening…" });
    const answer: FilesOpened = await openFileTab(workspaceLink, from.workspace.id, { ref: entry.ref, name: entry.name, key: entry.key }, from.opener, { timeoutMs: here ? undefined : 660_000 });
    // A thread already holds it and its kind keeps its marks by item: that thread's item is shown, and no second seat is made.
    if (answer.held) await showInThread(workspaceLink, answer.held.sessionId, { itemId: answer.held.itemId }, true);
    return answer.tabId ?? null;
  } catch (err) {
    failed(`${entry.name} did not open`, err);
    return null;
  } finally {
    from.busy(null);
  }
}

/** As it opened before there were tabs: in a new thread's canvas, the thread folded away; the thread that already holds it shows it again. */
async function openInThread(entry: FileEntry, copy: PlaceCopy, from: OpenFrom, here: boolean): Promise<null> {
  const ref = entry.ref!;
  const ws = registry.linkOf(from.workspace.environmentId);
  const held = await heldBy(from.workspace, ref, from.tabs);
  if (held) {
    if (held.source.at === "microsoft") await registry.linkOf(copy.link).request("work.office.filesOpen", { source: ref });
    await showInThread(from.workspace.environmentId, held.sessionId, { itemId: held.itemId }, true);
    return null;
  }
  const kind = threadCanvasOf(entry.name)!;
  let sessionId: string | null = null;
  try {
    let source: CanvasSource = ref;
    if (here) {
      await fetched(entry, copy, from);
      from.busy({ key: entry.key, word: "Opening…" });
      const app = ref.at === "file" && isOffice(entry.name) ? (/\.(xls|xlsx|xlsm|xlsb)$/i.test(entry.name) ? "excel" : /\.(ppt|pptx|pptm|odp)$/i.test(entry.name) ? "powerpoint" : "word") : null;
      if (app && ref.at === "file") {
        source = { at: "microsoft", host: ref.host, app, name: entry.name, ref: { kind: "path", path: ref.path } };
        await registry.linkOf(copy.link).request("work.office.filesOpen", { source: ref });
      }
      sessionId = await newThread(from.workspace, entry.name);
    } else {
      // A copy lands in its thread's folder, so the thread comes first, and goes again if the copy fails.
      from.busy({ key: entry.key, word: entry.local === false ? "Downloading…" : "Opening…" });
      sessionId = await newThread(from.workspace, entry.name);
      source = (await ws.request<{ source: CanvasSource }>("work.office.filesCopy", { sessionId, source: ref })).source;
    }
    await showInThread(from.workspace.environmentId, sessionId, { kind: source.at === "microsoft" ? ({ excel: "sheet", word: "document", powerpoint: "slides" } as const)[source.app] : kind, source, title: entry.name }, true);
  } catch (err) {
    if (sessionId && !here) void ws.request("session.delete", { sessionId }).catch(() => {});
    throw err;
  }
  return null;
}

/** The file a tab shows, as its place names it: the item's own source, or for a copy the file it was made of. */
export function fileOf(tab: Pick<FileTab, "copyOf">, item: Pick<CanvasItem, "source">): CanvasSource | null {
  if (tab.copyOf) return { at: "file", host: tab.copyOf.host, path: tab.copyOf.path };
  const path = canvasSourcePath(item.source);
  if (path === null) return item.source.at === "thread" ? null : item.source;
  return { at: "file", host: (item.source as { host: string }).host, path };
}
