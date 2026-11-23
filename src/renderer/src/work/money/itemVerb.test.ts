/**
 * File as receipt on a canvas item: offered on a PDF and a picture, never on
 * a sheet or a video; a mail's attachment is fetched, read back by range and
 * arrives at the host whole, in parts under one key, marked as from a mail;
 * a file goes by its place; then the toast leads to Money.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem, CanvasSource } from "@shared/work";

const host: { asked: { method: string; params: Record<string, unknown> }[]; file: Uint8Array } = { asked: [], file: new Uint8Array() };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
vi.mock("../../lib/connection", () => ({
  registry: {
    primary: () => ({ environmentId: "mac" }),
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        if (method === "work.canvas.fetch") return { size: host.file.length };
        if (method === "work.canvas.read") {
          const from = params.offset as number;
          return { data: b64(host.file.subarray(from, from + (params.length as number))), size: host.file.length };
        }
        if (method === "work.money.receive") return { id: "w1", state: "reading" };
        return null;
      },
    }),
  },
}));
const toast = Object.assign(vi.fn(), { error: vi.fn() });
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => toast }));
const opened = vi.fn();
vi.mock("../../lib/workSwitch", () => ({ openWorkView: opened }));

const { itemVerbsFor } = await import("../canvas/itemVerbs");
await import("./itemVerb");
const { fileItem } = await import("./fileItem");

const item = (kind: CanvasItem["kind"], source: CanvasSource, title = "Item"): CanvasItem => ({ id: "i1", sessionId: "t1", workspaceId: "ws", kind, title, source, state: "open", position: 0, rev: 1, createdAt: 1, updatedAt: 1 });
const mail = (name: string, contentType?: string): CanvasSource => ({ at: "mail", threadId: "m", messageId: "x", partId: "2", name, ...(contentType ? { contentType } : {}) });
const offered = (i: CanvasItem) => itemVerbsFor(i, i.kind).map((v) => v.label);

beforeEach(() => {
  host.asked.length = 0;
  toast.mockClear();
  opened.mockClear();
});

describe("File as receipt", () => {
  it("is offered on a PDF and a picture, and never on a sheet or a video", () => {
    expect(offered(item("pdf", mail("invoice.pdf")))).toEqual(["File as receipt"]);
    expect(offered(item("media", mail("IMG_2231.jpg", "image/jpeg")))).toEqual(["File as receipt"]);
    expect(offered(item("media", { at: "file", host: "box", path: "/home/ref/scan.png" }))).toEqual(["File as receipt"]);
    expect(offered(item("media", mail("game.mp4", "video/mp4")))).toEqual([]);
    expect(offered(item("sheet", mail("budget.xlsx")))).toEqual([]);
  });

  it("fetches a mail's attachment, reads it back by range, and sends it whole under one key, as from a mail", async () => {
    host.file = Uint8Array.from({ length: 5_000_000 }, (_, i) => (i * 31 + 7) % 251);
    await fileItem(item("pdf", mail("statement.pdf", "application/pdf")), "box");
    expect(host.asked[0]).toEqual({ method: "work.canvas.fetch", params: { itemId: "i1" } });
    expect(host.asked.filter((a) => a.method === "work.canvas.read")).toHaveLength(2);
    const sent = host.asked.filter((a) => a.method === "work.money.receive").map((a) => a.params);
    expect(sent.map((s) => [s.part, s.parts])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(sent[0]).toMatchObject({ workspaceId: "ws", name: "statement.pdf", mime: "application/pdf", source: "mail" });
    const arrived = Buffer.concat(sent.map((s) => Buffer.from(s.dataBase64 as string, "base64")));
    expect(arrived.equals(Buffer.from(host.file))).toBe(true);
    expect(toast).toHaveBeenCalledWith("Filed to confirm in Money", expect.objectContaining({ action: expect.objectContaining({ label: "Open Money" }) }));
    (toast.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    expect(opened).toHaveBeenCalledWith({ workspaceId: "ws", view: "money" });
  });

  it("sends a file of the host by its place, for the host to copy", async () => {
    const source: CanvasSource = { at: "file", host: "box", path: "/home/ref/Downloads/scan.png" };
    await fileItem(item("media", source), "box");
    expect(host.asked.map((a) => a.method)).toEqual(["work.money.receive"]);
    expect(host.asked[0].params).toMatchObject({ workspaceId: "ws", name: "scan.png", file: source });
  });
});
