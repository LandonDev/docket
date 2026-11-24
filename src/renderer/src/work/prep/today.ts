import { useMemo } from "react";
import type { PrepUpcoming } from "@shared/contract-work-prep";
import { goTo } from "../today/open";
import { useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodayMark, TodaySource, TodayWorkspace } from "../today/types";
import { meetingMark } from "./model";

/**
 * What prep says about a meeting's row on Today (docs/agents/work-prep.md "The
 * borders"): a mark on `event:<LifeOS event id>`, never a row of its own. A
 * press opens the meeting's page in its job, and the row says "Prep is ready"
 * only once a brief stands. It reads `work.prep.upcoming` on every host with
 * Work on and again on the `work.prep` push; a host that does not answer adds
 * no line to the page, since a mark is only ever an extra.
 */

type Upcoming = { meetings: PrepUpcoming[] };

/** The marks for what the hosts answered. A host answers every job of its own to each ask, so a meeting is taken from its own job's answer alone. */
export function prepMarks(answers: readonly { workspace: TodayWorkspace; value: Upcoming }[], open: typeof goTo = goTo): TodayMark[] {
  const marks = new Map<string, TodayMark>();
  for (const { workspace, value } of answers) {
    for (const meeting of value.meetings ?? []) {
      if (meeting.workspaceId !== workspace.workspaceId) continue;
      const { key, note, target } = meetingMark(meeting);
      marks.set(key, { key, ...(note ? { note } : {}), open: () => open(workspace, { view: target.view, event: target.event }) });
    }
  }
  return [...marks.values()];
}

function usePrepMarks(env: TodayEnv): TodayAnswer {
  // At midnight the range moves with no push: every job is asked for the new day (`again`).
  const read = useEachWorkspace<Upcoming>(env, "work.prep.upcoming", () => ({ from: env.day.from, to: env.day.to }), { push: "work.prep", again: env.day.from });
  return useMemo(() => ({ marks: prepMarks(read.answers) }), [read.answers]);
}

export const source: TodaySource = { id: "prep", use: usePrepMarks };
