import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { FileEntry } from "@shared/work/files";

/**
 * A row's open starts everything at once: the kind's code loads at the click, beside `work.files.open`, and a Word
 * file's import starts as soon as the host answers the item, under the one key the item's body uses, so the body's
 * own ask is the same import and the host makes one document.
 */

const order: string[] = [];
let answerOpen: (value: unknown) => void = () => undefined;
const link = {
  has: () => true,
  request: vi.fn(async (method: string) => {
    order.push(method);
    if (method === "work.files.open") return new Promise((resolve) => (answerOpen = resolve));
    if (method === "work.formats.import") return { item: "i2", warnings: [] };
    return {};
  }),
  onPush: () => () => undefined,
};
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => link, has: () => true, onLink: () => () => undefined } }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ message: () => undefined, error: () => undefined }) }));
const loads = vi.hoisted(() => ({ document: 0, sheet: 0 }));
vi.mock("../canvas/registry", () => ({
  CANVAS: {
    document: { chunk: { load: async () => void (loads.document++, order.push("load document")) } },
    sheet: { chunk: { load: async () => void (loads.sheet++, order.push("load sheet")) } },
  },
}));

const shows = vi.hoisted(() => ({ noted: [] as Array<[string, string]> }));
vi.mock("../slides/openShow", () => ({ noteSlidesOpenedByHand: (env: string, item: CanvasItem) => void shows.noted.push([env, item.id]) }));

const { openEntry } = await import("./open");
const { importItem, resetImports } = await import("../formats/importOnce");

afterEach(() => {
  order.length = 0;
  loads.document = loads.sheet = 0;
  link.request.mockClear();
  resetImports();
});

const workspace = { id: "w1", environmentId: "box", path: "/work" };
const copy = { place: { kind: "folder", id: "own", name: "Work" }, link: "box", host: "the box", wire: "files" } as never;
const entry = (name: string): FileEntry => ({ key: `file:box:/work/${name}`, name, ref: { at: "file", host: "box", path: `/work/${name}` } }) as never;
const itemOf = (name: string, kind: CanvasItem["kind"]): CanvasItem => ({ id: "i1", sessionId: "files:w1", kind, title: name, source: { at: "file", host: "box", path: `/work/${name}` } }) as never;

describe("a row's open", () => {
  it("loads the kind's code before work.files.open answers", async () => {
    const opening = openEntry(entry("Budget.xlsx"), copy, { workspace, tabs: true, copy: true, busy: () => undefined });
    await vi.waitFor(() => expect(order).toContain("work.files.open"));
    expect(loads.sheet).toBe(1);
    expect(order.indexOf("load sheet")).toBeLessThan(order.indexOf("work.files.open"));
    answerOpen({ tabs: [], tabId: "t1", item: itemOf("Budget.xlsx", "sheet") });
    expect(await opening).toBe("t1");
    expect(order).not.toContain("work.formats.import");
  });

  it("starts a Word file's import right after the open, and the item's body asks the same import", async () => {
    const opening = openEntry(entry("Brief.docx"), copy, { workspace, tabs: true, copy: true, busy: () => undefined });
    await vi.waitFor(() => expect(order).toContain("work.files.open"));
    expect(loads.document).toBe(1);
    const item = itemOf("Brief.docx", "document");
    answerOpen({ tabs: [], tabId: "t1", item });
    await opening;
    expect(order.filter((m) => m === "work.formats.import")).toHaveLength(1);
    // ImportBody's ask, as it mounts on the same host with the item and its source: no second import.
    await importItem("box", { id: item.id, sessionId: item.sessionId, source: item.source });
    expect(order.filter((m) => m === "work.formats.import")).toHaveLength(1);
  });

  it("a .tcdoc opens with no import", async () => {
    const opening = openEntry(entry("Plan.tcdoc"), copy, { workspace, tabs: true, copy: true, busy: () => undefined });
    await vi.waitFor(() => expect(order).toContain("work.files.open"));
    answerOpen({ tabs: [], tabId: "t1", item: itemOf("Plan.tcdoc", "document") });
    await opening;
    expect(order).not.toContain("work.formats.import");
  });

  it("tells the deck a file he opened by his own press, so a show file (.pps, .ppsx) starts its show", async () => {
    shows.noted.length = 0;
    const opening = openEntry(entry("Keynote.ppsx"), copy, { workspace, tabs: true, copy: true, busy: () => undefined });
    await vi.waitFor(() => expect(order).toContain("work.files.open"));
    answerOpen({ tabs: [], tabId: "t1", item: itemOf("Keynote.ppsx", "slides") });
    await opening;
    expect(shows.noted).toEqual([["box", "i1"]]);
  });
});
