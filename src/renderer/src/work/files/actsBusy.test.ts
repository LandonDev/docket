/**
 * A row his act is changing shows the list's spinner and its verb until the host answers (docs/DESIGN.md "The Files
 * place"): rename (with the name he typed), move, copy, delete and download each mark their own rows, and let them go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@shared/work/files";
import type { RowBusy } from "./busy";

const world = vi.hoisted(() => ({ answers: {} as Record<string, unknown>, fail: null as string | null, seen: [] as { method: string; marks: string }[] }));
const marks = new Map<string, RowBusy>();
const words = (): string => [...marks].map(([key, b]) => `${key.slice(key.lastIndexOf("/") + 1)}=${b.word}${b.name ? `>${b.name}` : ""}`).join(", ");

vi.mock("../../lib/connection", () => ({
  registry: {
    has: () => true,
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        // What the rows say while the host works.
        world.seen.push({ method, marks: words() });
        if (world.fail === method) throw new Error("No.");
        if (method === "work.files.read") {
          const offset = params.offset as number;
          const end = offset >= 4 * 1024 * 1024;
          return { data: btoa("x".repeat(8)), version: "v1", end };
        }
        return world.answers[method] ?? { entries: [], refused: [] };
      },
    }),
  },
}));
vi.mock("./farLink", async () => ({ filesLink: (await import("../../lib/connection")).registry.linkOf }));
vi.mock("./store", () => ({ tabsNow: () => [], closeTab: vi.fn() }));
vi.mock("../../chrome/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: vi.fn(), error: vi.fn() }) }));
// Main's disk for a download: each part taken, and the path answered once kept.
vi.mock("../../lib/native", () => ({ isWebMode: () => false, downloadParts: () => ({ begin: async () => "d1", part: async () => undefined, end: async (_id: string, keep: boolean) => (keep ? "/Downloads/x" : null) }) }));
vi.mock("../../lib/fs", () => ({ revealPath: async () => undefined }));

const { renameTo, carryTo, trash, download, SETTLE_MS } = await import("./acts");

const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({ key: `file:box:/w/${name}`, ref: { at: "file", host: "box", path: `/w/${name}` }, folder: null, name, kind: "sheet", ...over }) as FileEntry;
const of = {
  workspaceId: "w1",
  home: "box",
  busy: (keys: readonly string[], next: RowBusy | null) => {
    for (const key of keys) next ? marks.set(key, next) : marks.delete(key);
  },
};
const copy = { link: "box", place: { id: "folder", kind: "folder", name: "Dummy", host: "box", env: "box", shared: false, can: ["rename", "move", "copy", "trash"], state: { state: "ok" }, root: { at: "file", host: "box", path: "/w" } } } as never;
const events = { copy, at: { at: "file", host: "box", path: "/w/Events" } as never, name: "Events" };

beforeEach(() => {
  vi.useFakeTimers();
  marks.clear();
  world.seen = [];
  world.fail = null;
  world.answers = {};
});
afterEach(() => vi.useRealTimers());

describe("a row his act is changing", () => {
  it("shows the name he typed while its rename is out, and keeps it until the list is read again", async () => {
    world.answers["work.files.rename"] = { entries: [file("Budget 2027.xlsx")], refused: [] };
    await renameTo(of, copy, file("Budget.xlsx"), " Budget 2027.xlsx ");
    expect(world.seen).toEqual([{ method: "work.files.rename", marks: "Budget.xlsx=Renaming…>Budget 2027.xlsx" }]);
    // The folder is read again on the host's push before the mark goes, so the old name never shows between.
    expect(words()).toBe("Budget.xlsx=Renaming…>Budget 2027.xlsx");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(words()).toBe("");
  });

  it("lets a refused rename go at once, back to its own name", async () => {
    world.fail = "work.files.rename";
    expect(await renameTo(of, copy, file("Budget.xlsx"), "Budget 2027.xlsx")).toBeNull();
    expect(words()).toBe("");
  });

  it("says Moving… or Copying… on each row carried, and Deleting… on each row deleted", async () => {
    world.answers["work.files.move"] = { entries: [file("Events/a.xlsx"), file("Events/b.xlsx")], refused: [] };
    await carryTo(of, "move", copy, [file("a.xlsx"), file("b.xlsx")], events);
    world.answers["work.files.copy"] = { entries: [file("Events/c.xlsx")], refused: [] };
    await carryTo(of, "copy", copy, [file("c.xlsx")], events);
    // A copy leaves its row where it was, so its word goes with the answer; a move's rows leave the list.
    expect(words()).toBe("a.xlsx=Moving…, b.xlsx=Moving…");
    vi.advanceTimersByTime(SETTLE_MS);
    world.answers["work.files.trash"] = { entries: [], refused: [], trashed: ["t1"] };
    await trash(of, copy, [file("d.xlsx")]);
    expect(world.seen.map((s) => [s.method, s.marks])).toEqual([
      ["work.files.move", "a.xlsx=Moving…, b.xlsx=Moving…"],
      // Each act's rows its own: the move's, still held for the list's read, beside the copy's.
      ["work.files.copy", "a.xlsx=Moving…, b.xlsx=Moving…, c.xlsx=Copying…"],
      ["work.files.trash", "d.xlsx=Deleting…"],
    ]);
  });

  it("says how far a download has come where the file's size is known, and lets the row go at its end", async () => {
    world.answers = {};
    // Each read answers 8 bytes here; the stand-in host ends past 4 MB, so the second read is the last.
    const big = file("Roster.xlsx", { size: 8.4 * 1024 * 1024 });
    const seenAt = world.seen.length;
    const reads: string[] = [];
    const real = of.busy;
    await download({ ...of, busy: (keys, next) => (next && reads.push(next.word), real(keys, next)) }, copy, big);
    expect(reads[0]).toBe("Downloading… 0.0 of 8.4 MB");
    expect(world.seen.slice(seenAt).every((s) => s.marks.startsWith("Roster.xlsx=Downloading…"))).toBe(true);
    expect(words()).toBe("");
  });
});
