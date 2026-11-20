import type { GuestLinkRow, GuestRole } from "@shared/contract-work-guests";

/**
 * The People view's data (docs/agents/work-people.md), from LifeOS's
 * `people:directory` and `people:page`, both bounded to the workspace's
 * sector, and the guest links the host keeps. Pure, so the list, the page
 * and their tests share one reading of it.
 */

/** One person of the sector, as `people:directory` answers: newest contact first, then by name. */
export interface DirectoryPerson {
  _id: string;
  name: string;
  emails: string[];
  lastAt?: number;
}

export interface PageMail {
  _id: string;
  subject: string;
  snippet: string;
  lastMessageAt: number;
  unread: boolean;
  messageCount?: number;
}

export interface PageEvent {
  _id: string;
  title: string;
  startsAt: number;
  endsAt?: number;
  allDay?: boolean;
  location?: string;
}

export interface PageTask {
  _id: string;
  title: string;
  status: string;
  dueAt?: number;
  /** They asked for it, or he waits on them for it. */
  relation: "asked" | "waiting";
}

export type SharedTable = "docs" | "sheets" | "projects";

/** `people:page`: who they are and what is live with them in the sector; null for no such person there. */
export interface PersonPage {
  person: { _id: string; name: string; notes: string; sectors: string[]; emails: string[]; phones: string[] };
  lastAt?: number;
  mail: PageMail[];
  coming: PageEvent[];
  recent: PageEvent[];
  tasks: PageTask[];
  /** Of the items asked about, those in the sector, with their titles now. */
  shared: { table: SharedTable; id: string; title: string }[];
}

/** One row of `mail:faces`: the picture LifeOS holds for an address. */
export interface FaceRow {
  address: string;
  url?: string | null;
  storageId?: string | null;
}

const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The people a search keeps, in the list's own order: every word typed is in their name or one of their addresses. */
export function findPeople(rows: readonly DirectoryPerson[], query: string): DirectoryPerson[] {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((p) => {
    const hay = fold([p.name, ...p.emails].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

/** Address to picture, the map Mail's faces read, so a person has the one face Mail gives them. */
export function faceMap(rows: readonly FaceRow[] | undefined, storageBase: string | null): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const r of rows ?? []) {
    const url = r.url ?? (r.storageId && storageBase ? `${storageBase}${r.storageId}` : undefined);
    if (url) map.set(r.address.toLowerCase(), url);
  }
  return map;
}

/** A person's picture: the first of their addresses LifeOS holds one for. */
export const pictureOf = (emails: readonly string[], faces: ReadonlyMap<string, string>): string | undefined =>
  emails.map((e) => faces.get(e.toLowerCase())).find(Boolean);

/** The person an ask names: an id from the list, or an address of theirs (a sender pressed in Mail). */
export function personFor(rows: readonly DirectoryPerson[], ask: string): DirectoryPerson | undefined {
  if (!ask.includes("@")) return rows.find((p) => p._id === ask);
  const address = ask.trim().toLowerCase();
  return rows.find((p) => p.emails.some((e) => e.toLowerCase() === address));
}

/**
 * The guest links made for this person: live, and named for them. A link names its guest by the
 * words he typed, so a link is theirs when those words are the person's name, folded for case,
 * accents and spacing. One item shared twice is listed once, by its newest link.
 */
export function linksFor(links: readonly GuestLinkRow[], name: string, now: number): GuestLinkRow[] {
  const who = fold(name);
  if (!who) return [];
  const mine = links.filter((l) => l.revokedAt === null && l.expiresAt > now && fold(l.name) === who).sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  return mine.filter((l) => {
    const key = `${l.source.table}:${l.source.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What a guest link lets them do, and until when: "Can comment until Dec 3". */
export function linkWords(role: GuestRole, expiresAt: number): string {
  const verb = role === "view" ? "view" : role === "comment" ? "comment" : "edit";
  return `Can ${verb} until ${new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** Whether the page has anything live to show under who they are. */
export const pageIsQuiet = (page: PersonPage): boolean =>
  !page.mail.length && !page.coming.length && !page.recent.length && !page.tasks.length && !page.shared.length;

/** The people of the sector an event's attendees are, in the event's order, each once. */
export function knownAttendees(attendees: readonly { address: string }[] | undefined, rows: readonly DirectoryPerson[]): DirectoryPerson[] {
  if (!attendees?.length || !rows.length) return [];
  const byAddress = new Map<string, DirectoryPerson>();
  for (const p of rows) for (const e of p.emails) byAddress.set(e.toLowerCase(), p);
  const out: DirectoryPerson[] = [];
  for (const a of attendees) {
    const p = byAddress.get(a.address.trim().toLowerCase());
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
