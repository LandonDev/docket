import type { CanvasSource } from "@shared/work/canvas";
import type { FolderRef } from "@shared/work/files";
import type { Template } from "@shared/work/templates";
import { refusalWords } from "../../lib/settingsHome";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { baseName } from "./model";

/**
 * The templates pillar's ways in for every other screen (docs/agents/work-templates.md
 * "The screens"; SEAMS.md "templates"): the one file besides the host's api.ts that
 * another pillar may import. It loads no chunk: the dialogs come through
 * `workTemplatePort` below, which TemplatesHost fills while Work is on, so a screen
 * that imports this takes nothing else of the pillar into its own chunk.
 */

/**
 * What the dialogs answer, filled by Work's shell while Work is on
 * (TemplatesHost.tsx): New from a template in a workspace (a folder to keep
 * the file in, or one template to ask the fields of), and Save as template on
 * a file. It lives here, in a file only lazy chunks import, so the first paint
 * carries nothing of this pillar.
 */
export interface WorkTemplatePort {
  open(ask: { workspaceId: string; into?: FolderRef; intoName?: string; template?: Template }): void;
  save(ask: { workspaceId: string; source: CanvasSource; name?: string; fields?: readonly string[] }): void;
}
let templatePort: WorkTemplatePort | null = null;
export const workTemplatePort = {
  get: (): WorkTemplatePort | null => templatePort,
  set(next: WorkTemplatePort | null): void {
    templatePort = next;
  },
};

/** "New from a template" for a workspace; the file is kept in `into` (named `intoName` in the footer), else the workspace's folder. False while Work's shell is not up. */
export function openTemplates(ask: { workspaceId: string; into?: FolderRef; intoName?: string }): boolean {
  const port = workTemplatePort.get();
  if (!port) return false;
  port.open(ask);
  return true;
}

/** One template's fields, asked before its file is made: the shelf's press on a template that names fields. */
export function askTemplateFields(ask: { workspaceId: string; template: Template; into?: FolderRef }): boolean {
  const port = workTemplatePort.get();
  if (!port) return false;
  port.open(ask);
  return true;
}

/** "Save as template" for a file; `fields`, when the caller knows them (a listed template), are named in the dialog. */
export function saveAsTemplate(ask: { workspaceId: string; source: CanvasSource; name?: string; fields?: readonly string[] }): boolean {
  const port = workTemplatePort.get();
  if (!port) return false;
  port.save(ask);
  return true;
}

/** The host a workspace lives on. */
export function hostOfWorkspace(workspaceId: string): string {
  const workspace = workspaceStore.getSnapshot().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw new Error("That workspace is gone");
  return workspace.environmentId;
}

/**
 * Opens a file in a Files tab of the workspace and shows Files, through Files'
 * own way in from another screen (`openInFiles`, work/files/openFrom.ts); no
 * thread is made. A made file and a template's own file (Edit) open this way.
 */
export async function openMade(ask: { workspaceId: string; source: CanvasSource; name?: string }): Promise<void> {
  const environmentId = hostOfWorkspace(ask.workspaceId);
  const name = ask.name ?? (ask.source.at === "file" ? baseName(ask.source.path) : "");
  try {
    // Files' opener is loaded when a file is first opened, so this file still brings no other pillar's code with it.
    const { openInFiles } = await import("../files/openFrom");
    await openInFiles({ id: ask.workspaceId, environmentId }, { ref: ask.source, name });
  } catch (err) {
    throw new Error(refusalWords(err) || "The host did not open the file");
  }
}
