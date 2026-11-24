import { useEffect, useRef, useState } from "react";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { LEFT, type MergedReview } from "@shared/work/review";
import { PageError } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { nameInLine } from "../../lib/hostWords";
import { lifeosHostName, useLifeosStatusHeard } from "../shell/lifeos";
import { downIsSilence, downWords, useDownPress, type LifeosDown } from "../shell/lifeosDown";
import { useDownAction } from "../shell/DownSignIn";
import { atHead } from "../shell/lifeosWords";

/**
 * Review's LifeOS line (docs/DESIGN.md "The weekly review", "Loading and empty states"): a host that left LifeOS out
 * says why in the rule's words, its computer named, once: silence red with a Retry that asks that host alone; a
 * sign-in missing, refused or waiting muted with Sign in or Show the code where this window may sign the host in, else
 * who can; Work off with Open Settings; on its way with no press. The line goes by itself: once that host's LifeOS
 * status says connected again, its week is asked for again.
 */

export type LifeosLine = { environmentId: string; state: LifeosStateName; kept: boolean };

/**
 * The page's LifeOS lines. A line every host that left it names a state for is worded a host at a time (`lines`) and
 * taken out of the plain ones (`plain`); a host a build behind keeps today's line. A host's part from before, when
 * that host did not answer this time, says nothing of LifeOS: its own "did not answer" is the newest cause.
 */
export function lifeosLinesOf(review: Pick<MergedReview, "left" | "lifeosDown"> | null, silentHosts: ReadonlySet<string>): { plain: ReadonlySet<string>; lines: LifeosLine[] } {
  const down = review?.lifeosDown ?? [];
  const plain = new Set<string>();
  const lines: LifeosLine[] = [];
  for (const line of [LEFT.lifeos, LEFT.lifeosKept] as const) {
    if (!review?.left.includes(line)) continue;
    const of = down.filter((d) => d.kept === (line === LEFT.lifeosKept));
    if (of.length === 0 || of.some((d) => d.state === null)) {
      plain.add(line);
      continue;
    }
    for (const d of of) if (!(d.stale && silentHosts.has(d.environmentId)) && !lines.some((l) => l.environmentId === d.environmentId)) lines.push({ environmentId: d.environmentId, state: d.state!, kept: d.kept });
  }
  return { plain, lines };
}

/** The state as the rule's presses read it; null while LifeOS is on its way there. A session that says connected and did not answer is LifeOS's silence. */
export const reviewDown = (state: LifeosStateName): LifeosDown | null => (state === "connecting" ? null : state === "connected" ? "unreachable" : state);

/** One host's line in words: its state by the rule, the computer named, then what the page does without it. */
export function reviewLifeosWords(state: LifeosStateName, host: string | null, kept: boolean): string {
  const down = reviewDown(state);
  const why = down ? downWords(down, host) : `${atHead(host ? nameInLine(host) : "this host")} is still connecting to LifeOS`;
  return `${why}, so ${kept ? "what it said when last read is shown" : "the calendar, tasks and mail are not counted"}.`;
}

export function LifeosDownLine({ line, onRetry }: { line: LifeosLine; /** asks this host alone for its part of the week again */ onRetry: (environmentId: string) => Promise<void> | void }) {
  const { environmentId, state, kept } = line;
  const down = reviewDown(state);
  const { press, elsewhere } = useDownPress(down, environmentId);
  const [busy, setBusy] = useState(false);
  // The page's newest ask, kept so the watch below hangs on nothing a render makes anew.
  const ask = useRef(onRetry);
  ask.current = onRetry;
  const retry = (): Promise<void> => {
    setBusy(true);
    return Promise.resolve(ask.current(environmentId)).finally(() => setBusy(false));
  };
  const { action, dialog } = useDownAction(press, environmentId, retry);
  // Back with no press: a status heard since the line was drawn that says connected asks the week again.
  const status = useLifeosStatusHeard(environmentId);
  const first = useRef(status);
  useEffect(() => {
    if (status && status !== first.current && status.lifeos.state === "connected") void ask.current(environmentId);
  }, [status, environmentId]);
  const words = reviewLifeosWords(state, lifeosHostName(environmentId), kept);
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
      {down && downIsSilence(down) ? (
        <div data-review-lifeos={state} className="flex items-start gap-3">
          <PageError className={cn("min-w-0 flex-1 py-0", button && "py-1.5")}>{words}</PageError>
          {button}
        </div>
      ) : (
        <div data-review-lifeos={state} className="flex items-start gap-3">
          <p className={cn("min-w-0 flex-1 text-xs text-pretty text-muted-foreground", button && "py-1.5")}>
            {words}
            {/* Who can, where this window may not: its own line under the state. */}
            {elsewhere ? <span className="block">{elsewhere}</span> : null}
          </p>
          {button}
        </div>
      )}
      {dialog}
    </>
  );
}
