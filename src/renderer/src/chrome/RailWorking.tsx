import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { STATUS_ON_TIP, STATUS_WORD, StatusMark } from "../components/ui/status";
import { plainStatus } from "@shared/statusWords";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { cn } from "../lib/cn";
import { duration } from "../lib/duration";
import { liveAgentTracker } from "../lib/liveAgentTracker";
import { WORKING_CAP, WORKING_MIN, withoutOpenWork, workingRows, type WorkingRow } from "../lib/railWorking";
import { sameProjectPath } from "../lib/recents";
import { isWorkWorkspace } from "../lib/workRow";
import { useSessionMeta } from "../lib/tcserver/store";
import { useSessionMetasDerived } from "../lib/tcserver/metaSelect";
import type { SessionMeta } from "../lib/tcserver/types";
import { useWorkspaceCatalog } from "../lib/tcserver/workspaces";
import { threadStatus } from "../lib/threadStripModel";
import { useClock } from "../lib/turnClock";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { HostGlyph } from "./HostGlyph";
import { ONE_HOST, spansHosts } from "../lib/hostSpan";
import { RailHeading, RailRow } from "./RailRow";

/** A row's hover line: the state, what it is about and the elapsed time
 *  while it works. */
export function workingTip(row: WorkingRow, now: number): { detail: string | null; elapsed: string | null } {
  const m = row.meta;
  const status = threadStatus({
    status: m.status,
    treeHasPaused: m.treeHasPaused,
    treeCanContinue: m.treeCanContinue,
    activity: m.activity,
    statusDetail: m.statusDetail,
    tasks: m.tasks,
    failure: m.failure?.summary ?? null,
    background: m.background,
  });
  const detail = status.state === row.state ? status.detail : null;
  const since = m.busySince;
  const elapsed = row.state === "working" && now > 0 && since ? duration(Math.max(0, now - since)) : null;
  return { detail, elapsed };
}

/** The hover line as one string, for a reader: "Working: Running bun test, 2m 5s". */
export function workingTipLine(row: WorkingRow, now: number): string {
  const { detail, elapsed } = workingTip(row, now);
  return plainStatus(STATUS_WORD[row.state], [detail, elapsed].filter(Boolean).join(", "));
}

/** The tooltip: the whole title while the row cuts it, then the word, its
 *  detail and the elapsed time 4px after it as spans (StatusMark), the
 *  project under them. It mounts only while the tooltip shows, so its second
 *  hand runs only then: the Working section itself never re-renders on the
 *  clock. `at` fixes the time (a fixture). */
function TipBody({ row: drawn, title, project, at }: { row: WorkingRow; title: string | null; project: string | null; at?: number }) {
  // The section keeps a row while what it draws holds (sameWorkingRows): the
  // open tooltip reads the thread's live meta for its detail and its clock.
  const live = useSessionMeta(drawn.id);
  const row = live && live !== drawn.meta ? { ...drawn, meta: live } : drawn;
  const ticking = useClock(at === undefined && row.state === "working");
  const now = at ?? ticking;
  const { detail, elapsed } = workingTip(row, now);
  return (
    <span data-working-tip role="group" aria-label={workingTipLine(row, now)} className="flex flex-col text-left">
      {title ? <span data-working-tip-title>{title}</span> : null}
      <StatusMark
        state={row.state}
        glyph={false}
        className={STATUS_ON_TIP}
        detail={
          detail || elapsed ? (
            <>
              {detail}
              {elapsed ? <span className={detail ? "ms-1" : undefined}>{elapsed}</span> : null}
            </>
          ) : null
        }
      />
      {project ? <span className="font-normal text-background/60">{project}</span> : null}
    </span>
  );
}

/** The row's tooltip, told by the row whether it cuts the title. */
function tipOf(row: WorkingRow, project: string | null, at?: number): (cut: boolean) => ReactNode {
  return (cut) => <TipBody row={row} title={cut ? row.meta.title.trim() || "Untitled" : null} project={project} at={at} />;
}

/**
 * The rail's Working section, presentational: a heading, then one RailRow
 * per thread that needs the person, works, or finished unseen, four at most
 * and "N more" for the rest (a scroller while open, "Show less" to close).
 * Each row is an item: the thread's type glyph, the title, the host glyph
 * when its rows span two or more hosts and the state's glyph at its end; the elapsed time
 * is in its tooltip, and a click opens the thread. It shows from one row:
 * nothing else in the rail names a thread. It sits in the rail's foot,
 * which draws the hairline above it.
 */
export function RailWorkingView({
  rows,
  now,
  activeSessionId,
  projectOf,
  onSelect,
}: {
  rows: readonly WorkingRow[];
  /** A fixed time for the tooltips (a fixture or a test; 0 leaves the elapsed
   *  time out); absent, each tooltip runs its own second hand while it shows. */
  now?: number;
  activeSessionId?: string;
  projectOf: (row: WorkingRow) => string | null;
  onSelect?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const lockList = useLockOverscroll<HTMLDivElement>();
  if (rows.length < WORKING_MIN) return null;
  const extra = rows.length - WORKING_CAP;
  const shown = open || extra <= 0 ? rows : rows.slice(0, WORKING_CAP);
  return (
    <section aria-label="Working" className="flex shrink-0 flex-col px-2 pt-2 pb-2" data-rail-working>
      <RailHeading>Working</RailHeading>
      <div ref={open ? lockList : undefined} className={cn("flex flex-col", open && "max-h-[45vh] overflow-x-hidden overflow-y-auto overscroll-none", !spansHosts(rows.map((row) => row.meta.environmentId)) && ONE_HOST)}>
        {shown.map((row) => (
          <RailRow
            key={row.id}
            glyph={<TypeGlyph type={row.meta.threadType} className="size-3" />}
            label={row.meta.title.trim() || "Untitled"}
            ariaLabel={`${row.meta.title.trim() || "Untitled"}, ${STATUS_WORD[row.state]}`}
            selected={row.id === activeSessionId}
            tooltip={tipOf(row, projectOf(row), now)}
            onClick={() => onSelect?.(row.id)}
            trailing={
              <>
                <HostGlyph environmentId={row.meta.environmentId} />
                <StatusMark state={row.state} word={false} />
              </>
            }
            data-working-row={row.id}
          />
        ))}
      </div>
      {extra > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-working-more
          // A rail row's box: the label at the rows' 36px, the /5 hover fill at once.
          className="h-7 w-full justify-start gap-2 px-3 text-[13px] font-normal text-muted-foreground tabular-nums transition-none hover:bg-chrome-hover hover:text-foreground"
        >
          <span aria-hidden className="size-4 shrink-0" />
          {open ? "Show less" : `${extra} more`}
        </Button>
      ) : null}
    </section>
  );
}

/** The Working section wired to the session store, the catalog and the
 *  live agent tracker; the second hand runs only inside an open tooltip. A Work workspace open beside the rail
 *  (`openPath`) lists its own threads in its column, so they leave this section. */
/** What a row draws (its glyph, title, host, state and project) and the rows'
 *  order: a meta push that changes none of it keeps the rows drawn. */
export function sameWorkingRows(a: readonly WorkingRow[], b: readonly WorkingRow[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const drawn = (x: SessionMeta, y: SessionMeta): boolean =>
    x === y ||
    (x.title === y.title &&
      x.threadType === y.threadType &&
      x.environmentId === y.environmentId &&
      x.projectId === y.projectId &&
      x.workspaceId === y.workspaceId);
  return a.every((row, i) => row.id === b[i].id && row.state === b[i].state && drawn(row.meta, b[i].meta));
}

export function RailWorking({ activeSessionId, openPath, onSelect }: { activeSessionId?: string; openPath?: string; onSelect?: (sessionId: string) => void }) {
  const { projects, workspaces } = useWorkspaceCatalog();
  const unseen = useSyncExternalStore(liveAgentTracker.subscribe, liveAgentTracker.unseenIds);
  const open = useMemo(
    () => new Set(openPath ? workspaces.filter((w) => isWorkWorkspace(w) && sameProjectPath(w.path, openPath)).map((w) => w.id) : []),
    [openPath, workspaces],
  );
  // Derived on each meta flush, drawn again only when a drawn row changed: a
  // push of a thread past "N more", or one whose row draws the same, renders nothing.
  const derive = useCallback(
    (metas: SessionMeta[]) => withoutOpenWork(workingRows(metas, unseen), open, (id) => projects.find((p) => p.id === id)?.workspaceId),
    [unseen, open, projects],
  );
  const rows = useSessionMetasDerived(derive, sameWorkingRows);
  const projectOf = (row: WorkingRow): string | null =>
    projects.find((p) => p.id === row.meta.projectId)?.name ?? workspaces.find((w) => w.id === row.meta.workspaceId)?.name ?? null;
  return <RailWorkingView rows={rows} activeSessionId={activeSessionId} projectOf={projectOf} onSelect={onSelect} />;
}
