import { memo, useEffect, useRef, useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ItemButton } from "../../components/ui/item";
import { ROW_CONTROLS, ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { reveal, yields } from "../../components/ui/reveal";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import type { TodayAct, TodayRow } from "./types";

/**
 * The page's one row grid (docs/DESIGN.md "Today"): a 16px lead, the title
 * over an optional second line, the job (its dot and its name), then the
 * trailing fact. Every title on the page starts at one left edge.
 */
export const ROW_GRID = "grid grid-cols-[16px_minmax(0,1fr)_96px_80px] gap-x-3";
/** Where a title starts, for a line that is not a row (a fold, an empty line): the row's inset, the lead and the gap. */
export const TITLE_EDGE = "ps-10";

/** How long a ticked row holds so the tick reads, before its task completes (the Tasks view's own). */
export const TICK_HOLD_MS = 350;

/**
 * One row. The whole of it opens its thing; its tick and its verbs are its
 * own controls over that. The verbs show on hover and on focus, in place of
 * the job and the fact; none is drawn at rest. Memoised: a row redraws only
 * when its own facts change.
 */
export const TodayRowView = memo(function TodayRowView({ row, job }: { row: TodayRow; job: string | null }) {
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
  return (
    <div role="listitem" data-today-row={row.key} className={cn("group/row min-h-8 items-start rounded-md px-3 py-1.5", ROW_GRID, ROW_HOLDS)}>
      {/* The open control lies over the whole row, so the keyboard's ring is the row's; the tick and the verbs sit above it. */}
      <ItemButton data-row-open aria-label={row.detail ? `${row.title}, ${row.detail}` : row.title} onClick={row.open} className={ROW_OPEN} />
      <span className={cn("flex h-5 items-center justify-center", tick ? ROW_CONTROLS : ROW_SHOWS)}>
        {tick ? <Checkbox shape="round" checked={ticked} onCheckedChange={setTicked} aria-label={tick.label} /> : Glyph ? <Glyph className="size-3.5 text-muted-foreground" /> : null}
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
        <span className={cn("absolute top-1 right-2 flex items-center gap-1", reveal("row", { row: true, overlay: true }))}>
          {acts.map((act) => (
            <Verb key={act.label} act={act} />
          ))}
        </span>
      ) : null}
    </div>
  );
});

/** A row's verb: a ghost button that spins in place while its act runs. */
function Verb({ act }: { act: TodayAct }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={busy}
      onClick={() => {
        const done = act.run();
        if (!(done instanceof Promise)) return;
        setBusy(true);
        void done.catch(() => {}).finally(() => setBusy(false));
      }}
    >
      <BusyLabel busy={busy} label={act.label} />
    </Button>
  );
}
