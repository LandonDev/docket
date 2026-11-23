import { useState } from "react";
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

export function Shipped({ review, known, left = [], canOpen, onOpen }: { review: MergedReview; /** LifeOS answered: an empty list is known to be empty */ known: boolean; left?: readonly string[]; canOpen: (job: MergedJob, target: Target) => boolean; onOpen: (job: MergedJob, target: Target) => void }) {
  const groups = review.jobs.map((job) => ({ job, rows: review.shipped.filter((r) => r.job === job.key) })).filter((g) => g.rows.length > 0);
  return (
    <PageSection title="Shipped">
      {left.map((line) => (
        <PageError key={line}>{line}</PageError>
      ))}
      {groups.length === 0 ? (
        <PageEmpty>{known ? "Nothing went out this week" : "Not known while LifeOS does not answer"}</PageEmpty>
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
  return (
    <div data-review-shipped={job.key}>
      <JobHeading job={job} />
      <div className="mt-1 flex flex-col">
        {shown.map((row) => {
          const words = shippedWords(row);
          const target = targetOf(row);
          const cells = (
            <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {words.lead}
                <span className="text-foreground">{words.title}</span>
                {words.tail}
              </span>
              <time className="shrink-0 text-xs text-muted-foreground tabular-nums">{dayWords(row.at, review, review.tz)}</time>
            </>
          );
          const box = cn("-mx-2 h-7 w-[calc(100%+1rem)] flex-nowrap gap-2 rounded-md py-0 pe-2 text-[13px] leading-5", "ps-8");
          return target && canOpen(job, target) ? (
            <ItemButton key={row.key} size="xs" className={cn(box, ROW_PRESS)} onClick={() => onOpen(job, target)}>
              {cells}
            </ItemButton>
          ) : (
            <Item key={row.key} size="xs" className={box}>
              {cells}
            </Item>
          );
        })}
      </div>
      {rows.length > SHIPPED_SHOWN && !all ? (
        // The button's own 8px inset puts its words on the rows' edge.
        <Button variant="ghost" size="xs" className="ms-4 mt-1 text-muted-foreground" onClick={() => setAll(true)}>
          Show all {rows.length}
        </Button>
      ) : null}
    </div>
  );
}

/** A section of grouped rows while the first host answers. */
export function RowsSkeleton({ title, groups = 2, rows = 3, tall = false }: { title: string; groups?: number; rows?: number; tall?: boolean }) {
  return (
    <PageSection title={title} aria-busy="true">
      <div className="flex flex-col gap-4">
        {Array.from({ length: groups }, (_, g) => (
          <div key={g}>
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="mx-1 size-2 rounded-full" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="mt-1 flex flex-col">
              {Array.from({ length: rows }, (_, r) => (
                <div key={r} className={cn("flex items-center gap-2", GUTTER, tall ? "h-8" : "h-7")}>
                  <Skeleton className="h-3.5" style={{ width: `${[58, 44, 66, 36][(g + r) % 4]}%` }} />
                  <Skeleton className="ms-auto h-3 w-8" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageSection>
  );
}
