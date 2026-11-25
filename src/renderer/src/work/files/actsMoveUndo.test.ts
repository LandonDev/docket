/**
 * Undo of a move from his window (acts.ts `carryTo`): the way back names each thing as the move left it, its key and
 * its version, so the host that moves it back finds each the same or leaves it (files/verbs.ts `boundThing`). A file
 * put at the new name since is never taken back to the old folder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@shared/work/files";

const world = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  answers: [] as unknown[],
  toasts: [] as { title: string; undo?: () => void }[],
}));

vi.mock("../../lib/connection", () => ({
  registry: {
    has: () => true,
    linkOf: () => ({ request: async (method: string, params: Record<string, unknown>) => (world.calls.push({ method, params }), world.answers.shift() ?? { entries: [], refused: [], op: "o" }) }),
  },
}));
vi.mock("./farLink", async () => ({ filesLink: (await import("../../lib/connection")).registry.linkOf }));
vi.mock("./store", () => ({ tabsNow: () => [], closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => ({ message: (title: string, o: { action?: { onClick(): void } } = {}) => void world.toasts.push({ title, undo: o.action?.onClick }), error: (title: string) => void world.toasts.push({ title }) }),
}));

const { carryTo } = await import("./acts");

const entry = (path: string, o: Partial<FileEntry> = {}): FileEntry => ({ key: `file:box:${path}`, ref: { at: "file", host: "box", path }, folder: null, name: path.slice(path.lastIndexOf("/") + 1), kind: "text", size: 5, changed: 1700, ...o }) as FileEntry;
const of = { workspaceId: "w1", home: "box" };
const folder = { link: "box", place: { id: "folder", kind: "folder", name: "Events", host: "box", env: "box", shared: false, can: ["move"], state: { state: "ok" }, root: { at: "file", host: "box", path: "/w" } } } as never;
const back = { at: { at: "file", host: "box", path: "/w" } as never, name: "Events" };
const to = { copy: folder, at: { at: "file", host: "box", path: "/w/Archive" } as never, name: "Archive" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  world.calls = [];
  world.answers = [];
  world.toasts = [];
});

describe("Undo of a move", () => {
  it("binds the way back to each thing as the move left it: its key and its version", async () => {
    world.answers.push({ entries: [entry("/w/Archive/A.txt", { size: 7, changed: 2000 }), entry("/w/Archive/Old", { kind: "folder", size: undefined, changed: 3000 })], refused: [], op: "o" });
    expect(await carryTo(of, "move", folder, [entry("/w/A.txt"), entry("/w/Old", { kind: "folder" })], to, back)).toBe(true);
    world.toasts.find((t) => t.undo)!.undo!();
    await flush();
    const undo = world.calls[1]!;
    expect(undo.method).toBe("work.files.move");
    expect(undo.params.origin).toEqual({
      from: "window",
      things: [
        { key: "file:box:/w/Archive/A.txt", version: "7:2000:" },
        { key: "file:box:/w/Archive/Old", version: "0:3000:" },
      ],
    });
  });

  it("offers no Undo when what the move left names no change time: it could not be bound", async () => {
    world.answers.push({ entries: [entry("/w/Archive/A.txt", { changed: undefined })], refused: [], op: "o" });
    await carryTo(of, "move", folder, [entry("/w/A.txt")], to, back);
    expect(world.toasts.some((t) => t.undo)).toBe(false);
  });
});
