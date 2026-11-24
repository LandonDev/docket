import { useState, type ReactNode } from "react";
import { formatMoney } from "@shared/work/money";
import { CALENDAR_NOTE, DESK_NOTE, factsOf, nothingWords, toQuarter, totalWords, type Comparison, type JobHours, type MergedJob } from "@shared/work/review";
import { ChevronRight } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { PageSection } from "../../components/page";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { Heading, LeftLines } from "./Shipped";
import { Facts } from "../../surfaces/settings/hosts/Facts";

/**
 * Hours: one row a job, every job, in the rail's order, since the job with
 * nothing is the news. A row is the job's dot and name, a bar and the total.
 * The bar is two parts on one scale shared by every job: calendar time
 * filled, desk time outlined and empty, so what was measured and what was
 * estimated differ by shape in both themes. The total says "about" whenever
 * any of it is the estimate (`totalWords`). A row opens to its three facts.
 * The section's closing line is the bar's key: each shape before the
 * sentence that says what it is.
 */

/**
 * Name, bar, total, chevron: one grid for every row, so the bars share an edge and a scale. In a narrow window
 * (under 480px of page) there is no room for a bar that says anything: it goes, the name takes the width, and the
 * total, which says the same in words, stays.
 */
const ROW = "grid grid-cols-[1rem_minmax(0,9rem)_minmax(0,1fr)_8.25rem_0.75rem] items-center gap-x-2 gap-y-0 @max-[30rem]/page:grid-cols-[1rem_minmax(0,1fr)_auto_0.75rem]";

/** A bar's part as the closing line shows it: a 12px piece of the bar, its height and its corner (a square would draw as a dot, and read as a bullet). */
const KEY = "h-2 w-3 shrink-0 rounded-sm @max-[30rem]/page:hidden";
const WHOLE = { calendar: true, calendarCounted: true, desk: true };
/** "Nothing seen", in the bar's and the total's place; a narrow page has no bar column, so it keeps to the total's. */
const NOTHING = "col-span-2 text-end text-[13px] leading-5 text-muted-foreground @max-[30rem]/page:col-span-1";

/** What a job's ledger took in and paid out in the week, in cents (Money's own sums). */
type JobMoney = { in: number; out: number };

export function Hours({
  jobs,
  hours,
  compare,
  money,
  known = WHOLE,
  pending = false,
  left = [],
  retry,
  opened,
}: {
  jobs: readonly MergedJob[];
  hours: readonly JobHours[];
  compare: readonly Comparison[];
  /** Money's sums by job; a job with none has no line */
  money?: ReadonlyMap<string, JobMoney>;
  /** what was read: a job with no hours says "nothing" only of that, and no calendar fact is stated with the calendar unread */
  known?: { calendar: boolean; calendarCounted: boolean; desk: boolean };
  /** a linked host has not answered yet: a job with no hours so far waits, and claims nothing */
  pending?: boolean;
  /** the sources that did not answer, each one line */
  left?: readonly string[];
  /** the page's one Retry, when this section's line is the first red line on the page */
  retry?: ReactNode;
  /** a job whose row starts open (a preview's still picture of the facts) */
  opened?: string;
}) {
  const byJob = new Map(hours.map((h) => [h.job, h]));
  // The bar draws desk time as the words say it, to the quarter hour, so the scale is cut from the same sums.
  const scale = Math.max(1, ...hours.map((h) => h.calendarMs + toQuarter(h.deskMs)));
  return (
    <PageSection title={<Heading>Hours</Heading>}>
      <LeftLines lines={left} retry={retry} />
      {jobs.map((job) => (
        <HoursRow key={job.key} job={job} hours={byJob.get(job.key) ?? null} compare={compare.find((c) => c.job === job.key)?.words ?? null} money={money?.get(job.key) ?? null} scale={scale} known={known} pending={pending} startOpen={opened === job.key} />
      ))}
      {/* The bar's key. A narrow page draws no bar, so the shapes go and the two sentences run on. */}
      <p className="flex flex-wrap gap-x-3 pt-2 text-xs text-muted-foreground @max-[30rem]/page:block">
        {known.calendarCounted ? (
          <span className="inline-flex items-center gap-1 @max-[30rem]/page:inline">
            <span aria-hidden className={cn(KEY, "bg-muted-foreground")} />
            {CALENDAR_NOTE}{" "}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 @max-[30rem]/page:inline">
          <span aria-hidden className={cn(KEY, "border border-muted-foreground")} />
          {DESK_NOTE}
        </span>
      </p>
    </PageSection>
  );
}

function HoursRow({ job, hours, compare, money, scale, known, pending, startOpen = false }: { job: MergedJob; hours: JobHours | null; compare: string | null; money: JobMoney | null; scale: number; known: { calendar: boolean; calendarCounted: boolean; desk: boolean }; pending: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const total = hours ? totalWords(hours) : null;
  // While a host is still answering, what desk time stands on is not all in and nothing has failed: the words wait as a bone.
  const nothing = pending && !known.desk ? <Skeleton aria-hidden data-review-pending className="ms-auto h-3.5 w-16" /> : nothingWords(known);
  const facts = hours ? factsOf(hours) : null;
  // The comparison is its own line under the row, from the name's edge across the bar's width: it is a sentence,
  // and the name's column is too narrow for one.
  const head = (
    <>
      <SectorDot sector={job.sector} />
      {/* A narrow page has no bar, and a long status beside the name: the name wraps there, whole. */}
      <span className="truncate text-[13px] leading-5 text-foreground @max-[30rem]/page:[overflow-wrap:anywhere] @max-[30rem]/page:whitespace-normal">{job.name}</span>
    </>
  );
  const under = compare ? <span className="col-span-2 col-start-2 row-start-2 truncate text-xs leading-4 text-muted-foreground @max-[30rem]/page:whitespace-normal">{compare}</span> : null;
  // A job with nothing has no facts to open: its row is plain words. Threads that ran with none of his own time
  // are still a fact, so such a row opens to it.
  if (!total && !facts?.ran && !money) {
    return (
      <div data-review-job={job.key} data-starved className={cn(ROW, "min-h-8 py-1.5")}>
        {head}
        <span className={NOTHING}>{nothing}</span>
        {under}
      </div>
    );
  }
  const sums = money ? [money.in > 0 ? `${formatMoney(money.in)} in` : null, money.out > 0 ? `${formatMoney(money.out)} out` : null].filter((x): x is string => x !== null) : [];
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-review-job={job.key} data-starved={total ? undefined : ""}>
      <CollapsibleTrigger
        render={
          // The hover box reaches 8px past the words each side; the grid inside stays on the column (no border: Item's
          // own would set the row a pixel in and two taller than the plain rows beside it).
          <ItemButton size="xs" className={cn(ROW, ROW_PRESS, "-mx-2 min-h-8 w-[calc(100%+1rem)] flex-nowrap rounded-md border-0 px-2 py-1.5")} />
        }
      >
        {head}
        {hours && total ? (
          <>
            <Bar calendarMs={hours.calendarMs} deskMs={hours.deskMs} scale={scale} />
            <span className="text-end text-[13px] leading-5 text-foreground tabular-nums">{total}</span>
          </>
        ) : (
          <span className={NOTHING}>{nothing}</span>
        )}
        <ChevronRight aria-hidden className={cn("size-3 text-muted-foreground", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        {under}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* On the row's own grid: a fact's name under the job's, its value from the bar's edge. A narrow page sets the name over the value. */}
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-2 gap-y-1 pb-2 ps-6 pt-1 text-xs leading-4 @max-[30rem]/page:grid-cols-1">
          {/* With the calendar unread there is no calendar fact to state, not "Nothing": a calendar counted only part of the span states its time, never its "Nothing". A job with none of his own time states neither of his. */}
          {facts && total && known.calendarCounted && (known.calendar || hours!.calendarMs > 0) ? <Fact name="On the calendar" values={[facts.calendar]} details={facts.calendarDetail ? [facts.calendarDetail] : []} /> : null}
          {facts?.desk ? <Fact name="At the desk" values={[facts.desk]} details={facts.deskDetail ? `from ${facts.deskDetail}`.split(", ") : []} /> : null}
          {facts?.ran ? <Fact name="Threads ran" values={[facts.ran]} details={["not counted in your hours"]} /> : null}
          {/* Money owns every sum of money: these are its own, for the same days. */}
          {sums.length > 0 ? <Fact name="Money" values={sums} /> : null}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One fact: its name muted, its values in the foreground, what they stand on muted after a comma. A line breaks only between facts (`Facts`). */
function Fact({ name, values, details = [] }: { name: string; values: readonly string[]; details?: readonly string[] }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-muted-foreground @max-[30rem]/page:pb-1">
        <Facts
          parts={[
            ...values.map((value) => (
              <span key={value} className="text-foreground">
                {value}
              </span>
            )),
            ...details,
          ]}
        />
      </dd>
    </>
  );
}

/**
 * The bar: calendar time filled, desk time an empty outline, on the scale
 * the longest job sets. Drawn for the eye alone: the total beside it and the
 * facts under it say the same in words, so the outline is sized by the
 * estimate as the words round it (`toQuarter`), and a part is never under
 * 12px, the key's own piece: shorter, with the bar's round ends, it draws as
 * a dot or a ring beside the job's own dot.
 */
function Bar({ calendarMs, deskMs, scale }: { calendarMs: number; deskMs: number; scale: number }) {
  const share = (ms: number): string => `${Math.max(0, (ms / scale) * 100)}%`;
  return (
    <span aria-hidden data-review-bar className="flex h-2 min-w-0 items-stretch gap-0.5 @max-[30rem]/page:hidden">
      {calendarMs > 0 ? <span data-part="calendar" className="min-w-3 rounded-sm bg-muted-foreground" style={{ width: share(calendarMs) }} /> : null}
      {deskMs > 0 ? <span data-part="desk" className="min-w-3 rounded-sm border border-muted-foreground" style={{ width: share(toQuarter(deskMs)) }} /> : null}
    </span>
  );
}

/** The section while the first host answers: rows in the shape of what is coming. */
export function HoursSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <PageSection title="Hours" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn(ROW, "h-8")}>
          <Skeleton className="mx-1 size-2 rounded-full" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-2 rounded-sm @max-[30rem]/page:hidden" style={{ width: `${[72, 38, 64, 30, 12, 22][i % 6]}%` }} />
          <Skeleton className="ms-auto h-3.5 w-16" />
        </div>
      ))}
      {/* The closing line's place, so nothing under the section moves when the week lands: one line, two on a narrow page. */}
      <div className="flex flex-col pt-2">
        <span className="flex h-4 items-center">
          <Skeleton className="h-3 w-96 max-w-full" />
        </span>
        <span className="hidden h-4 items-center @max-[30rem]/page:flex">
          <Skeleton className="h-3 w-48" />
        </span>
      </div>
    </PageSection>
  );
}
