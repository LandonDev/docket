import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SETTLE_HOWS, SETTLE_WORDS, slippedDetail, splitOlder, type MergedJob, type MergedReview, type Placed, type SettleHow, type SlippedRow } from "@shared/work/review";
import { ChevronRight } from "../../chrome/icons";
import { PageSection } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import type { Target } from "./go";
import { EmptyLine, Heading, JobHeading } from "./Shipped";

/**
 * Slipped: what is still open, a group a job. A row is the thing's own
 * title and one muted detail; on hover or keyboard focus it shows its three
 * presses: do it now, move it to next week, or drop it, each named for what
 * it does to that kind of thing. A press that landed makes the row leave.
 * Tasks due before the week fold behind "12 older"; rows of a kept week that
 * were dealt with since sit under their own fold, with no presses.
 */

export const slippedTarget = (row: Pick<SlippedRow, "ref">): Target =>
  row.ref.kind === "task" ? { at: "task", id: row.ref.id } : row.ref.kind === "mail" ? { at: "mail", threadId: row.ref.threadId } : row.ref.kind === "held" ? { at: "held", ref: row.ref.ref } : { at: "meeting", eventId: row.ref.eventId };

type Press = (job: MergedJob, row: Placed<SlippedRow>, how: SettleHow) => Promise<void> | void;

/** How a height and an opacity ease when something leaves or takes its place. */
const EASES = "duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none";

export function Slipped({
  review,
  pending = false,
  gone,
  canOpen,
  onOpen,
  onPress,
  peek,
}: {
  review: MergedReview;
  /** a linked host has not answered yet: an empty list waits, and claims nothing */
  pending?: boolean;
  /** a still picture's seams (the preview): a row whose presses show as on hover, and the folds open */
  peek?: { verbs?: string; folds?: boolean };
  /** rows a press just settled: they leave, and stay away until the week is read again */
  gone: ReadonlySet<string>;
  canOpen: (job: MergedJob, target: Target) => boolean;
  onOpen: (job: MergedJob, target: Target) => void;
  onPress: Press;
}) {
  const open = review.slipped.filter((r) => r.open);
  const dealt = review.slipped.filter((r) => !r.open);
  const here = (rows: readonly Placed<SlippedRow>[]): number => rows.filter((r) => !gone.has(r.key)).length;
  const groups = review.jobs.map((job) => ({ job, ...splitOlder(open.filter((r) => r.job === job.key), review) })).filter((g) => g.lead.length + g.older.length > 0);
  const remaining = here(open);
  const empty = remaining === 0;
  const row = (job: MergedJob, r: Placed<SlippedRow>) => <SlippedRowView key={r.key} job={job} row={r} review={review} gone={gone.has(r.key)} canOpen={canOpen} onOpen={onOpen} onPress={onPress} shown={peek?.verbs === r.key} />;
  return (
    <PageSection title={<Heading>Slipped</Heading>}>
      {groups.length > 0 ? (
        <div className="flex flex-col">
          {groups.map(({ job, lead, older }, i) => {
            const olderHere = here(older);
            // 16px over a group only while a group stands before it, and inside what collapses: a group that left leaves no gap.
            const spaced = groups.slice(0, i).some((g) => here(g.lead) + here(g.older) > 0);
            return (
              <Leaving key={job.key} gone={here(lead) + olderHere === 0}>
                <div data-review-slipped={job.key} className={cn("transition-[padding-top]", EASES, spaced ? "pt-4" : "pt-0")}>
                  <JobHeading job={job} />
                  <div className="mt-1 flex flex-col">{lead.map((r) => row(job, r))}</div>
                  {older.length > 0 ? (
                    // The fold counts what is still behind it, and goes with its last row.
                    <Leaving gone={olderHere === 0}>
                      <Fold label={`${Math.max(1, olderHere)} older`} startOpen={peek?.folds}>
                        {older.map((r) => row(job, r))}
                      </Fold>
                    </Leaving>
                  ) : null}
                </div>
              </Leaving>
            );
          })}
        </div>
      ) : null}
      {/* After the groups: the line takes the place of the last one as it leaves. */}
      {empty ? (
        <div data-review-empty className={cn("grid grid-rows-[1fr]", groups.length > 0 ? ["transition-[grid-template-rows,opacity] starting:grid-rows-[0fr] starting:opacity-0", EASES] : null)}>
          <div className="min-h-0 overflow-hidden">
            <EmptyLine review={review} known={review.known.slipped} nothing="Nothing slipped" pending={pending} />
          </div>
        </div>
      ) : null}
      {dealt.length > 0 ? (
        <div className={cn(groups.length > 0 || empty ? "mt-4" : null)}>
          <Fold label={`${dealt.length} dealt with since`} flush startOpen={peek?.folds}>
            {dealt.map((r) => (
              <Item key={r.key} size="xs" data-review-dealt={r.key} className="h-8 flex-nowrap gap-1 border-0 px-0 py-0 text-[13px] leading-5 text-muted-foreground @max-[30rem]/page:h-auto @max-[30rem]/page:min-h-8 @max-[30rem]/page:py-1.5">
                <span className={cn("min-w-0 truncate", WRAPS)}>{r.title}</span>
              </Item>
            ))}
          </Fold>
        </div>
      ) : null}
    </PageSection>
  );
}

/**
 * A fold of rows under one muted line, laid out as a job's heading is: its chevron in the gutter, its words on the
 * rows' edge, the count first ("3 older", "2 dealt with since"). The line lifts to the foreground on hover; only
 * the chevron's turn animates.
 */
function Fold({ label, flush = false, startOpen = false, children }: { label: string; flush?: boolean; startOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="focus-ring flex h-6 items-center rounded-sm text-xs text-muted-foreground hover:text-foreground">
        <span className="grid size-4 place-items-center">
          <ChevronRight aria-hidden className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        </span>
        <span className="ms-2 tabular-nums">{label}</span>
      </CollapsibleTrigger>
      {/* The panel clips, as `Leaving` does: at the rows' hover box, so a row behind the fold keeps its whole fill and ring. */}
      <CollapsibleContent className="-mx-2 px-2">
        <div className={cn("flex flex-col", flush ? "ps-6" : null)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * What a settled row or an emptied group does: it leaves, its height and
 * opacity easing out over `--dur-base`, and takes no pointer or focus on the
 * way. With reduced motion it is simply gone. The clip is the rows' hover
 * box, 8px past the column each side, so a row's fill and its focus ring
 * are whole.
 */
function Leaving({ gone, children }: { gone: boolean; children: ReactNode }) {
  return (
    <div data-leaving={gone ? "" : undefined} inert={gone || undefined} className={cn("grid transition-[grid-template-rows,opacity]", EASES, gone ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}>
      <div className="-mx-2 min-h-0 overflow-hidden px-2">{children}</div>
    </div>
  );
}

/** Focus is nowhere, or still inside a row that can no longer hold it. */
const lostFocus = (row: HTMLElement | null): boolean => {
  const at = document.activeElement;
  return !at || at === document.body || !!row?.contains(at);
};

/** A row that left hands the keyboard on: to the row after it, else the one before, else the section's heading. */
function focusNear(row: HTMLElement | null): void {
  const section = row?.closest<HTMLElement>("[data-slot=page-section]");
  if (!row || !section) return;
  const rows = [...section.querySelectorAll<HTMLElement>("[data-review-row]")];
  const at = rows.indexOf(row);
  // A row's opener, else its first verb that is on (a meeting with no workspace here has neither an opener nor Follow up).
  const hold = (r: HTMLElement): HTMLElement | null => (r === row || r.closest("[inert]") ? null : r.querySelector<HTMLElement>("[data-row-open]:not(:disabled), button:not(:disabled)"));
  const target =
    rows
      .slice(at + 1)
      .map(hold)
      .find((el) => el !== null) ??
    rows
      .slice(0, at)
      .reverse()
      .map(hold)
      .find((el) => el !== null) ??
    section.querySelector<HTMLElement>("[data-review-heading]");
  target?.focus();
}

/**
 * The verbs' leading edge: the words under them fade into the row's fill over 24px (the fill is the foreground at 5%
 * on the page), so a title or a detail is never cut mid-letter.
 */
/** On a narrow page a line wraps, a long word too: nothing a row says is cut where there is no room to open it. */
const WRAPS = "@max-[30rem]/page:[overflow-wrap:anywhere] @max-[30rem]/page:whitespace-normal";

const FADES = "before:pointer-events-none before:absolute before:inset-y-0 before:end-full before:w-6 before:bg-linear-to-r before:from-transparent before:to-[color-mix(in_srgb,var(--foreground)_5%,var(--background))]";

function SlippedRowView({ job, row, review, gone, canOpen, onOpen, onPress, shown = false }: { job: MergedJob; row: Placed<SlippedRow>; review: MergedReview; gone: boolean; canOpen: (job: MergedJob, target: Target) => boolean; onOpen: (job: MergedJob, target: Target) => void; onPress: Press; shown?: boolean }) {
  const [busy, setBusy] = useState<SettleHow | null>(null);
  const box = useRef<HTMLDivElement>(null);
  /** the verb a press came from, when the keyboard was in the row: its place is kept, or handed on */
  const from = useRef<HTMLElement | null>(null);
  const target = slippedTarget(row);
  const opens = canOpen(job, target);
  const words = SETTLE_WORDS[row.ref.kind];
  // A follow-up and a nudge start in the job's workspace: with none this window can open, the verb is off, not a
  // press that does nothing or one a host refuses.
  const nowhere = (row.ref.kind === "meeting" || row.ref.kind === "mail") && !opens;
  // A row that stands as last known (its source did not answer this time) waits: its presses would act on what
  // nobody could check. A held item's Open only shows it in the Outbox, so it stays.
  const waits = (how: SettleHow): boolean => !!row.unchecked && !(row.ref.kind === "held" && how === "now");
  const press = (how: SettleHow, verb: HTMLElement): void => {
    if (busy) return;
    from.current = box.current?.contains(document.activeElement) ? verb : null;
    setBusy(how);
    void Promise.resolve(onPress(job, row, how)).finally(() => setBusy(null));
  };
  // The row left under the keyboard: the next row takes it.
  useLayoutEffect(() => {
    if (!gone || !from.current) return;
    from.current = null;
    if (lostFocus(box.current)) focusNear(box.current);
  }, [gone]);
  // The verbs are off while the host works, which drops the keyboard's place: a press that left the row standing gives it back.
  useEffect(() => {
    if (busy !== null || gone || !from.current) return;
    const verb = from.current;
    from.current = null;
    if (lostFocus(box.current)) verb.focus();
  }, [busy, gone]);
  return (
    <Leaving gone={gone}>
      {/* The hover box reaches 8px past the column each side; the words keep the rows' edge, 24px in. A narrow page sets the title over the detail. */}
      <div
        ref={box}
        data-review-row={row.key}
        className={cn(
          "group/row -mx-2 flex h-8 w-[calc(100%+1rem)] items-center rounded-md ps-8 pe-2 text-[13px] leading-5 @max-[30rem]/page:h-auto @max-[30rem]/page:min-h-12 @max-[30rem]/page:pt-1 @max-[30rem]/page:pb-1.5",
          opens ? ROW_HOLDS : "relative hover:bg-foreground/5",
          // The row's fill wherever its verbs show: under the keyboard and through a wait, not under the pointer alone.
          "has-focus-visible:bg-foreground/5",
          shown || busy !== null ? "bg-foreground/5" : null,
        )}
      >
        {opens ? <ItemButton data-row-open aria-label={`Open ${row.title}`} className={ROW_OPEN} onClick={() => onOpen(job, target)} /> : null}
        {/* The title whole wherever it fits beside a few words of detail; short of room the detail gives way first. A grid, not a flex row: a flex row shaves a hair off the title and it gains an ellipsis it does not need. */}
        <span className={cn("grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)_minmax(4rem,1fr)] items-baseline gap-x-1 @max-[30rem]/page:grid-cols-1", ROW_SHOWS)}>
          <span className={cn("truncate text-foreground", WRAPS)}>{row.title}</span>
          {/* Under its title the detail is the next size down, 2px under it. */}
          <span className={cn("truncate text-muted-foreground @max-[30rem]/page:mt-0.5 @max-[30rem]/page:text-xs @max-[30rem]/page:leading-4", WRAPS)}>{slippedDetail(row, review, review.tz)}</span>
        </span>
        {/*
          Over the row's end, on the row's own fill, so the words under them never show through; 2px inside the row,
          so the row's focus ring is whole round them. On a narrow page over the detail's last line alone, and the
          title stays whole. They stay while the host works, whatever became of the pointer and the focus: the
          spinner is the only sign of the wait.
        */}
        <span
          className={cn(
            "absolute inset-y-0.5 end-0.5 flex items-center rounded-e-sm bg-background @max-[30rem]/page:top-auto @max-[30rem]/page:bottom-0.5 @max-[30rem]/page:h-6",
            FADES,
            shown || busy !== null ? null : reveal("row", { row: true, overlay: true }),
          )}
        >
          <span className="flex h-full items-center gap-0.5 rounded-e-sm bg-foreground/5 ps-2 pe-0.5">
            {SETTLE_HOWS.map((how) => (
              // 4px of inset: the label holds its spinner's place at rest (`BusyLabel`), which is the rest of a verb's room.
              <Button key={how} variant="ghost" size="xs" className="px-1" aria-label={`${words[how]}: ${row.title}`} disabled={busy !== null || (how === "now" && nowhere) || waits(how)} onClick={(event) => press(how, event.currentTarget)}>
                <BusyLabel busy={busy === how} label={words[how]} />
              </Button>
            ))}
          </span>
        </span>
      </div>
    </Leaving>
  );
}
