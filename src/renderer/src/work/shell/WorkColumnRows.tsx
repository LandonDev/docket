import { memo, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { HostGlyph } from "../../chrome/HostGlyph";
import { useHostsOffline } from "../../chrome/hostOffline";
import { Outbox } from "../../chrome/icons";
import { RailRow } from "../../chrome/RailRow";
import { ThreadListPopover } from "../../chrome/ThreadListPopover";
import { InlineRename, MoreMenu, MoreRow, PlanReadyContext, type RowActions } from "../../chrome/WorkspaceSessions";
import { Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { yields } from "../../components/ui/reveal";
import { STATUS_WORD, StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { whenIdle } from "../../lib/hoverPrefetch";
import { sessionPrefetch } from "../../lib/sessionPrefetch";
import { windowRows } from "../../lib/sidebarRows";
import { setSessionArchived } from "../../lib/sessionStore";
import { sessionStore } from "../../lib/tcserver/store";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import type { WorkThreadItem } from "../../lib/sidebarRows";
import { archivedThreads, targetWords, threadLead, threadLine, threadTime, workProjectRows, type ArchivedThread, type WorkLead, type WorkProjectRow } from "./columnModel";
import { useColumnProjects } from "./columnProjects";
import type { ProjectGroup } from "../../lib/workspaceSessions";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import type { ThreadRow } from "../../lib/workspaceSessions";

/**
 * A Work job's column under its views (docs/DESIGN.md "The column"): Projects, one row a project, then Threads, two
 * lines a thread, then a quiet archived row. The lead slot of every row says what is live (work/shell/columnModel.ts), in
 * one 16px column, so the eye learns one place. Everything here reads the session summaries and LifeOS's project
 * list the column already keeps; no row asks a host anything.
 */

/** A section's name over its rows: 28px, 12px medium muted, on the rows' 12px inset. */
const HEADING = "flex h-7 w-full items-center rounded-md px-3 text-xs font-medium text-muted-foreground";
/** A quiet row on the names' column (12px inset, the 16px lead, 8px: 36px): "1 paused", "3 archived". */
const QUIET_ROW =
  "h-7 w-full justify-start rounded-md pr-3 pl-9 text-[13px] font-normal text-muted-foreground tabular-nums transition-none hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/5";

/** The lead slot's mark: a state's glyph, or the Outbox's glyph, muted, for something held. */
export function LeadMark({ lead }: { lead: WorkLead }) {
  if (!lead) return null;
  if (lead.kind === "held") return <Outbox aria-hidden data-lead="held" className="size-3.5 text-muted-foreground" />;
  return <StatusMark state={lead.state} word={false} />;
}

/** The words a lead says to a screen reader, after the row's name. */
const leadWords = (lead: WorkLead): string | null => (!lead ? null : lead.kind === "held" ? "Held" : STATUS_WORD[lead.state]);

// --- Projects --------------------------------------------------------------

/**
 * The Projects section: its heading opens the job's Projects view (so the views have no Projects row), then a row a
 * project, then the paused and backlog ones behind one "N paused" row. `onOpen` opens a project's page.
 */
export const WorkProjectsSection = memo(function WorkProjectsSection({
  workspaceId,
  linked,
  groups,
  onOpen,
}: {
  workspaceId: string;
  /** A job linked to a LifeOS sector: it has a Projects view for the heading to open. */
  linked: boolean;
  /** The job's project groups (`groupWorkspaceSessions` over `withLifeosCards`). */
  groups: readonly ProjectGroup[];
  onOpen: (row: WorkProjectRow) => void;
}) {
  // LifeOS's rows for the job, with each one's state and target, as the column's head keeps them.
  const lifeos = useColumnProjects(workspaceId);
  const projects = useMemo(() => workProjectRows(groups, lifeos), [groups, lifeos]);
  const [quietOpen, setQuietOpen] = useState(false);
  const shown = useWorkView();
  const on = shown?.workspaceId === workspaceId && shown.view === "projects";
  const now = Date.now();
  if (!linked && projects.rows.length === 0 && projects.quiet.length === 0) return null;
  return (
    <section aria-label="Projects" data-work-projects className="flex flex-col gap-1">
      {linked ? (
        <Button
          variant="ghost"
          aria-current={on || undefined}
          onClick={() => openWorkView(on ? null : { workspaceId, view: "projects" })}
          className={cn(HEADING, "justify-start font-medium transition-none hover:bg-foreground/5 hover:text-foreground", on && "bg-muted text-foreground hover:bg-muted")}
        >
          Projects
        </Button>
      ) : (
        <h3 className={HEADING}>Projects</h3>
      )}
      {projects.rows.map((row) => (
        <ProjectRow key={row.id} row={row} now={now} onOpen={onOpen} />
      ))}
      {projects.quiet.length > 0 ? (
        <>
          <Button variant="ghost" aria-expanded={quietOpen} onClick={() => setQuietOpen((was) => !was)} data-quiet-fold className={QUIET_ROW}>
            {projects.quiet.length} paused
          </Button>
          {quietOpen ? projects.quiet.map((row) => <ProjectRow key={row.id} row={row} now={now} onOpen={onOpen} />) : null}
        </>
      ) : null}
    </section>
  );
});

/** One project: what is live in the lead, its name, its target date at the end (red once it has passed). */
function ProjectRow({ row, now, onOpen }: { row: WorkProjectRow; now: number; onOpen: (row: WorkProjectRow) => void }) {
  const target = row.target === null ? null : targetWords(row.target, now);
  const words = [row.name, leadWords(row.lead), target ? `${target.late ? "late, was due" : "target"} ${target.words}` : null].filter(Boolean).join(", ");
  return (
    <RailRow
      data-project-row={row.id}
      glyph={<LeadMark lead={row.lead} />}
      label={row.name}
      ariaLabel={words}
      trailing={target ? <span className={cn(target.late && "text-destructive")}>{target.words}</span> : null}
      onClick={() => onOpen(row)}
    />
  );
}

// --- Threads ---------------------------------------------------------------

/** Threads under Projects: a new group, 12px on top of the list's 4px gap. */
const SECTION = "flex flex-col gap-1 pt-3";

/** The time gives way to the row's ⋯ on hover and focus, as every rail row's end does. */
const TIME_YIELDS = yields("row");

/**
 * The Threads section: every root thread of the job, loose and in its projects, newest first, one page at a time
 * (the open thread always in it), two lines each; then the archived row. Nothing at all with no thread and nothing
 * archived.
 */
export const WorkThreadsSection = memo(function WorkThreadsSection({
  items,
  actions,
  requested,
  onMore,
  archived,
}: {
  items: readonly WorkThreadItem[];
  actions: RowActions;
  requested: number;
  onMore: () => void;
  /** The scope whose archived threads the last row lists. */
  archived: ArchivedScope;
}) {
  const rows = items.map((item) => item.row);
  const { shown, hidden } = windowRows(rows, requested, actions.activeSessionId);
  // With no live thread the heading stands over the archived row alone, and over nothing with none archived.
  if (items.length === 0) return <ArchivedRow scope={archived} onOpen={actions.onOpen} headed />;
  return (
    <section aria-label="Threads" data-work-threads className={SECTION}>
      <h3 className={HEADING}>Threads</h3>
      {items.slice(0, shown.length).map((item) => (
        <WorkThreadRow key={item.row.id} row={item.row} project={item.project} actions={actions} />
      ))}
      {hidden > 0 ? <MoreRow hidden={hidden} onMore={onMore} place="list" /> : null}
      <ArchivedRow scope={archived} onOpen={actions.onOpen} />
    </section>
  );
});

/**
 * One thread, two lines: the lead, its title and its time (none while it works: the spinner says now); under them
 * its project and what it left him, "Spring LAN, 1 mail to send". Unread is weight on the title. A right-click or
 * its ⋯ opens the thread's menu; a double-click renames it.
 */
export const WorkThreadRow = memo(function WorkThreadRow({ row, project, actions }: { row: ThreadRow; project: string | null; actions: RowActions }) {
  const offline = useHostsOffline([row.environmentId]);
  const planReady = !!useContext(PlanReadyContext)[row.id];
  const lead = threadLead(row, planReady);
  const line = threadLine(project, row);
  const title = row.title || "Untitled";
  const selected = row.id === actions.activeSessionId;
  const renaming = actions.renamingId === row.id;
  const working = lead?.kind === "state" && lead.state === "working";
  const label = [title, leadWords(lead), line].filter(Boolean).join(", ");
  return (
    <div
      data-thread-row
      data-work-thread={row.id}
      data-menu-id={row.id}
      data-host-offline={offline || undefined}
      onPointerEnter={() => sessionPrefetch.enter(row.id)}
      onPointerLeave={() => sessionPrefetch.leave(row.id)}
      onDoubleClick={() => actions.onStartRename(row.id)}
      className={cn(
        "group/row relative flex w-full cursor-default gap-2 rounded-md px-3 py-1.5 text-left has-[>[data-row-open]:active]:bg-foreground/12",
        selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        offline && "opacity-50",
      )}
    >
      {renaming ? null : <ItemButton data-row-open aria-current={selected || undefined} aria-label={label} onClick={() => actions.onOpen(row.id)} className={ROW_OPEN} />}
      <span aria-hidden className={cn(ROW_SHOWS, "grid h-5 w-4 shrink-0 place-items-center")}>
        <LeadMark lead={lead} />
      </span>
      <span aria-hidden={!renaming || undefined} className={cn(!renaming && ROW_SHOWS, "flex min-w-0 flex-1 flex-col")}>
        <span className="flex h-5 min-w-0 items-baseline gap-1">
          {renaming ? (
            <InlineRename
              value={row.title}
              className="text-[13px]"
              onCommit={(next) => {
                actions.onStartRename(null);
                actions.onRename(row.id, next);
              }}
              onCancel={() => actions.onStartRename(null)}
            />
          ) : (
            <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", row.unread && "font-medium text-foreground")}>{title}</span>
          )}
          {renaming ? null : <HostGlyph environmentId={row.environmentId} />}
          {renaming || working ? null : <span className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", TIME_YIELDS)}>{threadTime(row.updatedAt, Date.now())}</span>}
        </span>
        {line ? <span className="truncate text-xs leading-4 text-muted-foreground">{line}</span> : null}
      </span>
      {renaming ? null : <MoreMenu id={row.id} menu={actions.menu} className="absolute top-1.5 right-1" />}
    </div>
  );
});

// --- archived --------------------------------------------------------------

/** Whose archived threads: a job (its copies on every host) or Work Chats; and the hosts that hold them. */
export type ArchivedScope = { scope: string | readonly string[]; environmentIds: readonly string[] };

/**
 * The scope's archived threads, asked of its hosts once, in an idle slot after the column mounts (archived Work
 * threads alone: `session.list {archived, scope: "work"}`), never in the first paint. It renders again only when
 * the scope's archived ids change, never on another thread's push (docs/agents/renderer-over-time.md); the list
 * itself is read when it opens.
 */
export function useArchivedThreads({ scope, environmentIds }: ArchivedScope): { ids: readonly string[]; list: () => ArchivedThread[] } {
  const hosts = environmentIds.join("\n");
  const key = typeof scope === "string" ? scope : scope.join("\n");
  useEffect(() => {
    if (hosts) whenIdle(() => hosts.split("\n").forEach((id) => void sessionStore.ensureArchivedWork(id)));
  }, [hosts]);
  const read = useCallback((): ArchivedThread[] => {
    const { projects, workspaces } = workspaceStore.getSnapshot();
    return archivedThreads(sessionStore.metas(), key.includes("\n") ? key.split("\n") : key, projects, workspaces);
  }, [key]);
  const joined = useSyncExternalStore(
    (listener) => {
      const offMetas = sessionStore.onMetaChange(listener);
      const offCatalog = workspaceStore.subscribe(listener);
      return () => {
        offMetas();
        offCatalog();
      };
    },
    () => read().map((thread) => thread.id).join("\n"),
  );
  const ids = useMemo(() => (joined ? joined.split("\n") : []), [joined]);
  return { ids, list: read };
}

/** Put an archived thread back, then open it; a refusal is said in a toast and nothing opens. */
async function restoreThread(id: string, onOpen: (id: string) => void): Promise<void> {
  try {
    await setSessionArchived(id, false);
  } catch (error) {
    void loadToast().then((toast) => toast.error(error instanceof Error ? error.message : String(error)));
    return;
  }
  onOpen(id);
}

/**
 * The quiet row at the end of Threads: "3 archived", opening the list of the scope's archived threads, freshest
 * first, each with Restore on hover; a pick puts the thread back and opens it. Nothing while none are archived.
 * `headed`: no live thread stands above it, so it draws the Threads heading itself (a job), or stands alone under
 * the list (Work Chats, whose column header names it).
 */
export function ArchivedRow({ scope, onOpen, headed = false }: { scope: ArchivedScope; onOpen: (id: string) => void; headed?: boolean }) {
  const { ids, list } = useArchivedThreads(scope);
  const [open, setOpen] = useState(false);
  if (ids.length === 0) return null;
  const restore = (id: string) => {
    if (ids.length === 1) setOpen(false);
    void restoreThread(id, onOpen);
  };
  const row = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" data-archived-row className={QUIET_ROW} />}>{ids.length} archived</PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 gap-1 p-1">
        {open ? <ThreadListPopover heading="Archived" threads={list()} restore onPick={restore} /> : null}
      </PopoverContent>
    </Popover>
  );
  return headed ? (
    <section aria-label="Threads" data-work-threads className={SECTION}>
      <h3 className={HEADING}>Threads</h3>
      {row}
    </section>
  ) : (
    row
  );
}
