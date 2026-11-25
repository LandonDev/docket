import type { ActKind } from './acts'

/**
 * A press's or a request's one name, in his words, on every surface that shows it: the Outbox's summary head, a
 * thread request's row, card and notice (docs/agents/work-outbox.md "One press, many items"). Shared so the host's
 * notice and the window say the same thing.
 */
export type HeadItem = { kind: ActKind; verb: string; payload: unknown }

/** Each kind's noun, one and many, and the verb a summary says for it when its items do not share one. */
const NOUN: Record<ActKind, [string, string, string]> = {
  "mail.send": ["mail", "mails", "Send"],
  "office.mail.send": ["mail", "mails", "Send"],
  "teams.post": ["message", "messages", "Post"],
  "chat.reply": ["reply", "replies", "Send"],
  "calendar.op": ["invite", "invites", "Answer"],
  "office.calendar.op": ["invite", "invites", "Answer"],
  "office.edit": ["file", "files", "Change"],
  "google.edit": ["file", "files", "Change"],
  "file.act": ["file", "files", "Change"],
  "share.guestLink": ["guest link", "guest links", "Make"],
  "share.google": ["share", "shares", "Make"],
  "form.publish": ["form", "forms", "Publish"],
  "msform.publish": ["form", "forms", "Publish"],
  "msform.make": ["form", "forms", "Make"],
  "frameio.post": ["post", "posts", "Make"],
  "portal.submit": ["form", "forms", "Submit"],
  "addon.call": ["call", "calls", "Run"],
  "computer.act": ["step", "steps", "Run"],
};
const MAIL: readonly ActKind[] = ["mail.send", "office.mail.send"];

type Address = { address?: unknown };
/** Every address a mail goes to, lower case. */
function recipients(item: Pick<HeadItem, "payload">): string[] {
  const p = (item.payload ?? {}) as { message?: Record<string, unknown> } & Record<string, unknown>;
  const m = (p.message && typeof p.message === "object" ? p.message : p) as Record<string, unknown>;
  return ["to", "cc", "bcc"].flatMap((k) => (Array.isArray(m[k]) ? (m[k] as Address[]) : [])).flatMap((a) => (typeof a?.address === "string" ? [a.address.toLowerCase()] : []));
}

export const joinWords = (parts: readonly string[]): string => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? ""));
const lower = (s: string): string => s[0]!.toLowerCase() + s.slice(1);

/**
 * One sentence of everything a press on these sends: "Send 4 mails to 4 people, post 1 message and accept 1
 * invite". Kinds in the order first met; each says its items' own verb when they share one ("Accept"), else its
 * kind's; mail says to how many people. `discard` adds what goes nowhere.
 */
export function summaryHead(
  items: readonly HeadItem[],
  discard: number | readonly HeadItem[] = 0,
  opts: { /** sent at a time he set: their own part, "… later" */ later?: readonly HeadItem[]; /** no tool's or add-on's own words (a digest a read key sees) */ generic?: boolean } = {}
): string {
  const parts = groupParts(items, opts.generic === true);
  // A later send is its own act: "send 2 mails to 2 people later", never folded into a send now.
  for (const part of opts.later?.length ? groupParts(opts.later, opts.generic === true) : []) parts.push(`${parts.length ? lower(part) : part} later`);
  // What goes nowhere says what it is too ("discard 1 mail"); a bare count stays a count.
  if (typeof discard === "number") {
    if (discard) parts.push(parts.length ? `discard ${discard}` : `Discard ${discard}`);
  } else if (discard.length) {
    // An add-on's call is named by what it does, never "call" (which reads as a phone call): "discard Echo with League".
    const calls = discard.filter((i) => i.kind === "addon.call");
    const nouns = [...groupParts(discard.filter((i) => i.kind !== "addon.call"), true).map((p) => p.replace(/^\S+ /, "")), ...groupParts(calls, false)];
    parts.push(`${parts.length ? "discard" : "Discard"} ${joinWords(nouns)}`);
  }
  return joinWords(parts);
}

/** Each kind's part of a head: its verb, its count and its noun; mail to how many people; an add-on call by its tool. */
function groupParts(items: readonly HeadItem[], bare: boolean): string[] {
  const groups = new Map<string, { noun: [string, string]; verbs: Set<string>; fallback: string; items: HeadItem[] }>();
  for (const item of items) {
    const [one, many, fallback] = NOUN[item.kind];
    const p = (item.payload ?? {}) as { addonId?: unknown; tool?: unknown };
    const key = MAIL.includes(item.kind) ? "mail" : item.kind === "addon.call" ? `addon:${String(p.addonId)}:${String(p.tool)}` : `${item.kind}`;
    const group = groups.get(key) ?? { noun: [one, many], verbs: new Set(), fallback, items: [] };
    group.verbs.add(item.verb.split(" ")[0]!);
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups].map(([key, g], i) => {
    const n = g.items.length;
    if (key.startsWith("addon:") && !bare) {
      // An add-on's call by what it does, in the tool's and the add-on's own words: "Echo with League, 3 times".
      const p = (g.items[0]!.payload ?? {}) as { words?: unknown; tool?: unknown; addon?: unknown };
      const words = String(p.words ?? p.tool ?? "Run");
      const part = `${words}${typeof p.addon === "string" ? ` with ${p.addon}` : ""}${n > 1 ? `, ${n} times` : ""}`;
      return i ? lower(part) : part;
    }
    // An add-on call's verb is its tool's own words: generic, it is the kind's ("Run 2 calls").
    const verb = key.startsWith("addon:") ? g.fallback : g.verbs.size === 1 ? [...g.verbs][0]! : g.fallback;
    let part = `${i ? lower(verb) : verb} ${n} ${n === 1 ? g.noun[0] : g.noun[1]}`;
    if (key === "mail" && !bare) {
      const people = new Set(g.items.flatMap(recipients)).size;
      if (people) part += ` to ${people} ${people === 1 ? "person" : "people"}`;
    }
    return part;
  });
}

