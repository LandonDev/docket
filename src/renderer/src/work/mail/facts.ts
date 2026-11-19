import type { SectorKey } from "@shared/work";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useLifeosQuery, useLifeosSession } from "../shell/lifeos";

/**
 * The Mail row's fact (docs/DESIGN.md "The Work column": one muted trailing
 * fact): how many threads wait unread in the sector, over every account, as
 * the view opens on them ("everything"). Read live on the column's own
 * narrowed session, as Tasks and Agenda read theirs.
 */

/** "3": the unread threads across the accounts; none when there are none. */
export function unreadOf(rows: readonly { count: number }[]): string | null {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return total > 0 ? String(total) : null;
}

export function useUnreadCount(workspace: WorkspaceMeta, sector: SectorKey): string | null {
  const session = useLifeosSession(workspace.environmentId, sector);
  const rows = useLifeosQuery<{ count: number }[]>(session, "mail:unread", { view: "everything" });
  return rows.status === "ready" ? unreadOf(rows.value) : null;
}
