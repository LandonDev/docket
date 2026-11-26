import { describe, expect, it } from "vitest";
import type { ServerPush } from "@server/shared/contract";
import type { Link } from "./link";
import { COLD_OPEN_DEADLINE_MS, Subscriptions, asPage, firstOfTwo, type SubscriptionHandlers } from "./subscriptions";
import { flush } from "./testing";

class FakeLink implements Link {
  environmentId = "env_a";
  connected = true;
  calls: { method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  /** A local socket keeps subscribe and fetch apart; a remote one asks for both at once. */
  constructor(readonly profile: "local" | "remote" = "local") {}
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.calls.push({ method, params, resolve: resolve as (v: unknown) => void, reject }),
    );
  }
  onPush(_l: (push: ServerPush) => void): () => void {
    return () => undefined;
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  onClose(l: () => void): () => void {
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }
  /** A replacement session came up. */
  reopen(): void {
    this.connected = true;
    for (const l of this.openListeners) l();
  }
  drop(): void {
    this.connected = false;
    for (const l of this.closeListeners) l();
  }
  /** Answer the oldest unanswered call of `method`. */
  answer(method: string, value: unknown): void {
    const i = this.calls.findIndex((c) => c.method === method && !("done" in c));
    if (i < 0) throw new Error(`no pending ${method}`);
    const call = this.calls[i];
    Object.assign(call, { done: true });
    call.resolve(value);
  }
  /** Answer the newest unanswered call of `method`. */
  answerLast(method: string, value: unknown): void {
    const call = this.calls.filter((c) => c.method === method && !("done" in c)).at(-1);
    if (!call) throw new Error(`no pending ${method}`);
    Object.assign(call, { done: true });
    call.resolve(value);
  }
  refuse(method: string, message: string): void {
    const call = this.calls.find((c) => c.method === method && !("done" in c))!;
    Object.assign(call, { done: true });
    call.reject(new Error(message));
  }
  pendingOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method && !("done" in c)).map((c) => c.params);
  }
}

function owner(cursor = 0) {
  const log: string[] = [];
  const handlers: SubscriptionHandlers & { cursorValue: number } = {
    cursorValue: cursor,
    cursor: () => handlers.cursorValue,
    begin: () => log.push("begin"),
    page: (page) => {
      log.push(`page reset=${page.reset} rows=${page.rows.map((r) => r.seq).join(",")}`);
      const last = page.rows.at(-1);
      if (last) handlers.cursorValue = last.seq;
    },
    end: () => log.push("end"),
    gone: (reason) => log.push(`gone ${reason}`),
  };
  return { handlers, log };
}

const row = (seq: number) => ({ sessionId: "s1", seq, ts: seq, event: { kind: "status", status: "idle" } }) as never;

describe("asPage", () => {
  it("wraps a bare row array and reads the head off the first seq on a cold open", () => {
    expect(asPage([row(1)], true)).toEqual({ rows: [row(1)], moreBefore: false, moreAfter: false, reset: false });
    expect(asPage([row(5), row(6)], true)).toMatchObject({ moreBefore: true, reset: false });
    expect(asPage([row(5)], false)).toMatchObject({ moreBefore: false, reset: false });
    const page = { rows: [], moreBefore: true, moreAfter: false, reset: true };
    expect(asPage(page, false)).toBe(page);
  });
});

describe("Subscriptions", () => {
  it("subscribes once on a socket, then fetches what follows the owner's cursor", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(10);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }]);
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 10 }]);
    link.answer("session.events", { rows: [row(11), row(12)], moreBefore: false, moreAfter: false, reset: false });
    const page = await p;
    expect(page.rows.map((r) => r.seq)).toEqual([11, 12]);
    expect(a.log).toEqual(["begin", "page reset=false rows=11,12", "end"]);
    expect(subs.isLive("s1")).toBe(true);
    // Already subscribed on this socket: the next resume only fetches.
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 12 }]);
  });

  it("a cold open asks for the tail; a bare array answer is history behind the tail, not a reset", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 3 });
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 3 }]);
    link.answer("session.events", [row(5), row(6)]);
    const page = await p;
    expect(page.moreBefore).toBe(true);
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "end"]);
  });

  it("passes a reset page through: the owner throws its fold away before folding", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(40);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", { rows: [row(900), row(901)], moreBefore: true, moreAfter: false, reset: true });
    await p;
    expect(a.log).toEqual(["begin", "page reset=true rows=900,901", "end"]);
    expect(a.handlers.cursorValue).toBe(901);
  });

  it("a replacement session forgets what was subscribed; resumeAll subscribes everyone again, four at a time", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const owners = ["s1", "s2", "s3", "s4", "s5", "s6"].map((id, i) => {
      const o = owner(i + 1);
      subs.add(id, o.handlers);
      return { id, ...o };
    });
    for (const o of owners) {
      void subs.resume(o.id);
      await flush();
      link.answer("session.subscribe", {});
      await flush();
      link.answer("session.events", []);
    }
    await flush();
    expect(owners.every((o) => subs.isLive(o.id))).toBe(true);
    link.drop();
    expect(subs.isLive("s1")).toBe(false);
    link.reopen();
    const all = subs.resumeAll();
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }, { sessionId: "s4" }]);
    for (let i = 0; i < 4; i++) link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events").map((p) => (p as { afterSeq: number }).afterSeq)).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < 4; i++) link.answer("session.events", []);
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s5" }, { sessionId: "s6" }]);
    link.answer("session.subscribe", {});
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", []);
    link.answer("session.events", []);
    await all;
    expect(subs.ids()).toHaveLength(6);
    expect(owners.every((o) => subs.isLive(o.id))).toBe(true);
  });

  it("remove tells a live socket, and nothing when there is none", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    subs.add("s2", a.handlers);
    void subs.resume("s1");
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    link.answer("session.events", []);
    await flush();
    subs.remove("s1");
    expect(link.pendingOf("session.unsubscribe")).toEqual([{ sessionId: "s1" }]);
    subs.remove("s2");
    expect(link.pendingOf("session.unsubscribe")).toHaveLength(1);
    expect(subs.ids()).toEqual([]);
  });

  it("a refused subscribe reports the session gone and rejects the resume", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1");
    await flush();
    link.refuse("session.subscribe", "no such session");
    await expect(p).rejects.toThrow("no such session");
    expect(a.log).toEqual(["begin", "gone no such session", "end"]);
    expect(subs.isLive("s1")).toBe(false);
  });

  it("tells its owner the moment the history request leaves, after the subscribe it waited on", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    const a = owner(0);
    a.handlers.asked = () => a.log.push(`asked out=${link.pendingOf("session.events").length}`);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    expect(a.log).toEqual(["begin"]);
    link.answer("session.subscribe", {});
    await flush();
    expect(a.log).toEqual(["begin", "asked out=0"]);
    expect(link.pendingOf("session.events")).toHaveLength(1);
    link.answer("session.events", [row(1)]);
    await p;
    expect(a.log).toEqual(["begin", "asked out=0", "page reset=false rows=1", "end"]);
  });

  it("over a remote link a cold open subscribes inside the history request: one round trip", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    expect(link.pendingOf("session.subscribe")).toEqual([]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 300, subscribe: true }]);
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false, subscribed: true });
    await p;
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "end"]);
    expect(subs.isLive("s1")).toBe(true);
    // Live now: a resume only fetches, without the flag.
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 6 }]);
  });

  it("a remote host that predates the flag: subscribe after the page, then fold the gap, pushes held throughout", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false });
    await flush();
    expect(subs.isLive("s1")).toBe(false);
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }]);
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 6 }]);
    link.answer("session.events", { rows: [row(7)], moreBefore: false, moreAfter: false, reset: false });
    const page = await p;
    expect(page.rows.map((r) => r.seq)).toEqual([5, 6]);
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "page reset=false rows=7", "end"]);
    expect(subs.isLive("s1")).toBe(true);
  });

  it("a remote cold open that fails tells the host to drop the subscription it may have made", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    subs.add("s1", owner(0).handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    link.refuse("session.events", "timed out");
    await expect(p).rejects.toThrow("timed out");
    expect(link.pendingOf("session.unsubscribe")).toEqual([{ sessionId: "s1" }]);
    expect(subs.isLive("s1")).toBe(false);
  });

  /** A deadline the test passes by hand; it records what it was asked to wait. */
  function handTimer() {
    const asked: number[] = [];
    let pass = (): void => undefined;
    const timer = (ms: number): Promise<void> => {
      asked.push(ms);
      return new Promise<void>((resolve) => (pass = resolve));
    };
    return { timer, asked, pass: () => pass() };
  }

  it("a cold open whose answer never comes asks again at its deadline, without subscribe; rows fold once and the gap after", async () => {
    const link = new FakeLink("remote");
    const clock = handTimer();
    const subs = new Subscriptions(link, undefined, clock.timer);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    expect(clock.asked).toEqual([COLD_OPEN_DEADLINE_MS]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 300, subscribe: true }]);
    clock.pass();
    await flush();
    expect(link.pendingOf("session.events")).toEqual([
      { sessionId: "s1", afterSeq: 0, tail: 300, subscribe: true },
      { sessionId: "s1", afterSeq: 0, tail: 300 },
    ]);
    link.answerLast("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false });
    await flush();
    // The second page does not say it subscribed: one `session.subscribe` (the host keeps one a socket and thread), then the gap.
    expect(link.pendingOf("session.subscribe")).toEqual([{ sessionId: "s1" }]);
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events").at(-1)).toEqual({ sessionId: "s1", afterSeq: 6 });
    link.answerLast("session.events", { rows: [row(7)], moreBefore: false, moreAfter: false, reset: false });
    const page = await p;
    expect(page.rows.map((r) => r.seq)).toEqual([5, 6]);
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "page reset=false rows=7", "end"]);
    expect(subs.isLive("s1")).toBe(true);
    // The first answer, landing at last, folds nothing and drops no subscription.
    link.answer("session.events", { rows: [row(5), row(6), row(7)], moreBefore: true, moreAfter: false, reset: false, subscribed: true });
    await flush();
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "page reset=false rows=7", "end"]);
    expect(link.pendingOf("session.unsubscribe")).toEqual([]);
    expect(link.calls.filter((c) => c.method === "session.events")).toHaveLength(3);
  });

  it("a cold open's first answer past the deadline but before the second wins, and the second's is dropped", async () => {
    const link = new FakeLink("remote");
    const clock = handTimer();
    const subs = new Subscriptions(link, undefined, clock.timer);
    const a = owner(0);
    subs.add("s1", a.handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    clock.pass();
    await flush();
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false, subscribed: true });
    await p;
    link.answer("session.events", { rows: [row(5), row(6)], moreBefore: true, moreAfter: false, reset: false });
    await flush();
    expect(a.log).toEqual(["begin", "page reset=false rows=5,6", "end"]);
    expect(link.calls.map((c) => c.method)).toEqual(["session.events", "session.events"]);
    expect(subs.isLive("s1")).toBe(true);
  });

  it("an answer inside the deadline asks once; a resume from a cursor has no deadline of its own", async () => {
    const link = new FakeLink("remote");
    const clock = handTimer();
    const subs = new Subscriptions(link, undefined, clock.timer);
    subs.add("s1", owner(0).handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    link.answer("session.events", { rows: [row(5)], moreBefore: true, moreAfter: false, reset: false, subscribed: true });
    await p;
    clock.pass();
    await flush();
    void subs.resume("s1");
    await flush();
    expect(clock.asked).toEqual([COLD_OPEN_DEADLINE_MS]);
    expect(link.calls.filter((c) => c.method === "session.events")).toHaveLength(2);
  });

  it("firstOfTwo: a failure before the deadline is the open's; after it, the other ask may still win; both failing fails", async () => {
    let pass = (): void => undefined;
    const deadline = (): Promise<void> => new Promise<void>((r) => (pass = r));
    await expect(firstOfTwo(Promise.reject(new Error("gone")), () => Promise.resolve(1), deadline())).rejects.toThrow("gone");
    let failFirst = (_e: Error): void => undefined;
    const late = firstOfTwo(new Promise<number>((_r, j) => (failFirst = j)), () => Promise.resolve(2), deadline());
    pass();
    await flush();
    failFirst(new Error("timed out"));
    await expect(late).resolves.toEqual({ answer: 2, second: true });
    const both = firstOfTwo(new Promise<number>((_r, j) => (failFirst = j)), () => Promise.reject(new Error("second")), deadline());
    pass();
    await flush();
    failFirst(new Error("first"));
    await expect(both).rejects.toThrow("first");
  });

  it("a resume from a cursor names the time of the row it holds there; a cold open and an unknown time do not", async () => {
    const link = new FakeLink("local");
    const subs = new Subscriptions(link);
    const a = owner(0);
    let ts: number | undefined;
    a.handlers.cursorTs = () => ts;
    subs.add("s1", a.handlers);
    void subs.resume("s1", { tail: 300 });
    await flush();
    link.answer("session.subscribe", {});
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 300 }]);
    link.answer("session.events", [row(4), row(5)]);
    await flush();
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 5 }]);
    link.answer("session.events", []);
    await flush();
    ts = 5_005;
    void subs.resume("s1");
    await flush();
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 5, afterTs: 5_005 }]);
  });

  it("two resumes in flight for one session share the fetch", async () => {
    const link = new FakeLink();
    const subs = new Subscriptions(link);
    subs.add("s1", owner(0).handlers);
    const a = subs.resume("s1");
    const b = subs.resume("s1");
    expect(a).toBe(b);
    await expect(subs.resume("nope")).rejects.toThrow("not subscribed");
  });

  it("a fetch made for an owner that left is waited out, not joined: the new owner gets a page of its own", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    const old = owner(40);
    subs.add("s1", old.handlers);
    const stale = subs.resume("s1");
    await flush();
    // The transcript unloads and opens again while the gap fetch is out.
    subs.remove("s1");
    const fresh = owner(0);
    subs.add("s1", fresh.handlers);
    const opened = subs.resume("s1", { tail: 300 });
    expect(opened).not.toBe(stale);
    link.answer("session.events", { rows: [row(41)], moreBefore: false, moreAfter: false, reset: false, subscribed: true });
    await stale;
    await flush();
    expect(old.log).toEqual(["begin", "end"]);
    expect(link.pendingOf("session.events")).toEqual([{ sessionId: "s1", afterSeq: 0, tail: 300 }]);
    link.answer("session.events", { rows: [row(40), row(41)], moreBefore: true, moreAfter: false, reset: false });
    await opened;
    expect(fresh.log).toEqual(["begin", "page reset=false rows=40,41", "end"]);
    expect(subs.isLive("s1")).toBe(true);
  });

  it("an answer that subscribed an owner who left tells the host to drop it", async () => {
    const link = new FakeLink("remote");
    const subs = new Subscriptions(link);
    subs.add("s1", owner(0).handlers);
    const p = subs.resume("s1", { tail: 300 });
    await flush();
    subs.remove("s1");
    link.answer("session.events", { rows: [row(1)], moreBefore: false, moreAfter: false, reset: false, subscribed: true });
    await p;
    expect(subs.isLive("s1")).toBe(false);
    expect(link.pendingOf("session.unsubscribe")).toEqual([{ sessionId: "s1" }]);
  });
});
