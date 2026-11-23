import type { SectorKey } from "@shared/work";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useLifeosQuery, useLifeosSession } from "../shell/lifeos";

/**
 * The Messages row's fact (docs/DESIGN.md "The Work column": one muted
 * trailing fact): how many of the job's conversations wait unread, read live
 * on the column's own narrowed session, as Mail's count is.
 */

/** "3", or nothing when none waits. */
export const unreadFact = (count: number | undefined): string | null => (count && count > 0 ? String(count) : null);

export function useUnreadChats(workspace: WorkspaceMeta, sector: SectorKey): string | null {
  const session = useLifeosSession(workspace.environmentId, sector);
  const unread = useLifeosQuery<{ count: number }>(session, "chats:unread", { sector });
  return unread.status === "ready" ? unreadFact(unread.value.count) : null;
}
