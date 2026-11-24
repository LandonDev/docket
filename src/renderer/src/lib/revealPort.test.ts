import { describe, expect, it, vi } from "vitest";
import type { RevealNavigation } from "@shared/contract-work-reveal";
import { openReveal } from "./revealPort";

function openers() {
  return {
    thread: vi.fn(), workspace: vi.fn(), view: vi.fn(), place: vi.fn(), files: vi.fn(),
    threadItem: vi.fn(), held: vi.fn(), settings: vi.fn(),
  };
}

const workspace = { id: "w1", path: "/jobs/work" };
const localFile = { ref: { at: "file" as const, host: "host", path: "/jobs/work/file" }, name: "File" };

describe("the desktop reveal router", () => {
  it.each<[RevealNavigation, Partial<Record<keyof ReturnType<typeof openers>, unknown[]>>]>([
    [{ target: { thread: "s1" } }, { thread: ["s1"] }],
    [{ target: { view: "agenda", workspaceId: "w1", at: "e1" }, workspace }, { workspace: [workspace], view: [{ workspaceId: "w1", view: "agenda", event: "e1" }] }],
    [{ target: { place: "review", at: "1795478400000" } }, { place: ["review", 1795478400000] }],
    [{ target: { place: "today" } }, { place: ["today", undefined] }],
    [{ target: { item: "i1" }, item: { tab: "t1", itemId: "i1" }, workspace }, { workspace: [workspace], files: [workspace, { tab: "t1", itemId: "i1" }] }],
    [{ target: { item: "i1" }, item: localFile, workspace }, { workspace: [workspace], files: [workspace, localFile] }],
    [{ target: { item: "i1" }, item: { owner: "s1" } }, { threadItem: ["s1", "i1"] }],
    [{ target: { held: { at: "host", id: "h1" }, thread: "s1" } }, { held: ["local:host:h1"] }],
    [{ target: { settings: "connections" } }, { settings: ["connections"] }],
  ])("calls only the openers named by %j", async (nav, expected) => {
    const open = openers();
    await expect(openReveal(nav, open)).resolves.toBe(true);
    for (const key of Object.keys(open) as (keyof typeof open)[]) {
      expect(open[key].mock.calls).toEqual(key in expected ? [expected[key]] : []);
    }
  });

  it("ignores a destination the router does not know", async () => {
    const open = openers();
    const nav = { target: { settings: "unknown" } } as unknown as RevealNavigation;
    await expect(openReveal(nav, open)).resolves.toBe(false);
    for (const fn of Object.values(open)) expect(fn).not.toHaveBeenCalled();
  });
});
