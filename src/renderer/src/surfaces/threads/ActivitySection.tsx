import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { sessionStore } from "../../lib/tcserver/store";
import { loadToast } from "../../components/ui/toaster";
import { useLinkMay } from "../../lib/linkMayCore";
import { useHostHeld } from "../../lib/connection/degraded";
import { HeldTip } from "../../components/heldTip";
import { Button } from "@renderer/components/ui/button";
import { Collapsible, CollapsibleContent } from "@renderer/components/ui/collapsible";
import { Item, ItemActions, ItemButton, ItemContent, ItemMedia } from "@renderer/components/ui/item";
import { ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "@renderer/components/ui/press";
import { Region } from "@renderer/components/bones";
import { CONSOLE } from "@renderer/components/ui/console";
import { TruncateTip, useTruncated } from "@renderer/components/tip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { Bot, Clock, Eye, Globe, Laptop, Layers, Square, SquareMousePointer, Terminal, Workflow } from "../../chrome/icons";
import { usePaneVisible } from "../../hooks/paneVisibility";
import { rowStale, stopActivity, useActivity, type ActivityKind, type ActivityRow } from "../../lib/activity";
import { devPane } from "../../lib/devPane";
import { taskLog } from "../../lib/tcserver/commands";
import type { SessionMeta } from "../../lib/tcserver/types";
import { minuteAge } from "../../lib/duration";
import { useSlowClock } from "../../lib/turnClock";
import { ComputerLines } from "./ComputerLines";

/**
 * The right panel's Activity section: what a thread has running in the
 * background, one 28px line each (docs/DESIGN.md "Panels"). No heading, no
 * card, no separators. A row carries its kind's glyph, the work in the
 * model's words, its age, and Stop. A shell row opens under it onto its
 * command and its live output (session.taskLog, every 1.5 s while open and
 * on screen; a read that fails says so and keeps what it had); a dev server
 * opens the dev servers pane; a computer session this desktop cannot draw
 * says its window and app and the tier of its last action, and opens in
 * place, with no height animation, onto what it waits on (ComputerLines: a
 * card on its Mac, a held step). A session it can draw is the Computer
 * section's and has no row here; subagents are the Agents section's alone.
 * Rows have no enter or leave motion: a row leaves when its push says the
 * work ended, and an open log closes with it.
 */

const GLYPH: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  shell: Terminal,
  monitor: Eye,
  agent: Bot,
  workflow: Workflow,
  cron: Clock,
  other: Clock,
  batch: Layers,
  dev: Globe,
  mac: Laptop,
  computer: SquareMousePointer,
};

/** How often an open log asks for more. */
const LOG_POLL_MS = 1_500;
/** The most of a log the fold keeps. */
const LOG_KEEP = 64 * 1024;

// Colour codes and cursor moves a terminal would act on; the fold shows the text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function ActivitySection({ threadId }: { threadId: string }) {
  const { rows, meta } = useActivity(threadId);
  // D5: Stop asks the thread's host (session.stopTask, devServer.stop: operate); a key that may not has no Stop.
  const host = sessionStore.environmentOf(threadId);
  const mayStop = useLinkMay(host ?? "", "session.stopTask");
  // Round 2: one read of the host's link for the section, handed to each row's Stop (no subscription per row).
  const held = useHostHeld(host);
  const shown = useMemo(() => (mayStop ? rows : rows.map((row) => (row.stop ? { ...row, stop: undefined } : row))), [rows, mayStop]);
  if (!meta) return null;
  return <ActivityRows threadId={threadId} rows={shown} meta={meta} held={held} />;
}

/** The rows alone, given the join (ActivitySection; tests). */
export const ActivityRows = memo(function ActivityRows({
  threadId,
  rows,
  meta,
  initialOpen = null,
  readLog = taskLog,
  held = null,
}: {
  threadId: string;
  rows: ActivityRow[];
  /** The thread's host away (D5): every Stop is held, this its tooltip. */
  held?: string | null;
  meta: Pick<SessionMeta, "status" | "background">;
  /** The row shown open at mount (a fixture's open fold). */
  initialOpen?: string | null;
  readLog?: typeof taskLog;
}) {
  const shown = usePaneVisible();
  const now = useSlowClock(shown && rows.length > 0);
  const [openKey, setOpenKey] = useState<string | null>(initialOpen);
  // An open log closes with its row.
  const open = rows.some((r) => r.key === openKey) ? openKey : null;

  const activate = (row: ActivityRow): void => {
    if (row.open === "log" || row.open === "lines") setOpenKey(open === row.key ? null : row.key);
    else if (row.open === "dev") devPane.open(row.devKey);
  };

  // No TooltipProvider round the scroller: each row's one Stop keeps its own delay.
  return (
    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-slot="activity-scroller">
      <div className="flex flex-col px-1 py-3" data-slot="activity-section">
        {rows.map((row) => (
          <Row
            key={row.key}
            threadId={threadId}
            row={row}
            now={now}
            stale={now > 0 && rowStale(row, meta, now)}
            expanded={open === row.key}
            onActivate={row.open ? () => activate(row) : undefined}
            live={shown}
            readLog={readLog}
            held={held}
          />
        ))}
      </div>
    </div>
  );
});

function Row({
  threadId,
  row,
  now,
  stale,
  expanded,
  onActivate,
  live,
  readLog,
  held,
}: {
  threadId: string;
  held: string | null;
  row: ActivityRow;
  now: number;
  stale: boolean;
  expanded: boolean;
  onActivate?: () => void;
  live: boolean;
  readLog: typeof taskLog;
}) {
  const Glyph = GLYPH[row.kind];
  const [stopping, setStopping] = useState(false);
  const stop = (): void => {
    if (stopping) return;
    setStopping(true);
    stopActivity(row)
      .catch(() => loadToast().then((toast) => toast.error("Couldn't stop it", { description: row.label })))
      .finally(() => setStopping(false));
  };
  // A row that opens (a shell's log, a dev server's pane) is a plain
  // container with its open control laid over it and Stop beside it, so no
  // button holds a button (press.ts ROW_HOLDS).
  const opens = !!onActivate;
  const { ref: labelRef, cut } = useTruncated(row.label);
  const label = (
    <span ref={opens ? labelRef : undefined} className="block truncate text-[13px] leading-5 text-foreground">
      {row.label}
    </span>
  );
  // A computer row's tier sits 4px after the label, muted and a size down; the label gives way first.
  const words = row.tierWords ? (
    <span data-slot="activity-tier" className="ms-1 shrink-0 text-xs leading-5 text-muted-foreground">
      {row.tierWords}
    </span>
  ) : null;
  const item = (
    <Item size="xs" data-kind={row.kind} className={cn("min-h-7 flex-nowrap py-0", opens && ROW_HOLDS, expanded && "bg-muted hover:bg-muted")}>
      {opens ? (
        // Always the same tree, the tooltip off while the label fits.
        <Tooltip disabled={!cut}>
          <TooltipTrigger
            render={
              <ItemButton
                data-row-open
                aria-label={row.tierWords ? `${row.label}, ${row.tierWords}` : row.label}
                aria-expanded={row.open === "log" || row.open === "lines" ? expanded : undefined}
                onClick={onActivate}
                className={ROW_OPEN}
              />
            }
          />
          {cut ? <TooltipContent>{row.label}</TooltipContent> : null}
        </Tooltip>
      ) : null}
      <ItemMedia className={cn(opens && ROW_SHOWS)}>
        <Glyph className="size-3.5 text-muted-foreground" />
      </ItemMedia>
      <ItemContent className={cn("min-w-0", words && "flex-row items-baseline", opens && ROW_SHOWS)}>
        {opens ? label : <TruncateTip text={row.label}>{label}</TruncateTip>}
        {words}
      </ItemContent>
      <ItemActions className={cn("gap-1", opens && ROW_SHOWS)}>
        {now > 0 ? (
          <span className={cn("pointer-events-none text-xs leading-5 tabular-nums", stale ? "text-warning" : "text-muted-foreground")}>{minuteAge(now - row.since)}</span>
        ) : null}
        {row.stop && held ? (
          <HeldTip held={held} className="pointer-events-auto">
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Stop" disabled>
              <Square className="size-2.5 fill-current" />
            </Button>
          </HeldTip>
        ) : row.stop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="pointer-events-auto text-muted-foreground hover:text-foreground"
                  aria-label="Stop"
                  disabled={stopping}
                  onClick={stop}
                />
              }
            >
              <Square className="size-2.5 fill-current" />
            </TooltipTrigger>
            <TooltipContent>Stop</TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-6 shrink-0" aria-hidden="true" />
        )}
      </ItemActions>
    </Item>
  );
  if (row.open === "lines" && row.computer) {
    // In place, no fold animation: one status line.
    return (
      <div data-slot="computer-row">
        {item}
        {expanded ? <ComputerLines row={row.computer.row} /> : null}
      </div>
    );
  }
  if (row.open !== "log" || !row.taskId) return item;
  return (
    <Collapsible open={expanded}>
      {item}
      {/* The panel drops the log once its close has run, so the fold never
          closes an emptied box; the polling stops as the close starts. */}
      <CollapsibleContent>
        <TaskLogFold threadId={threadId} taskId={row.taskId} command={row.detail} live={live && expanded} readLog={readLog} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A task's command (when it says more than the label) and its live output, pinned to its end while the reader has not scrolled up. */
function TaskLogFold({ threadId, taskId, command, live, readLog }: { threadId: string; taskId: string; command?: string; live: boolean; readLog: typeof taskLog }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const next = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const ready = !!text;

  useEffect(() => {
    if (!live) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const log = await readLog(threadId, taskId, next.current);
        if (!alive) return;
        // Either source answers only what is new since `from`.
        next.current = log.next;
        setFailed(false);
        setText((prev) => ((prev ?? "") + log.data.replace(ANSI, "")).slice(-LOG_KEEP));
      } catch {
        // The host is out of reach or the read failed: say so, keep what was read.
        if (!alive) return;
        setFailed(true);
        setText((prev) => prev ?? "");
      }
      if (alive) timer = setTimeout(() => void poll(), LOG_POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [live, readLog, taskId, threadId]);

  useEffect(() => {
    const viewport = scroller.current;
    if (!viewport) return;
    const onScroll = (): void => {
      pinned.current = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [ready]);

  useEffect(() => {
    const viewport = scroller.current;
    if (viewport && pinned.current) viewport.scrollTop = viewport.scrollHeight;
  }, [text]);

  // One console: the command as its first line, then the output; while the
  // first read is out, the same console drawn from sample output, the command
  // in it as it is (it is known at once).
  const head = command ? (
    <span data-slot="task-command" className="block break-all">
      $ {command}
    </span>
  ) : null;
  return (
    <div className="px-2 pt-0.5 pb-2">
      <Region
        loading={text === null}
        label="Loading the output"
        bones={() => (
          <pre className={cn(CONSOLE, "break-words whitespace-pre-wrap")}>
            {head ? <span skullet-own="">{head}</span> : null}
            {SAMPLE_OUTPUT}
          </pre>
        )}
      >
        {text === null ? null : !text && !head ? (
          <p className="text-xs text-muted-foreground">{failed ? "Couldn't read the output" : "No output yet"}</p>
        ) : (
          <>
            <pre ref={scroller} tabIndex={0} data-slot="task-log" className={cn(CONSOLE, "max-h-60 overflow-x-hidden overflow-y-auto break-words whitespace-pre-wrap")}>
              {head}
              {text || <span className="font-sans">{failed ? "Couldn't read the output" : "No output yet"}</span>}
            </pre>
            {failed && text ? <p className="pt-1 text-xs text-muted-foreground">Couldn't read the output</p> : null}
          </>
        )}
      </Region>
    </div>
  );
}

/** Two lines of a task's output, for its console's bones. */
const SAMPLE_OUTPUT = "VITE v6.2.0 ready in 412 ms\nLocal: http://localhost:5173/";
