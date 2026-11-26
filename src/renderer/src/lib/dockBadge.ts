import type { SessionMeta } from "./tcserver/types";
import { threadStateOf } from "../components/ui/status";
import { invoke } from "./native";
import { sessionStore } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import { loadLastSeen, seenFloor, subscribeLastSeen, type SeenMap } from "./sessionSeen";
import { rowUnread } from "./sidebarRows";
import { railMasters, unreadCanShow } from "./threadStripModel";
import { housedIds } from "./workspaceSessions";

/**
 * The Dock badge: how many threads want the person, on every host. A thread
 * wants him while it needs him (an approval, a question) or reads unread by
 * the rail's own rule (`rowUnread`: a settled root past its read mark, in no
 * archived project). Each counts once, as the row he would open: a subagent
 * as its root, a thread of a master's batch as the master, so a master's
 * child never adds a number of its own. Archived threads never count.
 */
export function badgeCount(
  metas: readonly SessionMeta[],
  archivedProjects: ReadonlySet<string>,
  lastSeen: SeenMap,
  floor = 0,
): number {
  const byId = new Map<string, SessionMeta>();
  for (const meta of metas) byId.set(meta.id, meta);
  const masters = railMasters(metas);
  const housed = housedIds(metas, masters);
  const rootOf = (meta: SessionMeta): SessionMeta => {
    let root = meta;
    for (let hops = 0; root.parentId && hops < 64; hops++) {
      const parent = byId.get(root.parentId);
      if (!parent) break;
      root = parent;
    }
    return root;
  };
  const rows = new Set<string>();
  for (const meta of metas) {
    if (meta.archived) continue;
    const waiting = threadStateOf(meta.status) === "waiting";
    if (!waiting && !unreadRoot(meta, housed, archivedProjects, lastSeen, floor)) continue;
    const root = rootOf(meta);
    rows.add(housed.has(root.id) && root.masterId && masters.has(root.masterId) ? root.masterId : root.id);
  }
  return rows.size;
}

function unreadRoot(meta: SessionMeta, housed: ReadonlySet<string>, archivedProjects: ReadonlySet<string>, lastSeen: SeenMap, floor: number): boolean {
  if (meta.parentId || (meta.projectId && archivedProjects.has(meta.projectId))) return false;
  const unread = unreadCanShow(meta) && meta.updatedAt > (lastSeen[meta.id] ?? floor);
  return rowUnread({ ...meta, unread, housed: housed.has(meta.id) });
}

let lastCount = -1;
let ready = false;

function archivedProjectIds(): Set<string> {
  return new Set(workspaceStore.getSnapshot().projects.filter((p) => p.archived).map((p) => p.id));
}

export function syncDockBadge(): void {
  // Nothing is said until every host has painted (its list, or the launch
  // mirror's rows): a count from half the hosts would flash and change.
  if (!ready) return;
  const count = badgeCount(sessionStore.metas(), archivedProjectIds(), loadLastSeen(), seenFloor());
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch((err) => {
    console.error("[dock] badge update failed:", err);
  });
}

/** Follows every input of the count: the metas, the read marks, the catalog. */
export function installDockBadge(): () => void {
  let live = true;
  void sessionStore.settledEnvironments().then(() => {
    if (!live) return;
    ready = true;
    syncDockBadge();
  });
  const offs = [sessionStore.onMetaChange(syncDockBadge), subscribeLastSeen(syncDockBadge), workspaceStore.subscribe(syncDockBadge)];
  return () => {
    live = false;
    for (const off of offs) off();
  };
}
