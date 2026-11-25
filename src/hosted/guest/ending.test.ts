import { describe, expect, it } from "vitest";
import { afterRevoked, CLOSE_FULL, CLOSE_REVOKED, CLOSE_TOO_BIG, CLOSE_TOO_MUCH, endingSocket, QUIET_MS, watchedSocket } from "./ending";

/** A socket that opens nothing: the browser's events, dispatched by the test as the host's close would be. */
class Quiet extends EventTarget {
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
}
const closeOf = (code: number, reason = ""): Event => Object.assign(new Event("close"), { code, reason });
/** A frame of the collaboration wire: the document's name, then its kind (0: a change or a sync step; 1: presence). */
const frame = (kind: number, name = "kdocrun"): Uint8Array => new Uint8Array([name.length, ...new TextEncoder().encode(name), kind, 2, 1, 0]);
/** Timers the test fires by hand. */
const clock = () => {
  const waiting = new Map<number, { fn(): void; ms: number }>();
  let n = 0;
  return { set: (fn: () => void, ms: number) => (waiting.set(++n, { fn, ms }), n), clear: (t: unknown) => void waiting.delete(t as number), waiting, fire: () => [...waiting.entries()].forEach(([id, w]) => (waiting.delete(id), w.fn())) };
};

describe("the guest document's socket", () => {
  it("tells the page when the host closes it as revoked, and of no other close", () => {
    let told = 0;
    const Socket = endingSocket(() => void told++, Quiet as unknown as typeof WebSocket);
    const ws = new Socket("ws://h/g/ws/L1") as unknown as Quiet;
    expect(ws.url).toBe("ws://h/g/ws/L1");
    for (const code of [1000, 1006, 4401, 4503]) ws.dispatchEvent(closeOf(code));
    expect(told).toBe(0);
    ws.dispatchEvent(closeOf(CLOSE_REVOKED));
    expect(told).toBe(1);
    expect(CLOSE_REVOKED).toBe(4403);
  });
});

describe("after the host closed a page's socket as revoked", () => {
  const run = async (refresh: () => Promise<{ role: string }>): Promise<string> => {
    let said = "";
    await afterRevoked(refresh, "edit", { gone: () => (said = "gone"), reopen: () => (said = "reopen"), again: () => (said = "again") });
    return said;
  };
  it("ends the page when the link is gone, opens it again as a changed role, else reconnects", async () => {
    expect(await run(() => Promise.reject(Object.assign(new Error("gone"), { why: "gone" })))).toBe("gone");
    expect(await run(() => Promise.resolve({ role: "view" }))).toBe("reopen");
    expect(await run(() => Promise.resolve({ role: "edit" }))).toBe("again");
    // A failure in passing (the network) is not an end.
    expect(await run(() => Promise.reject(Object.assign(new Error("down"), { why: "down" })))).toBe("again");
  });
});

describe("what the page learns from its document's socket", () => {
  const make = () => {
    const said: string[] = [];
    const timers = clock();
    const Socket = watchedSocket(
      { revoked: () => void said.push("revoked"), quiet: (q) => void said.push(q ? "quiet" : "heard"), tooBig: () => void said.push("too big"), refusedCopy: () => void said.push("refused copy"), tooMuch: () => void said.push("too much"), full: () => void said.push("full") },
      Quiet as unknown as typeof WebSocket,
      timers,
    );
    return { said, timers, open: () => new Socket("ws://h/g/ws/L1") as unknown as Quiet & { send(data: unknown): void } };
  };

  it("a change the host has not answered in two seconds is not saved yet, and the page is told; the host's next word says it is", () => {
    const { said, timers, open } = make();
    const ws = open();
    ws.send(frame(0));
    expect([...timers.waiting.values()].map((w) => w.ms)).toEqual([QUIET_MS]);
    expect(said).toEqual([]);
    timers.fire();
    expect(said).toEqual(["quiet"]);
    // More typed while quiet starts no second count, and is still sent on.
    ws.send(frame(0));
    expect(ws.sent).toHaveLength(2);
    ws.dispatchEvent(new Event("message"));
    expect(said).toEqual(["quiet", "heard"]);
  });

  it("an answer in time says nothing, and presence alone never starts the count: the host does not answer it", () => {
    const { said, timers, open } = make();
    const ws = open();
    ws.send(frame(1));
    ws.send("text");
    expect(timers.waiting.size).toBe(0);
    ws.send(frame(0));
    ws.dispatchEvent(new Event("message"));
    expect(timers.waiting.size).toBe(0);
    timers.fire();
    expect(said).toEqual([]);
  });

  it("a line that went quiet stays so across a new socket, until the host is heard on it", () => {
    const { said, timers, open } = make();
    const first = open();
    first.send(frame(0));
    timers.fire();
    first.dispatchEvent(closeOf(1006));
    const second = open();
    expect(said).toEqual(["quiet"]);
    second.dispatchEvent(new Event("message"));
    expect(said).toEqual(["quiet", "heard"]);
  });

  it("tells a message cut as too large from a revoked link, and a copy the host refused from both", () => {
    const { said, open } = make();
    open().dispatchEvent(closeOf(CLOSE_TOO_BIG));
    open().dispatchEvent(closeOf(CLOSE_REVOKED, "that client id is another writer's"));
    open().dispatchEvent(closeOf(CLOSE_REVOKED, "the link was revoked"));
    open().dispatchEvent(closeOf(1012, "the service is restarting"));
    open().dispatchEvent(closeOf(CLOSE_TOO_MUCH, "too much at once: wait 42 s"));
    open().dispatchEvent(closeOf(CLOSE_FULL, "the document is as large as a guest can make it"));
    expect(said).toEqual(["too big", "refused copy", "revoked", "too much", "full"]);
    expect([CLOSE_TOO_MUCH, CLOSE_FULL]).toEqual([4429, 4413]);
    expect(CLOSE_TOO_BIG).toBe(1009);
    // A page that keeps no copy has none to refuse: that close is a revoked one to it.
    let revoked = 0;
    const Plain = watchedSocket({ revoked: () => void revoked++ }, Quiet as unknown as typeof WebSocket);
    (new Plain("ws://h") as unknown as Quiet).dispatchEvent(closeOf(CLOSE_REVOKED, "that client id is another writer's"));
    expect(revoked).toBe(1);
  });
});
