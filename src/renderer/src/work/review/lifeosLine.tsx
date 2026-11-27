import { useRef, useState } from "react";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { LEFT, type MergedReview } from "@shared/work/review";
import { PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Region } from "../../components/bones";
import { cn } from "../../lib/cn";
import { lifeosHostName } from "../shell/lifeos";
import { downIsSilence, downWords, useDownPress, type LifeosDown } from "../shell/lifeosDown";
import { useDownAction } from "../shell/DownSignIn";
import { connectingWords } from "../shell/lifeosWords";
import { useLiveDown, type SavedDown } from "../shell/lifeosLive";
import { SAMPLE_LIFEOS_LINE } from "./samples";

/** A state's words with what the page does without it, on the last line of its kind. */
const reviewWordsOf = (why: string, kept: boolean, tail: boolean): string => (tail ? `${why}, so ${kept ? "what it said when last read is shown" : "the calendar, tasks and mail are not counted"}.` : `${why}.`);

/**
 * Review's LifeOS line (docs/DESIGN.md "The weekly review", "Loading and empty states"): a host that left LifeOS out
 * says why in the rule's words, its computer named, once: silence red with a Retry that asks that host alone; a
 * sign-in missing, refused or waiting muted with Sign in or Show the code where this window may sign the host in, else
 * who can; Work off with Open Settings; on its way with no press. The line goes by itself: once that host's LifeOS
 * status says connected again, its week is asked for again.
 */

export type LifeosLine = {
  environmentId: string;
  state: LifeosStateName;
  kept: boolean;
  /** this line says what the page does without LifeOS: the last line of its kind, unless the plain line of that kind says it */
  tail: boolean;
};

/**
 * The page's LifeOS lines. A host that names a state is worded a host at a time (`lines`); a host a build behind, which
 * names none, keeps today's line (`plain`), beside the named lines of the others. A host's part from before, when that
 * host did not answer this time, says nothing of LifeOS: its own "did not answer" is the newest cause. What the page does
 * without LifeOS is said once a kind, after its last line.
 */
export function lifeosLinesOf(review: Pick<MergedReview, "left" | "lifeosDown"> | null, silentHosts: ReadonlySet<string>): { plain: ReadonlySet<string>; lines: LifeosLine[] } {
  const down = review?.lifeosDown ?? [];
  const plain = new Set<string>();
  const lines: LifeosLine[] = [];
  for (const line of [LEFT.lifeos, LEFT.lifeosKept] as const) {
    if (!review?.left.includes(line)) continue;
    const of = down.filter((d) => d.kept === (line === LEFT.lifeosKept));
    if (of.length === 0 || of.some((d) => d.state === null)) plain.add(line);
    const named: LifeosLine[] = [];
    for (const d of of) if (d.state !== null && !(d.stale && silentHosts.has(d.environmentId)) && !lines.some((l) => l.environmentId === d.environmentId) && !named.some((l) => l.environmentId === d.environmentId)) named.push({ environmentId: d.environmentId, state: d.state, kept: d.kept, tail: false });
    if (named.length && !plain.has(line)) named[named.length - 1]!.tail = true;
    lines.push(...named);
  }
  return { plain, lines };
}

/** The state as the rule's presses read it; null while LifeOS is on its way there. A session that says connected and did not answer is LifeOS's silence. */
export const reviewDown = (state: LifeosStateName): LifeosDown | null => (state === "connecting" ? null : state === "connected" ? "unreachable" : state);

/** A line's state as the cause it saved, for the live status to judge (`useLiveDown`). */
const savedOfLine = (state: LifeosStateName): SavedDown => (state === "connecting" ? "connecting" : reviewDown(state));

/** One host's line in words: its state by the rule, the computer named, then, on the last line of its kind, what the page does without it. */
export function reviewLifeosWords(state: LifeosStateName, host: string | null, kept: boolean, tail = true): string {
  const down = reviewDown(state);
  return reviewWordsOf(down ? downWords(down, host) : connectingWords(host), kept, tail);
}

export function LifeosDownLine({ line, onRetry }: { line: LifeosLine; /** asks this host alone for its part of the week again */ onRetry: (environmentId: string) => Promise<void> | void }) {
  const { environmentId, kept, tail } = line;
  // The page's newest ask, kept so the watch below hangs on nothing a render makes anew.
  const ask = useRef(onRetry);
  ask.current = onRetry;
  // The host's live status says it now: a sign-in begun elsewhere is Show the code, LifeOS on its way a wait; a status
  // heard since the week was read that says connected asks the week again, with no press.
  // While that ask is out (`again`) the line is bones, never the old state.
  const live = useLiveDown(savedOfLine(line.state), environmentId, () => Promise.resolve(ask.current(environmentId)));
  const down = live.down;
  const { press, elsewhere } = useDownPress(down, environmentId);
  const [busy, setBusy] = useState(false);
  const retry = (): Promise<void> => {
    setBusy(true);
    return Promise.resolve(ask.current(environmentId)).finally(() => setBusy(false));
  };
  const { action, dialog } = useDownAction(press, environmentId, retry);
  const host = lifeosHostName(environmentId);
  const words = reviewWordsOf(down ? downWords(down, host) : connectingWords(host), kept, tail);
  // A line with a press is the press's 28px tall, its words on the first line's middle: two such lines, one per
  // computer, never lay one button over the other.
  const button = action ? (
    <span className="flex shrink-0">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action.run()}>
        <BusyLabel busy={busy} label={action.label} />
      </Button>
    </span>
  ) : null;
  return (
    <>
      <Region
        loading={!!live.again}
        label=""
        bones={
          <p data-review-lifeos="again" className="text-xs text-muted-foreground">
            {SAMPLE_LIFEOS_LINE}
          </p>
        }
      >
        {down && downIsSilence(down) ? (
          <div data-review-lifeos={down} className="flex items-start gap-3">
            <PageError className={cn("min-w-0 flex-1 py-0", button && "py-1.5")}>{words}</PageError>
            {button}
          </div>
        ) : (
          <div data-review-lifeos={down ?? "connecting"} className="flex items-start gap-3">
            <p className={cn("min-w-0 flex-1 text-xs text-pretty text-muted-foreground", button && "py-1.5")}>
              {words}
              {/* Who can, where this window may not: its own line under the state. */}
              {elsewhere ? <span className="block">{elsewhere}</span> : null}
            </p>
            {button}
          </div>
        )}
      </Region>
      {dialog}
    </>
  );
}
