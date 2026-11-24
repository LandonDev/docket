import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./store", () => ({ closeItem: async (_env: string, _session: string, itemId: string) => void calls.push(`close ${itemId}`) }));
vi.mock("../office/live/leave", () => ({ leaveLive: async () => true }));

import { closeThroughDoor, readyToClose } from "./closeDoor";
import { registerFlush } from "./flush";

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
});
