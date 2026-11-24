import { useMemo, useState, useSyncExternalStore } from "react";
import { CHAT_ROUTES, SOURCE_NAME, type ChatDetail, type ChatFace, type ChatHit, type ChatKind, type ChatMessage, type ChatRoute, type ChatRow, type ChatSource, type ChatSourceState } from "@shared/work/messages";
import type { LifeosQuery } from "../shell/lifeos";
import type { FileVerb, MessagesData, Paged, ThreadDraft } from "./data";
import { discardRefusal } from "./drafts";
import { fileVerb } from "./files";
import { INVENTORY, LEVEL } from "./pictures.fixtures";
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
  [MIA, today(10, 24), "It's 400ms right now, I can bring it to 250.", { replyTo: { id: "c_design_m1", who: "Ana Ruiz", text: "Love the rarity sort. The tooltip delay feels long though." } }],
  [PRIYA, today(11, 3), "Can we keep the old sort as an option? Speedrunners will ask for it."],
  [MIA, today(11, 9), "Yes, I'll add it under the sort menu.", { replyTo: { id: "c_design_m3", who: "Priya Shah", text: "Can we keep the old sort as an option? Speedrunners will ask for it." } }],
  [ME, today(11, 30), "Looks great. Ship it to playtest with 0.9.6."],
  [ANA, today(14, 2), "250 feels right. One nit: the rarity border is hard to see on the dark theme.", { replyTo: { id: "c_design_m2", who: "Mia Chen", text: "It's 400ms right now, I can bring it to 250." } }],
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
  { id: "c_art", name: "#art", kind: "channel", source: "slack", account: "Starboard Games", who: [ANA], lastAt: at(2026, 10, 12, 15, 10), text: "The launcher banner, still exporting:", lastWho: "Ana Ruiz", readAt: at(2026, 10, 12, 16, 0) },
  { id: "c_lucas", name: "Lucas Gray", kind: "direct", source: "slack", account: "Starboard Games", who: [LUCAS], lastAt: at(2026, 10, 19, 11, 2), text: "The build, as promised.", fromMe: false, readAt: at(2026, 10, 19, 12, 0) },
];

/** Where each source's conversation opens in its own app; iMessage and Teams give none. */
const LINKS: Partial<Record<ChatSource, string>> = { slack: "https://starboard.slack.com/archives/", discord: "https://discord.com/channels/starboard/" };

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
    ...(LINKS[seed.source] ? { link: `${LINKS[seed.source]}${seed.id}` } : {}),
  };
}

/** Newest first, as LifeOS lists them. */
export const CHATS: ChatRow[] = SEEDS.map(rowOf).sort((a, b) => b.lastAt - a.lastAt);

/** A plain conversation's lines, for every one without its own. */
function filler(row: ChatRow): ChatMessage[] {
  const other = person(row.faces[0]?.name ?? row.name);
  return thread(row._id, [
    [other, row.lastAt - 3 * HOUR, "Do you have a minute later today?"],
    [ME, row.lastAt - 2 * HOUR, "Yes, after three works."],
    [row.lastFromMe ? ME : other, row.lastAt, row.lastText],
  ]);
}

const nov = (d: number, h: number, mi = 0) => at(2026, 10, d, h, mi);

/** Pictures in place: two stored, one LifeOS has still to fetch. */
const ART = thread("c_art", [
  [ANA, nov(12, 14, 2), "Key art v3 is in the shared folder. Two frames from the level pass first:"],
  [ANA, nov(12, 14, 3), "[file: level-dusk.png]", { files: [{ _id: "f_level", name: "level-dusk.png", contentType: "image/png", size: 1_840_000, width: 1600, height: 900, status: "stored", url: LEVEL }] }],
  [MIA, nov(12, 14, 20), "The inventory panel on the same palette:\n[file: inventory.png]", { files: [{ _id: "f_inv", name: "inventory.png", contentType: "image/png", size: 920_000, width: 900, height: 1200, status: "stored", url: INVENTORY }] }],
  [ANA, nov(12, 15, 10), "The launcher banner, still exporting:\n[file: launcher-banner.png]", { files: [{ _id: "f_banner", name: "launcher-banner.png", contentType: "image/png", size: 2_400_000, width: 1920, height: 640, status: "wanted" }] }],
]);

/** Files as chips: two a canvas shows, one only saved. */
const FILES = thread("c_lucas", [
  [LUCAS, nov(19, 10, 12), "Here's the runner budget for next quarter and the patch notes draft."],
  [LUCAS, nov(19, 10, 13), "[file: runner-budget.xlsx] [file: patch-notes-0.9.5.pdf]", { files: [
    { _id: "f_budget", name: "runner-budget.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 48_200, status: "stored", url: "data:application/octet-stream;base64,AA==" },
    { _id: "f_notes", name: "patch-notes-0.9.5.pdf", contentType: "application/pdf", size: 312_000, status: "stored", url: "data:application/octet-stream;base64,AA==" },
  ] }],
  [ME, nov(19, 10, 40), "Thanks. Can you send the build too?"],
  [LUCAS, nov(19, 11, 2), "The build, as promised.\n[file: starboard-0.9.5-linux.zip]", { files: [{ _id: "f_zip", name: "starboard-0.9.5-linux.zip", contentType: "application/zip", size: 412_000_000, status: "listed" }] }],
]);

/** A picture LifeOS could not fetch, as its line. */
export const PICTURE_FAILED: ChatMessage[] = ART.map((m) =>
  m.files.some((f) => f._id === "f_banner") ? { ...m, files: m.files.map((f) => ({ ...f, status: "failed" as const, error: "This picture could not be read" })) } : m,
);

/** A file LifeOS could not fetch, which says why. */
export const FILE_FAILED: ChatMessage[] = FILES.map((m) =>
  m.files.some((f) => f._id === "f_zip") ? { ...m, files: m.files.map((f) => ({ ...f, status: "failed" as const, error: "Slack didn't let LifeOS read this file" })) } : m,
);

/** A conversation with his reply at its foot, on its way or failed, as LifeOS answers it. */
export function withReply(id: string, status: "queued" | "failed", text: string, error?: string): ChatMessage[] {
  const own: ChatMessage = { _id: `${id}_mine`, who: { name: ME.name, me: true }, text, sentAt: NOW - MIN, files: [], reply: { outboxId: `${id}_out`, status, ...(status === "queued" ? { sendAt: NOW + 4_000 } : {}), ...(error ? { error } : {}) } };
  return [own, ...(MESSAGES[id] ?? [])];
}

/** A thread's held reply and a copy-only draft, for the composer's two draft states. */
export const HELD_DRAFT: ThreadDraft = { id: "held_1", held: true, text: "Thursday works. I'll have the key art in the launcher by Wednesday night so the art team can check it first.", threadId: "t_keyart", thread: "Key art for the launcher" };
export const COPY_DRAFT: ThreadDraft = { id: "copy_1", held: false, text: "Thanks Theo! I'll post the patch notes in #announcements once wave two is in.", threadId: "t_wave", thread: "Playtest wave two" };

export const MESSAGES: Record<string, ChatMessage[]> = { c_dana: DIRECT, c_builds: CHANNEL, c_design: REPLIES, c_playtest: PLAYTEST, c_art: ART, c_lucas: FILES };

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
  /** Conversations a thread's draft waits in, with no draft drawn (the list's mark alone). */
  drafted?: string[];
  /** The threads' drafts in each conversation, drawn in its composer. */
  drafts?: Record<string, ThreadDraft[]>;
  /** A conversation's route, where LifeOS says no. */
  routes?: Record<string, ChatRoute>;
  /** Send refuses, in these words (LifeOS's sentence). */
  refuse?: string;
  /** Reads that fail, each for its first N mounts (a Retry mounts it again). */
  fail?: Partial<Record<"chats" | "sources" | "search" | "chat" | "messages", number>>;
  /** Asks for a message's files that fail, the first N. */
  requestFails?: number;
  /** His Send waits until the test lets it go (`release`), so he can type while it goes. */
  slow?: boolean;
  /** A search whose answer is still on its way, for these words. */
  searchPending?: string;
  /** Messages that are still loading, for a conversation's bones. */
  messagesLoading?: boolean;
  /** Older pages of messages fail to come: the page asked for past the first turns to a failure. */
  olderFail?: boolean;
  /** The loaded page stays at its first fifty messages: asking for more brings nothing. */
  pageFixed?: boolean;
  /** A pressed or discarded draft stays in `useDrafts` after its press resolves, until `catchUp`, as the Outbox's list lags its answer. */
  lingers?: boolean;
  /** A held draft's press fails and the item stays as failed, with these words. */
  pressFails?: string;
  /** With `pressFails`: the failure's outcome is unknown (the Outbox's `outcomeUnknown`), so it may have gone. */
  pressUnknown?: boolean;
  /** Saving an edit to a held draft waits for `release`. */
  slowSave?: boolean;
  /** A held draft's press waits for `release` (his own sends do not). */
  slowDraft?: boolean;
  /** A held draft's press is refused with these words and the item stays held (a revision conflict, say). */
  refuseDraft?: string;
  /** With `refuseDraft`: only the first N presses are refused; later ones go. */
  refuseDraftTimes?: number;
  /** His own Send is refused with these words (a held draft's press is not). */
  refuseSend?: string;
  /** His own Send reaches LifeOS, which queues it, but the answer is lost: it rejects as `unknown`. */
  sendUnknown?: boolean;
  /** His own Send's answer is lost and LifeOS never queued it: it rejects as `unknown`, and nothing shows above. */
  sendLost?: boolean;
  /** Each of his Sends in turn: its answer lost, LifeOS having queued it (`queued`) or not (`lost`). */
  sendOutcomes?: ("queued" | "lost")[];
  /** Undo's answer is lost after LifeOS took the reply back: its row goes, and it rejects as `unknown`. */
  undoLost?: boolean;
  /** Discard is refused with these words and the item stays held. */
  discardRefused?: string;
  /** Discard is answered with the item in this state, not discarded (another window claimed it first). */
  discardAnswer?: "sending" | "sent";
  /** Saving an edit to a held draft (Undo's save) is refused with these words. */
  saveRefused?: string;
  /** A held draft pressed with words other than its own is refused before anything is saved (the host's check of an edit, a
   * reply over LifeOS's length), with these words; the item keeps its old words. */
  editRefused?: string;
  /** Undo waits for `release`. */
  slowUndo?: boolean;
  /** Mark unread reaches the list only at `catchUp`, as LifeOS's answer comes after the command. */
  unreadLater?: boolean;
  /** Mark unread is refused. */
  unreadFails?: boolean;
  /** Searches for these words fail. */
  searchFails?: string[];
  /** Discard waits for `release`. */
  slowDrop?: boolean;
  now?: number;
}

/** What the fixtures were asked to do, for a test to read. */
export interface FixtureLog {
  read: string[];
  unread: string[];
  chats: ChatFilter[];
  searched: string[];
  sent: { chatId: string; text: string }[];
  undone: string[];
  retried: string[];
  pressed: { id: string; text: string }[];
  saved: { id: string; text: string }[];
  /** The Outbox items asked for by Open in Outbox, by the page's key. */
  outbox: string[];
  /** Files read by id (`useFile`): asked for while their message is outside the loaded page. */
  fileReads: string[];
  dropped: string[];
  requested: string[];
  opened: { chatId: string; messageId: string; file: string; verb: FileVerb }[];
}

const ready = <T>(value: T): LifeosQuery<T> => ({ status: "ready", value });
const LOADING = { status: "loading" } as const;
const FAILED = { status: "failed", error: "LifeOS did not answer" } as const;

const matches = (row: ChatRow, filter: ChatFilter): boolean =>
  filter === "all" || (filter === "unread" ? row.unread : filter === "direct" ? row.kind === "direct" : row.kind === "channel");

/** The words a route that says no gives where LifeOS cannot reply at all. */
const copyWhy = (row: ChatRow): string => `LifeOS can't reply in ${SOURCE_NAME[row.source]} yet`;

/**
 * The seam over made-up conversations. What he does is kept: a mark read
 * clears its dot, a reply lands as his own message inside its undo time, an
 * undone one leaves, a pressed draft goes.
 */
/** What a test may do to the fixtures besides what the view does: a message arriving, a slow Send let go. */
export interface FixtureControls {
  log: FixtureLog;
  /** A message from someone else arrives at the foot of a conversation, as LifeOS would answer it. */
  deliver(chatId: string, who: string, text: string): void;
  /** Lets a slow Send (or a slow Undo) go. */
  release(): void;
  /** The lists catch up: lingering drafts leave, a late unread mark lands. */
  catchUp(): void;
  /** A held draft's press fails elsewhere (the Outbox, the phone): the list shows it failed. */
  failDraft(id: string, reason: string, unknown?: boolean): void;
  /** LifeOS's worker stores a message's file: its address comes. */
  storeFile(chatId: string, messageId: string, fileId: string, url: string): void;
  /** LifeOS's worker fails to fetch a message's file, with these words. */
  failFile(chatId: string, messageId: string, fileId: string, reason: string): void;
  /** A held item leaves the Outbox's Waiting list from elsewhere (discarded or decided in another window). */
  dropElsewhere(draftId: string): void;
  /** A held item is pressed elsewhere and is sending now: the list shows it sending. */
  sendingElsewhere(draftId: string): void;
  /** A held item leaves the list though it is still held (the list's cap): asked by its id, it is still waiting. */
  hideDraft(draftId: string): void;
  /** A hidden item is decided: asked by its id, it has ended. */
  endHidden(draftId: string): void;
  /** LifeOS's route for a conversation changes (the Mac goes away, comes back). */
  setRoute(chatId: string, route: ChatRoute): void;
}

export function fixtureData(options: FixtureOptions = {}): MessagesData & FixtureControls {
  const now = options.now ?? NOW;
  const log: FixtureLog = { read: [], unread: [], chats: [], searched: [], sent: [], undone: [], retried: [], pressed: [], saved: [], outbox: [], fileReads: [], dropped: [], requested: [], opened: [] };
  let rows = options.empty || options.noSource ? [] : (options.chats ?? CHATS);
  const threads = new Map<string, ChatMessage[]>(Object.entries(options.messages ?? MESSAGES));
  // Discord silent since Nov 3 holds nothing newer than Nov 3: its conversations move back to before its last sync.
  if (options.stale) {
    const synced = STALE.find((source) => source.kind === "discord")!.lastSyncAt!;
    rows = rows.map((row) => {
      if (row.source !== "discord" || row.lastAt <= synced) return row;
      const back = row.lastAt - synced + HOUR;
      const held = threads.get(row._id) ?? filler(row);
      threads.set(row._id, held.map((m) => ({ ...m, sentAt: m.sentAt - back })));
      return { ...row, lastAt: row.lastAt - back, lastInAt: row.lastInAt && row.lastInAt - back, lastForMeAt: row.lastForMeAt && row.lastForMeAt - back, readAt: row.readAt && row.readAt - back };
    });
    // Newest first again, as LifeOS lists them, once the dates have moved.
    rows = [...rows].sort((a, b) => b.lastAt - a.lastAt);
  }
  const fails = { ...(options.fail ?? {}) };
  /** Whether this mount of a read fails: true for the first N of each. */
  const failing = (name: keyof NonNullable<FixtureOptions["fail"]>): boolean => {
    const left = fails[name] ?? 0;
    if (left > 0) fails[name] = left - 1;
    return left > 0;
  };
  let requestFails = options.requestFails ?? 0;
  let drafts: Record<string, ThreadDraft[]> = { ...(options.drafts ?? {}) };
  let version = 0;
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const changed = (): void => {
    version++;
    for (const fn of listeners) fn();
  };
  const useVersion = () => useSyncExternalStore(subscribe, () => version, () => version);
  const mark = (id: string, unread: boolean): void => {
    rows = rows.map((row) => (row._id === id ? { ...row, unread, readAt: unread ? row.readAt : now } : row));
    changed();
  };
  const useRows = () => {
    useVersion();
    return rows;
  };
  const sources = options.noSource ? [] : options.stale ? STALE : SOURCES;
  const messagesOf = (id: string): ChatMessage[] => {
    let held = threads.get(id);
    if (!held) {
      const row = rows.find((r) => r._id === id);
      held = row ? filler(row) : [];
      threads.set(id, held);
    }
    return held;
  };
  const putMessages = (id: string, next: ChatMessage[]): void => {
    threads.set(id, next);
    changed();
  };
  let replies = 0;
  /** His reply as LifeOS answers it: his own newest message, inside its undo time. */
  const reply = (chatId: string, text: string): void => {
    replies++;
    const own: ChatMessage = { _id: `${chatId}_r${replies}`, who: { name: ME.name, me: true }, text, sentAt: now, files: [], reply: { outboxId: `o${replies}`, status: "queued", sendAt: now + 5_000 } };
    putMessages(chatId, [own, ...messagesOf(chatId)]);
  };
  const dropped = (chatId: string, id: string): void => {
    drafts = { ...drafts, [chatId]: (drafts[chatId] ?? []).filter((d) => d.id !== id) };
    changed();
  };
  const chatOfDraft = (id: string): string | undefined => Object.keys(drafts).find((chatId) => drafts[chatId]!.some((d) => d.id === id));
  let letGo: (() => void) | null = null;
  let refusedPresses = 0;
  const routeNow = new Map<string, ChatRoute>();
  const lingering: (() => void)[] = [];
  const lateUnread: string[] = [];
  /** A settled draft leaves the list at once, or at `catchUp` when the list lags. */
  const settleDraft = (chatId: string, id: string): void => {
    if (options.lingers) lingering.push(() => dropped(chatId, id));
    else dropped(chatId, id);
  };
  let delivered = 0;
  /** Held items out of the list, as the host answers them by id. */
  const hidden = new Map<string, "waiting" | "done">();
  return {
    log,
    deliver(chatId, who, text) {
      delivered++;
      const sentAt = now + delivered * MIN;
      const message: ChatMessage = { _id: `${chatId}_in${delivered}`, who: person(who), text, sentAt, files: [] };
      threads.set(chatId, [message, ...messagesOf(chatId)]);
      rows = rows.map((row) => (row._id === chatId ? { ...row, lastAt: sentAt, lastText: text, lastWho: who, lastFromMe: false, lastInAt: sentAt, lastForMeAt: sentAt, unread: true } : row));
      changed();
    },
    failFile(chatId, messageId, fileId, reason) {
      putMessages(
        chatId,
        messagesOf(chatId).map((m) => (m._id === messageId ? { ...m, files: m.files.map((f) => (f._id === fileId ? { ...f, status: "failed" as const, url: undefined, error: reason } : f)) } : m)),
      );
    },
    setRoute(chatId, route) {
      routeNow.set(chatId, route);
      changed();
    },
    dropElsewhere(draftId) {
      const chatId = chatOfDraft(draftId);
      if (chatId) dropped(chatId, draftId);
    },
    hideDraft(draftId) {
      hidden.set(draftId, "waiting");
      const chatId = chatOfDraft(draftId);
      if (chatId) dropped(chatId, draftId);
    },
    endHidden(draftId) {
      hidden.set(draftId, "done");
      // The list moves on the decision, as the Outbox's does: each conversation's drafts are read afresh.
      drafts = Object.fromEntries(Object.entries(drafts).map(([chatId, list]) => [chatId, [...list]]));
      changed();
    },
    sendingElsewhere(draftId) {
      const chatId = chatOfDraft(draftId);
      if (!chatId) return;
      drafts = { ...drafts, [chatId]: drafts[chatId]!.map((d) => (d.id === draftId ? { ...d, sending: true } : d)) };
      changed();
    },
    storeFile(chatId, messageId, fileId, url) {
      putMessages(
        chatId,
        messagesOf(chatId).map((m) => (m._id === messageId ? { ...m, files: m.files.map((f) => (f._id === fileId ? { ...f, status: "stored" as const, url } : f)) } : m)),
      );
    },
    failDraft(id, reason, unknown) {
      const chatId = chatOfDraft(id);
      if (!chatId) return;
      drafts = { ...drafts, [chatId]: drafts[chatId]!.map((d) => (d.id === id ? { ...d, failed: reason, ...(unknown ? { unknown } : {}) } : d)) };
      changed();
    },
    catchUp() {
      for (const later of lingering.splice(0)) later();
      for (const id of lateUnread) mark(id, true);
      lateUnread.length = 0;
    },
    release() {
      letGo?.();
      letGo = null;
    },
    useChats(filter) {
      log.chats.push(filter);
      const all = useRows();
      const [count, setCount] = useState(100);
      const [failed] = useState(() => failing("chats"));
      if (failed) return FAILED;
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
      useVersion();
      const all = useRows();
      const [failed] = useState(() => failing("chat"));
      if (failed) return FAILED;
      if (options.loading || !id) return LOADING;
      const chat = all.find((row) => row._id === id);
      if (!chat) return ready(null);
      const source = sources.find((s) => s.kind === chat.source) ?? null;
      const route: ChatRoute = routeNow.get(id) ?? options.routes?.[id] ?? (CHAT_ROUTES[chat.source] === "lifeos" ? { can: true } : { can: false, why: copyWhy(chat) });
      const detail: ChatDetail = { chat, source, route, ...(chat.kind === "direct" ? { email: `${chat.name.split(" ")[0]!.toLowerCase()}@starboard.games` } : {}), ...(chat.link ? { link: chat.link } : {}) };
      return ready(detail);
    },
    useMessages(chatId) {
      useVersion();
      const [count, setCount] = useState(50);
      const [failed, setFailed] = useState(() => failing("messages"));
      if (failed) return FAILED;
      if (options.loading || options.messagesLoading || !chatId) return LOADING;
      const all = messagesOf(chatId);
      const page: Paged<ChatMessage> = { rows: all.slice(0, count), done: count >= all.length, more: () => (options.olderFail ? setFailed(true) : options.pageFixed ? undefined : setCount((c) => c + 50)) };
      return ready(page);
    },
    useSources() {
      const [failed] = useState(() => failing("sources"));
      if (failed) return FAILED;
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
      const [failed] = useState(() => failing("search"));
      if (failed || options.searchFails?.includes(query)) return FAILED;
      if (options.searchPending && query === options.searchPending.toLowerCase()) return LOADING;
      return options.loading ? LOADING : ready(hits);
    },
    useDrafted() {
      useVersion();
      // A failed held reply is no draft waiting: the row's mark leaves it to the composer's line.
      return useMemo(() => new Set([...(options.drafted ?? []), ...Object.keys(drafts).filter((id) => drafts[id]!.some((d) => d.failed === undefined))]), [drafts]);
    },
    useNow: () => now,
    markRead(id) {
      log.read.push(id);
      mark(id, false);
    },
    markUnread(id, onFailed) {
      if (options.unreadFails) return void onFailed?.();
      log.unread.push(id);
      if (options.unreadLater) lateUnread.push(id);
      else mark(id, true);
    },
    async send(chatId, text) {
      if (options.slow) await new Promise<void>((go) => (letGo = go));
      if (options.sendLost) throw Object.assign(new Error("It may have gone: the host did not answer"), { unknown: true });
      const outcome = options.sendOutcomes?.shift();
      if (outcome === "lost") throw Object.assign(new Error("It may have gone: the host did not answer"), { unknown: true });
      if (options.refuse) throw new Error(options.refuse);
      if (options.refuseSend) throw new Error(options.refuseSend);
      log.sent.push({ chatId, text });
      reply(chatId, text);
      if (outcome === "queued") throw Object.assign(new Error("It may have gone: the host did not answer"), { unknown: true });
      if (options.sendUnknown) throw Object.assign(new Error("It may have gone: the host did not answer"), { unknown: true });
    },
    async undo(chatId, id) {
      if (options.slowUndo) await new Promise<void>((go) => (letGo = go));
      log.undone.push(id);
      const all = messagesOf(chatId);
      const own = all.find((m) => m.reply?.outboxId === id);
      putMessages(chatId, all.filter((m) => m !== own));
      if (options.undoLost) throw Object.assign(new Error("It may have gone: the host did not answer"), { unknown: true });
      return own?.text ?? "";
    },
    async retry(chatId, id) {
      log.retried.push(id);
      putMessages(
        chatId,
        messagesOf(chatId).map((m) => (m.reply?.outboxId === id ? { ...m, reply: { ...m.reply, status: "queued" as const, error: undefined } } : m)),
      );
    },
    useDrafts(chatId) {
      useVersion();
      return chatId ? (drafts[chatId] ?? NO_DRAFTS) : NO_DRAFTS;
    },
    async sendDraft(draft, text) {
      if (options.slow || options.slowDraft) await new Promise<void>((go) => (letGo = go));
      if (options.refuse) throw new Error(options.refuse);
      if (options.refuseDraft && (options.refuseDraftTimes === undefined || refusedPresses++ < options.refuseDraftTimes)) throw new Error(options.refuseDraft);
      if (options.editRefused) {
        const chatOf = chatOfDraft(draft.id);
        const stored = chatOf ? drafts[chatOf]!.find((d) => d.id === draft.id)?.text : undefined;
        if (text !== stored) throw new Error(options.editRefused);
      }
      log.pressed.push({ id: draft.id, text });
      const chatId = chatOfDraft(draft.id);
      if (!chatId) return;
      if (options.pressFails) {
        // The item stays, failed, as the Outbox keeps it: its list says so only once it catches up.
        const failed = options.pressFails;
        const unknown = options.pressUnknown === true;
        const settle = (): void => {
          drafts = { ...drafts, [chatId]: drafts[chatId]!.map((d) => (d.id === draft.id ? { ...d, text, failed, ...(unknown ? { unknown } : {}) } : d)) };
          changed();
        };
        if (options.lingers) lingering.push(settle);
        else settle();
        throw Object.assign(new Error(failed), { failed: true, unknown });
      }
      settleDraft(chatId, draft.id);
      reply(chatId, text);
    },
    openOutbox(draft) {
      log.outbox.push(draft.outboxKey ?? `box:host:${draft.id}`);
    },
    async saveDraft(draft, text) {
      if (options.slowSave) await new Promise<void>((go) => (letGo = go));
      if (options.saveRefused) throw new Error(options.saveRefused);
      log.saved.push({ id: draft.id, text });
      const chatId = chatOfDraft(draft.id);
      if (!chatId) return;
      drafts = { ...drafts, [chatId]: drafts[chatId]!.map((d) => (d.id === draft.id ? { ...d, text } : d)) };
      changed();
    },
    async draftState(draft) {
      return hidden.get(draft.id) ?? (chatOfDraft(draft.id) ? "waiting" : "done");
    },
    async dropDraft(draft) {
      if (options.slowDrop) await new Promise<void>((go) => (letGo = go));
      if (options.discardRefused) throw new Error(options.discardRefused);
      if (options.discardAnswer) throw new Error(discardRefusal({ state: options.discardAnswer })!);
      log.dropped.push(draft.id);
      const chatId = chatOfDraft(draft.id);
      if (chatId) settleDraft(chatId, draft.id);
    },
    async requestFiles(messageId) {
      log.requested.push(messageId);
      if (requestFails > 0) {
        requestFails--;
        throw new Error("LifeOS did not answer");
      }
      // As LifeOS's `chats:requestFiles`: each file only listed, or failed, goes back to wanted with no error.
      for (const chatId of threads.keys()) {
        const all = messagesOf(chatId);
        if (!all.some((m) => m._id === messageId)) continue;
        putMessages(
          chatId,
          all.map((m) => (m._id === messageId ? { ...m, files: m.files.map((f) => (f.status === "listed" || f.status === "failed" ? { ...f, status: "wanted" as const, error: undefined } : f)) } : m)),
        );
      }
    },
    fileVerb,
    useFile(fileId) {
      useVersion();
      if (!fileId) return LOADING;
      if (!log.fileReads.includes(fileId)) log.fileReads.push(fileId);
      for (const chatId of threads.keys()) {
        for (const message of messagesOf(chatId)) {
          const file = message.files.find((f) => f._id === fileId);
          if (file) return ready(file);
        }
      }
      return ready(null);
    },
    openFile(chatId, messageId, file) {
      log.opened.push({ chatId, messageId, file: file._id, verb: fileVerb(file) });
    },
  };
}

const NO_DRAFTS: readonly ThreadDraft[] = [];
