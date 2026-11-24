import { describe, expect, it, vi } from "vitest";
import { CloseRefused, flushAll, flushedItem, flushItem, registerFlush } from "./flush";

describe("what an item holds is sent before its tab closes", () => {
  it("awaits the kind's own send, once registered, and nothing after it is let go", async () => {
    let sent = false;
    const off = registerFlush("item-1", async () => {
      await new Promise((r) => setTimeout(r, 5));
      sent = true;
    });
    await flushItem("item-1");
    expect(sent).toBe(true);
    off();
    sent = false;
    await flushItem("item-1");
    expect(sent).toBe(false);
  });

  it("answers a failed send and one past its limit, throws one its kind refuses, and waits no longer than its limit", async () => {
    await expect(flushItem("nothing-held")).resolves.toBe("sent");
    const off = registerFlush("item-2", () => Promise.reject(new Error("failed")));
    await expect(flushItem("item-2")).resolves.toBe("failed");
    off();
    const offRefused = registerFlush("item-2", () => Promise.reject(new CloseRefused("refused")));
    await expect(flushItem("item-2")).rejects.toThrow("refused");
    offRefused();
    vi.useFakeTimers();
    const offSlow = registerFlush("item-3", () => new Promise(() => undefined));
    const done = flushItem("item-3", 100);
    vi.advanceTimersByTime(100);
    await expect(done).resolves.toBe("late");
    offSlow();
    vi.useRealTimers();
  });

  it("an off of an older body leaves a newer body's send in place", async () => {
    const calls: string[] = [];
    const offOld = registerFlush("item-4", async () => void calls.push("old"));
    registerFlush("item-4", async () => void calls.push("new"));
    offOld();
    await flushItem("item-4");
    expect(calls).toEqual(["new"]);
  });
});

describe("flushedItem", () => {
  it("answers whether the kind's send landed", async () => {
    expect(await flushedItem("none")).toBe(true);
    const off = registerFlush("ok", async () => undefined);
    expect(await flushedItem("ok")).toBe(true);
    off();
    const offBad = registerFlush("bad", async () => Promise.reject(new Error("no")));
    expect(await flushedItem("bad")).toBe(false);
    offBad();
    const offSlow = registerFlush("slow", () => new Promise(() => undefined));
    expect(await flushedItem("slow", 5)).toBe(false);
    offSlow();
  });
});

describe("flushAll: what every item holds, sent as the window closes or the app quits", () => {
  it("sends every item's at once, within one limit, and names the items whose send failed or ran past it", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const offs = [
        registerFlush("deck", async () => void sent.push("deck")),
        registerFlush("text", () => Promise.reject(new Error("offline"))),
        registerFlush("sheet", () => Promise.reject(new CloseRefused("a cell is open"))),
        registerFlush("doc", () => new Promise(() => undefined)),
        registerFlush("thrown", () => {
          throw new Error("at once");
        }),
      ];
      const all = flushAll(1500);
      await vi.advanceTimersByTimeAsync(1500);
      const got = await all;
      expect(sent).toEqual(["deck"]);
      expect([...got.failed].sort()).toEqual(["sheet", "text", "thrown"]);
      expect(got.late).toEqual(["doc"]);
      offs.forEach((off) => off());
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers at once when nothing is held, and once every send landed, before its limit", async () => {
    await expect(flushAll(10_000)).resolves.toEqual({ failed: [], late: [] });
    const off = registerFlush("quick", async () => undefined);
    const started = Date.now();
    await expect(flushAll(10_000)).resolves.toEqual({ failed: [], late: [] });
    expect(Date.now() - started).toBeLessThan(1000);
    off();
  });
});
