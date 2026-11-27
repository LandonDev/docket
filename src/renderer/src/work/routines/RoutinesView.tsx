import { downOf, downWords } from "../shell/lifeosDown";
import { connectingWords } from "../shell/lifeosWords";
import { HostLinkLine, useHostLinkDown } from "../shell/hostLinkDown";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import type { RoutineRow, RoutineRun } from "@shared/contract-work-routines";
import { ChevronLeft, Plus } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Region } from "../../components/bones";
import { StatusMark } from "../../components/ui/status";
import { registry, useEnvironments } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { hostKind, platformOf } from "../../lib/hostPlatform";
import { headAsk } from "../../lib/headAsk";
import { managedElsewhere, useLinkMay } from "../../lib/linkMay";
import { workErrorWords } from "../../lib/workErrorWords";
import { loadToast } from "../../components/ui/toaster";
import { workOpenPort } from "../../lib/workSwitch";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "../views/registry";
import { routineJobOpenPort } from "./jobOpen";
import { RoutineDialog } from "./RoutineForm";
import { failedOver, loadFailure, usePlays, type Load } from "./plays/data";
import { ViewStateLine } from "../views/ViewStateLine";
import { noRunsLine, rowLine, rowMark, runMark, runWords } from "./model";
import { Tip, TruncateTip, useTruncated } from "../../components/tip";
import { HostLine } from "../shell/DownLine";
import { useHostLive } from "../shell/lifeosLive";

/** The host's reason for a routine that cannot fire while its LifeOS is not connected (routines/engine.ts `waiting`). */
const LIFEOS_WAIT = "Waiting on LifeOS";

/**
 * A Work workspace's Routines (prototype routines.html, "List and detail"):
 * the routines, watches and an agent's proposals on the left, the one picked
 * on the right with what it does, what starts it and every run, each run its
 * thread one click away. New routine and Edit open the form; a proposal's
 * Create opens it filled, and nothing an agent proposed runs until then.
 * Under 640px of pane the list and the detail take turns: a pick opens the
 * detail, and its Routines row goes back. A key that may not save routines on
 * the host (its admin rule) is offered no New, Edit or proposal's press; a
 * proposal says who can take it. Pause and Run now stay where it may operate.
 */

// The header's New routine asks the view to open the form: a press made while the view still loads is answered when it mounts.
const newForm = headAsk();

export function Head({ env }: WorkViewProps) {
  newForm.useHead();
  const linkDown = useHostLinkDown(env);
  if (!useLinkMay(env, "work.routines.save")) return null;
  return (
    <Button variant="ghost" size="sm" disabled={!!linkDown} onClick={newForm.ask}>
      <Plus />
      New routine
    </Button>
  );
}


function useRoutines(env: string, workspaceId: string): [Load<RoutineRow[]>, number, () => Promise<void>] {
  const [state, setState] = useState<Load<RoutineRow[]>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  // The read the effect holds, for Retry: what is shown, a failure too, stays until it answers.
  const read = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    // Several pushes ask in a row: only the newest answer is shown.
    let asked = 0;
    const fetch = (): Promise<void> => {
      const mine = ++asked;
      return link.request<{ routines: RoutineRow[] }>("work.routines.list", { workspaceId }).then(
        (r) => void (live && mine === asked && setState({ status: "ready", value: r.routines })),
        (err: unknown) => void (live && mine === asked && setState((prev) => failedOver(prev, loadFailure(env, err, "routines")))),
      );
    };
    read.current = fetch;
    void fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.routines" && push.workspaceId === workspaceId) {
        void fetch();
        setTick((n) => n + 1);
      }
    });
    const offOpen = link.onOpen?.(() => void fetch());
    return () => {
      live = false;
      off();
      offOpen?.();
    };
  }, [env, workspaceId]);
  const retry = useCallback(() => read.current(), []);
  return [state, tick, retry];
}

/** A routine's runs: null while they load, or why they did not, kept apart from a routine that never ran. */
function useRuns(env: string, id: string | null, tick: number): [RoutineRun[] | { error: string } | null, () => Promise<void>] {
  const [runs, setRuns] = useState<{ id: string; runs: RoutineRun[] | { error: string } } | null>(null);
  // The read the effect holds, for Retry: the failure stays until it answers.
  const read = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    if (!id) return;
    let live = true;
    const fetch = (): Promise<void> =>
      registry
        .linkOf(env)
        .request<{ runs: RoutineRun[] }>("work.routines.runs", { id, limit: 30 })
        .then(
          (r) => void (live && setRuns({ id, runs: r.runs })),
          (err: unknown) => void (live && setRuns({ id, runs: { error: loadFailure(env, err, "runs") } })),
        );
    read.current = fetch;
    void fetch();
    return () => {
      live = false;
    };
  }, [env, id, tick]);
  const retry = useCallback(() => read.current(), []);
  return [runs?.id === id ? runs.runs : null, retry];
}

export function View({ env, workspace }: WorkViewProps) {
  const [load, tick, retry] = useRoutines(env, workspace.id);
  // His Retry spins in place, the failure kept, until the read answers.
  const [retrying, setRetrying] = useState(false);
  const again = (): void => {
    setRetrying(true);
    void retry().finally(() => setRetrying(false));
  };
  const [plays] = usePlays(env, workspace.id);
  const playName = (id: string | null) => (id && plays.status === "ready" ? (plays.value.find((p) => p.id === id)?.name ?? null) : null);
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState<{ row: RoutineRow | null } | null>(null);
  const linkDown = useHostLinkDown(env);
  // Narrow, a pick hides the list and Back hides the detail: the keyboard goes with them, to the detail's way back and
  // then to the row it came from, never left on a press that is gone.
  const list = useRef<HTMLUListElement>(null);
  const backFrom = useRef<string | null>(null);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (picked !== null && el.getClientRects().length === 0) el.parentElement?.querySelector<HTMLElement>("[data-routine-back]")?.focus();
    else if (picked === null && backFrom.current) [...el.querySelectorAll<HTMLElement>("[data-routine-row]")].find((row) => row.dataset.routineRow === backFrom.current)?.focus();
    backFrom.current = null;
  }, [picked]);
  newForm.useAnswer(() => !linkDown && setForm({ row: null }));
  // Whether the detail stands beside the list (40rem of view and over): there the first routine's detail is open before
  // any pick, so its row is the current one for a reader too, as its fill says.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!pane) return;
    const measure = () => setWide(pane.clientWidth >= 40 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);

  const rows = useMemo(() => {
    if (load.status !== "ready") return [];
    // An agent's proposals lead: they wait on him.
    return [...load.value].sort((a, b) => Number(b.proposed) - Number(a.proposed) || a.createdAt - b.createdAt);
  }, [load]);
  const current = rows.find((r) => r.id === picked) ?? rows[0] ?? null;
  const hostLive = useHostLive(env);
  const host = useEnvironments().find((e) => e.id === env)?.name;
  const down = hostLive.down && downOf(hostLive.down);
  const lifeosWait = down ? downWords(down, host) : hostLive.waits ? connectingWords(host) : null;

  // New routine is the header's press in every state the view draws, so its dialog stands beside each of them.
  const dialog = form ? <RoutineDialog env={env} workspaceId={workspace.id} row={form.row} onClose={() => setForm(null)} onSaved={(row) => setPicked(row.id)} /> : null;
  if (linkDown) return <HostLinkLine word={linkDown} retryHost={env} />;
  // Narrow, the detail shows only once a routine is picked; wide, the first is shown until then.
  const narrowDetail = picked !== null && current?.id === picked;
  return (
    <>
      <Region loading={load.status === "loading"} label="Loading routines" className="h-full" bones={RoutinesBones}>
        {load.status === "loading" ? null : load.status === "error" ? (
          <EmptyState title="Routines did not load" line={load.error} action={{ label: "Retry", onClick: again, busy: retrying }} />
        ) : rows.length === 0 ? (
          <EmptyState title="No routines yet" />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {load.failed ? (
              // The cause cut to one line reads whole in the line's tip (as Forms').
              <TruncateTip text={load.failed}>
                <div data-state-tip="">
                  <ViewStateLine word="Routines did not load" detail={load.failed} onRetry={retry} />
                </div>
              </TruncateTip>
            ) : null}
            <div ref={setPane} className="@container/routines flex min-h-0 flex-1">
              <RoutineList listRef={list} rows={rows} current={current?.id ?? null} picked={picked} wide={wide} hidden={narrowDetail} lifeosWait={lifeosWait} onPick={setPicked} />
              {current ? (
                <Detail key={current.id} env={env} row={current} play={playName(current.playId)} tick={tick} narrowShown={narrowDetail} onBack={() => {
                    backFrom.current = picked;
                    setPicked(null);
                  }} onEdit={() => setForm({ row: current })} />
              ) : null}
            </div>
          </div>
        )}
      </Region>
      {dialog}
    </>
  );
}

/** The list of routines: buttons, the picked one marked current, so Tab moves through them as a listbox's arrows would not. */
function RoutineList({ listRef, rows, current, picked, wide, hidden, lifeosWait, onPick }: { listRef?: Ref<HTMLUListElement>; rows: readonly RoutineRow[]; current: string | null; picked: string | null; wide: boolean; hidden: boolean; lifeosWait: string | null; onPick(id: string): void }) {
  return (
    <ul
      ref={listRef}
      aria-label="Routines"
      data-routine-list=""
      className={cn(
        "flex w-70 shrink-0 flex-col gap-px overflow-x-hidden overflow-y-auto border-r border-border p-2 @max-[40rem]/routines:w-full @max-[40rem]/routines:border-r-0",
        hidden && "@max-[40rem]/routines:hidden",
      )}
    >
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col">
          <RoutineItem lifeosWait={lifeosWait} row={r} current={r.id === current} picked={r.id === picked} open={r.id === current && (r.id === picked || wide)} onPick={() => onPick(r.id)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A row. `current` is the routine the detail shows: wide, the picked one or the first; `picked`, the one he chose; `open`,
 * the current one wherever its detail is on screen. Under 640px the list stands alone until he picks, so only a picked
 * row is marked open there (its ground and `aria-current`); wide, the first is, before any pick.
 */
function RoutineItem({ row, current, picked, open, onPick, lifeosWait }: { row: RoutineRow; current: boolean; picked: boolean; open: boolean; onPick: () => void; lifeosWait: string | null }) {
  const mark = rowMark(row);
  const line = rowLine(row);
  const shown = row.waiting === LIFEOS_WAIT && lifeosWait ? line.replace(/waiting on LifeOS$/, midLine(lifeosWait)) : line;
  // One tip on the row's press while either line cuts, so Tab reads it as hover does.
  const { ref, cut } = useTruncated(`${row.name}\n${shown}`);
  return (
    <Tip label={`${row.name}, ${shown}`} disabled={!cut}>
      <ItemButton
        ref={ref}
        data-routine-row={row.id}
        aria-current={open ? "true" : undefined}
        onClick={onPick}
        className={cn("flex-col flex-nowrap items-stretch gap-0.5 px-2 py-1.5 transition-none", current ? "bg-muted" : "hover:bg-foreground/5", current && !picked && "@max-[40rem]/routines:bg-transparent @max-[40rem]/routines:hover:bg-foreground/5")}
      >
        <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
          {mark ? <StatusMark state={mark} word={false} className="shrink-0" /> : null}
        </span>
        <span className="truncate text-xs text-muted-foreground">{shown}</span>
      </ItemButton>
    </Tip>
  );
}

/** LifeOS's words after the row's trigger and a comma: their head word lowered ("not signed in", "the box"), a name kept. */
export const midLine = (words: string): string => words.replace(/^(Not|The|This|Work)\b/, (w) => w.toLowerCase());

function Detail({ env, row, play, tick, narrowShown, onBack, onEdit }: { env: string; row: RoutineRow; play: string | null; tick: number; narrowShown: boolean; onBack: () => void; onEdit: () => void }) {
  const [runs, retryRuns] = useRuns(env, row.id, tick);
  // Retry on the runs spins in place, the failure kept, until they answer.
  const [runsAgain, setRunsAgain] = useState(false);
  const [busy, setBusy] = useState<"pause" | "run" | "drop" | null>(null);
  const hostName = useEnvironments().find((e) => e.id === env)?.name ?? "this host";
  const maySave = useLinkMay(env, "work.routines.save");
  const mayOperate = useLinkMay(env, "work.routines.runNow");
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
            void loadToast().then((toast) => toast.error(workErrorWords(err) || "The host refused it"));
          },
        );
    },
    [env],
  );
  const open = (sessionId: string | null) => {
    if (sessionId) workOpenPort.get()?.(sessionId);
  };
  // A run opens its thread, or a job run the page its job named; with neither, its row is plain text.
  const openRun = (run: RoutineRun): (() => void) | null => {
    if (run.sessionId) return () => open(run.sessionId);
    const page = run.open;
    return page && routineJobOpenPort.has(page) ? () => routineJobOpenPort.open(page) : null;
  };
  // A routine that waits on its host's LifeOS says why there, by the rule: the state with the computer named and its
  // press, or LifeOS is still connecting on it with none (`HostLine`), from the host's live status; not yet heard, the
  // host's own "waiting on LifeOS".
  const hostLive = useHostLive(env);
  const lifeosSaid = row.waiting === LIFEOS_WAIT && (row.enabled || row.proposed) && (!!hostLive.down || hostLive.waits);
  const starts = lifeosSaid ? row.words : row.waiting ? `${row.words}, ${row.waiting.charAt(0).toLowerCase()}${row.waiting.slice(1)}` : row.nextAt ? `${row.words}, next ${dayTime(row.nextAt)}` : row.words;
  const ends = row.ends.kind === "day" ? dayTime(row.ends.at) : row.ends.kind === "once" ? "After the first run" : null;

  return (
    <div data-routine-detail="" className={cn("min-w-0 flex-1 overflow-x-hidden overflow-y-auto", !narrowShown && "@max-[40rem]/routines:hidden")}>
      <div className="hidden px-4 pt-2 @max-[40rem]/routines:block">
        <Button variant="ghost" size="xs" data-routine-back="" onClick={onBack}>
          <ChevronLeft className="size-3.5" />
          Routines
        </Button>
      </div>
      <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-6 py-5">
        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{row.name}</h1>
          <div className="flex shrink-0 items-center gap-1">
            {row.proposed && !maySave ? (
              <span className="text-[13px] leading-6 text-muted-foreground">{managedElsewhere(hostName)}</span>
            ) : row.proposed ? (
              <>
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act("drop", "work.routines.remove", { id: row.id })}>
                  <BusyLabel busy={busy === "drop"} label="Dismiss" />
                </Button>
                <Button size="sm" onClick={onEdit}>
                  Add…
                </Button>
              </>
            ) : (
              <>
                {maySave ? (
                  <Button variant="ghost" size="sm" onClick={onEdit}>
                    Edit
                  </Button>
                ) : null}
                {row.ended || !mayOperate ? null : (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => act("pause", "work.routines.pause", { id: row.id, paused: row.enabled })}>
                    <BusyLabel busy={busy === "pause"} label={row.enabled ? "Pause" : "Resume"} />
                  </Button>
                )}
                {mayOperate ? (
                  // Off while its last run's thread is to wake: the tip says why, on a span a key can reach, since a disabled button hears no pointer.
                  <Tip label="Waits for its last run's thread" disabled={row.resumeSessionId === null}>
                    <span className="inline-flex rounded-md focus-ring" data-run-now tabIndex={row.resumeSessionId === null ? undefined : 0}>
                      <Button variant="secondary" size="sm" disabled={busy !== null || row.running || row.resumeSessionId !== null} onClick={() => act("run", "work.routines.runNow", { id: row.id })}>
                        <BusyLabel busy={busy === "run" || row.running} label="Run now" />
                      </Button>
                    </span>
                  </Tip>
                ) : null}
              </>
            )}
          </div>
        </div>
        {row.job ? (
          <p className={cn("text-sm leading-[22px]", row.jobName ? "text-foreground" : "text-muted-foreground")}>{row.jobName ?? "Its job is not on this host"}</p>
        ) : row.prompt ? (
          <p className="text-sm leading-[22px] whitespace-pre-wrap text-foreground">{row.prompt}</p>
        ) : null}
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          {play ? (
            <>
              <dt className="text-muted-foreground">Play</dt>
              <dd className="min-w-0 text-foreground">{play}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Starts</dt>
          <dd className="min-w-0 text-foreground">
            {row.enabled || row.proposed ? starts : `${row.words}, paused`}
            {lifeosSaid ? <HostLine live={hostLive} className="min-h-0 pt-1" /> : null}
          </dd>
          {ends ? (
            <>
              <dt className="text-muted-foreground">Ends</dt>
              <dd className="text-foreground">{ends}</dd>
            </>
          ) : null}
          {row.model && !row.job ? (
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
            <Region loading={runs === null} label="Loading runs" bones={() => <RunRows runs={SAMPLE_RUNS} openRun={() => null} />}>
              {runs === null ? null : "error" in runs ? (
                <p className="inline-flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="min-w-0 text-destructive">{runs.error}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="-my-1"
                    disabled={runsAgain}
                    onClick={() => {
                      setRunsAgain(true);
                      void retryRuns().finally(() => setRunsAgain(false));
                    }}
                  >
                    <BusyLabel busy={runsAgain} label="Retry" />
                  </Button>
                </p>
              ) : runs.length === 0 ? (
                <p className="text-xs text-muted-foreground">{noRunsLine(row)}</p>
              ) : (
                <RunRows runs={runs} openRun={openRun} />
              )}
            </Region>
          </section>
        )}
      </div>
    </div>
  );
}

/** A run's row: 32px at least, growing with an outcome too long for its cell (a narrow pane), which wraps and is never cut. */
const RUN_ROW = "-mx-2 min-h-8 w-[calc(100%+1rem)] flex-nowrap items-start gap-3 border-0 px-2 py-1.5 text-[13px] leading-5";

/** A routine's runs, newest first: a run that opens something is a press, one with nothing to open is plain. */
function RunRows({ runs, openRun }: { runs: readonly RoutineRun[]; openRun(run: RoutineRun): (() => void) | null }) {
  return (
    <div className="flex flex-col">
      {runs.map((run) => {
        const press = openRun(run);
        const cells = (
          <>
            <time className="w-28 shrink-0 text-muted-foreground tabular-nums">{dayTime(run.firedAt)}</time>
            <StatusMark state={runMark(run)} word={false} className="mt-[3px] shrink-0" />
            <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", run.state === "failed" ? "text-destructive" : run.state === "held" ? "text-foreground" : "text-muted-foreground")}>{runWords(run)}</span>
          </>
        );
        return press ? (
          // A run that opens something answers the pointer as every row that opens its thing does. Its words keep the
          // heading's edge: the fill reaches 8px past them, and no border sets them in.
          <ItemButton key={run.id} onClick={press} className={cn(RUN_ROW, ROW_PRESS)}>
            {cells}
          </ItemButton>
        ) : (
          <Item key={run.id} className={RUN_ROW}>
            {cells}
          </Item>
        );
      })}
    </div>
  );
}

/** A routine as the bones draw it, a weekday schedule that has run: every field the list reads set. */
const sampleRoutine = (id: string, name: string, words: string): RoutineRow => ({
  id,
  workspaceId: "sample:ws",
  projectId: null,
  kind: "routine",
  name,
  prompt: "Read my mail and list what needs me today.",
  playId: null,
  model: null,
  reasoning: null,
  trigger: { on: "schedule", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0", tz: "America/Chicago" },
  words,
  ends: { kind: "never" },
  enabled: true,
  proposed: false,
  resumeSessionId: null,
  madeIn: null,
  nextAt: null,
  lastAt: null,
  lastState: null,
  lastWords: null,
  checkedAt: null,
  waiting: null,
  running: false,
  ended: false,
  createdBy: "owner",
  createdAt: 0,
  host: "sample:host",
});

const SAMPLE_ROUTINES: readonly RoutineRow[] = [
  sampleRoutine("sample:1", "Morning brief", "Weekdays at 7:00 AM"),
  sampleRoutine("sample:2", "Friday review", "Fridays at 3:00 PM"),
  sampleRoutine("sample:3", "Watch the sign-up sheet", "Every 15 minutes"),
  sampleRoutine("sample:4", "Invoice reminders", "Mondays at 9:00 AM"),
];

/** Two runs of a routine: the runs' bones. */
const SAMPLE_RUNS: readonly RoutineRun[] = [
  { id: "sample:run-1", routineId: "sample:1", sessionId: null, firedAt: 0, cause: "Weekdays at 7:00 AM", folded: 0, state: "held", summary: "Held 2" },
  { id: "sample:run-2", routineId: "sample:1", sessionId: null, firedAt: 0, cause: "Weekdays at 7:00 AM", folded: 0, state: "quiet", summary: "Nothing to do" },
];

/**
 * The list and the detail in their own shapes, by the view's own container rule: under 640px the list alone, as the
 * view lands. The detail is drawn without its presses, which hang on his rights.
 */
function RoutinesBones() {
  const first = SAMPLE_ROUTINES[0]!;
  return (
    <div data-routine-bones="" className="@container/routines flex h-full min-h-0">
      <RoutineList rows={SAMPLE_ROUTINES} current={first.id} picked={null} wide hidden={false} lifeosWait={null} onPick={() => undefined} />
      <div data-routine-detail-bones="" className="min-w-0 flex-1 @max-[40rem]/routines:hidden">
        <div className="mx-auto flex max-w-[672px] flex-col gap-6 px-6 py-5">
          <h1 className="text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">{first.name}</h1>
          <p className="text-sm leading-[22px] text-foreground">{first.prompt}</p>
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">Starts</dt>
            <dd className="text-foreground">{first.words}</dd>
            <dt className="text-muted-foreground">Runs on</dt>
            <dd className="text-foreground">The box</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
