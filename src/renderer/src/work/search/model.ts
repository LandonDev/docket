import { mentionMatches } from "@shared/work/mentions";
import {
  RECENT_KIND,
  SEARCH_ALL,
  SEARCH_PER_GROUP,
  SEARCH_RECENTS,
  searchLabel,
  searchNoun,
  searchRank,
  type SearchAnswer,
  type SearchGroup,
  type SearchHit,
} from "@shared/work/search";

/**
 * Work search in the window, as plain data (docs/agents/work-search.md "The
 * window"): what was asked, what has landed and what is still out, and the
 * rows the picker draws from them. Pure, so every rule of the list is a
 * unit test:
 *
 * - A generation a keystroke. An answer of an older generation is dropped.
 * - Groups stand in `SEARCH_ORDER`, never by speed or score; rows on screen
 *   never change order among themselves.
 * - A thing is shown once, in the first group that has it, whichever source
 *   or host found it.
 * - The highlight stays on the first row until he moves it; then it stays
 *   on the row he chose, wherever that row now stands.
 */

/** A host asked: the Work home first. */
export interface SearchHost {
  id: string;
  name: string;
  /** the one host asked for what LifeOS holds */
  home: boolean;
}

/** What one source of one host answered. */
export interface Slot {
  host: string;
  source: string;
  kind: string;
  label: string;
  tier: "instant" | "network";
  hits: SearchHit[];
  more: boolean;
  /** the generation it answered; an older one is shown only while it still holds the words */
  gen: number;
}

export interface SearchModel {
  gen: number;
  /** his words, trimmed */
  text: string;
  /** one kind alone, or null */
  kind: string | null;
  /** the job the search is held to (its key), or null for all jobs */
  scope: string | null;
  hosts: SearchHost[];
  slots: Slot[];
  /** what was asked this generation and has not answered: `<host>\n*` for a host's first answer, `<host>\n<source>` for a source */
  out: ReadonlySet<string>;
  /** one line a cause, in the order they came */
  quiet: { key: string; line: string }[];
  /** kinds in the order they were first seen, for the ones the fixed order does not name */
  seen: string[];
  /** he moved the highlight (an arrow, the pointer): it stays on `active` */
  moved: boolean;
  active: string | null;
}

export const emptyModel = (): SearchModel => ({ gen: 0, text: "", kind: null, scope: null, hosts: [], slots: [], out: new Set(), quiet: [], seen: [], moved: false, active: null });

const outKey = (host: string, source = "*"): string => `${host}\n${source}`;

/** The network tier waits for this long after his last key, and for this many characters. */
export const NETWORK_WAIT_MS = 120;
export const NETWORK_MIN_CHARS = 2;
export const asksNetwork = (text: string): boolean => text.trim().length >= NETWORK_MIN_CHARS;

/**
 * A new generation: his words, the kind and the hosts to ask. Every host's
 * first answer is out. What is on screen stays until its own answer lands,
 * shown only where it still holds the words. A change of scope clears the
 * list at once: a row of a job the search no longer reads must not stand
 * there, unlabelled, for a Return to take. A change of words, kind or scope
 * puts the highlight back on the first row; `offline` are hosts with Work
 * on that cannot be asked, each one quiet line.
 */
export function begin(model: SearchModel, ask: { text: string; kind: string | null; scope?: string | null; hosts: SearchHost[]; offline?: readonly string[] }): SearchModel {
  const text = ask.text.trim();
  const scope = ask.scope ?? null;
  const same = text === model.text && ask.kind === model.kind && scope === model.scope;
  return {
    ...model,
    gen: model.gen + 1,
    text,
    kind: ask.kind,
    scope,
    hosts: ask.hosts,
    slots: scope === model.scope ? model.slots.filter((slot) => ask.hosts.some((h) => h.id === slot.host)) : [],
    out: new Set(ask.hosts.map((h) => outKey(h.id))),
    quiet: (ask.offline ?? []).map((name) => ({ key: `offline:${name}`, line: `${name} is offline.` })),
    moved: same ? model.moved : false,
    active: same ? model.active : null,
  };
}

/** What a host is asked first, and then for one source: `own` to every host but the Work home, so LifeOS is asked once. */
export function paramsFor(model: SearchModel, host: SearchHost, o: { workspaceId?: string; sources?: string[] }): Record<string, unknown> {
  return {
    text: model.text,
    ...(o.workspaceId ? { workspaceId: o.workspaceId } : {}),
    ...(o.sources ? { sources: o.sources } : { tier: "instant" }),
    ...(model.kind ? { kind: model.kind } : {}),
    ...(host.home ? {} : { own: true }),
  };
}

const slotOf = (host: string, group: SearchGroup, tier: Slot["tier"], gen: number): Slot => ({ host, source: group.source, kind: group.kind, label: group.label, tier, hits: group.hits, more: group.more, gen });

/** LifeOS's and a host's own words, as the list's foot says them. */
export function quietLine(cause: string, line: string, host: SearchHost, hosts: number): { key: string; line: string } {
  if (cause === "lifeos") {
    const words: Record<string, string> = {
      "This host is not signed in to LifeOS": `LifeOS is signed out on ${host.name}.`,
      "This host's LifeOS sign-in waits for approval": `LifeOS sign-in on ${host.name} waits for approval.`,
      "LifeOS is still connecting": `LifeOS is still connecting on ${host.name}.`,
      "LifeOS is unreachable": `${host.name} cannot reach LifeOS.`,
      "LifeOS refused this host's sign-in; sign in again": `LifeOS refused the sign-in on ${host.name}.`,
    };
    return { key: "lifeos", line: words[line] ?? `${line.replace(/\.$/, "")}.` };
  }
  const said = `${line.replace(/\.$/, "")}`;
  return { key: `${cause}@${host.id}`, line: hosts > 1 ? `${said} on ${host.name}.` : `${said}.` };
}

function withQuiet(model: SearchModel, host: SearchHost, quiet: SearchAnswer["quiet"]): SearchModel["quiet"] {
  const out = [...model.quiet];
  for (const q of quiet) {
    const line = quietLine(q.cause, q.line, host, model.hosts.length);
    if (!out.some((have) => have.key === line.key)) out.push(line);
  }
  return out;
}

const withSeen = (seen: string[], groups: readonly SearchGroup[]): string[] => [...seen, ...groups.map((g) => g.kind).filter((kind, i, all) => !seen.includes(kind) && all.indexOf(kind) === i)];

/**
 * A host's first answer: its instant groups stand in the place of that
 * host's instant rows, and the network sources it named are out (asked by
 * the caller once he has stopped typing; none under two characters). A
 * network row of an older generation stays until its own answer lands,
 * unless its source is no longer asked.
 */
export function landInstant(model: SearchModel, gen: number, hostId: string, answer: SearchAnswer): { model: SearchModel; ask: { source: string; kind: string }[] } {
  const host = model.hosts.find((h) => h.id === hostId);
  if (gen !== model.gen || !host) return { model, ask: [] };
  const ask = asksNetwork(model.text) ? answer.pending : [];
  const out = new Set(model.out);
  out.delete(outKey(hostId));
  for (const { source } of ask) out.add(outKey(hostId, source));
  const kept = model.slots.filter((slot) => slot.host !== hostId || (slot.tier === "network" && ask.some((a) => a.source === slot.source)));
  return {
    model: { ...model, out, slots: [...kept, ...answer.groups.map((g) => slotOf(hostId, g, "instant", gen))], quiet: withQuiet(model, host, answer.quiet), seen: withSeen(model.seen, answer.groups) },
    ask,
  };
}

/** One network source's answer: its rows stand in the place of that source's, or leave when it found none. */
export function landSource(model: SearchModel, gen: number, hostId: string, source: string, answer: SearchAnswer): SearchModel {
  const host = model.hosts.find((h) => h.id === hostId);
  if (gen !== model.gen || !host) return model;
  const out = new Set(model.out);
  out.delete(outKey(hostId, source));
  const kept = model.slots.filter((slot) => !(slot.host === hostId && slot.source === source));
  return { ...model, out, slots: [...kept, ...answer.groups.map((g) => slotOf(hostId, g, "network", gen))], quiet: withQuiet(model, host, answer.quiet), seen: withSeen(model.seen, answer.groups) };
}

/**
 * A host that did not answer its first ask: its rows leave, and it is one
 * quiet line by its name. One source of a host that did not answer: that
 * source's rows leave and the line names the kind ("Mail did not answer."),
 * since the host's other sources did.
 */
export function failed(model: SearchModel, gen: number, hostId: string, source: { source: string; kind: string } | null): SearchModel {
  const host = model.hosts.find((h) => h.id === hostId);
  if (gen !== model.gen || !host) return model;
  const out = new Set(model.out);
  out.delete(outKey(hostId, source?.source ?? "*"));
  const slots = model.slots.filter((slot) => slot.host !== hostId || (source !== null && slot.source !== source.source));
  const said = source ? quietLine(`source:${source.source}`, `${searchLabel(source.kind)} did not answer`, host, model.hosts.length) : { key: `host:${hostId}`, line: `${host.name} did not answer.` };
  const quiet = model.quiet.some((q) => q.key === said.key) ? model.quiet : [...model.quiet, said];
  return { ...model, out, slots, quiet };
}

/** Whether any host could be asked and answered: with none, there is nothing to say was not found. */
const someoneAnswered = (model: SearchModel): boolean => model.hosts.some((h) => !model.quiet.some((q) => q.key === `host:${h.id}`));

/** Something asked this generation is still out: the field's spinner. */
export const busy = (model: SearchModel): boolean => model.out.size > 0;

export type Row =
  | { type: "heading"; id: string; label: string }
  | { type: "hit"; id: string; hit: SearchHit; host: string }
  /** "All mail for …": Return narrows the picker to the kind */
  | { type: "all"; id: string; kind: string; label: string }
  /** "Search all jobs", under nothing found in one job */
  | { type: "widen"; id: string; label: string }
  | { type: "note"; id: string; text: string };

/** A row Return can take. */
export type Option = Extract<Row, { type: "hit" | "all" | "widen" }>;
export const isOption = (row: Row): row is Option => row.type === "hit" || row.type === "all" || row.type === "widen";

/**
 * The list, top to bottom. Kinds stand in the fixed order (Recent first,
 * then a kind the order does not name in the order it was first seen);
 * within a kind, the Work home's rows before another host's and what a
 * host knew at once before what it fetched, so a row that lands later goes
 * under the rows of its kind already there, never among them.
 */
export function rowsOf(model: SearchModel, o: { scoped?: boolean } = {}): Row[] {
  const rank = (kind: string): number => (kind === RECENT_KIND ? -1 : searchRank(kind));
  const place = (slot: Slot): number[] => [rank(slot.kind), model.seen.indexOf(slot.kind), model.hosts.findIndex((h) => h.id === slot.host), slot.tier === "instant" ? 0 : 1];
  const shown = model.slots
    .filter((slot) => (model.text ? slot.kind !== RECENT_KIND : slot.kind === RECENT_KIND))
    .filter((slot) => model.kind === null || slot.kind === model.kind)
    .map((slot, index) => ({ slot, index, at: place(slot) }))
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.at[3] - b.at[3] || a.slot.source.localeCompare(b.slot.source) || a.index - b.index);

  const rows: Row[] = [];
  const taken = new Set<string>();
  const kinds = [...new Set(shown.map((s) => s.slot.kind))];
  let hits = 0;
  for (const kind of kinds) {
    const cap = kind === RECENT_KIND ? SEARCH_RECENTS : model.kind ? SEARCH_ALL : SEARCH_PER_GROUP;
    const mine = shown.filter((s) => s.slot.kind === kind).map((s) => s.slot);
    const fresh: { hit: SearchHit; host: string }[] = [];
    let more = false;
    for (const slot of mine) {
      // A row of an older generation waits for its own answer only while it still holds his words.
      const stale = slot.gen !== model.gen;
      for (const hit of slot.hits) {
        if (taken.has(hit.key)) continue;
        if (stale && model.text && !mentionMatches(model.text, hit.title, hit.detail, hit.snippet)) continue;
        taken.add(hit.key);
        fresh.push({ hit, host: slot.host });
      }
      more ||= slot.more && !stale;
    }
    if (fresh.length === 0) continue;
    // Recent is one list across hosts: what he opened last, wherever he opened it.
    if (kind === RECENT_KIND) fresh.sort((a, b) => (b.hit.openedAt ?? 0) - (a.hit.openedAt ?? 0));
    more ||= fresh.length > cap;
    const shownHits = fresh.slice(0, cap);
    // The row he chose is never the one the cap cuts: when rows that landed since stand before it, it takes the last place.
    const chosen = model.moved && model.active ? fresh.findIndex((f) => `hit:${f.hit.key}` === model.active) : -1;
    if (chosen >= cap) shownHits[cap - 1] = fresh[chosen];
    // Held to one kind, the field already names it: no heading says it again.
    if (!model.kind) rows.push({ type: "heading", id: `heading:${kind}`, label: mine[0].label });
    for (const { hit, host } of shownHits) rows.push({ type: "hit", id: `hit:${hit.key}`, hit, host });
    hits += shownHits.length;
    if (more && !model.kind && kind !== RECENT_KIND) rows.push({ type: "all", id: `all:${kind}`, kind, label: `All ${searchNoun(kind, mine[0].label)} for “${model.text}”` });
  }
  if (hits === 0 && model.text && !busy(model) && someoneAnswered(model)) {
    rows.push({ type: "note", id: "nothing", text: `Nothing for “${model.text}”` });
    if (o.scoped) rows.push({ type: "widen", id: "widen", label: "Search all jobs" });
  }
  for (const quiet of model.quiet) rows.push({ type: "note", id: `quiet:${quiet.key}`, text: quiet.line });
  return rows;
}

/** The highlighted row: the one he chose while it is still listed, else the first a Return can take. */
export function activeOf(model: SearchModel, rows: readonly Row[]): string | null {
  const options = rows.filter(isOption);
  if (model.moved && model.active && options.some((row) => row.id === model.active)) return model.active;
  return options[0]?.id ?? null;
}

/** An arrow: the next or the previous row a Return can take, round the ends. */
export function step(model: SearchModel, rows: readonly Row[], by: 1 | -1): SearchModel {
  const options = rows.filter(isOption);
  if (options.length === 0) return model;
  const at = options.findIndex((row) => row.id === activeOf(model, rows));
  return { ...model, moved: true, active: options[(at + by + options.length) % options.length].id };
}

/** The pointer on a row. */
export const point = (model: SearchModel, id: string): SearchModel => (model.moved && model.active === id ? model : { ...model, moved: true, active: id });
