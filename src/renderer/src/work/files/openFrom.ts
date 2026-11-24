import type { FilePage } from "@shared/contract-work-files";
import type { CanvasSource } from "@shared/work";
import { PLACE } from "@shared/work/files";
import { loadToast } from "../../components/ui/toaster";
import { refusalWords } from "../../lib/settingsHome";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { movedOnSince, openWorkView, workViewNow } from "../../lib/workSwitch";
import { openFileTab, openPageTab } from "./store";

/** What another screen opens in Files: a file, in a tab of its own, or a page to stand on (a place, a folder). */
export type FilesTarget = { ref: CanvasSource; name: string; key?: string } | { page: FilePage };

/**
 * Opens a file for him from another screen of Work (Today, Search, a meeting's prep, Money, a template): in a
 * Files tab of the workspace, with no thread, and with the Files place shown (unless he opened something else
 * while the host made the tab: then the tab waits in Files and the window stays where he is). The one way in from outside: a
 * screen that has a file to show calls this, and writes no opener of its own (docs/agents/work-files.md
 * "Opening a file from another screen"). The workspace's host picks the kind by the file's name, and a file
 * that is open already is shown in the tab it has. Given a page, a new tab stands on it. A refusal (a host a
 * release behind, a place the workspace may not use) is thrown in the host's own sentence, for the caller's
 * one toast.
 */
export async function openInFiles(workspace: Pick<WorkspaceMeta, "id" | "environmentId">, what: FilesTarget): Promise<void> {
  const before = workViewNow();
  if ("page" in what) await openPageTab(workspace.environmentId, workspace.id, what.page);
  else await openFileTab(workspace.environmentId, workspace.id, what);
  // A slow host: he may have opened a mail or gone back to a thread by now. The tab is made; the window stays with him.
  if (movedOnSince(before, workspace.id)) return;
  openWorkView({ workspaceId: workspace.id, view: "files" });
}

/** The LifeOS place's top: its projects as folders, then its documents and sheets. */
export const LIFEOS_PAGE: FilePage = { at: { at: "place", id: PLACE.lifeos }, name: "LifeOS" };

/**
 * Where a way into the Docs view opens now that Docs lives in Files (docs/agents/work-docs.md): a LifeOS
 * document asked for opens in a Files tab of its own, and a bare way in stands on the LifeOS place. The host
 * names the document by its title as LifeOS has it, so a caller with no title passes none.
 */
export function filesOfDocs(doc?: { id: string; title?: string }): FilesTarget {
  return doc ? { ref: { at: "lifeos", table: "docs", id: doc.id }, name: doc.title || "Untitled" } : { page: LIFEOS_PAGE };
}

/**
 * A LifeOS document opened in Files from a screen that holds only its workspace's id (a meeting's page, a
 * person's page): the workspace is read from the window's list, and a refusal is the one toast.
 */
export function openDocInFiles(workspaceId: string, doc: { id: string; title?: string }): Promise<void> {
  const workspace = workspaceStore.getSnapshot().workspaces.find((w) => w.id === workspaceId);
  const said = (err: unknown): void => void loadToast().then((toast) => toast.error("It did not open", { description: refusalWords(err) || undefined }));
  if (!workspace) return Promise.resolve(said(new Error("That workspace is not in this window.")));
  return openInFiles(workspace, filesOfDocs(doc)).catch(said);
}
