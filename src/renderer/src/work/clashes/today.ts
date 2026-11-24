import { clashLine, leaveLine, listFrom, type LifeosRange } from "@shared/work/clashes";
import { useLifeosQuery } from "../shell/lifeos";
import { sessionDown } from "../today/lifeos";
import { useMinute } from "../tasks/minute";
import type { TodayMark, TodaySource } from "../today/types";
import { marksOf } from "./model";
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

export const source: TodaySource = {
  id: "clashes",
  use(env) {
    const read = useLifeosQuery<LifeosRange>(env.lifeos, "clashes:range", { from: env.day.from, to: env.day.to });
    const now = useMinute();
    if (read.status === "loading") return { loading: true };
    if (read.status === "failed") {
      // A session that is down is the page's one line ("Not signed in to LifeOS"), never a second one under Also.
      if (sessionDown(env.lifeos)) return {};
      // LifeOS refused the read: no host is at fault, and its own words are not his.
      return { failed: [{ environmentId: env.lifeos.environmentId, error: read.error, said: "LifeOS could not read clashes" }] };
    }
    const { clashes, leaves } = marksOf(listFrom(read.value, (sector) => env.workspaceOf(sector)?.workspaceId));
    const marks = new Map<string, TodayMark>();
    for (const [eventId, of] of clashes) {
      const first = of[0];
      if (!first) continue;
      const more = of.length - 1;
      marks.set(eventId, {
        key: `event:${eventId}`,
        note: `${clashLine(first, eventId)}${more > 0 ? `, and ${more} more` : ""}`,
        late: true,
        act: { label: "Resolve", run: () => openClash({ id: first.id, environmentId: env.lifeos.environmentId, clash: first }) },
      });
    }
    for (const [eventId, leave] of leaves) {
      // Once the drive would have him there, the row's own line ("in 5 min", "Now") says more.
      if (now >= leave.leaveAt + (leave.minutes ?? 0) * MINUTE) continue;
      marks.set(eventId, { key: `event:${eventId}`, ...marks.get(eventId), whenLine: leaveLine(leave) });
    }
    return { marks: [...marks.values()] };
  },
};
