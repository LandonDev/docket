import { fixAllowed, HEALTH_OWN_COMPUTER, type HealthFix, type HealthReport, type HealthRow, type HealthState } from "@shared/work/health";
import type { ThreadState } from "../../components/ui/status";
import { nameInLine } from "../../lib/hostWords";
import { connectingWords, lifeosDownWords } from "../shell/lifeosWords";

/**
 * Connections, as the page lays it out (docs/agents/work-connections.md):
 * one section per kind of connection, each host's rows inside it, and a
 * Hosts section only while a host could not be checked. Pure, so the page,
 * its preview and its test read the same thing.
 */

/** One host as the page knows it: still checking (`silent`: after a check it did not answer), its rows, not linked now, or its refusal. */
export type HostView =
  /** `failed`: the host's last check failed and it is asked again: its Hosts row stands, its Retry spinning, until the answer */
  | { id: string; name: string; status: "checking"; report?: HealthReport; silent?: boolean; failed?: { error?: string } }
  | { id: string; name: string; status: "ready"; report: HealthReport }
  | { id: string; name: string; status: "offline" }
  | { id: string; name: string; status: "failed"; error?: string; silent?: boolean; report?: HealthReport };

export interface PlacedRow {
  key: string;
  hostId: string;
  /** the row's title, with its host when more than one host is listed: "Excel on Mac" */
  title: string;
  /** the line the page draws in place of the host's, where the page words it (`lifeosLine`) */
  line?: string;
  /**
   * The row's host did not answer its last check, and the row is LifeOS's silence from the check before: its line and
   * Retry are not drawn, since the Hosts row says the host's silence and asks it again. Its account control stays.
   */
  hushed?: true;
  row: HealthRow;
}

export interface Section {
  /** the heading; none where the group's one row has the group's own name ("Frame.io" over "Frame.io") */
  group: string;
  titled: boolean;
  rows: PlacedRow[];
}

/** The order the sections take: what everything else leans on first. A group not named here follows, in the order it came. */
export const GROUP_ORDER = ["LifeOS", "Mail and calendar", "Google", "Office", "Files", "Browser", "Windows VM", "Hosting", "Tools", "Frame.io"];

const rank = (group: string): number => {
  const at = GROUP_ORDER.indexOf(group);
  return at === -1 ? GROUP_ORDER.length : at;
};

/**
 * The sections, each host's rows in the order its host gave them. A row the
 * pillar marks `shared` (a LifeOS source, which every signed-in host reads
 * the same) is shown once when two hosts give it alike; a host's own row
 * never is, nor one with a fix, whose press belongs to its host; a title two hosts both give is told apart by its
 * host ("LifeOS on Mac"), and only then. A LifeOS row names its computer whenever the page lists more than one host:
 * in its line where the page words it in the rule's words ("Not signed in to LifeOS on the box", `lifeosLine`), else
 * in its title ("LifeOS answers on Mac"), never in both. A host still checking keeps the rows it had, so Check again
 * moves nothing. A host that did not answer keeps them too, but not an old cause beside its own: its row of LifeOS's
 * silence goes (LifeOS answers), or loses its line and Retry where it holds a control (the sign-in row's Sign out).
 */
export function sectionsOf(hosts: readonly HostView[]): Section[] {
  const placed: (PlacedRow & { hostName: string })[] = [];
  for (const host of hosts) {
    if (!("report" in host) || !host.report) continue;
    // Asked again after its silence, it stays hushed until it answers: the old cause never comes back for the ask.
    const silent = (host.status === "failed" || host.status === "checking") && !!host.silent;
    for (const row of host.report.rows) {
      const hushed = silent && row.pillar === "lifeos" && row.lifeos === "unreachable";
      if (hushed && !row.fix) continue;
      const twin = row.shared && !row.fix && placed.find((p) => p.row.shared && p.row.id === row.id && p.row.state === row.state && p.row.line === row.line && p.row.group === row.group);
      if (twin) continue;
      const line = hushed ? null : lifeosLine(row, host.name);
      placed.push({ key: `${host.id}\0${row.id}`, hostId: host.id, hostName: host.name, title: row.title, ...(line ? { line } : {}), ...(hushed ? { hushed: true as const } : {}), row });
    }
  }
  const byGroup = new Map<string, PlacedRow[]>();
  for (const one of placed) {
    const shared = placed.some((p) => p !== one && p.row.group === one.row.group && p.row.title === one.row.title && p.hostId !== one.hostId);
    const named = !one.line && (shared || (one.row.group === "LifeOS" && hosts.length > 1));
    const list = byGroup.get(one.row.group) ?? [];
    list.push({ key: one.key, hostId: one.hostId, title: named ? `${one.row.title} on ${nameInLine(one.hostName)}` : one.row.title, ...(one.line ? { line: one.line } : {}), ...(one.hushed ? { hushed: true as const } : {}), row: one.row });
    byGroup.set(one.row.group, list);
  }
  return [...byGroup.entries()].map(([group, rows], order) => ({ group, rows, order })).sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order).map(({ group, rows }) => ({ group, titled: !(rows.length === 1 && rows[0]!.title === group), rows }));
}

/**
 * A LifeOS row's line in the rule's words, its computer named (docs/DESIGN.md "Loading and empty states"), from the
 * state the host names on it (`HealthRow.lifeos`): "Not signed in to LifeOS on the box", "LifeOS did not answer Mac".
 * Null where the host's line says it whole ("Signed in", a key), and for a host a build behind, which names no state.
 */
export function lifeosLine(row: HealthRow, hostName: string): string | null {
  if (row.pillar !== "lifeos" || !row.lifeos || row.lifeos === "connected") return null;
  if (row.lifeos === "connecting") return connectingWords(hostName);
  const words = lifeosDownWords(row.lifeos, false, hostName);
  if (row.lifeos !== "unreachable") return words;
  // The sign-in row's time follows ("since 2:02 PM"); the answers row keeps a cause the host gave.
  if (row.id !== "lifeos.answers") return `${words}. Still trying since`;
  const why = /^(?:LifeOS )?did not answer: (.+)$/i.exec(row.line ?? "")?.[1];
  return why ? `${words}: ${why}` : words;
}

/**
 * A failed check as the row says it, from his words (`workErrorWords` already applied). An answer that never came is
 * "Did not answer", with no detail that would only say that again ("The host did not answer"); a host that answered
 * with a refusal did answer, so its word is "Not checked" and the refusal's words follow it.
 */
export function checkFailure(words: string): { word: string; error?: string; silent: boolean } {
  const silent = /\bdid not answer\b/i.test(words);
  return silent ? { word: "Did not answer", silent } : { word: "Not checked", silent, ...(words ? { error: words } : {}) };
}

/** The hosts that could not be checked: offline, or refused, and one asked again after a failed check, until it answers. */
export function unchecked(hosts: readonly HostView[]): HostView[] {
  return hosts.filter((h) => h.status === "offline" || h.status === "failed" || (h.status === "checking" && !!h.failed));
}

/** A row's state in the status vocabulary: the glyph and tone StatusMark gives, with this page's own word. */
export function markOf(state: HealthState): { state: ThreadState; word: string } {
  switch (state) {
    case "working":
      return { state: "done", word: "Ready" };
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

/**
 * A fix the page can carry out: only the allowed few (`fixAllowed`), whatever a host sent, and one that only a
 * window on the row's own computer may run (`HEALTH_OWN_COMPUTER`) only there (`own`): elsewhere the host refuses it.
 */
export function usableFix(fix: HealthFix | undefined, own = true): HealthFix | null {
  if (!fix || !fixAllowed(fix)) return null;
  return fix.kind === "run" && HEALTH_OWN_COMPUTER.includes(fix.method) && !own ? null : fix;
}
