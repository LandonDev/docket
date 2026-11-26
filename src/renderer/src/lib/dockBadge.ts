import type { SessionMeta } from "./tcserver/types";
import { threadStateOf } from "../components/ui/status";
import { invoke } from "./native";
import { IS_MAC } from "./platform";
import { sessionStore, type MetaChanges } from "./tcserver/store";
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

/**
 * The facts of a meta the count reads, as one string: a push that moves none of
 * them (a tool call, a phase, a context reading, a title) runs no pass.
 */
export function countingFacts(m: SessionMeta): string {
  return [
    m.status,
    m.archived ? 1 : 0,
    m.parentId ?? "",
    m.projectId ?? "",
    m.masterId ?? "",
    m.isMaster ? 1 : 0,
    m.updatedAt,
    m.readAt ?? "",
    m.treeHasPaused ? 1 : 0,
    m.treeCanContinue ? 1 : 0,
    m.treeHasLiveWork ? 1 : 0,
    m.background?.agents.length ? 1 : 0,
  ].join("\u0000");
}

let lastCount = -1;
let ready = false;
let passes = 0;
/** Each meta's counting facts as of the last pass, by id. */
let counted = new Map<string, string>();

/** Badge passes since load: tests count them. */
export function badgePasses(): number {
  return passes;
}

function archivedProjectIds(): Set<string> {
  return new Set(workspaceStore.getSnapshot().projects.filter((p) => p.archived).map((p) => p.id));
}

export function syncDockBadge(): void {
  // Nothing is said until every host has painted (its list, or the launch
  // mirror's rows): a count from half the hosts would flash and change.
  if (!ready) return;
  passes++;
  const metas = sessionStore.metas();
  const facts = new Map<string, string>();
  for (const meta of metas) facts.set(meta.id, countingFacts(meta));
  counted = facts;
  const count = badgeCount(metas, archivedProjectIds(), loadLastSeen(), seenFloor());
  if (count === lastCount) return;
  lastCount = count;
  void invoke("set_dock_badge", { count }).catch((err) => {
    console.error("[dock] badge update failed:", err);
  });
}

/** Whether a meta flush moved a fact the count reads; a flush that names no ids may have. */
export function movesCount(changes: MetaChanges, metaOf: (id: string) => SessionMeta | null = (id) => sessionStore.metaOf(id)): boolean {
  if (changes.ids.size === 0) return true;
  for (const id of changes.ids) {
    const meta = metaOf(id);
    if ((meta ? countingFacts(meta) : undefined) !== counted.get(id)) return true;
  }
  return false;
}

/** Follows every input of the count: the metas, the read marks, the catalog.
 *  Only macOS draws a Dock badge (main's `applyBadge`): elsewhere nothing is
 *  counted. `mac` is for tests. */
export function installDockBadge(mac = IS_MAC): () => void {
  if (!mac) return () => {};
  let live = true;
  void sessionStore.settledEnvironments().then(() => {
    if (!live) return;
    ready = true;
    syncDockBadge();
  });
  const onMetas = (changes: MetaChanges): void => {
    if (movesCount(changes)) syncDockBadge();
  };
  const offs = [sessionStore.onMetaChange(onMetas), subscribeLastSeen(syncDockBadge), workspaceStore.subscribe(syncDockBadge)];
  return () => {
    live = false;
    for (const off of offs) off();
  };
}
