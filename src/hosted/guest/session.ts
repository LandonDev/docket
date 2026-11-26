import type { GuestProjection } from "@shared/work/guestProjection";

/**
 * The hosted page's side of the Work service (docs/agents/work-guests.md "The
 * page"): what the address holds, the one request that opens it, the token it
 * keeps fresh, and a document's comments. No React, so a test drives it.
 *
 * Two ways in, one page:
 *  - a guest: `/g/<id>#k=<secret>`, the secret read from the fragment, which
 *    no request carries;
 *  - the owner: `/w/open#t=<ticket>`, a ticket that opens once; the renewal
 *    key it is traded for stays in this tab's session storage, so a reload
 *    of the tab keeps working and nothing else learns it.
 *
 * A guest's link may be for a project (view only): the open answers what the
 * project shows (asked again every 15 seconds), and each document or sheet
 * it lists opens through a session of its own (`child`), answered only while
 * the project still lists that item: a document as its text now (no socket),
 * a sheet with a view token for its socket.
 */

export type Mode = { kind: "guest"; id: string; secret: string } | { kind: "owner"; ticket: string | null } | { kind: "none" };

export function modeOf(pathname: string, hash: string): Mode {
  const frag = new URLSearchParams(hash.replace(/^#/, ""));
  const guest = /^\/g\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
  if (guest) {
    const secret = frag.get("k");
    return secret ? { kind: "guest", id: guest[1]!, secret } : { kind: "none" };
  }
  if (/^\/w\/open\/?$/.test(pathname)) return { kind: "owner", ticket: frag.get("t") };
  return { kind: "none" };
}

export type Role = "view" | "comment" | "edit";

export interface Opened {
  kind: "doc" | "sheet" | "project";
  role: Role;
  title: string;
  /** the guest's name; absent for the owner */
  name?: string;
  /** whose item it is; absent for the owner */
  owner?: string;
  expiresAt: number;
  token: string;
  tokenExp: number;
  /** the principal the server writes as: `guest:<id>` or `owner` */
  me: string;
  doc?: string;
  sheet?: string;
  renew?: string;
  /** a project's link: what it shows now; it has no token of its own */
  projection?: GuestProjection;
  /** a document of a project's link: its text as it stands, in place of a token and a socket */
  markdown?: string;
  /** false: a document kept as a file, whose comments the page cannot reach; it draws none */
  comments?: false;
  /** the owner's hosted editor: his own name, for his caret on a guest's page */
  self?: string;
}

/** A document or sheet of a project's link. */
export type ChildItem = { table: "docs" | "sheets"; id: string };

/**
 * Why the page could not open: the link is gone (ended, revoked, never made), too many tries, the host cannot be
 * reached, or it is starting (503: it answers, and cannot say yet whether the link stands; never an end).
 */
export type Failure = "gone" | "busy" | "down" | "starting";
export class OpenFailed extends Error {
  constructor(readonly why: Failure) {
    super(why);
  }
}

export interface Storage {
  get(): string | null;
  set(v: string | null): void;
}

/**
 * What the page keeps of a guest's link between visits, in this browser alone: when it ends and whose it is, so a
 * link past its end says so (the service gives one answer for every link that opens nothing), and the document it
 * opened, so the copy kept for an Edit link can be found and wiped when the link is over.
 */
export interface Remembered {
  until: number;
  owner?: string;
  doc?: string;
}

export interface ThreadRows {
  rows: unknown[];
  names: Record<string, string>;
}

/** A token is asked for again with two minutes left. */
const FRESH_MS = 2 * 60_000;

export class Session {
  private opened: Opened | null = null;
  private asking: Promise<Opened> | null = null;

  constructor(
    readonly mode: Exclude<Mode, { kind: "none" }>,
    private readonly origin: string,
    private readonly renewKey: Storage,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    /** set on a session for one document or sheet of a project's link */
    private readonly item: ChildItem | null = null,
    /** what the page keeps of this link between visits (`Remembered`); none for the owner's page or a test */
    private readonly memory: Storage | null = null,
  ) {}

  /** What this browser kept of the link from an earlier visit, or null. */
  remembered(): Remembered | null {
    try {
      const kept = JSON.parse(this.memory?.get() ?? "null") as Remembered | null;
      return kept && typeof kept.until === "number" ? kept : null;
    } catch {
      return null;
    }
  }

  /** A session for one document or sheet a project's link lists: its own token, asked for with the link's secret. */
  child(item: ChildItem): Session {
    return new Session(this.mode, this.origin, this.renewKey, this.fetchFn, item, null);
  }

  private async post(path: string, body: unknown): Promise<Opened> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
    } catch {
      throw new OpenFailed("down");
    }
    if (res.status === 403) throw new OpenFailed("gone");
    if (res.status === 429) throw new OpenFailed("busy");
    if (res.status === 503) throw new OpenFailed("starting");
    if (!res.ok) throw new OpenFailed("down");
    return (await res.json()) as Opened;
  }

  private ask(): Promise<Opened> {
    const m = this.mode;
    if (m.kind === "guest") return this.item ? this.post(`/g/${m.id}/item`, { secret: m.secret, table: this.item.table, id: this.item.id }) : this.post(`/g/${m.id}/open`, { secret: m.secret });
    const renew = this.renewKey.get();
    if (renew) return this.post("/w/open/renew", { renew });
    if (!m.ticket) return Promise.reject(new OpenFailed("gone"));
    const ticket = m.ticket;
    m.ticket = null;
    return this.post("/w/open/redeem", { ticket }).then((got) => {
      if (got.renew) this.renewKey.set(got.renew);
      return got;
    });
  }

  /** Opens the item, or answers what the last open said. */
  async open(): Promise<Opened> {
    if (this.opened) return this.opened;
    return this.refresh();
  }

  /** Asks again (one ask at a time): a fresh token, or the failure that says the link is gone. */
  refresh(): Promise<Opened> {
    this.asking ??= this.ask()
      .then((got) => {
        if (this.mode.kind === "guest" && !this.item) this.memory?.set(JSON.stringify({ until: got.expiresAt, ...(got.owner ? { owner: got.owner } : {}), ...(got.doc ? { doc: got.doc } : {}) } satisfies Remembered));
        return (this.opened = got);
      })
      .catch((err: unknown) => {
        if (err instanceof OpenFailed && err.why === "gone") this.renewKey.set(null);
        throw err;
      })
      .finally(() => (this.asking = null));
    return this.asking;
  }

  /** A token for the item's socket, fresh for two minutes at least. */
  async token(): Promise<{ token: string; expiresAt: number }> {
    let o = await this.open();
    if (o.tokenExp - Date.now() < FRESH_MS) o = await this.refresh();
    return { token: o.token, expiresAt: o.tokenExp };
  }

  /** The item's live socket: the link's own for a guest, the item's route for the owner. */
  socketUrl(o: Opened): string {
    const ws = this.origin.replace(/^http/, "ws");
    if (this.mode.kind === "guest") return `${ws}/g/ws/${this.mode.id}${this.item ? `/${this.item.table}/${this.item.id}` : ""}`;
    return o.kind === "doc" ? `${ws}/w/doc/${encodeURIComponent(o.doc!)}` : `${ws}/w/sheet/${encodeURIComponent(o.sheet!)}`;
  }

  private async authed(path: string, init: RequestInit = {}): Promise<Response> {
    const { token } = await this.token();
    const res = await this.fetchFn(`${this.origin}${path}`, { ...init, credentials: "omit", headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    if (res.status === 403) throw new OpenFailed("gone");
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That did not go through. Try again.");
    return res;
  }

  /** A document's comments, as the guest may see them; a guest's link only. */
  async threads(): Promise<ThreadRows> {
    if (this.mode.kind !== "guest") return { rows: [], names: {} };
    return (await (await this.authed(`/g/${this.mode.id}/threads`)).json()) as ThreadRows;
  }

  /** A new comment on the words `quote`, or a reply on a thread: plain words only. */
  async comment(c: { quote: string; text: string } | { threadId: string; text: string }): Promise<{ threadId?: string; commentId?: string }> {
    if (this.mode.kind !== "guest") throw new Error("Comments are made in Docket.");
    return (await (await this.authed(`/g/${this.mode.id}/comment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) })).json()) as {
      threadId?: string;
      commentId?: string;
    };
  }
}

/** How often a page asks again while the host says it is starting, and for how long before it says the page cannot be reached. */
export const STARTING_EVERY_MS = 2000;
export const STARTING_FOR_MS = 2 * 60_000;

/**
 * An open that waits out a host that is starting (503): asked again every two seconds for two minutes, then failed
 * as out of reach. Any other answer, good or bad, is given back as it came.
 */
export async function openWhenUp(ask: () => Promise<Opened>, o: { now?(): number; sleep?(ms: number): Promise<void>; stopped?(): boolean } = {}): Promise<Opened> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const began = now();
  for (;;) {
    try {
      return await ask();
    } catch (err) {
      if (!(err instanceof OpenFailed) || err.why !== "starting") throw err;
      if (now() - began >= STARTING_FOR_MS || o.stopped?.()) throw new OpenFailed("down");
      await sleep(STARTING_EVERY_MS);
    }
  }
}

/**
 * The line a link that opens nothing gets. One past the end time this browser was given says so, with the day and
 * whose it was; any other (revoked, a new address, never made) says only that it opens nothing.
 */
export function endWords(kept: Remembered | null, now = Date.now()): { title: string; detail: string } {
  if (kept && kept.until > 0 && kept.until <= now) return { title: `This link ended ${untilDay(kept.until)}`, detail: `Ask ${kept.owner ?? "the person who sent it"} for a new one if you still need it.` };
  return { title: "This link no longer opens anything", detail: "Ask the person who sent it if you still need it." };
}

/**
 * Whether the page's own Comment action shows. A guest comments through the page. The owner's comments are made
 * in TempCode (the phone's own Comment, the desktop's margin): `Session.comment` refuses his, so the page's
 * action would take his words and send none of them.
 */
export const commentsOnPage = (mode: Mode["kind"], role: string): boolean => mode === "guest" && role !== "view";

/** A comment body (the editor's block JSON) as the plain words the service takes. */
export function textOf(body: string): string {
  const out: string[] = [];
  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as { content?: unknown; children?: unknown }[]) {
      const runs = Array.isArray(b.content) ? (b.content as { text?: unknown; content?: unknown }[]) : [];
      out.push(runs.map((r) => (typeof r.text === "string" ? r.text : Array.isArray(r.content) ? (r.content as { text?: unknown }[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("") : "")).join(""));
      walk(b.children);
    }
  };
  try {
    walk(JSON.parse(body));
  } catch {
    return body;
  }
  return out.join("\n").trim();
}

export const untilDay = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
