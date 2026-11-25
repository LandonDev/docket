/**
 * A delete or a rename from his window while a tab on the file still holds words (acts.ts `trash`, `renameTo`): what
 * the tab holds goes to the file first, so Trash and Put Back keep his last words and a rename carries them; words
 * that did not go in are asked about before a delete.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { FileEntry } from "@shared/work/files";

const world = vi.hoisted(() => ({ calls: [] as string[], tabs: [] as FileTab[], asked: [] as { title: string; body?: string }[], answer: true }));

vi.mock("../../lib/connection", () => ({
  registry: {
    has: () => true,
    linkOf: () => ({
      request: async (method: string) => (world.calls.push(method), method === "work.files.trash" ? { entries: [], refused: [], trashed: ["t"], op: "o" } : { entries: [], refused: [], op: "o" }),
    }),
  },
}));
vi.mock("./store", () => ({ tabsNow: () => world.tabs, closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async (ask: { title: string; body?: string }) => (world.asked.push(ask), world.answer) }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn(), error: vi.fn() }) }));

const { carryTo, renameTo, trash } = await import("./acts");
const { registerFlush } = await import("../canvas/flush");

const W = "/w/Events/Notes.txt";
const entry = { key: `file:box:${W}`, ref: { at: "file", host: "box", path: W }, folder: null, name: "Notes.txt", kind: "text" } as FileEntry;
const of = { workspaceId: "w1", home: "box" };
const folder = { link: "box", place: { id: "folder", kind: "folder", name: "Events", host: "box", env: "box", shared: false, can: ["trash", "rename", "move"], state: { state: "ok" }, root: { at: "file", host: "box", path: "/w" } } } as never;
const tab: FileTab = { id: "t1", kind: "file", name: "Notes.txt", key: entry.key, itemId: "i1" };

beforeEach(() => {
  world.calls = [];
  world.tabs = [tab];
  world.asked = [];
  world.answer = true;
});

describe("a delete of a file whose tab still holds words", () => {
  it("sends what the tab holds before the file goes to Trash", async () => {
    const off = registerFlush("i1", async () => void world.calls.push("flush"));
    expect(await trash(of, folder, [entry])).toBe(true);
    off();
    expect(world.calls).toEqual(["flush", "work.files.trash"]);
    expect(world.asked).toEqual([]);
  });

  it("asks before it deletes a file whose words did not go in, and deletes nothing on Cancel", async () => {
    const off = registerFlush("i1", async () => {
      throw new Error("Your words are not in the file yet");
    });
    world.answer = false;
    expect(await trash(of, folder, [entry])).toBe(false);
    expect(world.asked).toEqual([{ title: "Changes to Notes.txt are not saved.", body: "Delete it anyway? They will be lost.", action: "Delete Anyway", danger: true }]);
    expect(world.calls).not.toContain("work.files.trash");
    world.answer = true;
    expect(await trash(of, folder, [entry])).toBe(true);
    off();
    expect(world.calls).toEqual(["work.files.trash"]);
  });

  it("sends what the tab holds before a rename, so nothing typed just before it is lost", async () => {
    const off = registerFlush("i1", async () => void world.calls.push("flush"));
    await renameTo(of, folder, entry, "Practice.txt");
    off();
    expect(world.calls).toEqual(["flush", "work.files.rename"]);
  });

  it("keeps the file where it is when the tab's words did not go in: a rename or move would leave them at the old name", async () => {
    const off = registerFlush("i1", async () => {
      throw new Error("Your words are not in the file yet");
    });
    expect(await renameTo(of, folder, entry, "Practice.txt")).toBeNull();
    const why: string[] = [];
    expect(await carryTo(of, "move", folder, [entry], { copy: folder, at: { at: "file", host: "box", path: "/w/Archive" } as never, name: "Archive" }, undefined, (w) => void why.push(w))).toBe(false);
    off();
    expect(world.calls).toEqual([]);
    expect(why[0]).toContain("Notes.txt");
  });
});
