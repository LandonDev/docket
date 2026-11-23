import { useState, type ReactNode } from "react";
import { SETTLE_HOWS, SETTLE_WORDS, slippedDetail, splitOlder, type MergedJob, type MergedReview, type Placed, type SettleHow, type SlippedRow } from "@shared/work/review";
import { ChevronRight } from "../../chrome/icons";
import { PageEmpty, PageError, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, DISCLOSURE_CHEVRON } from "../../components/ui/collapsible";
import { Item, ItemButton } from "../../components/ui/item";
import { ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import type { Target } from "./go";
import { JobHeading } from "./Shipped";

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

export function Slipped({
  review,
  known,
  left = [],
  gone,
  canOpen,
  onOpen,
  onPress,
  peek,
}: {
  review: MergedReview;
  left?: readonly string[];
  /** a still picture's seams (the preview): a row whose presses show as on hover, and the folds open */
  peek?: { verbs?: string; folds?: boolean };
  /** LifeOS answered: an empty list is known to be empty */
  known: boolean;
  /** rows a press just settled: they leave, and stay away until the week is read again */
  gone: ReadonlySet<string>;
  canOpen: (job: MergedJob, target: Target) => boolean;
  onOpen: (job: MergedJob, target: Target) => void;
  onPress: Press;
}) {
  const open = review.slipped.filter((r) => r.open);
  const dealt = review.slipped.filter((r) => !r.open);
  const groups = review.jobs.map((job) => ({ job, ...splitOlder(open.filter((r) => r.job === job.key), review) })).filter((g) => g.lead.length + g.older.length > 0);
  const remaining = open.filter((r) => !gone.has(r.key)).length;
  const row = (job: MergedJob, r: Placed<SlippedRow>) => <SlippedRowView key={r.key} job={job} row={r} review={review} gone={gone.has(r.key)} canOpen={canOpen} onOpen={onOpen} onPress={onPress} shown={peek?.verbs === r.key} />;
  return (
    <PageSection title="Slipped">
      {left.map((line) => (
        <PageError key={line}>{line}</PageError>
      ))}
      {remaining === 0 ? <PageEmpty>{known ? "Nothing slipped" : "Not known while LifeOS does not answer"}</PageEmpty> : null}
      {groups.length > 0 ? (
        <div className="flex flex-col gap-4">
          {groups.map(({ job, lead, older }) => (
            <Leaving key={job.key} gone={[...lead, ...older].every((r) => gone.has(r.key))}>
              <div data-review-slipped={job.key}>
                <JobHeading job={job} />
                <div className="mt-1 flex flex-col">{lead.map((r) => row(job, r))}</div>
                {older.length > 0 ? <Fold label={`${older.length} older`} startOpen={peek?.folds}>{older.map((r) => row(job, r))}</Fold> : null}
              </div>
            </Leaving>
          ))}
        </div>
      ) : null}
      {dealt.length > 0 ? (
        <div className={cn(groups.length > 0 || remaining === 0 ? "mt-4" : null)}>
          <Fold label="Dealt with since" count={dealt.length} flush startOpen={peek?.folds}>
            {dealt.map((r) => (
              <Item key={r.key} size="xs" data-review-dealt={r.key} className="h-8 flex-nowrap gap-1 px-0 py-0 text-[13px] leading-5 text-muted-foreground">
                <span className="min-w-0 truncate">{r.title}</span>
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
 * rows' edge. The line lifts to the foreground on hover; only the chevron's turn animates.
 */
function Fold({ label, count, flush = false, startOpen = false, children }: { label: string; count?: number; flush?: boolean; startOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="focus-ring flex h-6 items-center rounded-sm text-xs text-muted-foreground hover:text-foreground">
        <span className="grid size-4 place-items-center">
          <ChevronRight aria-hidden className={cn("size-3", DISCLOSURE_CHEVRON, open && "rotate-90")} />
        </span>
        <span className="ms-2">{label}</span>
        {count !== undefined ? <span className="ms-1 tabular-nums">{count}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("flex flex-col", flush ? "ps-6" : null)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * What a settled row or an emptied group does: it leaves, its height and
 * opacity easing out over `--dur-base`, and takes no pointer or focus on the
 * way. With reduced motion it is simply gone.
 */
function Leaving({ gone, children }: { gone: boolean; children: ReactNode }) {
  return (
    <div
      data-leaving={gone ? "" : undefined}
      inert={gone || undefined}
      className={cn("grid transition-[grid-template-rows,opacity] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none", gone ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function SlippedRowView({ job, row, review, gone, canOpen, onOpen, onPress, shown = false }: { job: MergedJob; row: Placed<SlippedRow>; review: MergedReview; gone: boolean; canOpen: (job: MergedJob, target: Target) => boolean; onOpen: (job: MergedJob, target: Target) => void; onPress: Press; shown?: boolean }) {
  const [busy, setBusy] = useState<SettleHow | null>(null);
  const target = slippedTarget(row);
  const opens = canOpen(job, target);
  const words = SETTLE_WORDS[row.ref.kind];
  const press = (how: SettleHow): void => {
    if (busy) return;
    setBusy(how);
    void Promise.resolve(onPress(job, row, how)).finally(() => setBusy(null));
  };
  return (
    <Leaving gone={gone}>
      {/* The hover box reaches 8px past the column each side; the words keep the rows' edge, 24px in. */}
      <div data-review-row={row.key} className={cn("group/row -mx-2 flex h-8 w-[calc(100%+1rem)] items-center rounded-md ps-8 pe-2 text-[13px] leading-5", opens ? ROW_HOLDS : "relative hover:bg-foreground/5", shown ? "bg-foreground/5" : null)}>
        {opens ? <ItemButton data-row-open aria-label={`Open ${row.title}`} className={ROW_OPEN} onClick={() => onOpen(job, target)} /> : null}
        {/* The title whole wherever it fits beside a few words of detail; short of room the detail gives way first. A grid, not a flex row: a flex row shaves a hair off the title and it gains an ellipsis it does not need. */}
        <span className={cn("grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)_minmax(4rem,1fr)] items-baseline gap-x-1", ROW_SHOWS)}>
          <span className="truncate text-foreground">{row.title}</span>
          <span className="truncate text-muted-foreground">{slippedDetail(row, review, review.tz)}</span>
        </span>
        {/* Over the row's end, on the row's own fill, so the words under them never show through. */}
        <span className={cn("absolute inset-y-0 end-0 flex items-center rounded-e-md bg-background", shown ? null : reveal("row", { row: true, overlay: true }))}>
          <span className="flex h-full items-center gap-0.5 rounded-e-md bg-foreground/5 ps-2 pe-1">
            {SETTLE_HOWS.map((how) => (
              <Button key={how} variant="ghost" size="xs" disabled={busy !== null} onClick={() => press(how)}>
                {words[how]}
              </Button>
            ))}
          </span>
        </span>
      </div>
    </Leaving>
  );
}
