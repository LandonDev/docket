/**
 * A file of another host renamed or moved from his window: the workspace's own host is told, so the copy a Files tab
 * keeps of it follows to the file's new path (files/copies.ts `copiesMoved`). Without it his next edit went to the old
 * path and was kept beside it as "(mine)".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTab } from "@shared/contract-work-files";
import type { FileEntry } from "@shared/work/files";

const world = vi.hoisted(() => ({ calls: [] as { link: string; method: string; params: Record<string, unknown> }[], tabs: [] as FileTab[], answers: {} as Record<string, unknown> }));

vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: (link: string) => ({
      request: async (method: string, params: Record<string, unknown>) => (world.calls.push({ link, method, params }), world.answers[method] ?? {}),
    }),
  },
}));
vi.mock("./store", () => ({ tabsNow: () => world.tabs, closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn(), error: vi.fn() }) }));

const { renameTo, carryTo, movedPairs } = await import("./acts");

const MAC = "env_mac";
const file = (path: string): FileEntry => ({ key: `file:${MAC}:${path}`, ref: { at: "file", host: MAC, path }, folder: null, name: path.slice(path.lastIndexOf("/") + 1), kind: "sheet" }) as FileEntry;
const of = { workspaceId: "w1", home: "box" };
const macCopy = { link: "mac", place: { id: "teams:1", kind: "teams", name: "Esports", host: MAC, env: MAC, shared: true, can: ["rename", "move"], state: { state: "ok" }, root: { at: "file", host: MAC, path: "/T" } } } as never;
const copyTab = (path: string): FileTab => ({ id: "t1", kind: "file", name: "Roster.xlsx", key: "k", itemId: "i1", copyOf: { host: MAC, path } }) as FileTab;

beforeEach(() => {
  world.calls = [];
  world.tabs = [];
  world.answers = {};
});

describe("a far file whose copy is open", () => {
  it("tells the workspace's host where a renamed file now lies", async () => {
    world.tabs = [copyTab("/T/General/Roster.xlsx")];
    world.answers["work.files.rename"] = { entries: [file("/T/General/Roster 2026.xlsx")], refused: [], op: "o" };
    await renameTo(of, macCopy, file("/T/General/Roster.xlsx"), "Roster 2026.xlsx");
    expect(world.calls.map((c) => [c.link, c.method])).toEqual([
      ["mac", "work.files.rename"],
      ["box", "work.files.copiesMoved"],
    ]);
    expect(world.calls[1]!.params).toEqual({ workspaceId: "w1", moves: [{ from: { at: "file", host: MAC, path: "/T/General/Roster.xlsx" }, to: { at: "file", host: MAC, path: "/T/General/Roster 2026.xlsx" } }] });
  });

  it("tells it of a move too, each thing paired by its name", async () => {
    world.tabs = [copyTab("/T/General/Roster.xlsx")];
    world.answers["work.files.move"] = { entries: [file("/T/Events/Roster.xlsx")], refused: [], op: "o" };
    await carryTo(of, "move", macCopy, [file("/T/General/Roster.xlsx")], { copy: macCopy, at: { at: "file", host: MAC, path: "/T/Events" } as never, name: "Events" });
    expect(world.calls.find((c) => c.method === "work.files.copiesMoved")?.params.moves).toEqual([{ from: { at: "file", host: MAC, path: "/T/General/Roster.xlsx" }, to: { at: "file", host: MAC, path: "/T/Events/Roster.xlsx" } }]);
  });

  it("pairs a move's things only by a name one thing alone holds, and never one the move refused", () => {
    const a = file("/T/General/Plan.xlsx");
    const b = file("/T/Events/Plan.xlsx");
    const c = file("/T/General/Roster.xlsx");
    const went = { entries: [file("/T/Out/Plan.xlsx"), file("/T/Out/Roster.xlsx")], refused: [{ name: "Plan.xlsx", text: "taken" }] } as never;
    expect(movedPairs([a, b, c], went).map(([x, y]) => [x.ref, y.ref])).toEqual([[c.ref, { at: "file", host: MAC, path: "/T/Out/Roster.xlsx" }]]);
  });

  it("asks nothing more when no tab holds a copy of it, or when the file is the workspace host's own", async () => {
    world.answers["work.files.rename"] = { entries: [file("/T/General/Roster 2026.xlsx")], refused: [], op: "o" };
    await renameTo(of, macCopy, file("/T/General/Roster.xlsx"), "Roster 2026.xlsx");
    world.tabs = [copyTab("/T/General/Roster.xlsx")];
    await renameTo(of, { ...(macCopy as object), link: "box" } as never, file("/T/General/Roster.xlsx"), "Roster 2026.xlsx");
    expect(world.calls.map((c) => c.method)).toEqual(["work.files.rename", "work.files.rename"]);
  });
});
