import { useState } from "react";
import { formatMoney } from "@shared/work/money";
import { factsOf, HOURS_NOTE, NOTHING_SEEN, totalMs, totalWords, type Comparison, type JobHours, type MergedJob } from "@shared/work/review";
import { ChevronRight } from "../../chrome/icons";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { PageError, PageSection } from "../../components/page";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";

/**
 * Hours: one row a job, every job, in the rail's order, since the job with
 * nothing is the news. A row is the job's dot and name, a bar and the total.
 * The bar is two parts on one scale shared by every job: calendar time
 * filled, desk time outlined and empty, so what was measured and what was
 * estimated differ by shape in both themes. The total says "about" whenever
 * any of it is the estimate (`totalWords`). A row opens to its three facts.
 */

/**
 * Name, bar, total, chevron: one grid for every row, so the bars share an edge and a scale. In a narrow window
 * (under 480px of page) there is no room for a bar that says anything: it goes, the name takes the width, and the
 * total, which says the same in words, stays.
 */
const ROW = "grid grid-cols-[1rem_minmax(0,9rem)_minmax(0,1fr)_8.25rem_0.75rem] items-center gap-x-2 gap-y-0 @max-[30rem]/page:grid-cols-[1rem_minmax(0,1fr)_auto_0.75rem]";

/** What a job's ledger took in and paid out in the week, in cents (Money's own sums). */
type JobMoney = { in: number; out: number };

export function Hours({
  jobs,
  hours,
  compare,
  money,
  left = [],
  opened,
}: {
  jobs: readonly MergedJob[];
  hours: readonly JobHours[];
  compare: readonly Comparison[];
  /** Money's sums by job; a job with none has no line */
  money?: ReadonlyMap<string, JobMoney>;
  /** the sources that did not answer, each one line */
  left?: readonly string[];
  /** a job whose row starts open (a preview's still picture of the facts) */
  opened?: string;
}) {
  const byJob = new Map(hours.map((h) => [h.job, h]));
  const scale = Math.max(1, ...hours.map(totalMs));
  return (
    <PageSection title="Hours">
      {left.map((line) => (
        <PageError key={line}>{line}</PageError>
      ))}
      {jobs.map((job) => (
        <HoursRow key={job.key} job={job} hours={byJob.get(job.key) ?? null} compare={compare.find((c) => c.job === job.key)?.words ?? null} money={money?.get(job.key) ?? null} scale={scale} startOpen={opened === job.key} />
      ))}
      <p className="pt-2 text-xs text-muted-foreground">{HOURS_NOTE}</p>
    </PageSection>
  );
}

function HoursRow({ job, hours, compare, money, scale, startOpen = false }: { job: MergedJob; hours: JobHours | null; compare: string | null; money: JobMoney | null; scale: number; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const total = hours ? totalWords(hours) : null;
  // The comparison is its own line under the row, from the name's edge across the bar's width: it is a sentence,
  // and the name's column is too narrow for one.
  const head = (
    <>
      <SectorDot sector={job.sector} />
      <span className="truncate text-[13px] leading-5 text-foreground">{job.name}</span>
    </>
  );
  const under = compare ? <span className="col-span-2 col-start-2 row-start-2 truncate text-xs leading-4 text-muted-foreground @max-[30rem]/page:whitespace-normal">{compare}</span> : null;
  // A job with nothing has no facts to open: its row is plain words.
  if ((!hours || !total) && !money) {
    return (
      <div data-review-job={job.key} data-starved className={cn(ROW, "min-h-8 py-1.5")}>
        {head}
        <span className="col-span-2 text-end text-[13px] leading-5 text-muted-foreground">{NOTHING_SEEN}</span>
        {under}
      </div>
    );
  }
  const facts = hours && total ? factsOf(hours) : null;
  const sums = money ? [money.in > 0 ? `${formatMoney(money.in)} in` : null, money.out > 0 ? `${formatMoney(money.out)} out` : null].filter((x): x is string => x !== null) : [];
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-review-job={job.key} data-starved={total ? undefined : ""}>
      <CollapsibleTrigger
        render={
          // The hover box reaches 8px past the words each side; the grid inside stays on the column.
          <ItemButton size="xs" className={cn(ROW, ROW_PRESS, "-mx-2 min-h-8 w-[calc(100%+1rem)] flex-nowrap rounded-md px-2 py-1.5")} />
        }
      >
        {head}
        {hours && total ? (
          <>
            <Bar calendarMs={hours.calendarMs} deskMs={hours.deskMs} scale={scale} />
            <span className="text-end text-[13px] leading-5 text-foreground tabular-nums">{total}</span>
          </>
        ) : (
          <span className="col-span-2 text-end text-[13px] leading-5 text-muted-foreground">{NOTHING_SEEN}</span>
        )}
        <ChevronRight aria-hidden className={cn("size-3 text-muted-foreground", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        {under}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 pb-2 ps-6 pt-1 text-xs leading-4">
          {facts ? (
            <>
              <Fact name="On the calendar" value={facts.calendar} detail={facts.calendarDetail} />
              {facts.desk ? <Fact name="At the desk" value={facts.desk} detail={facts.deskDetail ? `from ${facts.deskDetail}` : null} /> : null}
              {facts.ran ? <Fact name="Threads ran" value={facts.ran} detail="not counted in your hours" /> : null}
            </>
          ) : null}
          {/* Money owns every sum of money: these are its own, for the same days. */}
          {sums[0] ? <Fact name="Money" value={sums[0]} detail={sums[1] ?? null} /> : null}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One fact: its name muted, its value in the foreground, what it stands on muted after a comma. */
function Fact({ name, value, detail }: { name: string; value: string; detail: string | null }) {
  return (
    <>
      <dt className="whitespace-nowrap text-muted-foreground">{name}</dt>
      <dd className="min-w-0 text-muted-foreground">
        <span className="text-foreground tabular-nums">{value}</span>
        {detail ? `, ${detail}` : null}
      </dd>
    </>
  );
}

/**
 * The bar: calendar time filled, desk time an empty outline, on the scale
 * the longest job sets. Drawn for the eye alone: the total beside it and the
 * facts under it say the same in words.
 */
function Bar({ calendarMs, deskMs, scale }: { calendarMs: number; deskMs: number; scale: number }) {
  const share = (ms: number): string => `${Math.max(0, (ms / scale) * 100)}%`;
  return (
    <span aria-hidden data-review-bar className="flex h-2 min-w-0 items-stretch gap-0.5 @max-[30rem]/page:hidden">
      {calendarMs > 0 ? <span data-part="calendar" className="min-w-0.5 rounded-sm bg-muted-foreground" style={{ width: share(calendarMs) }} /> : null}
      {deskMs > 0 ? <span data-part="desk" className="min-w-0.5 rounded-sm border border-muted-foreground" style={{ width: share(deskMs) }} /> : null}
    </span>
  );
}

/** The section while the first host answers: rows in the shape of what is coming. */
export function HoursSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <PageSection title="Hours" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn(ROW, "h-8")}>
          <Skeleton className="mx-1 size-2 rounded-full" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-2 rounded-sm @max-[30rem]/page:hidden" style={{ width: `${[72, 38, 64, 30, 12, 22][i % 6]}%` }} />
          <Skeleton className="ms-auto h-3.5 w-16" />
        </div>
      ))}
    </PageSection>
  );
}
