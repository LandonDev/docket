import { useEffect } from "react";
import { lapseLine, lapseStage, type Lapse } from "@shared/work/health";
import { loadToast } from "../../components/ui/toaster";
import { registry, useEnvironments, useEnvironmentStatuses } from "../../lib/connection";
import { requestSettings } from "../../lib/monaco/debugTab";
import { useWorkHosts } from "../../lib/workSwitch";

/**
 * The app's notice before something Work leans on ends
 * (docs/agents/work-connections.md "Things that lapse"): 14 days before,
 * and again the day before, each said once per window. Each host answers
 * `work.lapses` from what it holds, so asking costs nothing: once a host's
 * link opens, then every six hours while Work is on.
 */

const SEEN_KEY = "work.lapsesNoticed";
const ASK_EVERY_MS = 6 * 3_600_000;

export interface DueNotice {
  key: string;
  text: string;
}

/** The notices due now that this window has not given: one per lapse and stage. */
export function dueNotices(hostId: string, lapses: readonly Lapse[], seen: ReadonlySet<string>, now: number): DueNotice[] {
  const due: DueNotice[] = [];
  for (const lapse of lapses) {
    const stage = lapseStage(lapse.until, now);
    if (stage === null) continue;
    const key = `${hostId}\0${lapse.id}\0${lapse.until}\0${stage}`;
    if (!seen.has(key)) due.push({ key, text: `${lapse.title}: ${lapseLine(lapse.until, now)}` });
  }
  return due;
}

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function markSeen(keys: readonly string[]): void {
  // The newest 200: a lapse long past drops off on its own.
  const all = [...readSeen(), ...keys].slice(-200);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // A full store only means the notice may be said again.
  }
}

async function askHost(hostId: string): Promise<void> {
  let lapses: Lapse[];
  try {
    lapses = await registry.linkOf(hostId).request<Lapse[]>("work.lapses", {});
  } catch {
    return; // an older host, or Work off there: nothing to say
  }
  const due = dueNotices(hostId, lapses, readSeen(), Date.now());
  if (!due.length) return;
  markSeen(due.map((d) => d.key));
  const toast = await loadToast();
  for (const notice of due) toast(notice.text, { action: { label: "Connections", onClick: () => requestSettings("connections") } });
}

/** Mounted once while Work is on (WorkRailHost); draws nothing. */
export function LapseNotices() {
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const on = useWorkHosts();
  const open = environments.filter((e) => on.has(e.id) && statuses.get(e.id)?.transport === "open").map((e) => e.id);
  const key = open.join();
  useEffect(() => {
    for (const id of open) void askHost(id);
    const timer = window.setInterval(() => {
      for (const id of open) void askHost(id);
    }, ASK_EVERY_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}
