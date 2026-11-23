import { SOURCE_NAME, type ChatFile, type ChatMessage, type ChatRow } from "@shared/work/messages";
import { clockTime } from "../../lib/duration";

/**
 * The Messages view's pure rules (docs/agents/work-messages.md): the words a
 * time takes, how a conversation's messages fall into runs and days, where
 * "New" sits, which words of a message are links, and what a search lights.
 * Nothing here reads LifeOS or draws.
 */

export type ChatFilter = "all" | "unread" | "direct" | "channels";
export const CHAT_FILTERS: readonly ChatFilter[] = ["all", "unread", "direct", "channels"];
/** The head's words for each filter: "Messages" for all of them. */
export const FILTER_LABEL: Record<ChatFilter, string> = { all: "Messages", unread: "Unread", direct: "Direct", channels: "Channels" };
/** The menu's words for each filter. */
export const FILTER_ROW: Record<ChatFilter, string> = { all: "All", unread: "Unread", direct: "Direct", channels: "Channels" };
/** What an empty list says under each filter. */
export const FILTER_EMPTY: Record<Exclude<ChatFilter, "all">, string> = { unread: "Nothing unread", direct: "No direct messages", channels: "No channels" };

const DAY_MS = 86_400_000;
/** A run of one writer's messages holds while each follows the last inside this. */
export const RUN_GAP_MS = 5 * 60_000;

const midnight = (at: number): number => new Date(at).setHours(0, 0, 0, 0);
/** Whole days from `at`'s day back to `now`'s: 0 today, 1 yesterday. */
const daysAgo = (at: number, now: number): number => Math.round((midnight(now) - midnight(at)) / DAY_MS);

const formats = new Map<string, Intl.DateTimeFormat>();
function format(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, options);
    formats.set(key, f);
  }
  return f;
}
const weekday = (at: number) => format("weekday", { weekday: "short" }).format(at);
const longWeekday = (at: number) => format("longWeekday", { weekday: "long" }).format(at);
const monthDay = (at: number) => format("monthDay", { month: "short", day: "numeric" }).format(at);
const monthDayYear = (at: number) => format("monthDayYear", { month: "short", day: "numeric", year: "numeric" }).format(at);

/** A row's time: "2:14 PM" today, "Yesterday", "Mon" within the week, "Nov 3" this year, "Nov 3, 2025" before. */
export function rowTime(at: number, now: number): string {
  const ago = daysAgo(at, now);
  if (ago <= 0) return clockTime(at);
  if (ago === 1) return "Yesterday";
  if (ago < 7) return weekday(at);
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? monthDay(at) : monthDayYear(at);
}

/** A day's line in a conversation: "Today", "Yesterday", "Monday" within the week, "Nov 3" this year, "Nov 3, 2025" before. */
export function dayWords(at: number, now: number): string {
  const ago = daysAgo(at, now);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return longWeekday(at);
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? monthDay(at) : monthDayYear(at);
}

/** The name a group's row leads its words with: "Dana" of "Dana Lee"; a handle stays whole. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** A row's second line: his own newest led by "You: ", a group's or channel's by the writer's first name, a direct chat's bare. */
export function rowLine(row: Pick<ChatRow, "kind" | "lastText" | "lastWho" | "lastFromMe">): string {
  const words = row.lastText.replace(/\s+/g, " ").trim();
  if (row.lastFromMe) return `You: ${words}`;
  if (row.kind === "direct" || !row.lastWho) return words;
  return `${firstName(row.lastWho)}: ${words}`;
}

/** The one muted fact beside an open conversation's name: "Slack, CosmicGames". */
export const chatFact = (chat: Pick<ChatRow, "source" | "accountName">): string =>
  chat.accountName ? `${SOURCE_NAME[chat.source]}, ${chat.accountName}` : SOURCE_NAME[chat.source];

/** When he last saw a conversation: his mark here, the service's own, or his own last word, whichever is newest. */
export const seenAt = (chat: Pick<ChatRow, "readAt" | "sourceReadAt" | "lastOutAt">): number => Math.max(chat.readAt ?? 0, chat.sourceReadAt ?? 0, chat.lastOutAt ?? 0);

/** Whether opening a conversation should mark it read: it is unread, or someone wrote after he last saw it. */
export const wantsRead = (chat: Pick<ChatRow, "unread" | "lastInAt" | "readAt" | "sourceReadAt" | "lastOutAt">): boolean => chat.unread || (chat.lastInAt ?? 0) > seenAt(chat);

/**
 * Where "New" sits as a conversation opens: after what he last saw, when he
 * has seen it before or it is unread (a conversation never opened and
 * never written to him starts at its foot, with nothing marked new). Null
 * for none.
 */
export function newSince(chat: Pick<ChatRow, "unread" | "readAt" | "sourceReadAt" | "lastOutAt">): number | null {
  if (!chat.unread && chat.readAt === undefined) return null;
  return seenAt(chat);
}

/** One message as the column draws it: whether it opens a run (face, name, time), the day it opens, and whether "New" sits over it. */
export interface Block {
  id: string;
  message: ChatMessage;
  head: boolean;
  day: string | null;
  isNew: boolean;
}

const writer = (m: ChatMessage): string => (m.who.me ? "\u0000me" : (m.who.personId ?? m.who.email ?? m.who.name));

/**
 * The column's blocks, oldest first, from LifeOS's page (newest first). A
 * run is one writer's messages, each inside five minutes of the one before,
 * on one day and on one side of "New". The first message of a page opens its
 * day. "New" sits over the first message from someone else after `since`,
 * unless that is the first message held and older ones are still to load.
 */
export function blocksOf(newestFirst: readonly ChatMessage[], since: number | null, now: number, done = true): Block[] {
  const blocks: Block[] = [];
  let marked = since === null;
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const message = newestFirst[i]!;
    const prev = blocks[blocks.length - 1]?.message;
    const newDay = !prev || midnight(prev.sentAt) !== midnight(message.sentAt);
    let isNew = false;
    if (!marked && !message.who.me && message.sentAt > since!) {
      marked = true;
      isNew = prev !== undefined || done;
    }
    const head = !prev || newDay || isNew || writer(prev) !== writer(message) || message.sentAt - prev.sentAt > RUN_GAP_MS;
    blocks.push({ id: message._id, message, head, day: newDay ? dayWords(message.sentAt, now) : null, isNew });
  }
  return blocks;
}

/** A picture, drawn in place in the conversation. */
export const isPicture = (file: Pick<ChatFile, "contentType" | "name">): boolean =>
  file.contentType ? file.contentType.startsWith("image/") : /\.(png|jpe?g|gif|webp|heic|avif)$/i.test(file.name);

/** A picture's drawn box: its own shape inside 360 by 270, never larger than it is; a square when its size is unknown. */
export function pictureBox(file: Pick<ChatFile, "width" | "height">): { width: number; height: number } {
  const w = file.width ?? 0;
  const h = file.height ?? 0;
  if (w <= 0 || h <= 0) return { width: 270, height: 270 };
  const scale = Math.min(1, 360 / w, 270 / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** A block's height before it is measured: its run's head, its day line, its quote, its lines of words at the column's measure and its files. */
export function estimateOf(block: Block): number {
  const text = block.message.text;
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 84)), 0);
  const files = block.message.files.reduce((sum, file) => sum + 6 + (isPicture(file) && file.status !== "failed" ? pictureBox(file).height : file.status === "failed" ? 24 : 40), 0);
  return (block.head ? 36 : 4) + lines * 22 + (block.day || block.isNew ? 40 : 0) + (block.message.replyTo ? 20 : 0) + files;
}

/** The schemes a message's link may open with, outside the app. */
const OPENS = /^(https?:|mailto:)/i;
/** Whether a link may be opened outside: http, https and mailto, nothing else. */
export function opensOutside(href: string): boolean {
  if (!OPENS.test(href)) return false;
  try {
    new URL(href);
    return true;
  } catch {
    return false;
  }
}

/** More closing brackets than opening: the last one closes the sentence's, not the link's. */
const unbalanced = (href: string): boolean => (href.match(/\(/g)?.length ?? 0) < (href.match(/\)/g)?.length ?? 0);

/** Text and the links in it. A link's trailing stop or bracket stays with the sentence. */
export type Part = { text: string; href?: string };
const LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"]+/gi;
export function linkParts(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    let href = match[0];
    // "see https://x.com/a." and "(https://x.com/a)": the stop and the bracket belong to the sentence.
    while (/[.,;:!?\]'}]$/.test(href) || (href.endsWith(")") && unbalanced(href))) href = href.slice(0, -1);
    const start = match.index!;
    if (start > at) parts.push({ text: text.slice(at, start) });
    if (opensOutside(href)) parts.push({ text: href, href });
    else parts.push({ text: href });
    at = start + href.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts.length ? parts : [{ text }];
}

/**
 * A search's words lit where a word starts, as Mail lights them: each part
 * of the text, and whether it is a match. Case does not matter.
 */
export function markWords(text: string, query: string): [string, boolean][] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!words.length) return [[text, false]];
  const lower = text.toLowerCase();
  const out: [string, boolean][] = [];
  let at = 0;
  let plain = 0;
  while (at < text.length) {
    const starts = at === 0 || /[^\p{L}\p{N}]/u.test(text[at - 1]!);
    const hit = starts ? words.find((w) => lower.startsWith(w, at)) : undefined;
    if (hit) {
      if (at > plain) out.push([text.slice(plain, at), false]);
      out.push([text.slice(at, at + hit.length), true]);
      at += hit.length;
      plain = at;
    } else at++;
  }
  if (plain < text.length) out.push([text.slice(plain), false]);
  return out;
}

/**
 * A long message's words from a little before the first match, so a hit's
 * line shows what it found: "…the controller fix on the second pad".
 */
export function aroundMatch(text: string, query: string, lead = 24): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let at = 0;
  for (const [part, hit] of markWords(flat, query)) {
    if (hit) break;
    at += part.length;
  }
  if (at >= flat.length || at <= lead) return flat;
  const space = flat.lastIndexOf(" ", at - lead);
  return `…${flat.slice(space + 1)}`;
}
