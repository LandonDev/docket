import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./store", () => ({ closeItem: async (_env: string, _session: string, itemId: string) => void calls.push(`close ${itemId}`) }));
vi.mock("../office/live/leave", () => ({ leaveLive: async () => true }));

import { closeThroughDoor, readyToClose } from "./closeDoor";
import { CloseRefused, registerFlush } from "./flush";
import { canvasFlushPort } from "../../lib/canvasFlushPort";

describe("the one door a canvas item closes by", () => {
  it("sends what the kind holds, then lets the live guest go, then closes", async () => {
    calls.length = 0;
    const off = registerFlush("i1", async () => void calls.push("flush"));
    const leave = vi.fn(async () => (calls.push("leave"), true));
    await expect(closeThroughDoor("local", "t1", { id: "i1", title: "Budget.xlsx" }, leave)).resolves.toBe(true);
    expect(calls).toEqual(["flush", "leave", "close i1"]);
    expect(leave).toHaveBeenCalledWith("i1", "Budget.xlsx");
    off();
  });

  it("keeps the item when he keeps a live file that has not saved", async () => {
    calls.length = 0;
    await expect(closeThroughDoor("local", "t1", { id: "i2", title: "Notes.docx" }, async () => false)).resolves.toBe(false);
    expect(calls).toEqual([]);
    await expect(readyToClose("i2", "Notes.docx", async () => false)).resolves.toBe(false);
  });

  it("never closes in silence over a send that failed or ran past its limit: he is asked, and the item stays unless he says close", async () => {
    calls.length = 0;
    const off = registerFlush("i3", () => Promise.reject(new Error("offline")));
    const keep = vi.fn(async () => false);
    await expect(closeThroughDoor("local", "t1", { id: "i3", title: "notes.txt" }, undefined, keep)).resolves.toBe(false);
    expect(keep).toHaveBeenCalledWith("notes.txt", "failed", false);
    expect(calls).toEqual([]);
    const close = vi.fn(async () => true);
    await expect(closeThroughDoor("local", "t1", { id: "i3", title: "notes.txt" }, undefined, close)).resolves.toBe(true);
    expect(calls).toEqual(["close i3"]);
    off();
    vi.useFakeTimers();
    try {
      const offSlow = registerFlush("i4", () => new Promise(() => undefined));
      const ask = vi.fn(async () => false);
      const ready = readyToClose("i4", "Deck.pptx", async () => true, ask);
      await vi.advanceTimersByTimeAsync(8000);
      await expect(ready).resolves.toBe(false);
      expect(ask).toHaveBeenCalledWith("Deck.pptx", "late", false);
      offSlow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells him a kind that keeps a draft keeps it: the ask says so", async () => {
    const off = registerFlush("i6", () => Promise.reject(new Error("offline")), { keeps: true });
    const ask = vi.fn(async () => false);
    await expect(readyToClose("i6", "notes.txt", async () => true, ask)).resolves.toBe(false);
    expect(ask).toHaveBeenCalledWith("notes.txt", "failed", true);
    off();
    expect(canvasFlushPort.keeps("i6")).toBe(false);
  });

  it("asks nothing when the send landed, and lets a refusal through as it was", async () => {
    const ask = vi.fn(async () => false);
    const off = registerFlush("i5", async () => undefined);
    await expect(readyToClose("i5", "Budget.xlsx", async () => true, ask)).resolves.toBe(true);
    off();
    const offRefused = registerFlush("i5", () => Promise.reject(new CloseRefused("A cell is open")));
    await expect(readyToClose("i5", "Budget.xlsx", async () => true, ask)).rejects.toThrow("A cell is open");
    expect(ask).not.toHaveBeenCalled();
    offRefused();
  });
});
