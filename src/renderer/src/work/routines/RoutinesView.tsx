import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RoutineRow, RoutineRun } from "@shared/contract-work-routines";
import { Plus } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { registry, useEnvironments } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { hostKind, platformOf } from "../../lib/hostPlatform";
import { refusalWords } from "../../lib/settingsHome";
import { loadToast } from "../../components/ui/toaster";
import { workOpenPort } from "../../lib/workSwitch";
import { EmptyState, PAGE_LIST_WIDTH } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { RoutineDialog } from "./RoutineForm";
import { noRunsLine, rowLine, rowMark, runMark, runWords } from "./model";

/**
 * A Work workspace's Routines (prototype routines.html, "List and detail"):
 * the routines, watches and an agent's proposals on the left, the one picked
 * on the right with what it does, what starts it and every run, each run its
 * thread one click away. New routine and Edit open the form; a proposal's
 * Create opens it filled, and nothing an agent proposed runs until then.
 */

// The header's New routine asks the view to open the form.
const formAsks = new Set<() => void>();
let formAsked = 0;
const askForm = () => {
  formAsked++;
  for (const fn of formAsks) fn();
};

export function Head(_props: WorkViewProps) {
  return (
    <Button variant="ghost" size="sm" onClick={askForm}>
      <Plus />
      New routine
    </Button>
  );
}

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

function useRoutines(env: string, workspaceId: string): [Load<RoutineRow[]>, number] {
  const [state, setState] = useState<Load<RoutineRow[]>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    const fetch = () =>
      link.request<{ routines: RoutineRow[] }>("work.routines.list", { workspaceId }).then(
        (r) => live && setState({ status: "ready", value: r.routines }),
        (err: unknown) => live && setState({ status: "error", error: refusalWords(err) || "The host did not answer" }),
      );
    void fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.routines" && push.workspaceId === workspaceId) {
        void fetch();
        setTick((n) => n + 1);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [env, workspaceId]);
  return [state, tick];
}

function useRuns(env: string, id: string | null, tick: number): RoutineRun[] | null {
  const [runs, setRuns] = useState<{ id: string; runs: RoutineRun[] } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    registry
      .linkOf(env)
      .request<{ runs: RoutineRun[] }>("work.routines.runs", { id, limit: 30 })
      .then(
        (r) => live && setRuns({ id, runs: r.runs }),
        () => live && setRuns({ id, runs: [] }),
      );
    return () => {
      live = false;
    };
  }, [env, id, tick]);
  return runs?.id === id ? runs.runs : null;
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, tick] = useRoutines(env, workspace.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<{ row: RoutineRow | null } | null>(null);
  const asked = useSyncExternalStore(
    (fn) => (formAsks.add(fn), () => formAsks.delete(fn)),
    () => formAsked,
  );
  const [seen, setSeen] = useState(asked);
  useEffect(() => {
    if (asked !== seen) {
      setSeen(asked);
      setForm({ row: null });
    }
  }, [asked, seen]);

  const rows = useMemo(() => {
    if (load.status !== "ready") return [];
    // An agent's proposals lead: they wait on him.
    return [...load.value].sort((a, b) => Number(b.proposed) - Number(a.proposed) || a.createdAt - b.createdAt);
  }, [load]);
  const current = rows.find((r) => r.id === picked) ?? rows[0] ?? null;

  if (load.status === "loading") return <ListSkeleton />;
  if (load.status === "error") return <EmptyState title="Routines did not load" line={load.error} />;
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No routines yet" line="Work that starts on a schedule or when something changes." action={{ label: "New routine", onClick: () => setForm({ row: null }) }} />
      ) : (
        <div className="flex h-full min-h-0">
          <div role="listbox" aria-label="Routines" className="flex shrink-0 flex-col gap-px overflow-x-hidden overflow-y-auto border-r border-border p-2" style={{ width: PAGE_LIST_WIDTH }}>
            {rows.map((r) => (
              <RoutineItem key={r.id} row={r} current={r.id === current?.id} onPick={() => setPicked(r.id)} />
            ))}
          </div>
          {current ? <Detail key={current.id} env={env} row={current} tick={tick} onEdit={() => setForm({ row: current })} /> : null}
        </div>
      )}
      {form ? <RoutineDialog env={env} workspaceId={workspace.id} row={form.row} onClose={() => setForm(null)} onSaved={(row) => setPicked(row.id)} /> : null}
    </>
  );
}

function RoutineItem({ row, current, onPick }: { row: RoutineRow; current: boolean; onPick: () => void }) {
  const mark = rowMark(row);
  return (
    <ItemButton role="option" aria-selected={current} aria-current={current} onClick={onPick} className="flex-col items-stretch gap-0.5 px-2 py-1.5">
      <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
        {mark ? <StatusMark state={mark} word={false} className="shrink-0" /> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">{rowLine(row)}</span>
    </ItemButton>
  );
}

function Detail({ env, row, tick, onEdit }: { env: string; row: RoutineRow; tick: number; onEdit: () => void }) {
  const runs = useRuns(env, row.id, tick);
  const [busy, setBusy] = useState<"pause" | "run" | "drop" | null>(null);
  const hostName = useEnvironments().find((e) => e.id === env)?.name ?? "this host";
  const mac = hostKind(platformOf(env)) === "mac";
  const act = useCallback(
    (what: "pause" | "run" | "drop", method: string, params: Record<string, unknown>) => {
      setBusy(what);
      registry
        .linkOf(env)
        .request(method, params)
        .then(
          () => setBusy(null),
          (err: unknown) => {
            setBusy(null);
            void loadToast().then((toast) => toast.error(refusalWords(err) || "The host refused it"));
          },
        );
    },
    [env],
  );
  const open = (sessionId: string | null) => {
    if (sessionId) workOpenPort.get()?.(sessionId);
  };
  const starts = row.waiting ? `${row.words}, ${row.waiting.charAt(0).toLowerCase()}${row.waiting.slice(1)}` : row.nextAt ? `${row.words}, next ${dayTime(row.nextAt)}` : row.words;
  const ends = row.ends.kind === "day" ? dayTime(row.ends.at) : row.ends.kind === "once" ? "After the first run" : null;

  return (
    <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-6 py-5">
        <div className="flex min-w-0 items-start gap-3">
          <h1 className="min-w-0 flex-1 text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{row.name}</h1>
          <div className="flex shrink-0 items-center gap-1">
            {row.proposed ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act("drop", "work.routines.remove", { id: row.id })}>
                  <BusyLabel busy={busy === "drop"} label="Not now" />
                </Button>
                <Button size="sm" onClick={onEdit}>
                  Create…
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={onEdit}>
                  Edit
                </Button>
                {row.ended ? null : (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act("pause", "work.routines.pause", { id: row.id, paused: row.enabled })}>
                    <BusyLabel busy={busy === "pause"} label={row.enabled ? "Pause" : "Resume"} />
                  </Button>
                )}
                <Button variant="secondary" size="sm" disabled={busy !== null || row.running || row.resumeSessionId !== null} onClick={() => act("run", "work.routines.runNow", { id: row.id })}>
                  <BusyLabel busy={busy === "run" || row.running} label="Run now" />
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground">{row.prompt}</p>
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted-foreground">Starts</dt>
          <dd className="min-w-0 text-foreground">{row.enabled || row.proposed ? starts : `${row.words}, paused`}</dd>
          {ends ? (
            <>
              <dt className="text-muted-foreground">Ends</dt>
              <dd className="text-foreground">{ends}</dd>
            </>
          ) : null}
          {row.model ? (
            <>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="text-foreground">{row.model}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Runs on</dt>
          <dd className="text-foreground">{mac ? `${hostName}, while it is awake` : hostName}</dd>
          {row.madeIn ? (
            <>
              <dt className="text-muted-foreground">{row.resumeSessionId ? "Wakes" : "Made in"}</dt>
              <dd className="min-w-0">
                <Button variant="link" size="xs" className="h-auto max-w-full truncate px-0 text-[13px]" onClick={() => open(row.madeIn)}>
                  The thread
                </Button>
              </dd>
            </>
          ) : null}
        </dl>
        {row.proposed ? null : (
          <section aria-label="Runs" className="flex flex-col gap-1">
            <h2 className="text-xs font-medium text-muted-foreground">Runs</h2>
            {runs === null ? (
              <Skeleton className="h-4 w-1/2" />
            ) : runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{noRunsLine(row)}</p>
            ) : (
              <div className="flex flex-col">
                {runs.map((run) => (
                  <ItemButton key={run.id} disabled={!run.sessionId} onClick={() => open(run.sessionId)} className="h-8 items-center gap-3 px-2 text-[13px]">
                    <time className="w-36 shrink-0 text-muted-foreground tabular-nums">{dayTime(run.firedAt)}</time>
                    <StatusMark state={runMark(run)} word={false} className="shrink-0" />
                    <span className={run.state === "failed" ? "min-w-0 flex-1 truncate text-destructive" : run.state === "held" ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-muted-foreground"}>{runWords(run)}</span>
                  </ItemButton>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading routines" className="flex h-full min-h-0">
      <div className="flex shrink-0 flex-col gap-3 border-r border-border p-4" style={{ width: PAGE_LIST_WIDTH }}>
        {[64, 48, 72, 40].map((w, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
            <Skeleton className="h-3" style={{ width: `${w - 16}%` }} />
          </div>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-3 px-6 py-5">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
