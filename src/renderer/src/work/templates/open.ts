import type { CanvasSource } from "@shared/work/canvas";
import type { FolderRef } from "@shared/work/files";
import type { Template } from "@shared/work/templates";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { openWorkView, workTemplatePort } from "../../lib/workSwitch";

/**
 * The templates pillar's ways in for every other screen (docs/agents/work-templates.md
 * "The screens"; SEAMS.md "templates"): the one file besides the host's api.ts that
 * another pillar may import. It loads no chunk: the dialogs come through
 * `workTemplatePort`, which TemplatesHost fills while Work is on, so a screen that
 * imports this takes nothing of the pillar into its own chunk.
 */

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
 * Opens a file in a Files tab of the workspace and shows Files (SEAMS.md "files":
 * `work.files.open` on the workspace's host, then the Files view); no thread is
 * made. A made file and a template's own file (Edit) open this way.
 */
export async function openMade(ask: { workspaceId: string; source: CanvasSource }): Promise<void> {
  const env = hostOfWorkspace(ask.workspaceId);
  try {
    await registry.linkOf(env).request("work.files.open", { workspaceId: ask.workspaceId, ref: ask.source });
  } catch (err) {
    throw new Error(refusalWords(err) || "The host did not open the file");
  }
  openWorkView({ workspaceId: ask.workspaceId, view: "files" });
}
