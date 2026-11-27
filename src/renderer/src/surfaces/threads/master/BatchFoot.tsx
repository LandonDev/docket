import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { tallyRender } from "../../../lib/devRenders";
import { HeldTip } from "../../../components/heldTip";
import { registerToastAnchor } from "../../../lib/toastAnchor";
import type { BatchState } from "@server/shared/contract-batch";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent } from "../../../components/ui/collapsible";
import { DISCLOSURE_CHEVRON } from "../../../components/ui/disclosure";
import { Region } from "../../../components/bones";
import { StatusMark } from "../../../components/ui/status";
import { ChevronRight } from "../../../chrome/icons";
import { cn } from "../../../lib/cn";
import { useNow } from "../../../lib/duration";
import { RulesDialog } from "./RulesDialog";
import { consoleStep, liveSteps, nearBottom, stepDetail, stepState, stepTime, consoleLines, hasConsole, type LiveStep } from "./steps";
import { blockedLine, type Rules } from "./useMasterModel";
import { CONSOLE } from "../../../components/ui/console";

/**
 * Under the list, what happens when the threads are done (docs/LAYOUT.md
 * "Master"): a "When done" heading with Edit, one row per step the master
 * wrote, in order (its glyph, its name, what it is about, its time), and
 * a last line saying what happens then. The running step's console opens
 * under its own row, the same for a shell step (its first line is the
 * command) as for a publish, newest line at the bottom and following
 * until the person scrolls up, Stop on the row; a failed step's console
 * stays open with its last lines until Hide. The console folds through
 * `Collapsible`. Its text sits on the board's 12px inset. Until
 * `batch.board` answers the foot alone is a still skeleton of the same
 * shape (the rows above it paint from the store at once). Read from the
 * `batch` push; Edit writes `batch.setRules`, Stop `batch.stopStep` with
 * the step's id.
 */

const LOG_LINES = 200;

export function BatchFoot({
  batch,
  loaded = true,
  failed = false,
  onRetry,
  titleOf,
  hostName,
  onSave,
  onStop,
  held = null,
  toastAnchor = false,
  clock,
}: {
  batch: BatchState;
  /** False until the board's first answer: the foot is its skeleton. */
  loaded?: boolean;
  /** Every read of the batch failed, so its rules are not known: a red line with Retry, no steps and no Edit…. */
  failed?: boolean;
  onRetry?: () => Promise<void>;
  /** A child's title by id, for the blocked line. */
  titleOf: (id: string) => string | undefined;
  /** A host's name by id, for a blocked child out of reach on it. */
  hostName?: (environmentId: string) => string | undefined;
  /** Absent for a key that may not change the rules (batch.setRules): no Edit… (D5). */
  onSave?: (rules: Rules) => Promise<void>;
  /** Absent for a key that may not stop a step (batch.stopStep): no Stop (D5). */
  onStop?: (stepId: string) => Promise<void>;
  /** The master's host away (D5): Edit… and Stop are held, this their tooltip. */
  held?: string | null;
  /** The master's chat is folded: the toast stack sits above this foot, not over it. */
  toastAnchor?: boolean;
  /** A fixed instant for a preview of an in-flight step. */
  clock?: number;
}) {
  tallyRender("batchFoot");
  const rules = batch.rules;
  const [editing, setEditing] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const steps = liveSteps(batch);
  const active = consoleStep(steps, folded);
  const running = steps.some((s) => s.status === "running");
  // A step that runs again after a fold unfolds it.
  if (running && folded.size > 0) setFolded(new Set());
  const liveNow = useNow(running && clock === undefined);
  const now = clock ?? liveNow;
  const blocked = blockedLine(batch, titleOf, hostName);
  // One Stop and one fold for every row, so a row renders again only for
  // what it shows (a log line on the running step re-renders that row alone).
  const stopRef = useRef(onStop);
  useLayoutEffect(() => {
    stopRef.current = onStop;
  });
  const stopStep = useCallback((id: string) => stopRef.current?.(id) ?? Promise.resolve(), []);
  const fold = useCallback((id: string, hide: boolean) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return (
    <div
      ref={toastAnchor ? registerToastAnchor : undefined}
      // Never over three fifths of the board: past that its steps scroll inside, the heading, Edit… and the thread list stay in view.
      className="flex max-h-3/5 min-h-0 shrink-0 flex-col border-t border-border bg-background px-3 py-2"
      data-batch-foot
      data-foot-mode={!loaded ? "loading" : active ? "console" : "idle"}
    >
      <div className="flex h-6 shrink-0 items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">When done</h3>
        {/* The foot's trailing buttons end their word on the 12px edge the times keep (-me-2 takes the button's own 8px back). */}
        {loaded && onSave && !failed ? (
          <HeldTip held={held} className="-me-2">
            <Button variant="ghost" size="xs" className={held ? undefined : "-me-2"} disabled={!!held} onClick={() => setEditing(true)}>
              Edit…
            </Button>
          </HeldTip>
        ) : null}
      </div>
      {loaded && blocked ? (
        // The word and what blocks, two spans in the failed tone (DESIGN "Typography and text hierarchy"), never "Blocked: …".
        <StatusMark state="failed" glyph={false} word="Blocked" detail={blocked} className="flex shrink-0" data-blocked />
      ) : null}

      {/* The heading is known at once; the steps are the board's first answer. */}
      <Region loading={!loaded} label="Loading the batch rules" className="min-h-0" bones={() => <ol className="mt-1 flex flex-col">{SAMPLE_STEPS.map((step) => <StepRow key={step.id} step={step} detail={stepDetail(step, rules)} now={0} open={false} held={null} onFold={NOOP} />)}</ol>}>
        {!loaded ? null : failed ? (
          <RulesFailed onRetry={onRetry} />
        ) : (
          <>
            <ol className="mt-1 flex min-h-0 flex-col overflow-x-hidden overflow-y-auto" data-steps>
              {steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  detail={stepDetail(step, rules)}
                  now={step.status === "running" ? now : 0}
                  open={active?.id === step.id}
                  onStop={onStop ? stopStep : undefined}
                  held={held}
                  onFold={fold}
                />
              ))}
            </ol>

            <p className="mt-1 shrink-0 text-xs text-muted-foreground" data-then>
              {rules.then === "archive-children" ? "Then archive the threads" : "Then notify you"}
            </p>
          </>
        )}
      </Region>

      {editing && onSave ? <RulesDialog rules={rules} onClose={() => setEditing(false)} onSave={onSave} /> : null}
    </div>
  );
}

/** No read of the batch answered: its rules are not known, so no step is drawn from the defaults and Edit… waits.
 *  One red line with Retry (DESIGN "Loading and empty states"); Retry spins until its read settles. */
function RulesFailed({ onRetry }: { onRetry?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    if (busy || !onRetry) return;
    setBusy(true);
    void onRetry().finally(() => setBusy(false));
  };
  return (
    <div className="flex min-h-7 items-center gap-2" data-rules-failed>
      <span role="alert" className="min-w-0 flex-1 text-xs text-destructive">
        Couldn't load the batch rules
      </span>
      {onRetry ? (
        <Button variant="ghost" size="xs" className="-me-2 shrink-0" onClick={retry} disabled={busy} aria-busy={busy || undefined}>
          <BusyLabel busy={busy} label="Retry" />
        </Button>
      ) : null}
    </div>
  );
}

/** The foot's steps before the board's first answer: two waiting steps, at rest. */
const SAMPLE_STEPS: readonly LiveStep[] = [
  { id: "sample:merge", name: "Merge each branch", kind: "land", status: "pending", detail: "", log: [] },
  { id: "sample:gate", name: "Run the gate", kind: "gate", status: "pending", detail: "", log: [] },
];
const NOOP = () => {};

/** One step: its glyph, its name, what it is about, its time, and Stop
 *  while it runs (Hide or Show on a failed one); its console under it. */
type StepRowProps = {
  step: LiveStep;
  detail: ReturnType<typeof stepDetail>;
  /** The clock, for the running step alone; 0 for the rest. */
  now: number;
  open: boolean;
  onStop?: (id: string) => Promise<void>;
  held: string | null;
  onFold: (id: string, hide: boolean) => void;
};

/** A step's own facts, by value: the steps are rebuilt on every batch push. The log is bounded (200 lines), so it is read whole. */
function sameStep(a: LiveStep, b: LiveStep): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.kind === b.kind &&
      a.run === b.run &&
      a.status === b.status &&
      a.detail === b.detail &&
      a.startedAt === b.startedAt &&
      a.endedAt === b.endedAt &&
      JSON.stringify(a.progress) === JSON.stringify(b.progress) &&
      a.log.length === b.log.length &&
      a.log.every((line, i) => line === b.log[i]))
  );
}

const sameRow = (a: StepRowProps, b: StepRowProps): boolean =>
  a.now === b.now &&
  a.open === b.open &&
  a.onStop === b.onStop &&
  a.held === b.held &&
  a.onFold === b.onFold &&
  a.detail.text === b.detail.text &&
  a.detail.label === b.detail.label &&
  sameStep(a.step, b.step);

const StepRow = memo(function StepRow({ step, detail, now, open, onStop, held, onFold }: StepRowProps) {
  const time = stepTime(step, now);
  const quiet = step.status === "pending" || step.status === "skipped";
  const failed = step.status === "failed";
  const [stopping, setStopping] = useState(false);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop?.(step.id);
    } finally {
      setStopping(false);
    }
  };

  return (
    <li data-step={step.id} data-step-status={step.status}>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <StatusMark state={stepState(step.status)} word={false} />
        {/* The name, its detail and the time on one baseline, 4px apart. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className={cn("shrink-0 text-[13px] leading-5", quiet ? "text-muted-foreground" : "text-foreground")}>{step.name}</span>
          {/* A failure is said only here, so it wraps rather than being cut. */}
          <span className={cn("min-w-0 flex-1 text-xs", failed ? "py-1.5 break-words text-destructive" : "truncate text-muted-foreground")} data-step-detail>
            {detail.text || detail.label ? <span className="tabular-nums">{[detail.text, detail.label].filter(Boolean).join(", ")}</span> : null}
          </span>
          {time ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-step-time>
              {time}
            </span>
          ) : null}
        </span>
        {step.status === "running" && onStop ? (
          // The word alone, as every Stop; the spinner joins it in its reserved slot while the stop runs.
          <HeldTip held={held} className="-me-2">
            <Button variant="ghost" size="xs" className={held ? undefined : "-me-2"} onClick={() => void stop()} disabled={stopping || !!held} aria-busy={stopping || undefined}>
              <BusyLabel busy={stopping} label="Stop" />
            </Button>
          </HeldTip>
        ) : failed && hasConsole(step) ? (
          // One word whatever the state, so nothing moves under the pointer: the chevron says open or closed,
          // and the fill is its hover alone, never a pressed look while open (the one disclosure recipe).
          <Button
            variant="ghost"
            size="xs"
            className="-me-2 aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/7"
            onClick={() => onFold(step.id, open)}
            aria-expanded={open}
          >
            Log
            <ChevronRight className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
          </Button>
        ) : null}
      </div>
      <Collapsible open={open}>
        {/* The panel unmounts the console once its close has run, so the fold never collapses an empty box. */}
        <CollapsibleContent>
          <Console step={step} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}, sameRow);

/** A step's console lines, oldest first, following the newest while the
 *  person has not scrolled up. A failed step's failure is its row's detail,
 *  never repeated here. */
function Console({ step }: { step: LiveStep }) {
  const lines = consoleLines(step, LOG_LINES);
  const logRef = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    follow.current = true;
  }, [step.id]);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, step.id]);
  // A box that gets shorter (a shorter window) keeps its newest line in view too, unless he scrolled up.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <pre
      ref={logRef}
      onScroll={(e) => {
        follow.current = nearBottom(e.currentTarget);
      }}
      data-console={step.id}
      data-log
      tabIndex={0}
      className={cn(CONSOLE, "mb-1 ml-[22px] max-h-[min(11rem,20vh)] min-h-15 overflow-x-hidden overflow-y-auto whitespace-pre-wrap")}
    >
      {lines.length > 0 ? lines.join("\n") : "Starting…"}
    </pre>
  );
}
