import { describe, expect, it, vi } from "vitest";
import { CloseRefused, flushedItem, flushItem, registerFlush } from "./flush";

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

  it("never keeps the tab for a failed send, keeps it for one its kind refuses, and waits no longer than its limit", async () => {
    const off = registerFlush("item-2", () => Promise.reject(new Error("failed")));
    await expect(flushItem("item-2")).resolves.toBeUndefined();
    off();
    const offRefused = registerFlush("item-2", () => Promise.reject(new CloseRefused("refused")));
    await expect(flushItem("item-2")).rejects.toThrow("refused");
    offRefused();
    vi.useFakeTimers();
    const offSlow = registerFlush("item-3", () => new Promise(() => undefined));
    const done = flushItem("item-3", 100);
    vi.advanceTimersByTime(100);
    await expect(done).resolves.toBeUndefined();
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
