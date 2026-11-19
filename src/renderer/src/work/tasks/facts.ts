import type { SectorKey } from "@shared/work";
import { clockTime } from "../../lib/duration";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useLifeosQuery, useLifeosSession } from "../shell/lifeos";
import { useMinute } from "./minute";

/**
 * The column's facts for Tasks and Agenda (docs/DESIGN.md "The Work column":
 * one muted trailing fact): how many tasks are open in the sector, and when
 * today's next event starts. Read live on the column's own narrowed session.
 * Nothing here loads before the Work shell does.
 */

/** "5": the sector's open tasks; none when there are none. */
export function useOpenCount(workspace: WorkspaceMeta, sector: SectorKey): string | null {
  const session = useLifeosSession(workspace.environmentId, sector);
  const rows = useLifeosQuery<unknown[]>(session, "tasks:list", { sector });
  return rows.status === "ready" && rows.value.length ? String(rows.value.length) : null;
}

type Timed = { startsAt: number; endsAt?: number; allDay: boolean; hidden?: boolean };

/** The next timed event still to start or still on today, as "2:00 PM". */
export function nextToday(events: readonly Timed[], now: number): number | null {
  const ahead = events.filter((e) => !e.allDay && !e.hidden && (e.endsAt ?? e.startsAt) > now).map((e) => e.startsAt);
  return ahead.length ? Math.min(...ahead) : null;
}

/** "2:00 PM": today's next event; none when the day holds no more. */
export function useNextEvent(workspace: WorkspaceMeta, sector: SectorKey): string | null {
  const now = useMinute();
  const day = new Date(now).setHours(0, 0, 0, 0);
  const session = useLifeosSession(workspace.environmentId, sector);
  const rows = useLifeosQuery<Timed[]>(session, "events:range", { from: day, to: day + 86_400_000, sector });
  const next = rows.status === "ready" ? nextToday(rows.value, now) : null;
  return next === null ? null : clockTime(next);
}
