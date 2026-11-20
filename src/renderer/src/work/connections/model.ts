import { fixAllowed, type HealthFix, type HealthReport, type HealthRow, type HealthState } from "@shared/work/health";
import type { ThreadState } from "../../components/ui/status";

/**
 * Connections, as the page lays it out (docs/agents/work-connections.md):
 * one section per kind of connection, each host's rows inside it, and a
 * Hosts section only while a host could not be checked. Pure, so the page,
 * its preview and its test read the same thing.
 */

/** One host as the page knows it: still checking, its rows, not linked now, or its refusal. */
export type HostView =
  | { id: string; name: string; status: "checking"; report?: HealthReport }
  | { id: string; name: string; status: "ready"; report: HealthReport }
  | { id: string; name: string; status: "offline" }
  | { id: string; name: string; status: "failed"; error: string; report?: HealthReport };

export interface PlacedRow {
  key: string;
  hostId: string;
  /** the row's title, with its host when more than one host is listed: "Excel on Mac" */
  title: string;
  row: HealthRow;
}

export interface Section {
  group: string;
  rows: PlacedRow[];
}

/** The order the sections take: what everything else leans on first. A group not named here follows, in the order it came. */
export const GROUP_ORDER = ["LifeOS", "Mail and calendar", "Google", "Office", "Files", "Browser", "Windows VM", "Work service", "Tools", "Frame.io"];

const rank = (group: string): number => {
  const at = GROUP_ORDER.indexOf(group);
  return at === -1 ? GROUP_ORDER.length : at;
};

/**
 * The sections, each host's rows in the order its host gave them. A row the
 * pillar marks `shared` (a LifeOS source, which every signed-in host reads
 * the same) is shown once when two hosts give it alike; a host's own row
 * never is, nor one with a fix, whose press belongs to its host; a title two hosts both give is told apart by its
 * host ("LifeOS on Mac"), and only then. A host still checking keeps the
 * rows it had, so Check again moves nothing.
 */
export function sectionsOf(hosts: readonly HostView[]): Section[] {
  const placed: (PlacedRow & { hostName: string })[] = [];
  for (const host of hosts) {
    if (!("report" in host) || !host.report) continue;
    for (const row of host.report.rows) {
      const twin = row.shared && !row.fix && placed.find((p) => p.row.shared && p.row.id === row.id && p.row.state === row.state && p.row.line === row.line && p.row.group === row.group);
      if (twin) continue;
      placed.push({ key: `${host.id}\0${row.id}`, hostId: host.id, hostName: host.name, title: row.title, row });
    }
  }
  const byGroup = new Map<string, PlacedRow[]>();
  for (const one of placed) {
    const shared = placed.some((p) => p !== one && p.row.group === one.row.group && p.row.title === one.row.title && p.hostId !== one.hostId);
    const list = byGroup.get(one.row.group) ?? [];
    list.push({ key: one.key, hostId: one.hostId, title: shared ? `${one.row.title} on ${one.hostName}` : one.row.title, row: one.row });
    byGroup.set(one.row.group, list);
  }
  return [...byGroup.entries()].map(([group, rows], order) => ({ group, rows, order })).sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order).map(({ group, rows }) => ({ group, rows }));
}

/** The hosts that could not be checked: offline, or refused. */
export function unchecked(hosts: readonly HostView[]): HostView[] {
  return hosts.filter((h) => h.status === "offline" || h.status === "failed");
}

/** A row's state in the status vocabulary: the glyph and tone StatusMark gives, with this page's own word. */
export function markOf(state: HealthState): { state: ThreadState; word: string } {
  switch (state) {
    case "working":
      return { state: "done", word: "Working" };
    case "needs-you":
      return { state: "waiting", word: "Needs you" };
    case "broken":
      return { state: "failed", word: "Broken" };
  }
}

/** The button's weight: raised where a press makes it work, ghost on a row that works (Sign out). */
export function fixVariant(state: HealthState): "secondary" | "ghost" {
  return state === "working" ? "ghost" : "secondary";
}

/** A fix the page can carry out: only the allowed few (`fixAllowed`), whatever a host sent. */
export function usableFix(fix: HealthFix | undefined): HealthFix | null {
  return fix && fixAllowed(fix) ? fix : null;
}
