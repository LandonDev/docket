import { useEffect, useRef, useState, type ReactNode } from "react";
import { dayWords, SHIPPED_SHOWN, shippedWords, type MergedJob, type MergedReview, type Placed, type ShippedRow } from "@shared/work/review";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { PageEmpty, PageError, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_PRESS } from "../../components/ui/press";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import type { Target } from "./go";

/**
 * Shipped: what went out in the week, a group a job, newest first, each row
 * led by what happened ("Sent Budget v2 to Dana Reyes") with its day at the
 * end. Five rows a job, then "Show all 23". A job with nothing is not listed
 * here: Hours already says so.
 */

/** The gutter holds a job's dot and nothing else: a heading's name and its rows' words share one edge. */
export const GUTTER = "ps-6";

export function JobHeading({ job }: { job: MergedJob }) {
  return (
    <h3 className="flex h-5 items-center gap-2 text-xs text-muted-foreground">
      <SectorDot sector={job.sector} />
      <span className="min-w-0 truncate">{job.name}</span>
    </h3>
  );
}

export const targetOf = (row: Pick<ShippedRow, "open">): Target | null => row.open;

/**
 * What an empty section says, always one muted line. "Nothing" only where every source of it answered; with LifeOS
 * out, that it is not known; else that some of it could not be read (the line over the sections says what).
 */
export function emptyWords(review: Pick<MergedReview, "lifeosFrom">, known: boolean, nothing: string): string {
  if (known) return nothing;
  return review.lifeosFrom ? "Some of it could not be read" : "Not known while LifeOS does not answer";
}

/**
 * An empty section's line. While a host is still answering, "nothing" is not known yet and nothing has failed: the
 * line waits as a bone of its own size (`PageEmpty`'s 40px), so the words land in place.
 */
export function EmptyLine({ review, known, nothing, pending }: { review: Pick<MergedReview, "lifeosFrom">; known: boolean; nothing: string; pending: boolean }) {
  if (pending && !known)
    return (
      <div aria-hidden data-review-pending className="flex h-10 items-center">
        <Skeleton className="h-3 w-28" />
      </div>
    );
  return <PageEmpty>{emptyWords(review, known, nothing)}</PageEmpty>;
}

/** A section's name as its heading holds it: a place the keyboard can be put (a row left, a retry cleared), with the app's own ring. */
export function Heading({ children }: { children: string }) {
  return (
    <span data-review-heading tabIndex={-1} className="focus-ring rounded-sm">
      {children}
    </span>
  );
}

/** The sources of one section alone that did not answer (Hours': threads, document history), a red line each; the page's one Retry rides the first when it is the first on the page. */
export function LeftLines({ lines, retry }: { lines: readonly string[]; retry?: ReactNode }) {
  return lines.map((line, i) => (
    <PageError key={line} action={i === 0 ? retry : undefined}>
      {line}
    </PageError>
  ));
}

export function Shipped({ review, pending = false, canOpen, onOpen }: { review: MergedReview; /** a linked host has not answered yet */ pending?: boolean; canOpen: (job: MergedJob, target: Target) => boolean; onOpen: (job: MergedJob, target: Target) => void }) {
  const groups = review.jobs.map((job) => ({ job, rows: review.shipped.filter((r) => r.job === job.key) })).filter((g) => g.rows.length > 0);
  return (
    <PageSection title={<Heading>Shipped</Heading>}>
      {groups.length === 0 ? (
        <EmptyLine review={review} known={review.known.shipped} nothing="Nothing went out" pending={pending} />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ job, rows }) => (
            <ShippedGroup key={job.key} job={job} rows={rows} review={review} canOpen={canOpen} onOpen={onOpen} />
          ))}
        </div>
      )}
    </PageSection>
  );
}

function ShippedGroup({ job, rows, review, canOpen, onOpen }: { job: MergedJob; rows: readonly Placed<ShippedRow>[]; review: MergedReview; canOpen: (job: MergedJob, target: Target) => boolean; onOpen: (job: MergedJob, target: Target) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHIPPED_SHOWN);
  // "Show all" goes once pressed, and the rows it brought sit before it: the keyboard carries on from the first of them.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (all) list.current?.querySelectorAll<HTMLElement>("[data-review-shipped-row]")[SHIPPED_SHOWN]?.focus();
  }, [all]);
  return (
    <div data-review-shipped={job.key}>
      <JobHeading job={job} />
      <div ref={list} className="mt-1 flex flex-col">
        {shown.map((row) => {
          const words = shippedWords(row);
          const target = targetOf(row);
          const cells = (
            <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground @max-[30rem]/page:[overflow-wrap:anywhere] @max-[30rem]/page:whitespace-normal">
                {words.lead}
                <span className="text-foreground">{words.title}</span>
                {words.tail}
              </span>
              <time className="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{dayWords(row.at, review, review.tz)}</time>
            </>
          );
          // No border: Item's own would set the words a pixel in from the heading's. A narrow page lets the sentence
          // wrap beside its day, which keeps the first line.
          const box = "-mx-2 h-7 w-[calc(100%+1rem)] flex-nowrap gap-2 rounded-md border-0 py-0 ps-8 pe-2 text-[13px] leading-5 @max-[30rem]/page:h-auto @max-[30rem]/page:min-h-7 @max-[30rem]/page:items-start @max-[30rem]/page:py-1";
          return target && canOpen(job, target) ? (
            <ItemButton key={row.key} data-review-shipped-row size="xs" className={cn(box, ROW_PRESS)} onClick={() => onOpen(job, target)}>
              {cells}
            </ItemButton>
          ) : (
            <Item key={row.key} data-review-shipped-row tabIndex={-1} size="xs" className={box}>
              {cells}
            </Item>
          );
        })}
      </div>
      {rows.length > SHIPPED_SHOWN && !all ? (
        // The button's own 8px inset puts its words on the rows' edge.
        <Button variant="ghost" size="xs" className="ms-4 mt-1 text-muted-foreground" aria-label={`Show all ${rows.length} shipped in ${job.name}`} onClick={() => setAll(true)}>
          Show all {rows.length}
        </Button>
      ) : null}
    </div>
  );
}

/** A section of grouped rows while the first host answers. `tall`: Slipped's rows, 32px with nothing at their end. */
export function RowsSkeleton({ title, groups = 2, rows = 3, tall = false }: { title: string; groups?: number; rows?: number; tall?: boolean }) {
  return (
    <PageSection title={title} aria-hidden>
      <div className="flex flex-col gap-4">
        {Array.from({ length: groups }, (_, g) => (
          <div key={g}>
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="mx-1 size-2 rounded-full" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="mt-1 flex flex-col">
              {Array.from({ length: rows }, (_, r) => (
                // A narrow page sets a slipped title over its detail: 48px, two bones.
                <div key={r} className={cn("flex items-center gap-2", GUTTER, tall ? "h-8 @max-[30rem]/page:h-12 @max-[30rem]/page:flex-col @max-[30rem]/page:items-start @max-[30rem]/page:justify-center @max-[30rem]/page:gap-1.5" : "h-7")}>
                  <Skeleton className="h-3.5" style={{ width: `${[58, 44, 66, 36][(g + r) % 4]}%` }} />
                  {tall ? <Skeleton className="hidden h-3 w-24 @max-[30rem]/page:block" /> : <Skeleton className="ms-auto h-3 w-8" />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageSection>
  );
}
