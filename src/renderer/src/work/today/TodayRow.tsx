import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { ROW_CONTROLS, ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { reveal, yields } from "../../components/ui/reveal";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { glideHeight, stopGlide } from "../../lib/heightGlide";
import type { TodayAct, TodayRow } from "./types";

/**
 * The page's one row grid (docs/DESIGN.md "Today"): a 16px lead, the title
 * over an optional second line, the job (its dot and its name), then the
 * trailing fact. Every title on the page starts at one left edge. In a
 * column under 480px (the window at its least beside the rail and the Chats
 * column) the gaps and the two trailing tracks narrow together, so the
 * title keeps the room: `TODAY_COLUMN` names the container they measure.
 */
export const ROW_GRID = "grid grid-cols-[16px_minmax(0,1fr)_112px_80px] gap-x-3 @max-[30rem]/today:grid-cols-[16px_minmax(0,1fr)_64px_64px] @max-[30rem]/today:gap-x-2";
/** Where a title starts, for a line that is not a row (a fold, an empty line): the row's inset, the lead and the gap. */
export const TITLE_EDGE = "ps-10 @max-[30rem]/today:ps-9";
/** The page's column: the container the grid measures, and the inset that narrows with it. */
export const TODAY_COLUMN = "@container/today";
export const TODAY_INSET = "mx-auto w-full max-w-[720px] px-6 @max-[30rem]/today:px-3";
/** A row's place in its list: rows sit 2px apart, each carrying the gap under it, so a place that closes leaves nothing behind. */
export const ROW_SLOT = "pb-0.5";

/** How long a ticked row holds so the tick reads, before its task completes (the Tasks view's own). */
export const TICK_HOLD_MS = 350;

/** Where a row is on its way out by his own act: fading where it stands, then its place closing. */
export type RowPhase = "leaving" | "closing" | undefined;

/**
 * A row's place in its list. While the row leaves by his own act it fades
 * over `--dur-fast`, inert; then its place closes over `--dur-base` on
 * `--ease-out` (lib/heightGlide.ts), so the rows under it glide up by its
 * height. Under reduced motion the fade stays and the list steps. A row
 * that arrived while he was looking lands with `.step-land`.
 */
export const TodayRowSlot = memo(function TodayRowSlot({ row, job, phase, lands, current }: { row: TodayRow; job: string | null; phase: RowPhase; lands: boolean; current: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const drawn = useRef(0);
  const closing = phase === "closing";
  // The height the row is drawn at, kept while it stands.
  useLayoutEffect(() => {
    if (!closing && box.current) drawn.current = box.current.offsetHeight;
  });
  // The place closes from that height, once. A row that comes back mid-close (Undo, an act that failed) stands whole at once.
  useLayoutEffect(() => {
    if (!box.current) return;
    if (closing) glideHeight(box.current, "base", drawn.current);
    else stopGlide(box.current);
  }, [closing]);
  return (
    <div ref={box} data-today-slot={phase ?? "in"} inert={phase ? true : undefined} className={cn("overflow-hidden", closing ? "" : ROW_SLOT, lands && !phase && "step-land")}>
      {closing ? null : <TodayRowView row={row} job={job} leaving={phase === "leaving"} current={current} />}
    </div>
  );
});

/**
 * One row. The whole of it opens its thing; its tick and its verbs are its
 * own controls over that. The verbs show on hover and on focus, in place of
 * the job and the fact; none is drawn at rest. Space ticks a task from the
 * row. Memoised: a row redraws only when its own facts change.
 */
export const TodayRowView = memo(function TodayRowView({ row, job, leaving = false, current = false }: { row: TodayRow; job: string | null; leaving?: boolean; current?: boolean }) {
  const [ticked, setTicked] = useState(false);
  const lead = row.lead;
  const tick = lead?.kind === "tick" ? lead : null;
  const run = useRef(tick?.run);
  run.current = tick?.run;
  useEffect(() => {
    if (!ticked) return;
    // A tick that failed (its own toast says so) puts the row back as it was.
    const timer = window.setTimeout(() => void run.current?.().catch(() => setTicked(false)), TICK_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [ticked]);
  const acts = row.acts?.slice(0, 2) ?? [];
  const gives = acts.length > 0 ? yields("row") : "";
  const Glyph = lead?.kind === "glyph" ? lead.glyph : null;
  // One tab stop for the whole list: only the row the arrows are on takes Tab, and its own controls with it.
  const stop = current ? 0 : -1;
  return (
    <div
      role="listitem"
      data-today-row={row.key}
      className={cn(
        "group/row min-h-8 items-start rounded-md px-3 py-1.5",
        ROW_GRID,
        ROW_HOLDS,
        // The fade is the row's own: its exit is --dur-fast on --ease-out, kept under reduced motion.
        "transition-[background-color,opacity] motion-reduce:transition-opacity",
        leaving && "opacity-0 duration-(--dur-fast)",
      )}
    >
      {/* The open control lies over the whole row, so the keyboard's ring is the row's; the tick and the verbs sit above it. */}
      <ItemButton
        data-row-open
        data-roving-key={row.key}
        tabIndex={stop}
        aria-label={row.detail ? `${row.title}, ${row.detail}` : row.title}
        onClick={row.open}
        onKeyDown={
          tick
            ? (event) => {
                if (event.key !== " ") return;
                event.preventDefault();
                setTicked((was) => !was);
              }
            : undefined
        }
        // Space ticked the task on the way down: its release must not also open the row.
        onKeyUp={tick ? (event) => event.key === " " && event.preventDefault() : undefined}
        className={ROW_OPEN}
      />
      <span className={cn("flex h-5 items-center justify-center", tick ? ROW_CONTROLS : ROW_SHOWS)}>
        {tick ? <Checkbox shape="round" tabIndex={stop} checked={ticked} onCheckedChange={setTicked} aria-label={tick.label} /> : Glyph ? <Glyph className="size-3.5 text-muted-foreground" /> : null}
      </span>
      <span className={cn("flex min-w-0 flex-col", ROW_SHOWS)}>
        <span data-row-title className={cn("truncate text-[13px] leading-5 transition-colors duration-(--dur-fast) motion-reduce:transition-none", ticked ? "text-muted-foreground line-through" : row.past ? "text-muted-foreground" : "text-foreground")}>
          {row.title}
        </span>
        {row.detail ? <span className={cn("truncate text-xs leading-4", row.detailLate ? "text-destructive" : "text-muted-foreground")}>{row.detail}</span> : null}
      </span>
      <span className={cn("flex h-5 min-w-0 items-center gap-1 text-xs text-muted-foreground", ROW_SHOWS, gives)}>
        {job ? (
          <>
            <SectorDot sector={row.sector} className="-ms-1" />
            <span className="min-w-0 truncate">{job}</span>
          </>
        ) : null}
      </span>
      <span className={cn("flex min-w-0 flex-col items-end text-xs tabular-nums", ROW_SHOWS, gives)}>
        {row.when ? <span className={cn("leading-5 whitespace-nowrap", row.late ? "text-destructive" : "text-muted-foreground")}>{row.when}</span> : null}
        {row.whenLine ? <span className="leading-4 font-medium whitespace-nowrap text-foreground">{row.whenLine}</span> : null}
      </span>
      {acts.length > 0 ? (
        // The last verb's label ends on the facts' edge: the verb lands where the fact stood.
        <span className={cn("absolute top-1 right-1 flex items-center gap-1", reveal("row", { row: true, overlay: true }))}>
          {acts.map((act) => (
            <Verb key={act.label} act={act} tabIndex={stop} />
          ))}
        </span>
      ) : null}
    </div>
  );
});

/** A row's verb: a ghost button that spins in place while its act runs. */
function Verb({ act, tabIndex }: { act: TodayAct; tabIndex: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      tabIndex={tabIndex}
      disabled={busy}
      onClick={() => {
        const done = act.run();
        if (!(done instanceof Promise)) return;
        setBusy(true);
        void done.catch(() => {}).finally(() => setBusy(false));
      }}
    >
      <BusyLabel busy={busy} label={act.label} align="end" />
    </Button>
  );
}
