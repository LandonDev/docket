import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLD_SLICE_MS, JUMP_PAGES, olderRunDone, sessionStore, type Link } from "./store";
import { emptyFold, FoldBuilder, foldPage, foldProbe } from "./fold";
import { perfThread } from "../../../../../scripts/lib/ios-perf-seeds";
import { openStamps } from "../openStamps";
import { ConnectionLostError } from "../connection";
import { newSession } from "../session";
import type { EventRow, ServerPush, SessionMeta } from "./types";
import type { EventsPage, OmittedBody, SessionPage, SessionChanges } from "@server/shared/wire";
import { workingPhase } from "../../surfaces/transcript/workingPhase";
import { blockForSeq, pageTowardJump, pendingTranscriptJump, requestTranscriptJump, takeTranscriptJump } from "../transcriptJump";

/**
 * The store over a remote socket: pages of the list, bounded pages of the
 * log with history on demand, a resume that resets, coalesced pushes, and
 * bodies that stayed on the server until a row opens.
 */

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude · implementer",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function wireMeta(over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  const { environmentId: _environmentId, ...wire } = meta(over);
  return wire;
}

const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({
  sessionId,
  seq,
  ts: 1_000 + seq,
  event,
});

const omitted = (text: string): OmittedBody => ({
  omitted: true,
  bytes: text.length,
  lines: text.split("\n").length,
  head: text.split("\n")[0],
});

class RemoteLink implements Link {
  environmentId = "local";
  connected = true;
  readonly profile = "remote" as const;
  calls: { method: string; params: unknown }[] = [];
  /** session.list answers these pages in order, with a cursor between. */
  pages: Omit<SessionMeta, "environmentId">[][] = [];
  /** The log per session, as the remote socket would project it. */
  events = new Map<string, EventRow[]>();
  /** Rows whole, by `sessionId:seq`, for session.rowBody. */
  full = new Map<string, EventRow>();
  /** When set, a resume (afterSeq alone) answers this page. */
  resume: EventsPage | null = null;
  changes: SessionChanges | null = null;
  /** Rows per tail or older page. */
  pageRows = 4;
  /** While set, every session.events answer waits here until released. */
  holdEvents: (() => void)[] | null = null;
  /** The next session.events alone waits here until released (an answer lost on a live link). */
  holdNext: (() => void)[] | null = null;
  /** The host's subscriptions on this socket: one a thread, whatever asked for it. */
  subscribed = new Set<string>();
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();

  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const p = params as { sessionId?: string; subscribe?: boolean } | undefined;
    if (method === "session.subscribe" || (method === "session.events" && p?.subscribe)) this.subscribed.add(p!.sessionId!);
    if (method === "session.unsubscribe") this.subscribed.delete(p!.sessionId!);
    const next = this.holdNext;
    if (method === "session.events" && next) {
      this.holdNext = null;
      const answer = this.answer<T>(method, params);
      return new Promise<T>((resolve) => next.push(() => resolve(answer)));
    }
    const hold = this.holdEvents;
    if (method === "session.events" && hold) {
      const answer = this.answer<T>(method, params);
      return new Promise<T>((resolve) => hold.push(() => resolve(answer)));
    }
    return this.answer<T>(method, params);
  }
  private answer<T>(method: string, params?: unknown): Promise<T> {
    if (method === "session.changes") return Promise.resolve(this.changes as T);
    if (method === "session.list") {
      const p = (params ?? {}) as { cursor?: string; archived?: boolean };
      if (p.archived) return Promise.resolve({ sessions: [], cursor: null } as T);
      const idx = p.cursor ? Number(p.cursor) : 0;
      const page: SessionPage = {
        sessions: this.pages[idx] ?? [],
        cursor: idx + 1 < this.pages.length ? String(idx + 1) : null,
      };
      return Promise.resolve(page as T);
    }
    if (method === "session.events") {
      const { sessionId, afterSeq = 0, beforeSeq, tail, subscribe } = params as {
        sessionId: string;
        afterSeq?: number;
        beforeSeq?: number;
        tail?: number;
        subscribe?: boolean;
      };
      // A current host subscribes inside the request and says so.
      const said = subscribe ? { subscribed: true } : {};
      const all = this.events.get(sessionId) ?? [];
      if (tail) {
        const range = all.filter((r) => r.seq > afterSeq && (beforeSeq === undefined || r.seq < beforeSeq));
        const rows = range.slice(-this.pageRows);
        const page: EventsPage = {
          rows,
          moreBefore: rows.length > 0 && rows[0].seq > afterSeq + 1,
          moreAfter: false,
          reset: false,
          ...said,
        };
        return Promise.resolve(page as T);
      }
      if (this.resume) return Promise.resolve({ ...this.resume, ...said } as T);
      // The host's resume guard (wire.ts eventsPageReads): a cursor past the log, or on a row of another time, starts over from the tail.
      const { afterTs } = params as { afterTs?: number };
      if (afterSeq > 0) {
        const held = all.find((r) => r.seq === afterSeq);
        if (!held || (afterTs !== undefined && held.ts !== afterTs)) {
          const rows = all.slice(-this.pageRows);
          return Promise.resolve({ rows, moreBefore: rows.length > 0 && rows[0].seq > 1, moreAfter: false, reset: true, ...said } as T);
        }
      }
      // A resume without a tail answers the oldest rows after the cursor,
      // capped at a page, and says when more follow (the wire's pager caps
      // the oldest page this way; from a cursor it answers whole or resets).
      const range = all.filter((r) => r.seq > afterSeq);
      const rows = range.slice(0, this.pageRows);
      return Promise.resolve({ rows, moreBefore: false, moreAfter: rows.length < range.length, reset: false, ...said } as T);
    }
    if (method === "session.rowBody") {
      const { sessionId, seq } = params as { sessionId: string; seq: number };
      const whole = this.full.get(`${sessionId}:${seq}`);
      return whole ? Promise.resolve({ row: whole } as T) : Promise.reject(new Error("no row"));
    }
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void): () => void {
    this.pushListeners.add(l);
    return () => this.pushListeners.delete(l);
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  onClose() {
    return () => {};
  }
  push(p: ServerPush): void {
    for (const l of this.pushListeners) l(p);
  }
  /** A row appended on the host: in the log, and pushed once to a socket subscribed to its thread. */
  append(r: EventRow): void {
    this.events.set(r.sessionId, [...(this.events.get(r.sessionId) ?? []), r]);
    if (this.subscribed.has(r.sessionId)) this.push({ push: "event", row: r });
  }
  open(): void {
    for (const l of this.openListeners) l();
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** Six turns of prompt + answer: seqs 1..12. */
function turns(sessionId: string, n = 6, from = 1): EventRow[] {
  const out: EventRow[] = [];
  let seq = from;
  for (let t = 1; t <= n; t++) {
    out.push(row(sessionId, seq++, { type: "user-text", text: `prompt ${t}` }));
    out.push(row(sessionId, seq++, { type: "assistant-text", text: `answer ${t}`, delta: false }));
  }
  return out;
}

let link: RemoteLink;
beforeEach(() => {
  sessionStore.reset();
  link = new RemoteLink();
});
afterEach(() => sessionStore.reset());

/** A link that reports connected lists on connect; `open()` would list again. */
async function boot(l: RemoteLink): Promise<void> {
  sessionStore.attach(l);
  await sessionStore.ready();
}

describe("remote profile: the list", () => {
  it("walks the pages and merges every one", async () => {
    link.pages = [[wireMeta({ id: "a", status: "running" })], [wireMeta({ id: "b" })], [wireMeta({ id: "c" })]];
    await boot(link);
    expect(sessionStore.metas().map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
    const lists = link.calls.filter((c) => c.method === "session.list" && !(c.params as { archived?: boolean })?.archived);
    expect(lists.map((c) => (c.params as { cursor?: string })?.cursor)).toEqual([undefined, "1", "2"]);
  });
});

describe("remote profile: pushes", () => {
  it("folds a coalesced events frame and merges a sessions frame", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 1));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks).toHaveLength(2);
    link.push({
      push: "events",
      sessionId: "s1",
      rows: [
        row("s1", 3, { type: "user-text", text: "prompt 2" }),
        row("s1", 4, { type: "assistant-text", text: "answer 2", delta: false }),
      ],
    });
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual([
      "prompt 1",
      "answer 1",
      "prompt 2",
      "answer 2",
    ]);
    link.push({ push: "sessions", sessions: [wireMeta({ id: "s1", status: "running" }), wireMeta({ id: "s2" })] });
    expect(sessionStore.metaOf("s1")?.status).toBe("running");
    expect(sessionStore.metaOf("s2")).not.toBeNull();
  });
});

describe("remote profile: history", () => {
  it("paints the tail, pages older rows in on demand, and keeps the tail's block ids", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 12));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const tail = sessionStore.get("s1")!;
    expect(tail.blocks.map((b) => b.text)).toEqual(["prompt 11", "answer 11", "prompt 12", "answer 12"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
    // No eager head fetch: one session.events so far.
    expect(link.count("session.events")).toBe(1);
    const tailIds = tail.blocks.map((b) => b.id);

    expect(await sessionStore.loadOlder("s1")).toBe(true);
    const after = sessionStore.get("s1")!;
    expect(after.blocks.map((b) => b.text)).toEqual([
      "prompt 9",
      "answer 9",
      "prompt 10",
      "answer 10",
      "prompt 11",
      "answer 11",
      "prompt 12",
      "answer 12",
    ]);
    expect(after.blocks.slice(4).map((b) => b.id)).toEqual(tailIds);
    const older = link.calls.filter((c) => c.method === "session.events").at(-1)!.params as { beforeSeq?: number; tail?: number };
    expect(older.beforeSeq).toBe(21);
    expect(older.tail).toBeGreaterThan(0);

    // Eight loaded, eight more would leave eight on the host: the run goes on to the first row.
    expect(await sessionStore.loadOlder("s1")).toBe(false);
    expect(sessionStore.get("s1")?.blocks).toHaveLength(24);
    expect(sessionStore.hasOlderHistory("s1")).toBe(false);
    expect(sessionStore.isComplete("s1")).toBe(true);
  });

  it("a cold load stamps the open's clock: its ask leaving, its answer, its rows folded, once each and in order", async () => {
    const seen: string[] = [];
    const spies = (["asked", "answered", "folded"] as const).map((k) =>
      vi.spyOn(openStamps, k).mockImplementation((id: string) => void seen.push(`${k} ${id}`)),
    );
    try {
      link.pages = [[wireMeta({ id: "s1" })]];
      link.events.set("s1", turns("s1"));
      await boot(link);
      await sessionStore.ensureLoaded("s1");
      expect(seen).toEqual(["asked s1", "answered s1", "folded s1"]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("ensureComplete pages the whole history in", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureComplete("s1");
    expect(sessionStore.get("s1")?.blocks).toHaveLength(12);
    expect(link.count("session.events")).toBe(3);
  });

  it("a push that lands while an older page folds is kept", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const loading = sessionStore.loadOlder("s1");
    link.push({ push: "event", row: row("s1", 13, { type: "user-text", text: "prompt 7" }) });
    await loading;
    const texts = sessionStore.get("s1")!.blocks.map((b) => b.text);
    expect(texts[0]).toBe("prompt 1");
    expect(texts.at(-1)).toBe("prompt 7");
  });

  it("a resume whose gap outgrew the budget takes the fresh tail and drops the old fold", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks[0].text).toBe("prompt 5");
    link.resume = {
      rows: turns("s1", 2, 41),
      moreBefore: true,
      moreAfter: false,
      reset: true,
    };
    await sessionStore.resync(link);
    const texts = sessionStore.get("s1")!.blocks.map((b) => b.text);
    expect(texts).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2"]);
    expect(sessionStore.get("s1")!.blocks[0].id).toBe("u:41");
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
  });

  it("an optimistic row whose echo is behind a reset tail is claimed when its page lands, never left pending under the stream", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    sessionStore.appendOptimisticUser("s1", "prompt 7");
    const sent = sessionStore.get("s1")!.blocks.at(-1)!;
    expect(sent).toMatchObject({ pending: true, pendingAfter: 12 });
    // The host wrote the echo at 13 and streamed for minutes; the socket
    // shed its pushes, and the resume found the gap past its budget and
    // answered a fresh tail that starts after the echo.
    const stream: EventRow[] = [row("s1", 13, { type: "user-text", text: "prompt 7" })];
    for (let seq = 14; seq <= 24; seq++) stream.push(row("s1", seq, { type: "assistant-text", text: `step ${seq}`, delta: false }));
    link.events.set("s1", [...turns("s1"), ...stream]);
    link.resume = { rows: stream.slice(-4), moreBefore: true, moreAfter: false, reset: true };
    await sessionStore.resync(link);
    let blocks = sessionStore.get("s1")!.blocks;
    expect(blocks[0]).toMatchObject({ pending: true, text: "prompt 7" });
    expect(blocks.at(-1)).toMatchObject({ role: "assistant", text: "step 24" });
    // An older page that stops short of the echo keeps the row pending
    // where it was: first, ahead of the stream, never under it.
    expect(await sessionStore.loadOlder("s1")).toBe(true);
    blocks = sessionStore.get("s1")!.blocks;
    expect(blocks[0]).toMatchObject({ pending: true, text: "prompt 7" });
    expect(blocks.at(-1)).toMatchObject({ role: "assistant", text: "step 24" });
    expect(blocks.filter((b) => b.pending)).toHaveLength(1);
    // The run that holds the echo (on to the first row): the echo takes the row's key, the pending row is gone.
    expect(await sessionStore.loadOlder("s1")).toBe(false);
    blocks = sessionStore.get("s1")!.blocks;
    expect(blocks.some((b) => b.pending)).toBe(false);
    const echo = blocks.find((b) => b.role === "user" && b.text === "prompt 7")!;
    expect(echo).toMatchObject({ id: "u:13", rowKey: sent.id, seq: 13 });
    expect(blocks.map((b) => b.text).slice(-2)).toEqual(["step 23", "step 24"]);
    // The working line over the live turn no longer reads Sending.
    expect(workingPhase(blocks.slice(blocks.indexOf(echo)), null).key).not.toBe("sending");
    // The claim tells the view nothing new is pending, and the echo is folded once.
    expect(sessionStore.get("s1")!.blocks.filter((b) => b.role === "user" && b.text === "prompt 7")).toHaveLength(1);
  });

  it("a pane restored from the saved layout paints the tail once its host lists it, never the oldest page", async () => {
    // The stub enters as a loaded draft with no rows (the setSessions shim),
    // before the box has connected; its first list adopts it and resyncs.
    link.environmentId = "box";
    const stub = { ...newSession("box", "claude", "/repo"), id: "s1", title: "Master" };
    sessionStore.mutate((prev) => [...prev, stub]);
    link.pages = [[wireMeta({ id: "s1", title: "Master" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    const events = link.calls.filter((c) => c.method === "session.events");
    expect(events).toHaveLength(1);
    expect(events[0].params).toMatchObject({ sessionId: "s1", afterSeq: 0, tail: expect.any(Number) });
    const session = sessionStore.get("s1")!;
    expect(session.environmentId).toBe("box");
    expect(session.blocks.map((b) => b.text)).toEqual(["prompt 5", "answer 5", "prompt 6", "answer 6"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
    expect(await sessionStore.loadOlder("s1")).toBe(false);
    expect(sessionStore.get("s1")!.blocks[0].text).toBe("prompt 1");
  });

  it("a resume page that says more rows follow is followed to the end, not left as the whole fold", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1"));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.blocks.at(-1)?.text).toBe("answer 6");
    // Six more turns landed while the socket was down: the pager answers
    // the gap four rows at a time, each page naming the cursor it left.
    link.events.set("s1", turns("s1", 12));
    const before = link.count("session.events");
    await sessionStore.resync(link);
    const pages = link.calls
      .filter((c) => c.method === "session.events")
      .slice(before)
      .map((c) => c.params as { afterSeq: number; tail?: number });
    // Each names the time of the row it holds at its cursor (`row` stamps 1,000 + seq).
    expect(pages).toEqual([
      { sessionId: "s1", afterSeq: 12, afterTs: 1_012 },
      { sessionId: "s1", afterSeq: 16, afterTs: 1_016 },
      { sessionId: "s1", afterSeq: 20, afterTs: 1_020 },
    ]);
    expect(sessionStore.get("s1")!.blocks.map((b) => b.text).slice(-2)).toEqual(["prompt 12", "answer 12"]);
    expect(sessionStore.hasOlderHistory("s1")).toBe(true);
  });
});

describe("remote profile: the catch-up after a reconnect", () => {
  it("replays each transcript in turn, the shown one at once, and every row of the gap lands once, in order", async () => {
    link.pages = [[wireMeta({ id: "a" }), wireMeta({ id: "b" }), wireMeta({ id: "c" })]];
    for (const id of ["a", "b", "c"]) link.events.set(id, turns(id, 2));
    await boot(link);
    let shown: string | null = "c";
    const shownListeners = new Set<() => void>();
    sessionStore.followShown({ shown: () => shown, onChange: (l) => (shownListeners.add(l), () => shownListeners.delete(l)) });
    sessionStore.setMounted(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) await sessionStore.ensureLoaded(id);
    // The link drops; while it is down each thread gains a turn.
    for (const id of ["a", "b", "c"]) link.events.set(id, [...turns(id, 2), ...turns(id, 1, 5).map((r, i) => ({ ...r, event: { ...r.event, text: `late ${i}` } as EventRow["event"] }))]);
    link.holdEvents = [];
    const before = link.count("session.events");
    link.open();
    await new Promise((r) => setTimeout(r, 0));
    const asked = (): string[] =>
      link.calls.filter((c) => c.method === "session.events").slice(before).map((c) => (c.params as { sessionId: string }).sessionId);
    // The shown thread alone: the others wait while its page is out.
    expect(asked()).toEqual(["c"]);
    // A row of the shown thread pushed while its page is out folds once, after it.
    link.push({ push: "event", row: link.events.get("c")!.at(-1)! });
    const held = link.holdEvents;
    // b becomes the shown one while it waits: it goes at once.
    shown = "b";
    for (const l of shownListeners) l();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["c", "b"]);
    link.holdEvents = null;
    for (const release of held) release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["c", "b", "a"]);
    for (const id of ["a", "b", "c"]) {
      expect(sessionStore.get(id)!.blocks.map((b) => b.text)).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "late 0", "late 1"]);
    }
  });

  /** A master shown in the focused pane whose own page stays out, and a child of its batch. */
  async function masterWithChild(): Promise<{ asked: () => string[] }> {
    link.pages = [[wireMeta({ id: "m" }), wireMeta({ id: "c", parentId: "m" })]];
    for (const id of ["m", "c"]) link.events.set(id, turns(id, 2));
    await boot(link);
    sessionStore.followShown({ shown: () => "m", onChange: () => () => {} });
    link.holdEvents = [];
    void sessionStore.ensureLoaded("m", "pane").catch(() => undefined);
    const asked = (): string[] => link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { sessionId: string }).sessionId);
    return { asked };
  }

  it("a thread a view draws loads at once, never behind the master's fetches", async () => {
    const { asked } = await masterWithChild();
    const off = sessionStore.drawOnScreen("c");
    void sessionStore.ensureLoaded("c", "byId").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m", "c"]);
    off();
  });

  it("a thread asked for before a view draws it starts when it does", async () => {
    const { asked } = await masterWithChild();
    void sessionStore.ensureLoaded("c", "byId").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m"]);
    const off = sessionStore.drawOnScreen("c");
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m", "c"]);
    off();
  });

  it("a thread is on screen until the last view that draws it lets go", async () => {
    const { asked } = await masterWithChild();
    const first = sessionStore.drawOnScreen("c");
    const second = sessionStore.drawOnScreen("c");
    first();
    first();
    void sessionStore.ensureLoaded("c", "byId").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m", "c"]);
    second();
  });

  /** A background fetch out (a hover prefetch, a reconnect's replay) and nothing on screen yet. */
  async function backgroundOut(): Promise<{ asked: () => string[] }> {
    link.pages = [[wireMeta({ id: "bg" }), wireMeta({ id: "b" }), wireMeta({ id: "c" })]];
    for (const id of ["bg", "b", "c"]) link.events.set(id, turns(id, 2));
    await boot(link);
    sessionStore.followShown({ shown: () => null, onChange: () => () => {} });
    link.holdEvents = [];
    void sessionStore.ensureLoaded("bg", "prefetch").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const asked = (): string[] => link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { sessionId: string }).sessionId);
    expect(asked()).toEqual(["bg"]);
    return { asked };
  }

  it("a pressed thread's fetch starts while a background fetch is out, before any pane mounts", async () => {
    const { asked } = await backgroundOut();
    sessionStore.pressOnScreen("b");
    void sessionStore.ensureLoaded("b", "load").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["bg", "b"]);
  });

  it("an ask for a thread on screen says shown; a background one does not", async () => {
    const { asked } = await backgroundOut();
    sessionStore.pressOnScreen("b");
    void sessionStore.ensureLoaded("b", "load").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["bg", "b"]);
    const shownOf = link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { shown?: boolean }).shown);
    expect(shownOf).toEqual([undefined, true]);
  });

  it("a press ends at the next press: the thread he left waits its turn again", async () => {
    const { asked } = await backgroundOut();
    sessionStore.pressOnScreen("b");
    sessionStore.pressOnScreen("c");
    void sessionStore.ensureLoaded("b", "load").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["bg"]);
  });

  it("a press ends when the focused pane shows the thread", async () => {
    link.pages = [[wireMeta({ id: "bg" }), wireMeta({ id: "b" })]];
    for (const id of ["bg", "b"]) link.events.set(id, turns(id, 2));
    await boot(link);
    let shown: string | null = null;
    const listeners = new Set<() => void>();
    sessionStore.followShown({ shown: () => shown, onChange: (l) => (listeners.add(l), () => listeners.delete(l)) });
    sessionStore.pressOnScreen("b");
    shown = "b";
    for (const l of listeners) l();
    // The pane moves on: nothing holds b on screen any longer.
    shown = null;
    for (const l of listeners) l();
    link.holdEvents = [];
    void sessionStore.ensureLoaded("bg", "prefetch").catch(() => undefined);
    void sessionStore.ensureLoaded("b", "prefetch").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { sessionId: string }).sessionId)).toEqual(["bg"]);
  });

  it("Retry on a load waiting its turn starts it now", async () => {
    const { asked } = await masterWithChild();
    void sessionStore.ensureLoaded("c", "byId").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m"]);
    sessionStore.retryLoad("c");
    await new Promise((r) => setTimeout(r, 0));
    expect(asked()).toEqual(["m", "c"]);
  });

  it("a page longer than a slice folds across tasks, whole and in order", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.pageRows = 2_000;
    link.events.set("s1", turns("s1", 1_000));
    await boot(link);
    const realNow = performance.now.bind(performance);
    let tick = 0;
    // Every row "takes" 1 ms, so the fold yields every FOLD_SLICE_MS rows.
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (tick += 1));
    let yields = 0;
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (!ms) yields++;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      await sessionStore.ensureLoaded("s1");
    } finally {
      spy.mockRestore();
      timeoutSpy.mockRestore();
      void realNow;
    }
    const blocks = sessionStore.get("s1")!.blocks;
    expect(blocks).toHaveLength(2_000);
    expect(blocks[0].text).toBe("prompt 1");
    expect(blocks.at(-1)!.text).toBe("answer 1000");
    expect(yields).toBeGreaterThan(100);
  });
});

describe("remote profile: what a page costs to fold", () => {
  /** The fold's own count of blocks read and copied (fold.ts `foldProbe`). */
  const visitsOf = async (run: () => Promise<unknown>): Promise<number> => {
    foldProbe.visits = 0;
    await run();
    return foldProbe.visits;
  };
  // One slice a page, whatever the machine's speed: the count below is of the fold, not of the clock.
  const oneSlice = (): (() => void) => {
    const spy = vi.spyOn(performance, "now").mockReturnValue(0);
    return () => spy.mockRestore();
  };

  it("a resume page into a long thread copies its blocks once a slice, not once a row", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.pageRows = 4_000;
    link.events.set("s1", turns("s1", 2_000));
    await boot(link);
    const restore = oneSlice();
    try {
      sessionStore.setMounted(["s1"]);
      await sessionStore.ensureLoaded("s1");
      expect(sessionStore.get("s1")!.blocks).toHaveLength(4_000);
      // The gap after a cut: 1,000 rows more, answered as one resume page.
      const gap = turns("s1", 500, 4_001);
      link.events.set("s1", [...link.events.get("s1")!, ...gap]);
      const visits = await visitsOf(async () => {
        link.open();
        await vi.waitFor(() => expect(sessionStore.get("s1")!.blocks).toHaveLength(5_000));
      });
      // Row by row this was 1,000 copies of 4,000 to 5,000 blocks: over 4,000,000.
      expect(visits).toBeLessThan(40_000);
    } finally {
      restore();
    }
    const blocks = sessionStore.get("s1")!.blocks;
    expect(blocks[3_999].text).toBe("answer 2000");
    expect(blocks[4_000].text).toBe("prompt 1");
    expect(blocks.at(-1)!.text).toBe("answer 500");
    expect(new Set(blocks.map((b) => b.id)).size).toBe(5_000);
  });

  it("an older page refolds the kept rows once, through one builder", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.pageRows = 2_000;
    link.events.set("s1", turns("s1", 5_000));
    await boot(link);
    const restore = oneSlice();
    try {
      await sessionStore.ensureLoaded("s1");
      const visits = await visitsOf(() => sessionStore.loadOlder("s1"));
      expect(sessionStore.get("s1")!.blocks).toHaveLength(4_000);
      // 4,000 rows refolded: row by row it copied the growing blocks 4,000 times (8,000,000 visits).
      expect(visits).toBeLessThan(40_000);
    } finally {
      restore();
    }
    const blocks = sessionStore.get("s1")!.blocks;
    expect(blocks[0].text).toBe("prompt 3001");
    expect(blocks.at(-1)!.text).toBe("answer 5000");
  });
});

describe("remote profile: climbing to the top", () => {
  /** A 30,000-row agent thread in two turns, the soak's long scene (perfThread). */
  const agentLog = (id: string, rows = 30_000): EventRow[] =>
    perfThread(id, { rows, turns: 2, seed: 7 }).map((event, i) => ({ sessionId: id, seq: i + 1, ts: 1_000 + i, event }));
  /** Every row handed to a fold builder: what the climb costs, by rows. */
  const countAdds = () => {
    const real = FoldBuilder.prototype.add;
    const counter = { rows: 0, restore: () => void (FoldBuilder.prototype.add = real) };
    FoldBuilder.prototype.add = function (this: FoldBuilder, r: EventRow) {
      counter.rows++;
      return real.call(this, r);
    };
    return counter;
  };
  const olderAsks = () =>
    link.calls.filter((c) => c.method === "session.events" && (c.params as { beforeSeq?: number }).beforeSeq !== undefined);

  it("a run gathers at least the rows loaded, and goes on to the top when the next run would reach it", () => {
    expect(olderRunDone(300, 299, 10_000)).toBe(false);
    expect(olderRunDone(300, 300, 10_000)).toBe(true);
    // 600 loaded after this run, 500 left: the next run would end at the first row, so this one does.
    expect(olderRunDone(300, 300, 500)).toBe(false);
    expect(olderRunDone(300, 300, 600)).toBe(true);
  });

  it("paging to the top of 30,000 rows folds them about once and a half, each once and in order", async () => {
    // The host's own cap: 300 rows a page (HISTORY_PAGE_ROWS), the tail too.
    link.pageRows = 300;
    const log = agentLog("s1");
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", log);
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const whole = (() => {
      foldProbe.visits = 0;
      foldPage(emptyFold(), log, "/repo");
      return foldProbe.visits;
    })();
    const adds = countAdds();
    foldProbe.visits = 0;
    let runs = 0;
    try {
      while (await sessionStore.loadOlder("s1")) runs++;
      runs++;
    } finally {
      adds.restore();
    }
    // Every page asked once: 29,700 rows below the tail at 300 a page.
    expect(olderAsks()).toHaveLength(99);
    // Runs fold at 600, 1,200, 2,400, 4,800, 9,600 rows, then all 30,000: 48,600 rows in six refolds.
    expect(runs).toBe(6);
    expect(adds.rows).toBe(48_600);
    // The bound the store holds: at most twice the rows (a refold a page was 50 times them).
    expect(adds.rows).toBeLessThanOrEqual(2 * log.length);
    expect(foldProbe.visits).toBeLessThanOrEqual(2 * whole);
    // Once and in order: the same blocks as one fold of the whole log.
    const blocks = sessionStore.get("s1")!.blocks;
    const expected = foldPage(emptyFold(), log, "/repo").blocks;
    expect(blocks.map((b) => b.id)).toEqual(expected.map((b) => b.id));
    expect(sessionStore.hasOlderHistory("s1")).toBe(false);
  });

  it("never two older asks in flight, however many presses, scrolls and jumps ask", async () => {
    link.pageRows = 4;
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 40));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    let out = 0;
    let most = 0;
    const real = link.request.bind(link);
    link.request = <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== "session.events" || (params as { beforeSeq?: number }).beforeSeq === undefined) return real<T>(method, params);
      out++;
      most = Math.max(most, out);
      return new Promise<T>((resolve) => setTimeout(() => resolve(real<T>(method, params)), 1)).finally(() => out--);
    };
    await Promise.all([
      sessionStore.loadOlder("s1"),
      sessionStore.loadOlder("s1"),
      sessionStore.loadOlder("s1", 3),
      sessionStore.loadOlder("s1"),
      sessionStore.loadOlder("s1", 1),
    ]);
    expect(most).toBe(1);
    expect(sessionStore.get("s1")!.blocks).toHaveLength(80);
    expect(new Set(olderAsks().map((c) => (c.params as { beforeSeq: number }).beforeSeq)).size).toBe(olderAsks().length);
  });

  it("no task of the climb folds more than a slice", async () => {
    link.pageRows = 300;
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", agentLog("s1", 6_000));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    // A page comes off the socket in a task of its own, as it does over a link.
    const answer = link.request.bind(link);
    link.request = <T,>(method: string, params?: unknown): Promise<T> =>
      new Promise<T>((resolve) => setTimeout(() => resolve(answer<T>(method, params)), 0));
    // Every read of the clock "takes" 1 ms: a slice is FOLD_SLICE_MS rows, give or take one.
    let tick = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (tick += 1));
    // A task ends at the next macrotask: each task's rows are counted apart.
    const tasks: number[] = [];
    let current: number | null = null;
    const real = FoldBuilder.prototype.add;
    FoldBuilder.prototype.add = function (this: FoldBuilder, r: EventRow) {
      if (current === null) {
        current = tasks.push(0) - 1;
        setTimeout(() => (current = null), 0);
      }
      tasks[current]++;
      return real.call(this, r);
    };
    try {
      while (await sessionStore.loadOlder("s1"));
    } finally {
      FoldBuilder.prototype.add = real;
      clock.mockRestore();
    }
    expect(sessionStore.get("s1")!.blocks.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(100);
    expect(Math.max(...tasks)).toBeLessThanOrEqual(FOLD_SLICE_MS + 1);
  });
});

describe("remote profile: a jump to an old search hit", () => {
  const olderAsks = () =>
    link.calls.filter((c) => c.method === "session.events" && (c.params as { beforeSeq?: number }).beforeSeq !== undefined);
  afterEach(() => void takeTranscriptJump("s1"));

  it("a hit at row 500 of 30,000 pages until its row is in, folded once, and lands on its block", async () => {
    link.pageRows = 300;
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 15_000));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    requestTranscriptJump("s1", 500);
    const jump = pendingTranscriptJump("s1")!;
    // What the transcript does when no block holds the hit yet.
    expect(blockForSeq(sessionStore.get("s1")!.blocks, 500)).toBeNull();
    const adds = { rows: 0 };
    const real = FoldBuilder.prototype.add;
    FoldBuilder.prototype.add = function (this: FoldBuilder, r: EventRow) {
      adds.rows++;
      return real.call(this, r);
    };
    try {
      expect(pageTowardJump(jump, sessionStore)).toBe(true);
      // Asked again while the run is out (each blocks change re-runs the effect): nothing more.
      expect(pageTowardJump(jump, sessionStore)).toBe(true);
      await vi.waitFor(() => expect(sessionStore.olderBefore("s1")).toBeLessThanOrEqual(500));
    } finally {
      FoldBuilder.prototype.add = real;
    }
    // 29,700 rows below the tail, 300 a page, until a page starts at or before seq 500 (at 301): 98 asks,
    // one run, and one refold of the 29,700 rows from 301 on.
    expect(olderAsks()).toHaveLength(98);
    expect(sessionStore.olderBefore("s1")).toBe(301);
    expect(adds.rows).toBe(29_700);
    const blocks = sessionStore.get("s1")!.blocks;
    const block = blockForSeq(blocks, 500)!;
    expect(block).toMatchObject({ role: "assistant", text: "answer 250", seq: 500 });
    // The jump still waits for the transcript to take it, and nothing else is asked for it.
    expect(pendingTranscriptJump("s1")).toBe(jump);
    expect(pageTowardJump(jump, sessionStore)).toBe(false);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  it("a hit past the bound stops after JUMP_PAGES pages: the request is dropped and the thread pages on as before", async () => {
    link.pageRows = 300;
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 30_000));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    requestTranscriptJump("s1", 500);
    pageTowardJump(pendingTranscriptJump("s1")!, sessionStore);
    await vi.waitFor(() => expect(pendingTranscriptJump("s1")).toBeNull());
    expect(olderAsks()).toHaveLength(JUMP_PAGES);
    expect(sessionStore.olderBefore("s1")).toBe(59_701 - JUMP_PAGES * 300);
    const blocks = sessionStore.get("s1")!.blocks;
    expect(blocks).toHaveLength(300 + JUMP_PAGES * 300);
    expect(blocks[0].seq).toBe(59_701 - JUMP_PAGES * 300);
    expect(blocks.at(-1)!.text).toBe("answer 30000");
    // Usable: Load earlier goes on from there (fewer rows remain than are loaded, so to the top), rows once and in order.
    expect(await sessionStore.loadOlder("s1")).toBe(false);
    const more = sessionStore.get("s1")!.blocks;
    expect(more).toHaveLength(60_000);
    const seqs = more.map((b) => b.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("remote profile: a cold open's lost answer", () => {
  afterEach(() => vi.useRealTimers());

  /** s1 listed, its first session.events held; returns the release of that answer. */
  async function lostOpen(): Promise<(() => void)[]> {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", turns("s1", 2));
    link.pageRows = 300;
    await boot(link);
    vi.useFakeTimers();
    const first: (() => void)[] = [];
    link.holdNext = first;
    void sessionStore.ensureLoaded("s1", "load").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.count("session.events")).toBe(1);
    return first;
  }

  const texts = (): string[] => sessionStore.get("s1")!.blocks.map((b) => b.text ?? "");

  it("a link that never answers the first ask paints by the second at the deadline, each row once", async () => {
    await lostOpen();
    // A row lands while both asks are out: it is pushed (the first ask subscribed) and in the second's page.
    link.append(row("s1", 5, { type: "user-text", text: "prompt 3" }));
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(link.count("session.events")).toBeGreaterThanOrEqual(2);
    expect(sessionStore.get("s1")!.load?.phase).toBe("loaded");
    expect(texts()).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "prompt 3"]);
    expect(link.subscribed).toEqual(new Set(["s1"]));
    link.append(row("s1", 6, { type: "assistant-text", text: "answer 3", delta: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "prompt 3", "answer 3"]);
  });

  it("the first answer landing after the second: each row folded once, each later push received once", async () => {
    const first = await lostOpen();
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2"]);
    for (const release of first) release();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2"]);
    const pushes: number[] = [];
    const off = link.onPush((p) => p.push === "event" && pushes.push(p.row.seq));
    link.append(row("s1", 5, { type: "user-text", text: "prompt 3" }));
    await vi.advanceTimersByTimeAsync(0);
    off();
    expect(pushes).toEqual([5]);
    expect(texts()).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "prompt 3"]);
    // The second ask did not subscribe; the host holds one subscription.
    const events = link.calls.filter((c) => c.method === "session.events").map((c) => c.params as { subscribe?: boolean });
    expect(events.filter((e) => e.subscribe)).toHaveLength(1);
    expect(link.subscribed).toEqual(new Set(["s1"]));
  });
});

describe("remote profile: a resume after the host lost rows", () => {
  it("names the time of its last row, and the reset page leaves no row of the lost run and no row twice", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.pageRows = 300;
    link.events.set("s1", turns("s1", 3));
    await boot(link);
    sessionStore.setMounted(["s1"]);
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")!.blocks.map((b) => b.text)).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "prompt 3", "answer 3"]);
    // The host died after pushing seqs 5 and 6 and before writing them: its next rows took those seqs, at other times.
    const reborn = (seq: number, event: EventRow["event"]): EventRow => ({ sessionId: "s1", seq, ts: 9_000 + seq, event });
    link.events.set("s1", [
      ...turns("s1", 2),
      reborn(5, { type: "user-text", text: "again 3" }),
      reborn(6, { type: "assistant-text", text: "again answer 3", delta: false }),
      reborn(7, { type: "user-text", text: "prompt 4" }),
    ]);
    link.holdEvents = [];
    link.open();
    await new Promise((r) => setTimeout(r, 0));
    const resume = link.calls.filter((c) => c.method === "session.events").at(-1)!.params as { afterSeq: number; afterTs?: number };
    expect(resume).toMatchObject({ afterSeq: 6, afterTs: 1_006 });
    // A row of the new run pushed while the page is out folds once, after it.
    link.push({ push: "event", row: reborn(7, { type: "user-text", text: "prompt 4" }) });
    const held = link.holdEvents;
    link.holdEvents = null;
    for (const release of held) release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(sessionStore.get("s1")!.blocks.map((b) => b.text)).toEqual(["prompt 1", "answer 1", "prompt 2", "answer 2", "again 3", "again answer 3", "prompt 4"]);
    // The next resume names the new run's time at its cursor.
    link.holdEvents = [];
    link.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(link.calls.filter((c) => c.method === "session.events").at(-1)!.params).toMatchObject({ afterSeq: 7, afterTs: 9_007 });
  });
});

describe("remote profile: bodies off the wire", () => {
  it("a tool row shows the first line, fetches the body when asked, and is whole after", async () => {
    const output = "first line\nsecond line\nthird line";
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, { type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      row("s1", 2, {
        type: "tool-result",
        callId: "c1",
        output: omitted(output) as unknown as string,
        isError: false,
      }),
    ]);
    link.full.set("s1:2", row("s1", 2, { type: "tool-result", callId: "c1", output, isError: false }));
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(block.tool?.detail).toBe("first line");
    expect(block.tool?.omitted).toEqual({ sessionId: "s1", seqs: [2], bytes: output.length });

    await sessionStore.loadRowBodies(block);
    const whole = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(whole.id).toBe(block.id);
    expect(whole.tool?.detail).toBe(output);
    expect(whole.tool?.omitted).toBeUndefined();
    expect(link.count("session.rowBody")).toBe(1);
    // Asking again costs nothing: the block is whole.
    await sessionStore.loadRowBodies(whole);
    expect(link.count("session.rowBody")).toBe(1);
  });

  it("an edit whose strings left the wire keeps its counts and comes back whole", async () => {
    const oldText = "a\nb\nc";
    const newText = "x\ny\nz\nw";
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, {
        type: "tool-call",
        callId: "e1",
        name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: omitted(oldText), new_string: omitted(newText) },
        preview: { kind: "write", path: "/repo/a.ts", fileName: "a.ts", additions: 4, deletions: 3 },
      }),
      row("s1", 2, { type: "tool-result", callId: "e1", output: "ok", isError: false }),
    ]);
    link.full.set(
      "s1:1",
      row("s1", 1, {
        type: "tool-call",
        callId: "e1",
        name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: oldText, new_string: newText },
        preview: { kind: "write", path: "/repo/a.ts", fileName: "a.ts", additions: 4, deletions: 3 },
      }),
    );
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "e1")!;
    expect(block.tool?.omitted?.seqs).toEqual([1]);
    expect(block.tool?.preview?.additions).toBe(4);
    expect(block.tool?.preview?.deletions).toBe(3);
    expect(block.tool?.status).toBe("completed");

    await sessionStore.loadRowBodies(block);
    const whole = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "e1")!;
    expect((whole.tool?.input as { old_string: string }).old_string).toBe(oldText);
    expect(whole.tool?.omitted).toBeUndefined();
    expect(whole.tool?.status).toBe("completed");
  });

  it("a body the server cannot give back marks the block failed, not loading", async () => {
    link.pages = [[wireMeta({ id: "s1" })]];
    link.events.set("s1", [
      row("s1", 1, { type: "tool-call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      row("s1", 2, { type: "tool-result", callId: "c1", output: omitted("gone\nx") as unknown as string, isError: false }),
    ]);
    await boot(link);
    await sessionStore.ensureLoaded("s1");
    const block = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    await sessionStore.loadRowBodies(block);
    const after = sessionStore.get("s1")!.blocks.find((b) => b.tool?.callId === "c1")!;
    expect(after.tool?.omitted).toMatchObject({ seqs: [2], loading: false, failed: true });
  });
});

describe("remote profile: the load phase", () => {
  afterEach(() => vi.useRealTimers());

  it("a socket that is down keeps the thread loading (slow after 8 s) and the load starts when it opens", async () => {
    vi.useFakeTimers();
    link.pages = [[wireMeta()]];
    link.events.set("s1", turns("s1", 2));
    await boot(link);
    link.connected = false;
    const since = Date.now();
    await expect(sessionStore.ensureLoaded("s1", "pane")).rejects.toThrow("not connected");
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loading", since, attempt: 0 });
    expect(link.count("session.events")).toBe(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sessionStore.get("s1")?.load?.phase).toBe("slow");
    link.connected = true;
    link.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loaded", since, attempt: 0, empty: false });
    expect(sessionStore.get("s1")?.blocks.length).toBeGreaterThan(0);
  });

  it("a socket that comes back cuts a failed load's wait short without resetting its count", async () => {
    vi.useFakeTimers();
    link.pages = [[wireMeta()]];
    link.events.set("s1", turns("s1", 2));
    await boot(link);
    const request = link.request.bind(link);
    let failures = 3;
    link.request = <T,>(method: string, params?: unknown): Promise<T> =>
      method === "session.events" && failures-- > 0 ? Promise.reject(new ConnectionLostError("connection closed")) : request<T>(method, params);
    await sessionStore.ensureLoaded("s1").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 2, retryAt: Date.now() + 2_000 });
    link.connected = false;
    await vi.advanceTimersByTimeAsync(2_000);
    // The retry found the socket down: still failed, the count goes on.
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 3, error: "not connected", retryAt: Date.now() + 4_000 });
    link.connected = true;
    link.open();
    await vi.advanceTimersByTimeAsync(0);
    // The third failure is used up by the open's attempt; the fourth try loads.
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 4, retryAt: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sessionStore.get("s1")?.load?.phase).toBe("loaded");
  });
});

/** A master's log: it is woken by its batch's reports, never by the person,
 *  so the newest turns carry no user-text row. */
function masterLog(sessionId: string, turns = 3): EventRow[] {
  const out: EventRow[] = [];
  let seq = 1;
  for (let t = 1; t <= turns; t++) {
    out.push(row(sessionId, seq++, { type: "agent-report", agentId: `c${t}`, title: `child ${t}`, status: "idle" } as never));
    out.push(row(sessionId, seq++, { type: "thinking", text: `weighing ${t}`, delta: false, msgId: `m${t}`, blockIndex: 0 } as never));
    out.push(row(sessionId, seq++, { type: "assistant-text", text: `landed ${t}`, delta: false, msgId: `m${t}`, blockIndex: 1 } as never));
    out.push(row(sessionId, seq++, { type: "turn-complete" } as never));
  }
  return out;
}

describe("remote profile: a master woken only by reports", () => {
  it("its first page folds to blocks", async () => {
    link.pages = [[wireMeta({ id: "m", isMaster: true, status: "watching" })]];
    link.events.set("m", masterLog("m"));
    await boot(link);
    await sessionStore.ensureLoaded("m");
    const s = sessionStore.get("m")!;
    expect(s.blocks.length).toBeGreaterThan(0);
    expect(s.blocks.some((b) => b.text === "landed 3")).toBe(true);
    expect(s.load).toMatchObject({ phase: "loaded", empty: false });
    expect(sessionStore.hasOlderHistory("m")).toBe(true);
    await sessionStore.loadOlder("m");
    expect(sessionStore.get("m")!.blocks.some((b) => b.text === "landed 2")).toBe(true);
  });

  it("reopened while a reconnect's resume for its unloaded transcript is still out: the reopen paints its own page", async () => {
    link.pages = [[wireMeta({ id: "m", isMaster: true, status: "watching" })]];
    link.events.set("m", masterLog("m"));
    link.pageRows = 50;
    await boot(link);
    await sessionStore.ensureLoaded("m");
    expect(sessionStore.get("m")!.blocks.length).toBeGreaterThan(0);
    // The host restarts: the socket comes back and the kept transcript
    // replays its gap, which the host is slow to answer.
    link.holdEvents = [];
    link.open();
    await new Promise((r) => setTimeout(r, 0));
    const held = link.holdEvents;
    expect(held).toHaveLength(1);
    // Its tab leaves the kept set and the transcript unloads, the resume still out.
    sessionStore.setMounted([]);
    (sessionStore as unknown as { unloadOutsideMounted(): void }).unloadOutsideMounted();
    expect(sessionStore.get("m")!.blocks).toEqual([]);
    // The person opens it again.
    const opened = sessionStore.ensureLoaded("m");
    link.holdEvents = null;
    for (const release of held) release();
    await opened;
    const s = sessionStore.get("m")!;
    expect(s.blocks.some((b) => b.text === "landed 3")).toBe(true);
    expect(s.load).toMatchObject({ phase: "loaded", empty: false });
  });

  it("a load that ends with no page for it tries again instead of reading as an empty thread", async () => {
    link.pages = [[wireMeta({ id: "m", isMaster: true, status: "watching" })]];
    link.events.set("m", masterLog("m"));
    await boot(link);
    const store = sessionStore as unknown as { replayGap(): Promise<void> };
    vi.spyOn(store, "replayGap").mockResolvedValueOnce(undefined);
    await expect(sessionStore.ensureLoaded("m")).rejects.toThrow("no answer yet");
    expect(sessionStore.get("m")!.load).toMatchObject({ phase: "failed", error: "no answer yet" });
    expect(sessionStore.get("m")!.load?.retryAt).toBeGreaterThan(0);
    sessionStore.retryLoad("m");
    await sessionStore.ensureLoaded("m");
    expect(sessionStore.get("m")!.blocks.length).toBeGreaterThan(0);
  });

  it("a thread the host has no rows for reads empty", async () => {
    link.pages = [[wireMeta({ id: "new" })]];
    await boot(link);
    await sessionStore.ensureLoaded("new");
    expect(sessionStore.get("new")!.load).toMatchObject({ phase: "loaded", empty: true });
  });
});

it("resync reconciles the list cursor and replays mounted logs without reconnecting", async () => {
  link.pages = [[wireMeta({ id: "s1" })]];
  link.changes = { reset: true, seq: 1, generation: "g", sessions: [], removed: [] };
  link.events.set("s1", turns("s1", 1));
  await boot(link);
  await sessionStore.ensureLoaded("s1");
  const lists = link.count("session.list");
  link.changes = { reset: false, seq: 3, generation: "g", sessions: [wireMeta({ id: "s1", title: "changed while lagging" })], removed: [] };
  link.events.set("s1", turns("s1", 2));
  link.push({ push: "resync" });
  await vi.waitFor(() => {
    expect(sessionStore.get("s1")?.title).toBe("changed while lagging");
    expect(sessionStore.get("s1")?.blocks).toHaveLength(4);
  });
  expect(link.count("session.list")).toBe(lists);
  expect(link.calls.filter((c) => c.method === "session.changes").at(-1)?.params).toEqual({ afterSeq: 1, generation: "g" });
  expect(link.connected).toBe(true);
});
