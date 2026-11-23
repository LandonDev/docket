import { useCallback, useEffect, useMemo, useState } from "react";
import { LEFT, madeWords, SETTLED_WORDS, type MergedJob, type Placed, type SettleHow, type SlippedRow } from "@shared/work/review";
import { PageError } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { takeWorkPlaceAt, useWorkPlaceAt } from "../../lib/workPlaceAt";
import type { WorkPlaceProps } from "../places/registry";
import { canOpen, followUp, openTarget, openThread, type Target } from "./go";
import { Hours, HoursSkeleton } from "./Hours";
import { RowsSkeleton, Shipped } from "./Shipped";
import { showWeekAt, shownWeek, useShownFrom } from "./shown";
import { Slipped } from "./Slipped";
import { loadHostWeek, loadWeek, loadZone, markSeen, settleRow, undoSettle, useReview, type ReviewView } from "./store";

/**
 * Review: one page above the workspaces that shows a week across every job
 * (docs/agents/work-review.md, docs/DESIGN.md "The weekly review"). A 672px
 * column of three sections in the order of a Friday: Hours, since the
 * question is which job was starved; Shipped, the good part; Slipped, the
 * chores, which end on "Nothing slipped" once he has cleared them. The frame
 * above draws the header and the week's controls (`Head`); the page has no
 * second title, and its first line says when it was made.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function View(_props: WorkPlaceProps) {
  const from = useShownFrom();
  const week = shownWeek(from);
  const view = useReview(week);

  // Opened at a week (a routine run's row, Today's row): the page moves there, once.
  const wanted = useWorkPlaceAt("review");
  useEffect(() => {
    if (wanted === null) return;
    showWeekAt(wanted);
    takeWorkPlaceAt("review");
  }, [wanted]);

  // The zone weeks are cut in is asked once; the week is asked for whenever it, or the zone, changes.
  useEffect(() => void loadZone(), []);
  useEffect(() => {
    void loadWeek({ from: week.from, to: week.to });
  }, [week.from, week.to, view.tz]);
  // He has seen the week once it has drawn: Today's row and the digest's line go.
  const drawn = view.review !== null;
  useEffect(() => {
    if (drawn) markSeen({ from: week.from, to: week.to });
  }, [drawn, week.from, week.to]);

  // Rows a press settled leave at once and stay away until the week no longer lists them.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setGone(new Set()), [week.from]);
  const leave = useCallback((key: string, away: boolean) => {
    setGone((before) => {
      const next = new Set(before);
      if (away) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const review = view.review;
  const onPress = useCallback(
    async (job: MergedJob, row: Placed<SlippedRow>, how: SettleHow): Promise<void> => {
      if (!review) return;
      // A held item's own press stays in the Outbox; a follow-up is a thread he starts.
      if (row.ref.kind === "held" && how === "now") return openTarget(job, { at: "held", ref: row.ref.ref });
      if (row.ref.kind === "meeting" && how === "now") return followUp(job, { id: row.ref.eventId, title: row.title });
      const toast = await loadToast();
      try {
        const done = await settleRow(review, row, how);
        const words = SETTLED_WORDS[row.ref.kind][how];
        if (done.sessionId) {
          const sessionId = done.sessionId;
          return void toast(words, { action: { label: "Open", onClick: () => openThread(sessionId) } });
        }
        leave(row.key, true);
        toast(
          words,
          done.undo
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    leave(row.key, false);
                    void undoSettle(done, { from: review.from, to: review.to }).catch(() => toast.error("Couldn't undo"));
                  },
                },
              }
            : undefined,
        );
      } catch (err) {
        toast.error("That did not go through", { description: errorText(err) });
      }
    },
    [review, leave],
  );

  return <ReviewPageView view={view} gone={gone} canOpen={canOpen} onOpen={openTarget} onPress={onPress} onRetry={(environmentId) => void loadHostWeek(environmentId, { from: week.from, to: week.to })} />;
}

/** The page as the hosts' answers leave it: what the preview and the tests draw. */
export function ReviewPageView({
  view,
  now = Date.now(),
  gone,
  canOpen: opens,
  onOpen,
  onPress,
  onRetry,
  peek,
}: {
  view: ReviewView;
  now?: number;
  /** a still picture's seams, for the preview: an Hours row open, a slipped row's presses shown, the folds open */
  peek?: { job?: string; verbs?: string; folds?: boolean };
  gone: ReadonlySet<string>;
  canOpen: (job: MergedJob, target: Target) => boolean;
  onOpen: (job: MergedJob, target: Target) => void;
  onPress: (job: MergedJob, row: Placed<SlippedRow>, how: SettleHow) => Promise<void> | void;
  onRetry: (environmentId: string) => void;
}) {
  const { review } = view;
  const left = useMemo(() => new Set(review?.left ?? []), [review]);
  const of = (...lines: string[]): string[] => lines.filter((line) => left.has(line));
  const known = !!review?.lifeosFrom;
  return (
    <div data-review-page className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-2xl p-6">
        <div className="flex flex-col gap-1">
          {review ? (
            <p data-review-made className="text-xs text-muted-foreground">
              {madeWords(review, view.tz, now)}
            </p>
          ) : view.settled ? null : (
            <div className="flex h-4 items-center" aria-busy="true" aria-label="Loading the review">
              <Skeleton className="h-3 w-40" />
            </div>
          )}
          {/* A host that is off is a fact, not a failure: one muted line, and the page stands. */}
          {view.off.map((line) => (
            <p key={line} data-review-off className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
          {view.errors.map((e) => (
            <PageError
              key={e.environmentId}
              className="py-0"
              action={
                <Button variant="ghost" size="sm" onClick={() => onRetry(e.environmentId)}>
                  Retry
                </Button>
              }
            >{`${e.name} did not answer: ${e.error}`}</PageError>
          ))}
          {/* LifeOS missing touches every section, so it is said once, here. */}
          {of(LEFT.lifeos).map((line) => (
            <PageError key={line} className="py-0">
              {line}
            </PageError>
          ))}
          {!review && view.settled && view.errors.length === 0 && view.off.length === 0 ? <p className="text-xs text-muted-foreground">No host with Work on is linked to this window</p> : null}
        </div>
        <div className="@container/page mt-6 flex flex-col gap-6">
          {review ? (
            <>
              <Hours jobs={review.jobs} hours={review.hours} compare={review.compare} money={view.money} left={of(LEFT.calendar, LEFT.threads, LEFT.files)} opened={peek?.job} />
              <Shipped review={review} known={known} left={of(LEFT.mail, LEFT.tasks)} canOpen={opens} onOpen={onOpen} />
              <Slipped review={review} known={known} left={of(LEFT.held)} gone={gone} canOpen={opens} onOpen={onOpen} onPress={onPress} peek={peek} />
            </>
          ) : view.settled ? null : (
            <>
              <HoursSkeleton />
              <RowsSkeleton title="Shipped" />
              <RowsSkeleton title="Slipped" tall />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
