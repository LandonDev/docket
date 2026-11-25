/**
 * A delete in a place others can open, with a copy of the file open (acts.ts `trash`): the copy's writes his question
 * showed go with the delete, so the host lets go of none written after his press; a drive that stopped answering
 * mid-delete is never said as "Nothing was deleted".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDone, FileTab } from "@shared/contract-work-files";
import type { FileEntry } from "@shared/work/files";

const world = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  tabs: [] as FileTab[],
  answer: null as FileDone | null,
  errors: [] as string[],
}));

vi.mock("../../lib/connection", () => ({
  registry: {
    has: () => true,
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown>) => (world.calls.push({ method, params }), world.answer ?? { entries: [], refused: [], trashed: ["t"], op: "o" }),
      onOpen: () => () => undefined,
    }),
  },
}));
vi.mock("./store", () => ({ tabsNow: () => world.tabs, closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn(), error: (title: string) => void world.errors.push(title) }) }));

const { trash } = await import("./acts");

const P = "/Users/l/Team/General/Plan.docx";
const entry = { key: `lib:1:${P}`, ref: { at: "file", host: "mac", path: P }, folder: null, name: "Plan.docx", kind: "doc" } as FileEntry;
const of = { workspaceId: "w1", home: "mac" };
const team = { link: "mac", place: { id: "lib:1", kind: "teams", name: "General", host: "", env: "mac", shared: true, can: ["trash"], state: { state: "ok" }, root: { at: "file", host: "mac", path: "/Users/l/Team/General" } } } as never;
const copyTab: FileTab = { id: "t1", kind: "file", name: "Plan.docx", key: entry.key, copyOf: { host: "mac", path: P }, back: { is: "refused", writes: 3, held: 1 } };

beforeEach(() => {
  world.calls = [];
  world.tabs = [copyTab];
  world.answer = null;
  world.errors = [];
});

describe("a delete with a copy of the file open", () => {
  it("carries the copy's writes his question showed, by its file's key", async () => {
    expect(await trash(of, team, [entry])).toBe(true);
    expect(world.calls[0]).toMatchObject({ method: "work.files.trash", params: { asked: true, writes: { [`file:mac:${P}`]: 3 } } });
  });

  it("carries no writes for a delete no question was asked about", async () => {
    world.tabs = [];
    const own = { link: "mac", place: { id: "folder", kind: "folder", name: "Events", host: "mac", env: "mac", shared: false, can: ["trash"], state: { state: "ok" }, root: { at: "file", host: "mac", path: "/w" } } } as never;
    await trash(of, own, [{ ...entry, ref: { at: "file", host: "mac", path: "/w/Plan.docx" } } as FileEntry]);
    expect(world.calls[0]!.params.writes).toBeUndefined();
  });

  it("says a delete its drive did not confirm as not confirmed, never as nothing deleted", async () => {
    world.answer = { entries: [], refused: [{ name: "Plan.docx", text: "J: stopped answering mid-delete. Look in its folder once it is back.", unknown: true }], trashed: [], op: "o" };
    expect(await trash(of, team, [entry])).toBe(false);
    expect(world.errors).toEqual(["Delete not confirmed"]);
  });
});
