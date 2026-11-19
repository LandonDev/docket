import type { OutboxItem } from "@shared/contract-work-outbox";
import type { ActKind } from "@shared/work";

/**
 * The Outbox's words and shapes, with no React (docs/agents/work-outbox.md,
 * "The screens"). The views draw what these answer; the tests read them.
 */

/** Work Chats' grant scope and held rows' workspace (`WORK_HOME`). */
export const WORK_CHATS_KEY = "~work";

export type Group<T> = { key: string; workspaceId: string | null; sector: string | null; items: T[] };

/** Held items under their workspace, in the order the first of each was held. Work Chats' items are one group. */
export function byWorkspace<T extends Pick<OutboxItem, "workspaceId" | "sector"> & { environmentId: string }>(items: readonly T[]): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const workspaceId = item.workspaceId === WORK_CHATS_KEY ? null : item.workspaceId;
    const key = workspaceId ? `${item.environmentId}:${workspaceId}` : `${item.environmentId}:${WORK_CHATS_KEY}`;
    const group = groups.get(key) ?? { key, workspaceId, sector: item.sector, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** "Today", "Yesterday", "Earlier": Sent's day headings. */
export function dayOf(at: number, now = Date.now()): "Today" | "Yesterday" | "Earlier" {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return "Today";
  if (at >= start.getTime() - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** 9:31 AM today; Nov 18 before. */
export function timeOf(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = dayOf(at, now) === "Today";
  return today
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Who decided a sent act, in his words: "Sent by you", "Sent from your phone", "Sent by the grant Mail to Dana Lee". */
export function decidedWords(item: Pick<OutboxItem, "decidedBy" | "verb">, grantLabel?: string | null): string {
  const past = pastOf(item.verb);
  if (item.decidedBy?.startsWith("grant:")) return grantLabel ? `${past} by the grant ${grantLabel}` : `${past} by a grant`;
  if (item.decidedBy === "owner:remote") return `${past} from another device`;
  return `${past} by you`;
}

/** "Send" → "Sent", "Post" → "Posted", "Make link" → "Made link". */
export function pastOf(verb: string): string {
  const [head = verb, ...rest] = verb.split(" ");
  const past: Record<string, string> = { Send: "Sent", Post: "Posted", Make: "Made", Accept: "Accepted", Submit: "Submitted", Share: "Shared", Book: "Booked", Run: "Ran", Publish: "Published", Decline: "Declined" };
  const word = past[head] ?? (head.endsWith("e") ? `${head}d` : `${head}ed`);
  return [word, ...rest].join(" ");
}

// ── the payload, exactly as it will go ───────────────────────────────────

type Address = { name?: string; address: string };
const isAddress = (v: unknown): v is Address => !!v && typeof v === "object" && typeof (v as Address).address === "string";
const isAddressList = (v: unknown): v is Address[] => Array.isArray(v) && v.length > 0 && v.every(isAddress);
export const addressWords = (list: readonly Address[]): string => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** Keys that are the host's bookkeeping, never what goes. */
const QUIET = new Set(["id", "status", "kind", "accountId", "html", "addonId", "specDigest", "toolDigest", "hints", "mark", "targets", "picture", "read", "proposed", "error", "words", "addon", "tool", "why"]);
/** Keys whose text is the body: drawn as one plain-text block, not a field. */
const BODY_KEYS = ["text", "body", "message", "content"];

const LABEL: Record<string, string> = { to: "To", cc: "Cc", bcc: "Bcc", from: "From", subject: "Subject", channel: "In", title: "Title", app: "App", window: "Window", label: "Act" };
const labelOf = (key: string): string => LABEL[key] ?? key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

export type Field = { key: string; path: string[]; label: string; value: string; edit: "text" | "addresses" | null };
/** The body as it reads; `readOnly` when it is drawn from html with no text beside it to edit. */
export type PayloadView = { fields: Field[]; body: { path: string[]; text: string; readOnly?: boolean } | null };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

/**
 * An html body as the words a person reads, for a view that must show what
 * goes: every link keeps its target beside its words and every image its
 * source, so nothing in the html hides from the preview. Plain text out;
 * React escapes it.
 */
export function htmlWords(html: string): string {
  // A background image goes with the mail as surely as an <img>: named first, before the tags go (the hold re-review's finding 23).
  const backgrounds: string[] = [];
  for (const m of html.matchAll(/\sbackground\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) backgrounds.push(decode(m[1] ?? m[2] ?? m[3] ?? "").trim());
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) backgrounds.push(decode(m[1] ?? m[2] ?? m[3] ?? "").trim());
  const out = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = decode(attr(tag, "src") ?? "").trim();
      const alt = decode(attr(tag, "alt") ?? "").trim();
      return `[image${alt ? ` ${alt}` : ""}${src ? `: ${src}` : ""}]`;
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (tag, inner: string) => {
      const href = decode(attr(tag.slice(0, tag.indexOf(">") + 1), "href") ?? "").trim();
      const words = decode(inner.replace(/<[^>]*>/g, "")).trim();
      if (!href || href === words || href === `mailto:${words}`) return words || href;
      return words ? `${words} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|h[1-6]|blockquote|pre|ul|ol|table)\s*>/gi, "\n\n")
    .replace(/<\/(div|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decode(out)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat(backgrounds.filter(Boolean).map((u) => `\n[background image: ${u}]`).join(""))
    .trim();
}

/**
 * The payload as the generic view draws it: each field a person would read,
 * with its path for the editor, and the body as plain text. A mail
 * (`message`) and an add-on call (`arguments`) are opened one level, so the
 * view reads as the act, not as its wrapper. What the host keeps for itself
 * (ids, digests, html beside its text) is left out.
 */
export function payloadView(payload: unknown): PayloadView {
  const fields: Field[] = [];
  let body: PayloadView["body"] = null;
  // Inside an add-on call's arguments every key is what goes, so none is quiet there (the hold review's finding 10).
  const walk = (value: unknown, path: string[], depth: number, quiet = true) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    // The html is what goes when there is one: the body reads from it, and edits go to the text beside it (the hold review's findings 4 and 11).
    if (quiet && !body && typeof obj.html === "string" && obj.html.trim()) {
      const hasText = typeof obj.text === "string";
      body = { path: [...path, hasText ? "text" : "html"], text: htmlWords(obj.html), ...(hasText ? {} : { readOnly: true }) };
    }
    for (const [key, v] of Object.entries(obj)) {
      if ((quiet && QUIET.has(key)) || v === undefined) continue;
      const at = [...path, key];
      // An add-on call's arguments are shown whole: no shortcut hides a key, a null or an empty value (the hold re-review's finding 18).
      if (!quiet && (v === null || typeof v === "object")) {
        fields.push({ key, path: at, label: labelOf(key), value: JSON.stringify(v), edit: null });
        continue;
      }
      if (v === null) continue;
      if (typeof v === "string") {
        if (quiet && body?.path.join(".") === at.join(".")) continue;
        if (!body && BODY_KEYS.includes(key) && (v.includes("\n") || v.length > 80)) body = { path: at, text: v };
        else if (v.trim()) fields.push({ key, path: at, label: labelOf(key), value: v, edit: "text" });
        // An add-on's empty or blank argument still goes: shown quoted (the hold re-review's finding 18).
        else if (!quiet) fields.push({ key, path: at, label: labelOf(key), value: JSON.stringify(v), edit: "text" });
      } else if (typeof v === "number" || typeof v === "boolean") {
        fields.push({ key, path: at, label: labelOf(key), value: String(v), edit: null });
      } else if (isAddress(v)) {
        fields.push({ key, path: at, label: labelOf(key), value: addressWords([v]), edit: null });
      } else if (isAddressList(v)) {
        fields.push({ key, path: at, label: labelOf(key), value: addressWords(v), edit: "addresses" });
      } else if (Array.isArray(v)) {
        if (v.length) fields.push({ key, path: at, label: labelOf(key), value: v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", "), edit: null });
      } else if (depth < 1 && (key === "message" || key === "arguments" || key === "args")) {
        walk(v, at, depth + 1, key === "message");
      } else if (typeof (v as { name?: unknown }).name === "string") {
        // a thing named (an app, a channel): its name
        fields.push({ key, path: at, label: labelOf(key), value: (v as { name: string }).name, edit: null });
      } else {
        fields.push({ key, path: at, label: labelOf(key), value: JSON.stringify(v), edit: null });
      }
    }
  };
  walk(payload, [], 0);
  return { fields, body };
}

const setAt = (value: unknown, path: readonly string[], next: unknown): unknown => {
  if (path.length === 0) return next;
  const [head, ...rest] = path as [string, ...string[]];
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { ...obj, [head]: setAt(obj[head], rest, next) };
};

/** "Dana Lee <dlee@purdue.edu>, sam@purdue.edu" back to addresses; null when one is not an address. */
export function parseAddresses(text: string): Address[] | null {
  const out: Address[] = [];
  for (const part of text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean)) {
    const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(part);
    if (named) out.push(named[1] ? { name: named[1].replace(/^"|"$/g, ""), address: named[2]! } : { address: named[2]! });
    else if (/^[^\s@]+@[^\s@]+$/.test(part)) out.push({ address: part });
    else return null;
  }
  return out;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text as the html a mail carries beside it: a paragraph per blank-line block. */
export const htmlOfText = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/**
 * The payload with the person's edits in place. A text beside an `html`
 * (a mail) carries a fresh html with it, so what goes matches what he read.
 */
export function applyEdits(payload: unknown, edits: ReadonlyMap<string, string>, view: PayloadView = payloadView(payload)): { payload: unknown; error: string | null } {
  let next = payload;
  const editable = [...view.fields.filter((f) => f.edit), ...(view.body && !view.body.readOnly ? [{ path: view.body.path, edit: "text" as const, label: "Message" }] : [])];
  for (const field of editable) {
    const key = field.path.join(".");
    const text = edits.get(key);
    if (text === undefined) continue;
    if (field.edit === "addresses") {
      const list = parseAddresses(text);
      if (!list) return { payload, error: `${field.label}: one of these is not an address` };
      next = setAt(next, field.path, list);
    } else {
      next = setAt(next, field.path, text);
      const parent = field.path.slice(0, -1);
      const sibling = parent.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], next) as Record<string, unknown> | undefined;
      if (field.path.at(-1) === "text" && typeof sibling?.html === "string") next = setAt(next, [...parent, "html"], htmlOfText(text));
    }
  }
  return { payload: next, error: null };
}

/** Kinds whose payload a person may change while it waits (the host refuses the rest). */
export const EDITABLE: readonly ActKind[] = ["mail.send", "addon.call", "teams.post", "office.mail.send"];

// ── grants: made only from a held item, narrow ───────────────────────────

/**
 * The grant a held item offers in its Send menu, and its name; null where
 * the kind takes none (a computer act) or its pillar has not said how. A
 * mail's fixes its account and every recipient; an add-on call's fixes the
 * server and the tool.
 */
export function grantFor(item: Pick<OutboxItem, "kind" | "payload">): { matcher: unknown; label: string } | null {
  const p = item.payload as Record<string, unknown> | null;
  if (!p) return null;
  if (item.kind === "mail.send") {
    const m = p.message as { accountId?: string; to?: Address[]; cc?: Address[]; bcc?: Address[] } | undefined;
    const people = [...(m?.to ?? []), ...(m?.cc ?? []), ...(m?.bcc ?? [])];
    if (!m || people.length === 0) return null;
    const names = people.map((a) => a.name || a.address);
    const label = names.length <= 2 ? `Mail to ${names.join(" and ")}` : `Mail to ${names[0]} and ${names.length - 1} more`;
    return { matcher: { ...(m.accountId ? { accountId: m.accountId } : {}), recipients: people.map((a) => a.address.toLowerCase()) }, label };
  }
  if (item.kind === "calendar.op") {
    // An invitation's answer on one account, or an invite to these people on it; a change to an event is never granted.
    const op = p as { kind?: string; account?: string; calendarId?: string; payload?: { attendees?: Address[]; uninvite?: string[]; series?: boolean } };
    const account = op.account ?? null;
    const calendarId = op.calendarId ?? null;
    if (op.payload?.uninvite?.length || op.payload?.series) return null;
    const on = account ? ` on ${account}` : "";
    if (op.kind === "accept" || op.kind === "decline" || op.kind === "tentative") {
      const verb = { accept: "Accept", decline: "Decline", tentative: "Answer maybe to" }[op.kind];
      return { matcher: { kind: op.kind, account, calendarId }, label: `${verb} invitations${on}` };
    }
    const people = op.payload?.attendees ?? [];
    if (op.kind !== "create" || people.length === 0) return null;
    const names = people.map((a) => a.name || a.address);
    const label = names.length <= 2 ? `Invites to ${names.join(" and ")}${on}` : `Invites to ${names[0]} and ${names.length - 1} more${on}`;
    return { matcher: { kind: "create", account, calendarId, attendees: people.map((a) => a.address.toLowerCase()) }, label };
  }
  if (item.kind === "addon.call") {
    if (typeof p.addonId !== "string" || typeof p.tool !== "string") return null;
    return { matcher: { addonId: p.addonId, tool: p.tool }, label: `${String(p.words ?? p.tool)} with ${String(p.addon ?? "the add-on")}` };
  }
  return null;
}

const KIND_WORDS: Partial<Record<ActKind, string>> = { "mail.send": "mail", "office.mail.send": "mail", "addon.call": "add-on call", "teams.post": "post", "calendar.op": "calendar act" };

/** A grant row's muted line, under its workspace's heading: "Made today from a held mail". */
export function grantLine(kind: ActKind, createdAt: number, now = Date.now()): string {
  return `Made ${dayOf(createdAt, now) === "Today" ? "today" : timeOf(createdAt, now)} from a held ${KIND_WORDS[kind] ?? "act"}`;
}

// ── the return from Away ─────────────────────────────────────────────────

export type AwayCounts = { held: number; failed: number; decided: number; written: number };

/** The toast: "Held 7, decided 4 without you, 2 failed"; null when nothing happened. */
export function awayLine(c: AwayCounts): string | null {
  const parts: string[] = [];
  if (c.held) parts.push(`held ${c.held}`);
  if (c.decided) parts.push(`decided ${c.decided} without you`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (!parts.length) return c.written ? `Wrote on ${c.written} ${c.written === 1 ? "file" : "files"} while you were away` : null;
  const line = parts.join(", ");
  return line[0]!.toUpperCase() + line.slice(1);
}

/** The Away list's sections, in the order he must act: held, failed, decided, written. Empty ones are left out. */
export const AWAY_SECTIONS = ["held", "failed", "decided", "written"] as const;
export type AwaySection = (typeof AWAY_SECTIONS)[number];
export const AWAY_HEADING: Record<AwaySection, string> = { held: "Held", failed: "Failed", decided: "Decided without you", written: "Written on your files" };

export function awaySections(c: AwayCounts): AwaySection[] {
  return AWAY_SECTIONS.filter((s) => c[s] > 0);
}

/** "5:40 PM to 9:55 PM": the stretch he was away. */
export function spanWords(since: number, until: number): string {
  const t = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(since).toDateString() === new Date(until).toDateString();
  return sameDay ? `${t(since)} to ${t(until)}` : `${timeOf(since, until)}, ${t(since)} to ${t(until)}`;
}
