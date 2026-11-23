import { useMemo, useState, useSyncExternalStore } from "react";
import type { ChatDetail, ChatFace, ChatHit, ChatKind, ChatMessage, ChatRow, ChatSource, ChatSourceState } from "@shared/work/messages";
import type { LifeosQuery } from "../shell/lifeos";
import type { MessagesData, Paged } from "./data";
import { firstName, type ChatFilter } from "./model";

/**
 * Made-up conversations for the preview and the tests: a game studio called
 * Starboard, its people, channels and words, none of them real. `fixtureData`
 * answers the seam from them, with switches for each state the view draws.
 * Times hang off one fixed moment, so a shot reads the same on any day.
 */

const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo, d, h, mi).getTime();
/** The preview's now: a Monday afternoon. */
export const NOW = at(2026, 10, 23, 15, 42);
const MIN = 60_000;
const HOUR = 60 * MIN;

export const JOB = "Starboard";

const ME = { name: "Alex Kim", me: true } as const;
const person = (name: string): ChatMessage["who"] => ({ name, me: false, personId: `p_${name.toLowerCase().replace(/\W+/g, "_")}`, email: `${name.split(" ")[0]!.toLowerCase()}@starboard.games` });
const DANA = person("Dana Lee");
const OMAR = person("Omar Reyes");
const PRIYA = person("Priya Shah");
const THEO = person("Theo Park");
const MIA = person("Mia Chen");
const LUCAS = person("Lucas Gray");
const ANA = person("Ana Ruiz");

const face = (who: { name: string }): ChatFace => ({ name: who.name });

type Line = [who: ChatMessage["who"], at: number, text: string, extra?: Partial<ChatMessage>];

/** A conversation's messages from its lines, oldest first in, newest first out, as LifeOS answers. */
function thread(id: string, lines: Line[]): ChatMessage[] {
  return lines.map(([who, sentAt, text, extra], i) => ({ _id: `${id}_m${i}`, who, text, sentAt, files: [], ...extra })).reverse();
}

const today = (h: number, mi = 0) => at(2026, 10, 23, h, mi);
const yesterday = (h: number, mi = 0) => at(2026, 10, 22, h, mi);

const DIRECT = thread("c_dana", [
  [DANA, yesterday(10, 2), "Morning! Did the 0.9.4 build make it to the playtest machines?"],
  [ME, yesterday(10, 9), "It did, all six are on it now. The lobby crash from Friday is gone."],
  [ME, yesterday(10, 10), "Tutorial skip is still flaky on the second controller though."],
  [DANA, yesterday(10, 31), "Good. I'll get Omar to look at the controller thing this afternoon."],
  [DANA, yesterday(10, 32), "Can you send me the crash numbers before the review?\nJust the last three builds is fine."],
  [ME, yesterday(11, 15), "Sure. Here they are: https://dash.starboard.games/crashes?builds=3"],
  [DANA, yesterday(16, 48), "Thanks, that helps a lot."],
  [ME, today(9, 20), "Heads up, I moved the review to 4:30 so Priya can make it."],
  [DANA, today(14, 55), "Works for me."],
  [DANA, today(14, 56), "One more thing: the store page copy still says early access. Can you ping marketing, or should I?"],
  [DANA, today(15, 31), "Also, the art team wants the new key art in the launcher by Thursday. Is that doable?"],
]);

const CHANNEL = thread("c_builds", [
  [THEO, yesterday(17, 4), "Nightly is red again: the shader cache step timed out on the Linux runner."],
  [LUCAS, yesterday(17, 9), "That runner is down to 4 GB free. I'll clear the old artifacts."],
  [LUCAS, yesterday(17, 30), "Done, 61 GB back. Re-running nightly now."],
  [THEO, yesterday(18, 2), "Green. Thanks Lucas."],
  [ME, today(9, 5), "Cutting 0.9.5 at noon. Anything that needs to make it in, merge before 11:30."],
  [OMAR, today(10, 41), "The controller fix is in review: https://git.starboard.games/game/pull/2214"],
  [PRIYA, today(11, 2), "Approved. Merging."],
  [THEO, today(12, 14), "0.9.5 is building. ETA 25 minutes."],
  [THEO, today(12, 41), "0.9.5 is up on the playtest channel."],
  [LUCAS, today(15, 2), "Seeing a spike of save sync failures on 0.9.5, looking now."],
  [LUCAS, today(15, 4), "It's the cloud save quota, not the build. Raised it to 50 MB a player."],
  [OMAR, today(15, 38), "@Alex can you confirm the controller fix on the second pad before we tell QA?"],
]);

const REPLIES = thread("c_design", [
  [MIA, today(10, 12), "New pass on the inventory screen is up. Biggest change: items sort by rarity first, then by type."],
  [ANA, today(10, 20), "Love the rarity sort. The tooltip delay feels long though."],
  [MIA, today(10, 24), "It's 400ms right now, I can bring it to 250.", { replyTo: { who: "Ana Ruiz", text: "Love the rarity sort. The tooltip delay feels long though." } }],
  [PRIYA, today(11, 3), "Can we keep the old sort as an option? Speedrunners will ask for it."],
  [MIA, today(11, 9), "Yes, I'll add it under the sort menu.", { replyTo: { who: "Priya Shah", text: "Can we keep the old sort as an option? Speedrunners will ask for it." } }],
  [ME, today(11, 30), "Looks great. Ship it to playtest with 0.9.6."],
  [ANA, today(14, 2), "250 feels right. One nit: the rarity border is hard to see on the dark theme.", { replyTo: { who: "Mia Chen", text: "It's 400ms right now, I can bring it to 250." } }],
]);

const PLAYTEST = thread("c_playtest", [
  [THEO, yesterday(16, 30), "Playtest wave two goes out tomorrow at 10. Same build as wave one plus the controller fix."],
  [ANA, yesterday(16, 41), "I pinned the feedback form in #feedback. It asks for the build number first, so we can sort by it."],
  [THEO, today(9, 58), "Invites are out."],
  [THEO, today(10, 5), "Wave two invites went out, 240 accepted so far."],
]);

type ChatSeed = { id: string; name: string; kind: ChatKind; source: ChatSource; account: string; who: ChatMessage["who"][]; lastAt: number; text: string; lastWho?: string; fromMe?: boolean; unread?: boolean; readAt?: number };

const SEEDS: ChatSeed[] = [
  { id: "c_builds", name: "#builds", kind: "channel", source: "slack", account: "Starboard Games", who: [OMAR, LUCAS], lastAt: today(15, 38), text: "@Alex can you confirm the controller fix on the second pad before we tell QA?", lastWho: "Omar Reyes", unread: true, readAt: today(15, 3) },
  { id: "c_dana", name: "Dana Lee", kind: "direct", source: "slack", account: "Starboard Games", who: [DANA], lastAt: today(15, 31), text: "Also, the art team wants the new key art in the launcher by Thursday. Is that doable?", unread: true, readAt: today(9, 30) },
  { id: "c_design", name: "#design-review", kind: "channel", source: "slack", account: "Starboard Games", who: [ANA, MIA], lastAt: today(14, 2), text: "250 feels right. One nit: the rarity border is hard to see on the dark theme.", lastWho: "Ana Ruiz", readAt: today(14, 10) },
  { id: "c_trio", name: "Dana, Omar, Mia", kind: "group", source: "slack", account: "Starboard Games", who: [OMAR, DANA], lastAt: today(13, 20), text: "Lunch order is in, sushi place on 5th. Back by 2.", lastWho: "Omar Reyes", unread: true },
  { id: "c_priya", name: "Priya Shah", kind: "direct", source: "slack", account: "Starboard Games", who: [PRIYA], lastAt: today(11, 47), text: "Sounds good, I'll be there at 4:30.", fromMe: false, readAt: today(12, 0) },
  { id: "c_playtest", name: "#playtest", kind: "channel", source: "discord", account: "Starboard Community", who: [THEO, ANA], lastAt: today(10, 5), text: "Wave two invites went out, 240 accepted so far.", lastWho: "Theo Park", readAt: today(10, 30) },
  { id: "c_omar", name: "Omar Reyes", kind: "direct", source: "slack", account: "Starboard Games", who: [OMAR], lastAt: yesterday(18, 12), text: "I'll take the controller bug, no worries.", fromMe: true, readAt: yesterday(18, 12) },
  { id: "c_jordan", name: "Jordan Blake", kind: "direct", source: "imessage", account: "iMessage", who: [person("Jordan Blake")], lastAt: yesterday(9, 40), text: "Running ten minutes late, save me a seat", readAt: yesterday(9, 45) },
  { id: "c_general", name: "#general", kind: "channel", source: "slack", account: "Starboard Games", who: [LUCAS, MIA], lastAt: at(2026, 10, 20, 16, 0), text: "Friday demo is in the big room, snacks provided.", lastWho: "Lucas Gray", readAt: at(2026, 10, 21, 9, 0) },
  { id: "c_theo", name: "Theo Park", kind: "direct", source: "discord", account: "Starboard Community", who: [THEO], lastAt: at(2026, 10, 19, 12, 30), text: "Thanks for the moderator role!", readAt: at(2026, 10, 19, 13, 0) },
  { id: "c_art", name: "#art", kind: "channel", source: "slack", account: "Starboard Games", who: [ANA], lastAt: at(2026, 10, 12, 15, 10), text: "Key art v3 is in the shared folder.", lastWho: "Ana Ruiz", readAt: at(2026, 10, 12, 16, 0) },
  { id: "c_lucas", name: "Lucas Gray", kind: "direct", source: "slack", account: "Starboard Games", who: [LUCAS], lastAt: at(2026, 9, 30, 11, 0), text: "Runner keys rotated, the old ones stop working Monday.", fromMe: false, readAt: at(2026, 9, 30, 12, 0) },
];

function rowOf(seed: ChatSeed): ChatRow {
  const fromMe = seed.fromMe ?? false;
  return {
    _id: seed.id,
    source: seed.source,
    account: seed.account.toLowerCase().replace(/\W+/g, "-"),
    accountName: seed.account,
    channel: seed.id,
    name: seed.name,
    kind: seed.kind,
    sector: "cosmic",
    lastAt: seed.lastAt,
    lastText: seed.text,
    lastWho: fromMe ? ME.name : (seed.lastWho ?? seed.name),
    lastFromMe: fromMe,
    lastInAt: fromMe ? seed.lastAt - HOUR : seed.lastAt,
    lastForMeAt: seed.unread ? seed.lastAt : undefined,
    lastOutAt: fromMe ? seed.lastAt : undefined,
    readAt: seed.readAt,
    unread: seed.unread ?? false,
    faces: seed.who.map(face),
  };
}

export const CHATS: ChatRow[] = SEEDS.map(rowOf);

/** A plain conversation's lines, for every one without its own. */
function filler(row: ChatRow): ChatMessage[] {
  const other = person(row.faces[0]?.name ?? row.name);
  return thread(row._id, [
    [other, row.lastAt - 3 * HOUR, "Do you have a minute later today?"],
    [ME, row.lastAt - 2 * HOUR, "Yes, after three works."],
    [row.lastFromMe ? ME : other, row.lastAt, row.lastText],
  ]);
}

export const MESSAGES: Record<string, ChatMessage[]> = { c_dana: DIRECT, c_builds: CHANNEL, c_design: REPLIES, c_playtest: PLAYTEST };

const WORDS = ["build", "the", "playtest", "controller", "lobby", "shader", "save", "art", "store", "review", "crash", "launcher", "menu", "patch", "sound"];
/** Made-up conversations past counting: the list's speed. */
export function manyChats(count: number): ChatRow[] {
  const people = [DANA, OMAR, PRIYA, THEO, MIA, LUCAS, ANA];
  return Array.from({ length: count }, (_, i) => {
    const kind: ChatKind = i % 5 === 0 ? "channel" : i % 7 === 0 ? "group" : "direct";
    const who = people[i % people.length]!;
    const name = kind === "channel" ? `#team-${i}` : kind === "group" ? `${firstName(who.name)}, ${firstName(people[(i + 2) % people.length]!.name)}` : `${who.name} ${i}`;
    return rowOf({ id: `h_${i}`, name, kind, source: i % 9 === 0 ? "discord" : "slack", account: "Starboard Games", who: [who], lastAt: NOW - i * 37 * MIN, text: `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} notes for round ${i}, see the doc before standup`, lastWho: who.name, unread: i % 11 === 5, readAt: NOW - i * 37 * MIN });
  });
}

/** One conversation of `count` messages, a few writers taking turns, four minutes apart on average. */
export function manyMessages(id: string, count: number): ChatMessage[] {
  const writers = [DANA, OMAR, ME, PRIYA];
  const lines: Line[] = [];
  let t = NOW - count * 4 * MIN;
  for (let i = 0; i < count; i++) {
    t += (i % 6 === 0 ? 40 : 2) * MIN;
    const words = Array.from({ length: 6 + ((i * 7) % 30) }, (_, j) => WORDS[(i + j * 5) % WORDS.length]).join(" ");
    lines.push([writers[Math.floor(i / 3) % writers.length]!, Math.min(t, NOW - MIN), `${words[0]!.toUpperCase()}${words.slice(1)}.`]);
  }
  return thread(id, lines);
}

const SOURCES: ChatSourceState[] = [
  { kind: "slack", label: "Starboard Games", status: "ok", lastSyncAt: NOW - 2 * MIN },
  { kind: "discord", label: "Starboard Community", status: "ok", lastSyncAt: NOW - 4 * MIN },
  { kind: "imessage", label: "Alex's Mac", status: "ok", reportedAt: NOW - 3 * HOUR },
];
const STALE: ChatSourceState[] = [
  { kind: "slack", label: "Starboard Games", status: "ok", lastSyncAt: NOW - 2 * MIN },
  { kind: "discord", label: "Starboard Community", status: "ok", lastSyncAt: at(2026, 10, 3, 18, 20) },
  { kind: "imessage", label: "Alex's Mac", status: "ok", reportedAt: at(2026, 10, 16, 22, 5) },
];

export interface FixtureOptions {
  /** Every answer on its way. */
  loading?: boolean;
  /** Sources linked, no conversation yet. */
  empty?: boolean;
  /** No chat source in the job. */
  noSource?: boolean;
  /** Discord and iMessage silent past their limits. */
  stale?: boolean;
  chats?: ChatRow[];
  messages?: Record<string, ChatMessage[]>;
  /** Conversations a thread's draft waits in. */
  drafted?: string[];
  /** Messages that are still loading, for a conversation's bones. */
  messagesLoading?: boolean;
  now?: number;
}

/** What the fixtures were asked to do, for a test to read. */
export interface FixtureLog {
  read: string[];
  unread: string[];
  chats: ChatFilter[];
  searched: string[];
}

const ready = <T>(value: T): LifeosQuery<T> => ({ status: "ready", value });
const LOADING = { status: "loading" } as const;

const matches = (row: ChatRow, filter: ChatFilter): boolean =>
  filter === "all" || (filter === "unread" ? row.unread : filter === "direct" ? row.kind === "direct" : row.kind === "channel");

/** The seam over made-up conversations. Marks are kept, so a mark read clears its dot. */
export function fixtureData(options: FixtureOptions = {}): MessagesData & { log: FixtureLog } {
  const now = options.now ?? NOW;
  const log: FixtureLog = { read: [], unread: [], chats: [], searched: [] };
  let rows = options.empty || options.noSource ? [] : (options.chats ?? CHATS);
  const messages = options.messages ?? MESSAGES;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const mark = (id: string, unread: boolean): void => {
    rows = rows.map((row) => (row._id === id ? { ...row, unread, readAt: unread ? row.readAt : now } : row));
    for (const fn of listeners) fn();
  };
  const useRows = () => useSyncExternalStore(subscribe, () => rows, () => rows);
  const drafted: ReadonlySet<string> = new Set(options.drafted ?? []);
  const sources = options.noSource ? [] : options.stale ? STALE : SOURCES;
  const messagesOf = (id: string): ChatMessage[] => messages[id] ?? (rows.find((r) => r._id === id) ? filler(rows.find((r) => r._id === id)!) : []);
  return {
    log,
    useChats(filter) {
      log.chats.push(filter);
      const all = useRows();
      const [count, setCount] = useState(100);
      const shown = useMemo(() => all.filter((row) => matches(row, filter)), [all, filter]);
      if (options.loading) return LOADING;
      const page: Paged<ChatRow> = { rows: shown.slice(0, count), done: count >= shown.length, more: () => setCount((c) => c + 100) };
      return ready(page);
    },
    useUnread() {
      const all = useRows();
      return options.loading ? null : all.filter((row) => row.unread).length;
    },
    useChat(id) {
      const all = useRows();
      if (options.loading || !id) return LOADING;
      const chat = all.find((row) => row._id === id);
      const source = chat ? (sources.find((s) => s.kind === chat.source) ?? null) : null;
      const detail: ChatDetail | null = chat ? { chat, source, route: { can: true }, email: chat.kind === "direct" ? `${chat.name.split(" ")[0]!.toLowerCase()}@starboard.games` : undefined, link: `https://starboard.slack.com/archives/${chat.channel}` } : null;
      return ready(detail);
    },
    useMessages(chatId) {
      const [count, setCount] = useState(50);
      const all = useMemo(() => (chatId ? messagesOf(chatId) : []), [chatId]);
      if (options.loading || options.messagesLoading || !chatId) return LOADING;
      const page: Paged<ChatMessage> = { rows: all.slice(0, count), done: count >= all.length, more: () => setCount((c) => c + 50) };
      return ready(page);
    },
    useSources() {
      return options.loading ? LOADING : ready(sources);
    },
    useSearch(text) {
      const query = text.trim().toLowerCase();
      if (query) log.searched.push(query);
      const hits = useMemo(() => {
        if (!query) return [];
        const found: ChatHit[] = [];
        for (const row of rows) {
          for (const m of messagesOf(row._id)) {
            if (m.text.toLowerCase().includes(query)) found.push({ chatId: row._id, messageId: m._id, chat: row.name, who: m.who.me ? "You" : m.who.name, text: m.text, at: m.sentAt, source: row.source });
          }
        }
        return found.sort((a, b) => b.at - a.at).slice(0, 50);
      }, [query]);
      return options.loading ? LOADING : ready(hits);
    },
    useDrafted: () => drafted,
    useNow: () => now,
    markRead(id) {
      log.read.push(id);
      mark(id, false);
    },
    markUnread(id) {
      log.unread.push(id);
      mark(id, true);
    },
  };
}

