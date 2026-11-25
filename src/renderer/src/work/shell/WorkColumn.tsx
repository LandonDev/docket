import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import { projectOrder } from "work-kit/projects/order";
import { MoreHorizontal } from "../../chrome/icons";
import { RailRow } from "../../chrome/RailRow";
import { Button } from "../../components/ui/button";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { openWorkView, setLifeosProjects, useWorkView, workColumnPort, workStartPort } from "../../lib/workSwitch";
import { addContextChip, contextChipsOf, startAboutChip } from "../canvas/chips";
import { rowOfView, type WorkViewDef, workColumnViews } from "../views/registry";
import { openLifeosProject } from "./actions";
import { setColumnProjects, type ColumnProject } from "./columnProjects";
import { HOLD, KeptRegion, useKeptRegion, useLifeosQuery, useLifeosSession } from "./lifeos";

/** The statuses whose projects the column lists: what is still under way. */
const LISTED = new Set(["backlog", "active", "paused"]);

type LifeosProject = { _id: string; name: string; status: string; targetDate?: number | null; _creationTime?: number };

/**
 * LifeOS's projects of one sector as the column lists them: still under way, oldest first (the order the Projects
 * view keeps inside a state, and the column's order between equal targets), each with its state and its target
 * date, from which the column sorts and folds its rows (work/shell/columnModel.ts `workProjectRows`).
 */
export function columnProjects(rows: readonly LifeosProject[]): ColumnProject[] {
  return rows
    .filter((p) => LISTED.has(p.status))
    .map((p) => ({ id: p._id, name: p.name, status: p.status, targetDate: p.targetDate ?? null, createdAt: p._creationTime ?? 0 }))
    .sort(projectOrder)
    .map(({ id, name, status, targetDate }) => ({ id, name, status, targetDate }));
}

/**
 * A linked Work workspace's column head (docs/DESIGN.md "The column"): the four daily views (Mail, Tasks, Agenda,
 * Messages), each with its one muted fact, then More, a fold holding the rest (`workColumnViews`). The More view he
 * last opened stays shown among the rows until he leaves the job (this head is keyed by the workspace, so leaving
 * drops it). A row opens its view in the main pane under the thread strip. It also keeps the column's LifeOS
 * projects live, so the Projects rows under it are LifeOS's, and makes a project's mirror on its first thread. An
 * unlinked Work workspace has no rows and no LifeOS projects.
 */
export function WorkColumnHead({ workspace }: { workspace: WorkspaceMeta }) {
  // The rows' facts may paint as this window last read them: the head reads busy until each is live.
  const kept = useKeptRegion();
  const sector = (workspace.sector ?? null) as SectorKey | null;
  const session = useLifeosSession(workspace.environmentId, sector);
  const listed = useLifeosQuery<LifeosProject[]>(session, "projects:list", sector ? { sector } : {}, HOLD);
  const rows = useMemo(() => (listed.status === "ready" ? columnProjects(listed.value) : null), [listed]);
  const shown = useWorkView();

  useEffect(() => {
    if (!sector || !rows) return;
    setLifeosProjects(workspace.id, rows);
    setColumnProjects(workspace.id, rows);
  }, [rows, sector, workspace.id]);
  useLayoutEffect(() => {
    workColumnPort.set({
      async openProject(_workspaceId, lifeosProjectId) {
        return (await openLifeosProject(workspace, lifeosProjectId, rows?.find((p) => p.id === lifeosProjectId)?.name)).id;
      },
    });
    return () => workColumnPort.set(null);
  }, [rows, workspace]);

  const { daily, more } = useMemo(() => workColumnViews(), []);
  const here = shown?.workspaceId === workspace.id ? rowOfView(shown.view) : null;
  const moreShown = here && more.some((view) => view.id === here) ? here : null;
  // The More view open now, else the last one opened while in this job.
  const [picked, setPicked] = useState<string | null>(moreShown);
  const keptId = moreShown ?? picked;
  useEffect(() => {
    if (moreShown) setPicked(moreShown);
  }, [moreShown]);
  const [open, setOpen] = useState(false);
  const { kept: keptView, fold } = foldRows(more, keptId, open);

  if (!sector) return null;
  const row = (view: WorkViewDef, onPick?: () => void) => (
    <ViewRow key={view.id} view={view} workspace={workspace} sector={sector} selected={here === view.id} on={shown?.workspaceId === workspace.id && shown.view === view.id} onPick={onPick} />
  );
  return (
    <KeptRegion value={kept.scope}>
      <div aria-busy={kept.busy || undefined} className="flex flex-col gap-1 px-2 pt-2 pb-2">
        {daily.map((view) => row(view))}
        {keptView ? row(keptView) : null}
        <MoreFold open={open} onToggle={() => setOpen((was) => !was)} />
        {fold.map((view) => row(view, () => setOpen(false)))}
      </div>
    </KeptRegion>
  );
}

/**
 * What the More fold shows: the More view he last opened in this job (`keptId`), as a row of its own after the daily
 * ones, and, while the fold is open, the rest of More under it, never that one twice.
 */
export function foldRows<V extends { id: string }>(more: readonly V[], keptId: string | null, open: boolean): { kept: V | null; fold: V[] } {
  const kept = keptId ? (more.find((view) => view.id === keptId) ?? null) : null;
  return { kept, fold: open ? more.filter((view) => view !== kept) : [] };
}

/**
 * The fold over the views that are not daily: a row in the views' own shape (28px, its 16px glyph, 13px words),
 * muted, that shows or hides them under it. Not a menu: no fill while open, the rows themselves say it.
 */
export function MoreFold({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      aria-expanded={open}
      onClick={onToggle}
      data-more-fold
      className="h-7 w-full justify-start gap-2 rounded-md px-3 text-[13px] font-normal text-muted-foreground transition-none hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/5"
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        <MoreHorizontal className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">More</span>
    </Button>
  );
}

/** One view's row; its own component, so a view's live fact (`useFact`) is a hook of its own. */
function ViewRow({ view, workspace, sector, selected, on, onPick }: { view: WorkViewDef; workspace: WorkspaceMeta; sector: SectorKey; selected: boolean; on: boolean; onPick?: () => void }) {
  const fact = view.useFact ? view.useFact(workspace, sector) : view.fact(workspace);
  return (
    <RailRow
      icon={view.icon}
      label={view.label}
      trailing={fact}
      selected={selected}
      // The row again closes it: the threads come back. From a view that stands inside this one (a meeting's page), the row leads back to it.
      onClick={() => {
        openWorkView(on ? null : { workspaceId: workspace.id, view: view.id });
        onPick?.();
      }}
      intent={{ onPointerEnter: view.chunk.preload, onFocus: view.chunk.preload }}
    />
  );
}

/** A view's `startThread`: a new thread's composer in the workspace with the chip in it; nothing runs until he sends. */
export function startThreadAbout(about: ContextChip | readonly ContextChip[], projectId: string | null = null, cwd?: string): void {
  const start = workStartPort.get();
  if (!start) return;
  openWorkView(null);
  const [first, ...rest] = Array.isArray(about) ? about : [about as ContextChip];
  const id = start(projectId, cwd, first ? { about: first, leadOf: (draft) => contextChipsOf(draft)[0] } : undefined);
  if (!first) return;
  // The first leads, so it is what the first send says the thread is about.
  startAboutChip(id, first);
  for (const chip of rest) addContextChip(id, chip);
}
