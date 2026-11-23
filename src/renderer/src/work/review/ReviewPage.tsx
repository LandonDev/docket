import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LEFT, madeWords, SETTLED_WORDS, type MergedJob, type Placed, type SettleHow, type SlippedRow } from "@shared/work/review";
import { PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { takeWorkPlaceAt, useWorkPlaceAt } from "../../lib/workPlaceAt";
import type { WorkPlaceProps } from "../places/registry";
import { canOpen, followUp, openTarget, openThread, type Target } from "./go";
import { Hours, HoursSkeleton } from "./Hours";
import { RowsSkeleton, Shipped } from "./Shipped";
import { showWeekNamed, shownWeek, useShownFrom, useWeekTurn } from "./shown";
import { Slipped } from "./Slipped";
import { hostError, loadWeek, loadZone, markSeen, sentence, settleRow, undoSettle, useReview, type ReviewView } from "./store";

/**
 * Review: one page above the workspaces that shows a week across every job
 * (docs/agents/work-review.md, docs/DESIGN.md "The weekly review"). A 672px
 * column of three sections in the order of a Friday: Hours, since the
 * question is which job was starved; Shipped, the good part; Slipped, the
 * chores, which end on "Nothing slipped" once he has cleared them. The frame
 * above draws the header and the week's controls (`Head`); the page has no
 * second title, and its first line says when it was made.
 */

const NONE: ReadonlySet<string> = new Set();

/** The settled rows still to keep away: those a read of the week still lists as open. One it no longer lists is the week's own to say from then on. */
export function stillAway(keys: ReadonlySet<string>, slipped: readonly Pick<SlippedRow, "key" | "open">[]): ReadonlySet<string> {
  if (keys.size === 0) return keys;
  const open = new Set(slipped.filter((r) => r.open).map((r) => r.key));
  const next = new Set([...keys].filter((key) => open.has(key)));
  return next.size === keys.size ? keys : next;
}

export function View(_props: WorkPlaceProps) {
  const from = useShownFrom();
  // Left open over a Sunday night, "this week" is the new week.
  useWeekTurn();
  const week = shownWeek(from);
  const view = useReview(week);

  // Opened at a week (a routine run's row, Today's row): the page moves there, once. Until it has, the week that
  // happened to be on screen is neither drawn, read nor marked seen: an old run's row must not clear this week's
  // "ready" on its way to its own week.
  const wanted = useWorkPlaceAt("review");
  const naming = wanted !== null;
  useEffect(() => {
    if (wanted === null) return;
    void showWeekNamed(wanted).then(() => takeWorkPlaceAt("review"));
  }, [wanted]);

  // The zone weeks are cut in is asked once; the week is asked for whenever it, or the zone, changes.
  useEffect(() => void loadZone(), []);
  useEffect(() => {
    if (!naming) void loadWeek({ from: week.from, to: week.to });
  }, [naming, week.from, week.to, view.tz]);
  // He has seen the week once it has drawn: Today's row and the digest's line go.
  const drawn = view.review !== null && !naming;
  useEffect(() => {
    if (drawn) markSeen({ from: week.from, to: week.to });
  }, [drawn, week.from, week.to]);

  // Rows a press settled leave at once, in the week the press was made in, and stay away until a read of that week
  // no longer lists them as open. From then on the week's own reads say what is there: a thing reopened elsewhere
  // comes back.
  const [left, setLeft] = useState<ReadonlyMap<number, ReadonlySet<string>>>(() => new Map());
  const leave = useCallback((from: number, key: string, away: boolean) => {
    setLeft((before) => {
      const keys = new Set(before.get(from));
      if (away) keys.add(key);
      else keys.delete(key);
      return new Map(before).set(from, keys);
    });
  }, []);
  const review = view.review;
  useEffect(() => {
    if (!review) return;
    setLeft((before) => {
      const keys = before.get(review.from);
      const still = keys ? stillAway(keys, review.slipped) : keys;
      return !keys || still === keys ? before : new Map(before).set(review.from, still!);
    });
  }, [review]);
  const gone = left.get(week.from) ?? NONE;

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
        leave(review.from, row.key, true);
        toast(
          words,
          done.undo
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    leave(review.from, row.key, false);
                    void undoSettle(done, { from: review.from, to: review.to }).catch(() => toast.error("Couldn't undo"));
                  },
                },
              }
            : undefined,
        );
      } catch (err) {
        toast.error("That did not go through", { description: sentence(hostError(err)) });
      }
    },
    [review, leave],
  );

  // The named week is on its way: the bones, not another week's rows.
  const shown: ReviewView = naming ? { ...view, review: null, settled: false, making: false, off: [], errors: [] } : view;
  return <ReviewPageView view={shown} gone={gone} canOpen={canOpen} onOpen={openTarget} onPress={onPress} onRetry={() => loadWeek({ from: week.from, to: week.to })} />;
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
  /** every host is asked again: one Retry answers every red line on the page */
  onRetry: () => Promise<void> | void;
}) {
  const { review } = view;
  const left = useMemo(() => new Set(review?.left ?? []), [review]);
  const of = (...lines: string[]): string[] => lines.filter((line) => left.has(line));
  const [retrying, setRetrying] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  /** Retry was pressed with the keyboard on it: off while the hosts answer, it cannot hold focus, so focus is put back after */
  const retryHeld = useRef(false);
  const retry = (
    <Button
      data-review-retry
      variant="ghost"
      size="sm"
      disabled={retrying}
      onClick={(event) => {
        retryHeld.current = document.activeElement === event.currentTarget;
        setRetrying(true);
        void Promise.resolve(onRetry()).finally(() => setRetrying(false));
      }}
    >
      <BusyLabel busy={retrying} label="Retry" />
    </Button>
  );
  // The round is over: the keyboard is back on Retry where a red line is left (it may be another line's now), else
  // on the first section's heading.
  useEffect(() => {
    if (retrying || !retryHeld.current) return;
    retryHeld.current = false;
    const at = document.activeElement;
    if (at && at !== document.body && !at.matches("[data-review-retry]")) return;
    (page.current?.querySelector<HTMLElement>("[data-review-retry]") ?? page.current?.querySelector<HTMLElement>("[data-review-heading]"))?.focus();
  }, [retrying]);
  // A source that feeds more than one section is said once, over them, as a host is: the calendar is Hours' time
  // and Slipped's meetings, a held item Shipped's approvals, Slipped's rows and desk time. Threads and document
  // history feed Hours alone and are said there. The first red line on the page carries the one Retry.
  // A host that did not answer says whether what it answered before still stands in the numbers.
  const over = [...view.errors.map((e) => `${e.name} did not answer: ${e.error.replace(/\.$/, "")}.${e.kept ? " Its last answer is shown." : ""}`), ...of(LEFT.lifeos, LEFT.calendar, LEFT.tasks, LEFT.mail, LEFT.held)];
  // A row whose source did not answer stands as last known, with its presses waiting: said once, under the red
  // lines, unless a host's own line already says its last answer is shown.
  const keptHosts = new Set(view.errors.filter((e) => e.kept).map((e) => e.environmentId));
  const lastKnown = !!review?.slipped.some((r) => r.unchecked && !keptHosts.has(r.environmentId));
  // A linked host has not answered yet: "nothing" is not known, and nothing has failed.
  const pending = !view.settled;
  const hours = of(LEFT.threads, LEFT.files);
  return (
    <div ref={page} data-review-page className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto w-full max-w-2xl p-6">
        <div className="flex flex-col gap-1">
          {view.making ? (
            // Make again: the rows stand while the hosts read the week again.
            <p data-review-made role="status" className="flex h-4 items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner aria-hidden className="size-3" />
              Making…
            </p>
          ) : review ? (
            <p data-review-made className="text-xs text-muted-foreground">
              {madeWords(review, view.tz, now)}
            </p>
          ) : view.settled ? null : (
            // The one thing a screen reader hears of the wait: the bones under it are for the eye.
            <div role="status" className="flex h-4 items-center">
              <span className="sr-only">Loading the review</span>
              <Skeleton className="h-3 w-40" />
            </div>
          )}
          {/* A host that is off is a fact, not a failure: one muted line, and the page stands. */}
          {view.off.map((line) => (
            <p key={line} data-review-off className="text-xs text-muted-foreground">
              {line}
            </p>
          ))}
          {/* A host that did not answer, and each source that feeds several sections: red lines in the same stack, the Retry on the first. */}
          {over.map((line, i) => (
            <div key={line} className="flex items-start gap-3">
              <PageError className="min-w-0 flex-1 py-0">{line}</PageError>
              {/* The 28px button overhangs the 16px line evenly. */}
              {i === 0 ? <span className="-my-1.5 flex shrink-0">{retry}</span> : null}
            </div>
          ))}
          {lastKnown ? (
            <p data-review-last-known className="text-xs text-muted-foreground">
              Slipped shows what was last known.
            </p>
          ) : null}
          {!review && view.settled && view.errors.length === 0 && view.off.length === 0 ? <p className="text-xs text-muted-foreground">No host with Work on is linked to this window</p> : null}
        </div>
        <div className="@container/page mt-6 flex flex-col gap-6">
          {review ? (
            <>
              <Hours jobs={review.jobs} hours={review.hours} compare={review.compare} money={view.money} known={review.known} pending={pending} left={hours} retry={over.length === 0 ? retry : undefined} opened={peek?.job} />
              <Shipped review={review} pending={pending} canOpen={opens} onOpen={onOpen} />
              <Slipped review={review} pending={pending} gone={gone} canOpen={opens} onOpen={onOpen} onPress={onPress} peek={peek} />
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
