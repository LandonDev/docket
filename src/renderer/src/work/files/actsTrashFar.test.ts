/**
 * Delete on a file another host holds, from his window: a desktop the window cannot reach (his PC, which links only to
 * the box) is asked through the workspace's host (`work.files.across`), never refused with "ask that host"; its Undo
 * goes the same way; a drive with no bin says so before the press, and only his yes deletes for good.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, FilePlace } from "@shared/work/files";

const world = vi.hoisted(() => ({
  calls: [] as { link: string; method: string; params: Record<string, unknown> }[],
  asked: [] as { title: string; body?: string; action: string }[],
  yes: true,
  toasts: [] as { title: string; undo?: () => void }[],
}));

vi.mock("../../lib/connection", () => ({
  registry: {
    has: (link: string) => link !== "pc",
    linkOf: (link: string) => ({
      request: async (method: string, params: Record<string, unknown>) => {
        world.calls.push({ link, method, params });
        return method === "work.files.across" && (params.method === "work.files.trash") ? { entries: [], refused: [], trashed: ["row-1"], op: "o" } : { entries: [], refused: [], trashed: ["row-2"], op: "o" };
      },
      onOpen: () => () => undefined,
    }),
  },
}));
vi.mock("./store", () => ({ tabsNow: () => [], closeTab: vi.fn(async () => undefined) }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async (r: { title: string; body?: string; action: string }) => (world.asked.push(r), world.yes) }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: (title: string, o: { action?: { onClick(): void } } = {}) => void world.toasts.push({ title, undo: o.action?.onClick }), error: (title: string) => void world.toasts.push({ title }) }) }));

const { trash } = await import("./acts");
const { reachThrough } = await import("./farLink");

const PC = "env_pc";
const place = (o: Partial<FilePlace> = {}): FilePlace => ({ id: "lib:1", kind: "teams", name: "Shared", host: "", env: PC, shared: true, can: ["trash"], state: { state: "ok" }, root: { at: "file", host: PC, path: "R:\\Shared" }, ...o }) as FilePlace;
const file = (path: string): FileEntry => ({ key: `file:${PC}:${path}`, ref: { at: "file", host: PC, path }, folder: null, name: path.slice(path.lastIndexOf("\\") + 1), kind: "doc" }) as FileEntry;
const of = { workspaceId: "w1", home: "box" };

beforeEach(() => {
  world.calls = [];
  world.asked = [];
  world.yes = true;
  world.toasts = [];
  reachThrough("pc", "box", "w1");
});

describe("Delete on a desktop the window reaches through the box", () => {
  it("goes through the box to that desktop, and its Undo goes the same way", async () => {
    expect(await trash(of, { link: "pc", place: place({ root: { at: "file", host: PC, path: "C:\\Users\\l\\OneDrive" } }) } as never, [file("C:\\Users\\l\\OneDrive\\Plan.docx")])).toBe(true);
    expect(world.calls[0]).toMatchObject({ link: "box", method: "work.files.across", params: { host: "pc", method: "work.files.trash", params: { asked: true } } });
    world.toasts.find((t) => t.undo)!.undo!();
    await new Promise((r) => setTimeout(r, 0));
    expect(world.calls[1]).toMatchObject({ link: "box", method: "work.files.across", params: { host: "pc", method: "work.files.restore", params: { ids: ["row-1"] } } });
  });

  it("on a drive with no bin, says before the press that it cannot be put back, and only his yes deletes for good", async () => {
    const r = place({ bin: false });
    expect(await trash(of, { link: "pc", place: r } as never, [file("R:\\Shared\\Roster.xlsx")])).toBe(true);
    expect(world.asked[0]).toMatchObject({ title: "Delete Roster.xlsx for good?", body: "Deleted from R: at once; it cannot be put back.", action: "Delete" });
    expect(world.calls[0]!.params).toMatchObject({ method: "work.files.trash", params: { forGood: true } });
    world.yes = false;
    expect(await trash(of, { link: "pc", place: r } as never, [file("R:\\Shared\\Roster.xlsx")])).toBe(false);
    expect(world.calls).toHaveLength(1);
  });
});
