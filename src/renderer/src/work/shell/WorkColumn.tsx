import { useEffect, useLayoutEffect, useMemo } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import { projectOrder } from "work-kit/projects/order";
import { RailRow } from "../../chrome/RailRow";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { openWorkView, setLifeosProjects, useWorkView, workColumnPort, workStartPort, type LifeosProjectRow } from "../../lib/workSwitch";
import { addContextChip, startAboutChip } from "../canvas/chips";
import { rowOfView, type WorkViewDef, workViewRows } from "../views/registry";
import { openLifeosProject } from "./actions";
import { useLifeosQuery, useLifeosSession } from "./lifeos";

/** The statuses whose projects the column lists: what is still under way. */
const LISTED = new Set(["backlog", "active", "paused"]);

type LifeosProject = { _id: string; name: string; status: string; _creationTime?: number };

/** LifeOS's projects of one sector as the column lists them: still under way, oldest first (the order the Projects view keeps inside a state), so a card never moves for what is opened or worked in, or for a change of state. */
export function columnProjects(rows: readonly LifeosProject[]): LifeosProjectRow[] {
  return rows
    .filter((p) => LISTED.has(p.status))
    .map((p) => ({ id: p._id, name: p.name, createdAt: p._creationTime ?? 0 }))
    .sort(projectOrder)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * A linked Work workspace's column head (prototype workspace.html, "Four
 * rows"): Mail, Tasks, Agenda and Docs, each with its one muted fact, 16px
 * over the project cards; a row opens its view in the main pane under the
 * thread strip. It also keeps the column's LifeOS projects live, so the
 * cards under it are LifeOS's, and makes a card's project on its first
 * thread. An unlinked Work workspace has no rows and no LifeOS projects.
 */
export function WorkColumnHead({ workspace }: { workspace: WorkspaceMeta }) {
  const sector = (workspace.sector ?? null) as SectorKey | null;
  const session = useLifeosSession(workspace.environmentId, sector);
  const listed = useLifeosQuery<LifeosProject[]>(session, "projects:list", sector ? { sector } : {});
  const rows = useMemo(() => (listed.status === "ready" ? columnProjects(listed.value) : null), [listed]);
  const shown = useWorkView();

  useEffect(() => {
    if (sector && rows) setLifeosProjects(workspace.id, rows);
  }, [rows, sector, workspace.id]);
  useLayoutEffect(() => {
    workColumnPort.set({
      async openProject(_workspaceId, lifeosProjectId) {
        return (await openLifeosProject(workspace, lifeosProjectId, rows?.find((p) => p.id === lifeosProjectId)?.name)).id;
      },
    });
    return () => workColumnPort.set(null);
  }, [rows, workspace]);

  if (!sector) return null;
  return (
    <div className="flex flex-col gap-1 px-2 pt-2 pb-2">
      {workViewRows().map((view) => (
        <ViewRow key={view.id} view={view} workspace={workspace} sector={sector} selected={shown?.workspaceId === workspace.id && rowOfView(shown.view) === view.id} on={shown?.workspaceId === workspace.id && shown.view === view.id} />
      ))}
    </div>
  );
}

/** One view's row; its own component, so a view's live fact (`useFact`) is a hook of its own. */
function ViewRow({ view, workspace, sector, selected, on }: { view: WorkViewDef; workspace: WorkspaceMeta; sector: SectorKey; selected: boolean; on: boolean }) {
  const fact = view.useFact ? view.useFact(workspace, sector) : view.fact(workspace);
  return (
    <RailRow
      icon={view.icon}
      label={view.label}
      trailing={fact}
      selected={selected}
      // The row again closes it: the threads come back. From a view that stands inside this one (a meeting's page), the row leads back to it.
      onClick={() => openWorkView(on ? null : { workspaceId: workspace.id, view: view.id })}
      intent={{ onPointerEnter: view.chunk.preload, onFocus: view.chunk.preload }}
    />
  );
}

/** A view's `startThread`: a new thread's composer in the workspace with the chip in it; nothing runs until he sends. */
export function startThreadAbout(about: ContextChip | readonly ContextChip[], projectId: string | null = null, cwd?: string): void {
  const start = workStartPort.get();
  if (!start) return;
  openWorkView(null);
  const id = start(projectId, cwd);
  const [first, ...rest] = Array.isArray(about) ? about : [about as ContextChip];
  if (!first) return;
  // The first leads, so it is what the first send says the thread is about.
  startAboutChip(id, first);
  for (const chip of rest) addContextChip(id, chip);
}
