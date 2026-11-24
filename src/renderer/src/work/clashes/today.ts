import { useMemo } from "react";
import { clashLine, leaveLine, listFrom, type LifeosRange } from "@shared/work/clashes";
import { useLifeosQuery } from "../shell/lifeos";
import { sessionDown } from "../today/lifeos";
import { useMinute } from "../tasks/minute";
import type { TodayAnswer, TodayEnv, TodayMark, TodaySource } from "../today/types";
import { liveClashes, marksOf } from "./model";
import { openClash } from "./open";

/**
 * Clashes on Today (docs/agents/work-today.md "Adding to Today"): never a row
 * of their own, since a clash is a fact about a meeting the page already
 * lists. Each event of a clash gets a mark on its `event:<id>` row: the
 * clash in that event's own words, drawn as a fault, with Resolve, which
 * opens the Clash dialog. An event he has to drive to gets its leave-by as
 * the row's live line, from where he will be, until he should be there.
 */
const MINUTE = 60_000;

/**
 * The marks at `now`: a clash only while it is his to settle (`liveClashes`, as the Agenda drops it), worded
 * under the day Today shows, so the other event's time takes its weekday when it began on another day.
 */
export function clashMarks(range: LifeosRange | undefined, env: Pick<TodayEnv, "day" | "workspaces" | "lifeos">, now: number): TodayMark[] {
  // A side's workspace is one on the host whose session reads the clash, the host the dialog opens on: as the
  // dialog's own read names them, so Running late is never offered for a job only another host holds.
  const host = env.lifeos.environmentId;
  const list = marksOf(listFrom(range, (sector) => env.workspaces.find((w) => w.sector === sector && w.environmentId === host)?.workspaceId));
  const marks = new Map<string, TodayMark>();
  for (const [eventId, of] of liveClashes(list.clashes, now)) {
    const first = of[0];
    if (!first) continue;
    const more = of.length - 1;
    marks.set(eventId, {
      key: `event:${eventId}`,
      note: `${clashLine(first, eventId, { on: env.day.from })}${more > 0 ? `, and ${more} more` : ""}`,
      late: true,
      act: { label: "Resolve", run: () => openClash({ id: first.id, environmentId: env.lifeos.environmentId, clash: first }) },
    });
  }
  for (const [eventId, leave] of list.leaves) {
    // Once the drive would have him there, the row's own line ("in 5 min", "Now") says more.
    if (now >= leave.leaveAt + (leave.minutes ?? 0) * MINUTE) continue;
    marks.set(eventId, { key: `event:${eventId}`, ...marks.get(eventId), whenLine: leaveLine(leave) });
  }
  return [...marks.values()];
}

function useClashMarks(env: TodayEnv): TodayAnswer {
  const read = useLifeosQuery<LifeosRange>(env.lifeos, "clashes:range", { from: env.day.from, to: env.day.to });
  const now = useMinute();
  const value = read.status === "ready" ? read.value : undefined;
  const marks = useMemo(() => (value === undefined ? null : clashMarks(value, env, now)), [value, env, now]);
  if (read.status === "loading") return { loading: true };
  if (read.status === "failed") {
    // A session that is down is the page's one line ("Not signed in to LifeOS"), never a second one under Also.
    if (sessionDown(env.lifeos)) return {};
    // LifeOS refused the read: no host is at fault, and its own words are not his.
    return { failed: [{ environmentId: env.lifeos.environmentId, error: read.error, said: "LifeOS could not read clashes" }] };
  }
  return { marks: marks ?? [] };
}

export const source: TodaySource = { id: "clashes", use: useClashMarks };
