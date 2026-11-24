import { useEffect, useRef } from "react";
import { homeOrWorkspacePath, landingPathOfSession, type Catalog } from "../../lib/projectContext";
import { aliasKeys } from "../../lib/linkedRail";
import { sessionStore } from "../../lib/tcserver/store";
import type { Session } from "../../lib/session";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaceCatalog, workspaceByPath } from "../../lib/tcserver/workspaces";
import { keepReturn, returnOf } from "./returnRecord";
import { openWorkView, useWorkView, type OpenWorkView } from "../../lib/workSwitch";
import { projectStore, useProject } from "../../stores/project";
import { useWorkspaceTabs } from "../../stores/workspace";

/** The thread is one of this workspace's own: a thread of the Work Chats or of another job shown here is not recorded. */
export function threadOf(session: Pick<Session, "id" | "cwd" | "projectId" | "workspaceId"> | undefined, workspace: WorkspaceMeta, catalog: Catalog): string | undefined {
  if (!session) return undefined;
  const at = homeOrWorkspacePath(landingPathOfSession(session, catalog));
  return at === homeOrWorkspacePath(aliasKeys(catalog.workspaces).path(workspace.path)) ? session.id : undefined;
}

/** What the record keeps of the window now, or null while the view open is another workspace's (the window is on its way). */
export function spotOfWindow(open: OpenWorkView | null, workspaceId: string, thread: string | undefined): { view: string | null; event?: string; thread?: string } | null {
  if (open && open.workspaceId !== workspaceId) return null;
  return { view: open?.view ?? null, event: open?.view === "prep" ? open.event : undefined, ...(thread ? { thread } : {}) };
}

/**
 * The window's half of "where he was" (lib/workReturn.ts, docs/agents/work-return.md): it writes the record of the
 * Work workspace on screen as he moves (its view and its thread), and once per launch opens the view the record names
 * for the workspace the window came back on. Entering a workspace from the rail reads the record in App
 * (`onSelectProject`); each view keeps its own place under its key.
 */
export function ReturnHost() {
  const catalog = useWorkspaceCatalog();
  const cwd = useProject((s) => s.projectCwd);
  const workspace = catalog.loaded ? workspaceByPath(catalog.workspaces, cwd) : undefined;
  const open = useWorkView();
  const focused = useWorkspaceTabs((s) => s.tabs.find((t) => t.id === s.activeTabId)?.focusedId ?? null);
  // The launch's own folder: until its workspace is known the window has not come back yet; once he leaves it, it never will.
  const boot = useRef<string | null>(projectStore.getState().projectCwd);
  useEffect(() => {
    if (boot.current !== null) {
      if (cwd !== boot.current || open) boot.current = null;
      else if (!workspace) return;
      else {
        boot.current = null;
        const spot = workspace.kind === "work" ? returnOf(workspace.id) : {};
        if (spot.view) return openWorkView({ workspaceId: workspace.id, view: spot.view, ...(spot.event ? { event: spot.event } : {}) });
      }
    }
    if (workspace?.kind !== "work") return;
    const spot = spotOfWindow(open, workspace.id, threadOf(focused ? sessionStore.get(focused) : undefined, workspace, catalog));
    if (spot) keepReturn(workspace.id, spot);
  }, [catalog, cwd, workspace, open, focused]);
  return null;
}
