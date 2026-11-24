import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem, CanvasSource } from "@shared/work";

/** The docked chat's new thread holds the tab's file: a live tab's item on the same live source, named by its address. */

const opened = vi.hoisted(() => [] as Array<{ env: string; sessionId: string; what: unknown }>);
const asked = vi.hoisted(() => [] as string[]);
vi.mock("../canvas/store", () => ({
  openItem: async (env: string, sessionId: string, what: unknown) => (opened.push({ env, sessionId, what }), { id: "i1" }),
}));
vi.mock("../../lib/connection", () => ({
  registry: { linkOf: () => ({ request: async (method: string) => (asked.push(method), { source: { at: "file", host: "env_box", path: "/copy" } }) }) },
}));

const { holdFile } = await import("./dockThread");

const LIVE: CanvasSource = {
  at: "microsoft",
  app: "word",
  host: "env_box",
  name: "TempCode proof live 1.docx",
  ref: { kind: "url", url: "https://purdue0-my.sharepoint.com/personal/owner_purdue_edu/Documents/TempCode%20proof%20live%201.docx?web=1" },
};
const item = (source: CanvasSource): CanvasItem => ({ kind: "document", source, title: "TempCode proof live 1.docx" }) as CanvasItem;
const workspace = { id: "w1", environmentId: "env_box" } as Parameters<typeof holdFile>[0];

beforeEach(() => {
  opened.length = 0;
  asked.length = 0;
});

describe("holdFile", () => {
  it("gives a thread asked from a live tab an item on the same live source, with no copy", async () => {
    await holdFile(workspace, { name: "TempCode proof live 1.docx" }, item(LIVE), "t1");
    expect(opened).toEqual([{ env: "env_box", sessionId: "t1", what: { kind: "document", source: LIVE, title: "TempCode proof live 1.docx" } }]);
    expect(asked).toEqual([]);
  });
});
