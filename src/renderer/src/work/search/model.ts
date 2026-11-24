import { mentionMatches } from "@shared/work/mentions";
import {
  RECENT_KIND,
  SEARCH_ALL,
  SEARCH_PER_GROUP,
  SEARCH_RECENTS,
  SEARCH_TEXT_MAX,
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
 *   never change order among themselves, and a row that lands later goes
 *   under the rows of its kind already there, whoever answered first.
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
  /** the words it answered: for the same words the host's own verdict stands, whatever the row's cut text shows */
  text: string;
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
  /** each kind's rows, by key, in the order they came to stand: what lands later goes under them */
  order: Readonly<Record<string, readonly string[]>>;
  /** the generation that order was last settled in: the first answer to new words ranks afresh */
  orderGen: number;
  /** a source searched and answered this generation: only then is there something to say was not found */
  searched: boolean;
  /** kinds a host can search further when asked alone (Files' search of every place and of text): each is offered as "All files for …" whatever was found */
  deeper: readonly string[];
  /** he moved the highlight (an arrow, the pointer): it stays on `active` */
  moved: boolean;
  active: string | null;
}

export const emptyModel = (): SearchModel => ({ gen: 0, text: "", kind: null, scope: null, hosts: [], slots: [], out: new Set(), quiet: [], seen: [], order: {}, orderGen: 0, searched: false, deeper: [], moved: false, active: null });

const outKey = (host: string, source = "*"): string => `${host}\n${source}`;

/** The slots with only the rows of these workspaces; null: every row. */
const inScope = (slots: Slot[], within: readonly string[] | null): Slot[] =>
  within === null ? slots : slots.map((slot) => ({ ...slot, hits: slot.hits.filter((hit) => hit.workspaceId !== null && within.includes(hit.workspaceId)) })).filter((slot) => slot.hits.length > 0);

/** The network tier waits for this long after his last key, and for this many characters. */
export const NETWORK_WAIT_MS = 120;
export const NETWORK_MIN_CHARS = 2;
export const asksNetwork = (text: string): boolean => text.trim().length >= NETWORK_MIN_CHARS;

/**
 * A new generation: his words, the kind and the hosts to ask. Every host's
 * first answer is out. What is on screen stays until its own answer lands,
 * shown only where it still holds the words. A change of scope keeps what
 * is still in reach and nothing else: narrowed to a job, that job's rows
 * stay (`within`, its workspaces) and every other row goes at once, since a
 * row of a job the search no longer reads must not stand there, unlabelled,
 * for a Return to take; widened, every row stays. A change of words, kind
 * or scope puts the highlight back on the first row; `offline` are hosts
 * with Work on that cannot be asked, each one quiet line.
 */
export function begin(model: SearchModel, ask: { text: string; kind: string | null; scope?: string | null; within?: readonly string[] | null; hosts: SearchHost[]; offline?: readonly string[] }): SearchModel {
  // No more than the wire takes: a host refuses longer words, and that is not a host that did not answer.
  const text = ask.text.trim().slice(0, SEARCH_TEXT_MAX);
  const scope = ask.scope ?? null;
  const same = text === model.text && ask.kind === model.kind && scope === model.scope;
  // Out of one kind, by Escape: back on the row he came in by, "All mail for …", when it is still there.
  const back = model.kind !== null && ask.kind === null && text === model.text && scope === model.scope ? `all:${model.kind}` : null;
  return {
    ...model,
    gen: model.gen + 1,
    text,
    kind: ask.kind,
    scope,
    hosts: ask.hosts,
    slots: inScope(
      model.slots.filter((slot) => ask.hosts.some((h) => h.id === slot.host)),
      scope === model.scope || scope === null ? null : (ask.within ?? []),
    ),
    out: new Set(ask.hosts.map((h) => outKey(h.id))),
    quiet: (ask.offline ?? []).map((name) => ({ key: `offline:${name}`, line: `${name} is offline.` })),
    // The rows on screen stay as they stand until an answer lands; the same ask again carries their order on.
    orderGen: same && model.orderGen === model.gen ? model.gen + 1 : model.orderGen,
    searched: false,
    // What a host can search further holds for the hosts asked, whatever the words: kept across a change of words, so
    // the row does not blink, and dropped when the hosts asked change (the host that offered it may be gone).
    deeper: ask.hosts.length === model.hosts.length && ask.hosts.every((h) => model.hosts.some((was) => was.id === h.id)) ? model.deeper : [],
    moved: same ? model.moved : back !== null,
    active: same ? model.active : back,
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

const slotOf = (host: string, group: SearchGroup, tier: Slot["tier"], model: SearchModel): Slot => ({ host, source: group.source, kind: group.kind, label: group.label, tier, hits: group.hits, more: group.more, gen: model.gen, text: model.text });

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
    // One line a cause, and never the same words twice (two sources of one kind that both failed).
    if (!out.some((have) => have.key === line.key || have.line === line.line)) out.push(line);
  }
  return out;
}

/** The kinds a host can search further, added to those already known; the same list when nothing is new. */
const withDeeper = (known: readonly string[], answer: SearchAnswer): readonly string[] => {
  const fresh = (answer.deeper ?? []).filter((kind) => !known.includes(kind));
  return fresh.length ? [...known, ...fresh] : known;
};

/** A host that predates the count is taken to have searched. */
const didSearch = (answer: SearchAnswer): boolean => answer.searched === undefined || answer.searched > 0;

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
  const slots = [...kept, ...answer.groups.map((g) => slotOf(hostId, g, "instant", model))];
  return {
    model: settled({ ...model, out, slots, quiet: withQuiet(model, host, answer.quiet), seen: withSeen(model.seen, answer.groups), searched: model.searched || didSearch(answer), deeper: withDeeper(model.deeper, answer) }),
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
  const slots = [...kept, ...answer.groups.map((g) => slotOf(hostId, g, "network", model))];
  return settled({ ...model, out, slots, quiet: withQuiet(model, host, answer.quiet), seen: withSeen(model.seen, answer.groups), searched: model.searched || didSearch(answer) });
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
  const quiet = model.quiet.some((q) => q.key === said.key || q.line === said.line) ? model.quiet : [...model.quiet, said];
  return settled({ ...model, out, slots, quiet });
}

/** Something asked this generation is still out: the field's spinner. */
export const busy = (model: SearchModel): boolean => model.out.size > 0;

export type Row =
  | { type: "heading"; id: string; label: string }
  | { type: "hit"; id: string; hit: SearchHit; host: string }
  /** "All mail for …": Return narrows the picker to the kind */
  | { type: "all"; id: string; kind: string; label: string }
  /** "Search all jobs", under nothing found in one job */
  | { type: "widen"; id: string; label: string }
  /** `cause`: what could not be searched, said at the list's foot outside its scroller, so a long list never hides it */
  | { type: "note"; id: string; text: string; cause?: true };

/** A row Return can take. */
export type Option = Extract<Row, { type: "hit" | "all" | "widen" }>;
export const isOption = (row: Row): row is Option => row.type === "hit" || row.type === "all" || row.type === "widen";

/** One kind's rows, every one a source holds, in the order they stand. */
interface Group {
  kind: string;
  label: string;
  hits: { hit: SearchHit; host: string }[];
  more: boolean;
}

/**
 * The kinds in the fixed order (Recent first, then a kind the order does
 * not name in the order it was first seen), each with its rows. A thing is
 * listed once. Within a kind the rows already standing keep their order
 * (`model.order`) and the rest follow: the Work home's before another
 * host's, what a host knew at once before what it fetched.
 */
function groupsOf(model: SearchModel, jobOf: (workspaceId: string | null) => string = (id) => id ?? ""): Group[] {
  const rank = (kind: string): number => (kind === RECENT_KIND ? -1 : searchRank(kind));
  const place = (slot: Slot): number[] => [rank(slot.kind), model.seen.indexOf(slot.kind), model.hosts.findIndex((h) => h.id === slot.host), slot.tier === "instant" ? 0 : 1];
  const shown = model.slots
    .filter((slot) => (model.text ? slot.kind !== RECENT_KIND : slot.kind === RECENT_KIND))
    // Held to one kind with nothing typed, Recent stays, by the things of that kind in it.
    .filter((slot) => model.kind === null || slot.kind === model.kind || slot.kind === RECENT_KIND)
    .map((slot, index) => ({ slot, index, at: place(slot) }))
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.at[3] - b.at[3] || a.slot.source.localeCompare(b.slot.source) || a.index - b.index);

  const groups: Group[] = [];
  const taken = new Set<string>();
  for (const kind of new Set(shown.map((s) => s.slot.kind))) {
    const mine = shown.filter((s) => s.slot.kind === kind).map((s) => s.slot);
    let hits: Group["hits"] = [];
    let more = false;
    if (kind === RECENT_KIND) {
      // Recent is one list across hosts: what he opened last, wherever he opened it, each thing by its newest opening.
      const all = mine
        .flatMap((slot) => slot.hits.map((hit) => ({ hit, host: slot.host })))
        .filter((found) => model.kind === null || found.hit.kind === model.kind)
        .sort((a, b) => (b.hit.openedAt ?? 0) - (a.hit.openedAt ?? 0));
      // Recent keeps a title and no more, so two things that would read the same (two messages of one conversation,
      // a thing of one job opened on two hosts) are one row: the newest.
      const looks = new Set<string>();
      for (const found of all) {
        const look = `${found.hit.kind}\n${found.hit.title}\n${jobOf(found.hit.workspaceId)}`;
        if (taken.has(found.hit.key) || looks.has(look)) continue;
        taken.add(found.hit.key);
        looks.add(look);
        hits.push(found);
      }
    } else {
      for (const slot of mine) {
        // A row of an older generation waits for its own answer only while it still holds his words.
        const stale = slot.gen !== model.gen;
        for (const hit of slot.hits) {
          if (taken.has(hit.key)) continue;
          // For the words it answered (a change of scope alone) the host's verdict stands: a match may lie past the row's cut text.
          if (stale && model.text && slot.text !== model.text && !mentionMatches(model.text, hit.title, hit.detail, hit.snippet)) continue;
          taken.add(hit.key);
          hits.push({ hit, host: slot.host });
        }
        // An older answer's "more" is not said of new words; but the row he stands on ("All mail for …", back out of
        // that kind) stays under him until the fresh answer lands and decides.
        more ||= slot.more && (!stale || (model.moved && model.active === `all:${kind}`));
      }
      const stood = model.order[kind];
      if (stood) {
        const at = (key: string): number => {
          const index = stood.indexOf(key);
          return index < 0 ? stood.length : index;
        };
        hits = hits.sort((a, b) => at(a.hit.key) - at(b.hit.key));
      }
    }
    if (hits.length > 0) groups.push({ kind, label: mine[0].label, hits, more });
  }
  return groups;
}

/**
 * After an answer: each kind's rows as they now stand are the order the
 * next answer goes under. The first answer to new words ranks afresh: the
 * list changes then anyway, and what a new search finds stands as it
 * ranks it.
 */
function settled(model: SearchModel): SearchModel {
  const order: Record<string, string[]> = {};
  // Unless he has already moved to a row of what stands there: then it keeps its place, and the new rows go under.
  for (const group of groupsOf(model.orderGen === model.gen || model.moved ? model : { ...model, order: {} })) if (group.kind !== RECENT_KIND) order[group.kind] = group.hits.map((found) => found.hit.key);
  return { ...model, order, orderGen: model.gen };
}

/** The list, top to bottom: each kind's heading, its rows up to the cap, the row that opens all of it; then what was not found, and what could not be searched. */
export function rowsOf(model: SearchModel, o: { scoped?: boolean; /** the job a workspace is of, as a row shows it: one job on two hosts reads the same */ jobOf?: (workspaceId: string | null) => string } = {}): Row[] {
  const rows: Row[] = [];
  let hits = 0;
  for (const group of groupsOf(model, o.jobOf)) {
    const { kind } = group;
    const cap = kind === RECENT_KIND ? SEARCH_RECENTS : model.kind ? SEARCH_ALL : SEARCH_PER_GROUP;
    // A kind a host can search further (Files' own search, asked only alone) always offers all of itself.
    const more = group.more || group.hits.length > cap || (kind !== RECENT_KIND && model.deeper.includes(kind));
    const shownHits = group.hits.slice(0, cap);
    // The row he chose is never the one the cap cuts: when rows stand before it that did not, it takes the last place.
    const chosen = model.moved && model.active ? group.hits.findIndex((found) => `hit:${found.hit.key}` === model.active) : -1;
    if (chosen >= cap) shownHits[cap - 1] = group.hits[chosen];
    // Held to one kind, the field already names it: no heading says it again. Recent's own heading says what the list is.
    if (!model.kind || kind === RECENT_KIND) rows.push({ type: "heading", id: `heading:${kind}`, label: group.label });
    for (const { hit, host } of shownHits) rows.push({ type: "hit", id: `hit:${hit.key}`, hit, host });
    hits += shownHits.length;
    if (more && !model.kind && kind !== RECENT_KIND) rows.push({ type: "all", id: `all:${kind}`, kind, label: `All ${searchNoun(kind, group.label)} for “${model.text}”` });
  }
  // "Nothing for …" is true only of a search that ran: every source asked (none is, under two characters), and at least one answering.
  if (hits === 0 && asksNetwork(model.text) && !busy(model) && model.searched) {
    rows.push({ type: "note", id: "nothing", text: `Nothing for “${model.text}”` });
    if (o.scoped) rows.push({ type: "widen", id: "widen", label: "Search all jobs" });
  }
  // A kind a host can search further with no row of its own yet (no file's name held the words, its text may):
  // offered at the list's end, so the deeper search is always one Return away.
  if (!model.kind && asksNetwork(model.text)) {
    for (const kind of model.deeper) if (!rows.some((row) => row.type === "all" && row.kind === kind)) rows.push({ type: "all", id: `all:${kind}`, kind, label: `All ${searchNoun(kind)} for “${model.text}”` });
  }
  for (const quiet of model.quiet) rows.push({ type: "note", id: `quiet:${quiet.key}`, text: quiet.line, cause: true });
  return rows;
}

/**
 * Whether rows of more than one place stand together, so each must say where it is: several jobs, or one job
 * and a thread of the Work Chats (which is in no job).
 */
export const placesMix = (jobs: number, rows: readonly Row[]): boolean => jobs > 1 || (jobs === 1 && rows.some((row) => row.type === "hit" && row.hit.workspaceId === null));

/**
 * The highlighted row: the first a Return can take until he moves the
 * highlight, then the one he chose. A thing he chose that an answer has
 * taken off the list leaves no row highlighted: Return must never open a
 * neighbour in its place, and the next arrow starts from the top.
 */
export function activeOf(model: SearchModel, rows: readonly Row[]): string | null {
  const options = rows.filter(isOption);
  if (model.moved && model.active) {
    if (options.some((row) => row.id === model.active)) return model.active;
    if (model.active.startsWith("hit:")) return null;
  }
  return options[0]?.id ?? null;
}

/** An arrow: the next or the previous row a Return can take, round the ends. With no row lit, either arrow starts from the top. */
export function step(model: SearchModel, rows: readonly Row[], by: 1 | -1): SearchModel {
  const options = rows.filter(isOption);
  if (options.length === 0) return model;
  const at = options.findIndex((row) => row.id === activeOf(model, rows));
  return { ...model, moved: true, active: options[at < 0 ? 0 : (at + by + options.length) % options.length].id };
}

/** The pointer on a row. */
export const point = (model: SearchModel, id: string): SearchModel => (model.moved && model.active === id ? model : { ...model, moved: true, active: id });
