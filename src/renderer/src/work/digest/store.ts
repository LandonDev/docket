import { useSyncExternalStore } from "react";
import { DIGEST_FIELDS, type DigestDay, type DigestField, type DigestList, type DigestSettings } from "@shared/contract-work-digest";
import { DEFAULT_LEVEL } from "@shared/work/digest";
import type { TellGroup, TellLevel, TellRow } from "@shared/work/tell";
import { registry } from "../../lib/connection";
import { workSwitch } from "../../lib/workSwitch";

/**
 * The digest as the screens read it (docs/agents/work-digest.md): each host
 * with Work on keeps its own ledger; this asks each for it when its link
 * opens, keeps the `work.digest` push, and merges them as the Outbox's
 * store does. A thing two hosts tell under one key is one row, and hosts'
 * days of the same date are one day.
 */

/** A tell with the link it came over: the id this window knows its host by ("local" for this machine's own), which a route to another surface's item needs. */
export type HostTell = TellRow & { environmentId: string };
const tagged = (environmentId: string, rows: readonly TellRow[]): HostTell[] => rows.map((row) => ({ ...row, environmentId }));

type HostState = {
  days: DigestDay[];
  rows: HostTell[];
  settings: DigestSettings | null;
  loaded: boolean;
  error: string | null;
};

/** A day across hosts: seen once any host's is. */
export type MergedDay = { day: string; madeAt: number; seenAt: number | null; hosts: string[]; /** when each host made it: a host that made its day late told its own rows by its own clock */ madeBy?: Record<string, number> };

export type DigestView = {
  days: MergedDay[];
  /** newest first; one row a key across hosts */
  rows: HostTell[];
  /** each field's newest setting across the hosts: they are written alike, and one that missed a write is brought to these */
  settings: DigestSettings | null;
  /** every host with Work on has answered once, or failed to */
  loaded: boolean;
  /** hosts whose ledger did not come back */
  errors: { environmentId: string; error: string }[];
};

const hosts = new Map<string, HostState>();
const listeners = new Set<() => void>();
let snapshot: DigestView | null = null;

const emptyHost = (): HostState => ({ days: [], rows: [], settings: null, loaded: false, error: null });
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function changed(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** One row a key: the one he was told of at once wins, else the newest. */
export function mergeRows<R extends TellRow>(lists: readonly (readonly R[])[]): R[] {
  const byName = new Map<string, R>();
  for (const rows of lists) {
    for (const row of rows) {
      const name = row.key ? `k:${row.key}` : `i:${row.host}:${row.id}`;
      const had = byName.get(name);
      if (!had || (row.toldAt !== null && had.toldAt === null) || (row.toldAt === null) === (had.toldAt === null) && row.at > had.at) byName.set(name, row);
    }
  }
  return [...byName.values()].sort((a, b) => b.at - a.at);
}

export function mergeDays(lists: readonly { environmentId: string; days: readonly DigestDay[] }[]): MergedDay[] {
  const byDay = new Map<string, MergedDay>();
  for (const { environmentId, days } of lists) {
    for (const d of days) {
      const had = byDay.get(d.day);
      if (!had) byDay.set(d.day, { day: d.day, madeAt: d.madeAt, seenAt: d.seenAt, hosts: [environmentId], madeBy: { [environmentId]: d.madeAt } });
      else byDay.set(d.day, { day: d.day, madeAt: Math.min(had.madeAt, d.madeAt), seenAt: had.seenAt ?? d.seenAt, hosts: [...had.hosts, environmentId], madeBy: { ...had.madeBy, [environmentId]: d.madeAt } });
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

type HostSettings = { environmentId: string; settings: DigestSettings };
type SettingsPatch = { at?: string; levels?: Partial<Record<TellGroup, TellLevel>>; setAt?: Partial<Record<DigestField, number>> };

/** A field's value on a host: the time, or a group's level (the default where he set none). */
const valueOf = (s: DigestSettings, field: DigestField): string => (field === "at" ? s.at : s.levels[field] ?? DEFAULT_LEVEL);

/**
 * The settings he sees: each field's newest setting across the hosts, the
 * first host's where a field was never set anywhere. Hosts are written
 * alike, so they differ only where one missed a write.
 */
export function newestSettings(all: readonly DigestSettings[]): DigestSettings | null {
  const first = all[0];
  if (!first) return null;
  const newest = (field: DigestField): DigestSettings => all.reduce((best, s) => ((s.setAt?.[field] ?? 0) > (best.setAt?.[field] ?? 0) ? s : best), first);
  const levels: Partial<Record<TellGroup, TellLevel>> = {};
  const setAt: Partial<Record<DigestField, number>> = {};
  for (const field of DIGEST_FIELDS) {
    const from = newest(field);
    const at = from.setAt?.[field];
    if (at !== undefined) setAt[field] = at;
    if (field !== "at" && from.levels[field] && from.levels[field] !== DEFAULT_LEVEL) levels[field] = from.levels[field];
  }
  return { ...first, at: newest("at").at, levels, ...(Object.keys(setAt).length ? { setAt } : {}) };
}

/**
 * For each host that missed a write: the fields it holds an older setting
 * of, with the time each was set, so the host stamps them as set then and
 * never as set now. A field no host says when it was set is left alone
 * (nothing says which is right). Empty when every host holds every field's
 * newest setting, stamp and all.
 */
export function staleSettings(all: readonly HostSettings[]): { environmentId: string; patch: SettingsPatch }[] {
  const newest = newestSettings(all.map((h) => h.settings));
  if (!newest?.setAt) return [];
  const out: { environmentId: string; patch: SettingsPatch }[] = [];
  for (const { environmentId, settings } of all) {
    const patch: SettingsPatch = {};
    for (const field of DIGEST_FIELDS) {
      const at = newest.setAt[field];
      // An older stamp is repaired though the value already matches: going back to an earlier choice is a new edit,
      // and a host that only happens to agree must not lose it later to a peer that holds a choice from in between.
      if (at === undefined || (settings.setAt?.[field] ?? 0) >= at) continue;
      patch.setAt = { ...patch.setAt, [field]: at };
      if (field === "at") patch.at = newest.at;
      else patch.levels = { ...patch.levels, [field]: valueOf(newest, field) as TellLevel };
    }
    if (patch.setAt) out.push({ environmentId, patch });
  }
  return out;
}

/** Whether each of these hosts is known to hold `value` for a field: a refusal is over once the hosts that refused do. One whose settings were never read is not known to. */
export function hostsHold(environmentIds: readonly string[], field: DigestField, value: string): boolean {
  return environmentIds.every((id) => {
    const settings = hosts.get(id)?.settings;
    return !!settings && valueOf(settings, field) === value;
  });
}

let aligning = false;
/** Writes of his own on their way: nothing is brought into line under them. */
let writing = 0;
/** After a host's settings are read: the fields it missed are written to it, each as set when it was. A host that refuses is left as it is. */
async function align(): Promise<void> {
  if (aligning || writing > 0) return;
  const on = [...workSwitch.hosts()].flatMap((environmentId) => {
    const settings = hosts.get(environmentId)?.settings;
    return settings ? [{ environmentId, settings }] : [];
  });
  const stale = staleSettings(on);
  if (stale.length === 0) return;
  aligning = true;
  try {
    await Promise.allSettled(
      stale.map(({ environmentId, patch }) =>
        registry
          .linkOf(environmentId)
          .request<DigestSettings>("work.digest.set", patch)
          .then((settings) => {
            const state = hosts.get(environmentId);
            if (state) hosts.set(environmentId, { ...state, settings });
          }),
      ),
    );
  } finally {
    aligning = false;
    changed();
  }
}

function view(): DigestView {
  if (snapshot) return snapshot;
  const on = [...workSwitch.hosts()];
  const states = on.map((id) => ({ environmentId: id, state: hosts.get(id) })).filter((h): h is { environmentId: string; state: HostState } => !!h.state);
  snapshot = {
    days: mergeDays(states.map((h) => ({ environmentId: h.environmentId, days: seenHere(h.environmentId, h.state.days) }))),
    rows: mergeRows(states.map((h) => h.state.rows)),
    settings: newestSettings(states.flatMap((h) => (h.state.settings ? [h.state.settings] : []))),
    loaded: on.length > 0 && on.every((id) => hosts.get(id)?.loaded),
    errors: states.filter((h) => h.state.error).map((h) => ({ environmentId: h.environmentId, error: h.state.error! })),
  };
  return snapshot;
}

const loading = new Map<string, Promise<void>>();

/** One host's ledger and settings. */
export function loadHost(environmentId: string): Promise<void> {
  const inFlight = loading.get(environmentId);
  if (inFlight) return inFlight;
  const link = registry.linkOf(environmentId);
  const load = Promise.all([link.request<DigestList>("work.digest.list", {}), link.request<DigestSettings>("work.digest.get", {})])
    .then(([list, settings]) => {
      hosts.set(environmentId, { days: list.days, rows: tagged(environmentId, list.rows), settings, loaded: true, error: null });
    })
    .catch((err: unknown) => {
      hosts.set(environmentId, { ...(hosts.get(environmentId) ?? emptyHost()), loaded: true, error: errorText(err) });
    })
    .finally(() => {
      loading.delete(environmentId);
      changed();
      void align();
    });
  loading.set(environmentId, load);
  return load;
}

export function loadDigest(): Promise<void> {
  return Promise.all([...workSwitch.hosts()].map(loadHost)).then(() => undefined);
}

/** The desktop he is at says its zone, so the digest follows it. A host that cannot take it (older, or this key may not operate) is left alone. */
function sayHere(environmentId: string): void {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return;
  }
  if (zone) void registry.linkOf(environmentId).request("work.digest.here", { zone }).catch(() => {});
}

// ── seen, until the host has heard ───────────────────────────────────────

const SEEN_KEY = "work.digest.seen.pending";
/**
 * The days he opened or closed whose host has not answered yet, by host,
 * with when. Kept through a reload and said again when the host's link
 * opens, and laid over what the host answers meanwhile: a lost connection
 * never brings back a notice he closed.
 */
const pendingSeen = new Map<string, Map<string, number>>();
function readPendingSeen(): void {
  pendingSeen.clear();
  try {
    const kept = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, Record<string, number>>;
    for (const [environmentId, days] of Object.entries(kept ?? {})) pendingSeen.set(environmentId, new Map(Object.entries(days ?? {}).filter(([, at]) => typeof at === "number")));
  } catch {
    // Nothing kept: a notice closed while a host was away may show once more.
  }
}
function writePendingSeen(): void {
  try {
    // The newest 40 days a host: the ledger keeps thirty.
    const kept = Object.fromEntries([...pendingSeen].filter(([, days]) => days.size > 0).map(([id, days]) => [id, Object.fromEntries([...days].sort().slice(-40))]));
    if (Object.keys(kept).length) localStorage.setItem(SEEN_KEY, JSON.stringify(kept));
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    // A full store only means the mark is not kept through a reload.
  }
}
readPendingSeen();

/** A host's days as he left them: one he opened whose host has not heard yet reads seen. */
const seenHere = (environmentId: string, days: readonly DigestDay[]): DigestDay[] => {
  const pending = pendingSeen.get(environmentId);
  return pending?.size ? days.map((d) => (d.seenAt === null && pending.has(d.day) ? { ...d, seenAt: pending.get(d.day)! } : d)) : [...days];
};

/** Says a day was seen to its host, and keeps saying it until the host answers. */
function sendSeen(environmentId: string, day: string, at = Date.now()): void {
  const days = pendingSeen.get(environmentId) ?? new Map<string, number>();
  if (!days.has(day)) days.set(day, at);
  pendingSeen.set(environmentId, days);
  writePendingSeen();
  void registry
    .linkOf(environmentId)
    .request("work.digest.seen", { day })
    .then(() => {
      pendingSeen.get(environmentId)?.delete(day);
      writePendingSeen();
    })
    .catch(() => {
      // Kept: said again when the link opens.
    });
}

/** He opened these days' digest: every host that holds one is told, and each window's notice goes with the push. */
export function markSeen(days: readonly MergedDay[]): void {
  for (const day of days) {
    if (day.seenAt !== null) continue;
    // At once here (the pending mark reads seen), so the notice leaves on the press and not on the host's answer.
    for (const environmentId of day.hosts) sendSeen(environmentId, day.day);
  }
  changed();
}

/** The time and the levels are written to every host with Work on; answers the hosts that refused, with why. */
export async function setDigest(patch: { at?: string; levels?: Partial<Record<TellGroup, TellLevel>> }): Promise<{ environmentId: string; error: string }[]> {
  const on = [...workSwitch.hosts()];
  writing += 1;
  const answers = await Promise.allSettled(on.map((id) => registry.linkOf(id).request<DigestSettings>("work.digest.set", patch))).finally(() => (writing -= 1));
  const refused: { environmentId: string; error: string }[] = [];
  answers.forEach((answer, i) => {
    const environmentId = on[i]!;
    if (answer.status === "rejected") return void refused.push({ environmentId, error: errorText(answer.reason) });
    const state = hosts.get(environmentId) ?? emptyHost();
    hosts.set(environmentId, { ...state, settings: answer.value });
  });
  changed();
  return refused;
}

export function useDigest(): DigestView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    view,
    view,
  );
}

/** Read outside React. */
export const digestNow = (): DigestView => view();

// ── the sheet ─────────────────────────────────────────────────────────────

let sheetOpen = false;
const sheetListeners = new Set<() => void>();
/** The digest's list, opened from the notice, Settings and the command. */
export function openDigestSheet(open = true): void {
  if (sheetOpen === open) return;
  sheetOpen = open;
  for (const listener of sheetListeners) listener();
}
export function useDigestSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      sheetListeners.add(listener);
      return () => void sheetListeners.delete(listener);
    },
    () => sheetOpen,
    () => sheetOpen,
  );
}

// ── a row's press, from outside the host component ────────────────────────

let opener: ((row: TellRow) => void) | null = null;
/** `DigestHost` hands over its row press while it is mounted. */
export function setTellOpener(next: ((row: TellRow) => void) | null): void {
  opener = next;
}
/** Opens a tell's target through the digest's own routes: what Today's rows of the digest press. */
export function openTell(row: TellRow): void {
  opener?.(row);
}

/** Test seam. */
export function resetDigestStore(): void {
  hosts.clear();
  loading.clear();
  aligning = false;
  writing = 0;
  pendingSeen.clear();
  writePendingSeen();
  sheetOpen = false;
  changed();
}
/** Test seam: a host's ledger as if it had answered. */
export function seedDigestHost(environmentId: string, state: Partial<Omit<HostState, "rows">> & { rows?: TellRow[] }): void {
  hosts.set(environmentId, { ...emptyHost(), loaded: true, ...state, rows: tagged(environmentId, state.rows ?? []) });
  changed();
}

// ── pushes ────────────────────────────────────────────────────────────────

registry.onLink((link, event) => {
  if (event === "removed") {
    hosts.delete(link.environmentId);
    changed();
    return;
  }
  link.onPush((push) => {
    if (push.push !== "work.digest") return;
    const state = hosts.get(link.environmentId);
    // Not read yet: the load that is coming holds it.
    if (!state?.loaded) return;
    let next = state;
    if (push.day) next = { ...next, days: [push.day, ...next.days.filter((d) => d.day !== push.day!.day)] };
    if (push.row) next = { ...next, rows: [...tagged(link.environmentId, [push.row]), ...next.rows.filter((r) => r.id !== push.row!.id)] };
    if (push.gone) next = { ...next, rows: next.rows.filter((r) => r.id !== push.gone) };
    if (push.settings) next = { ...next, settings: push.settings };
    // A day made stamps its rows on the host: read them again rather than guess.
    if (push.day && push.day.seenAt === null) void loadHost(link.environmentId);
    hosts.set(link.environmentId, next);
    changed();
  });
  link.onOpen(() => {
    if (!workSwitch.hosts().has(link.environmentId)) return;
    // What he saw while this host was away is said now.
    for (const [day, at] of pendingSeen.get(link.environmentId) ?? []) sendSeen(link.environmentId, day, at);
    void loadHost(link.environmentId);
    sayHere(link.environmentId);
  });
});

// A host whose Work turned on is read from then; one turned off leaves the view.
let onBefore = new Set(workSwitch.hosts());
workSwitch.subscribe(() => {
  const now = workSwitch.hosts();
  if (now.size === onBefore.size && [...now].every((id) => onBefore.has(id))) return;
  for (const id of now) {
    if (onBefore.has(id)) continue;
    void loadHost(id);
    sayHere(id);
  }
  onBefore = new Set(now);
  changed();
});

// Hosts already on and linked when this chunk lands.
for (const id of workSwitch.hosts()) {
  void loadHost(id);
  sayHere(id);
}
