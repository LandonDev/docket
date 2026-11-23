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
const toast = Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(() => "t1") });
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => toast }));
const opened = vi.fn();
vi.mock("../../lib/workSwitch", () => ({ openWorkView: opened }));
// "ws" is a Work job on this host; "code" is a code workspace.
vi.mock("../../lib/tcserver/workspaces", () => ({ workspaceStore: { workspace: (id: string) => (id === "ws" ? { id, kind: "work" } : id === "code" ? { id, kind: "code" } : undefined) } }));

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
  it("says to open it in a job, before any byte moves, when its pane has none", async () => {
    await fileItem({ ...item("pdf", mail("invoice.pdf")), workspaceId: "code" }, "box");
    expect(host.asked).toEqual([]);
    expect(toast).toHaveBeenCalledWith("Open this in a job to file it as a receipt.");
  });

  it("settles the toast to the host's words when filing fails", async () => {
    host.file = new Uint8Array(0);
    const source: CanvasSource = { at: "file", host: "box", path: "/home/ref/scan.png" };
    const failing = { ...item("media", source) };
    const ask = host.asked.length;
    const prev = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("No key");
    });
    await fileItem(failing, "box");
    prev.mockRestore();
    expect(host.asked.length).toBe(ask);
    expect(toast.error).toHaveBeenCalledWith("No key", { id: "t1" });
  });

  it("is offered on a PDF and a picture, and never on a sheet or a video", () => {
    expect(offered(item("pdf", mail("invoice.pdf")))).toEqual(["File as receipt"]);
    expect(offered(item("media", mail("IMG_2231.jpg", "image/jpeg")))).toEqual(["File as receipt"]);
    expect(offered(item("media", { at: "file", host: "box", path: "/home/ref/scan.png" }))).toEqual(["File as receipt"]);
    expect(offered(item("media", mail("game.mp4", "video/mp4")))).toEqual([]);
    expect(offered(item("sheet", mail("budget.xlsx")))).toEqual([]);
    // By the host's own rule: an attachment with no extension is a receipt by its type, and one with neither is not.
    expect(offered(item("media", mail("scan", "image/jpeg")))).toEqual(["File as receipt"]);
    expect(offered(item("pdf", mail("scan", "application/octet-stream")))).toEqual([]);
    // Only in a job's pane: a code workspace's or a jobless pane has no ledger.
    expect(offered({ ...item("pdf", mail("invoice.pdf")), workspaceId: "code" })).toEqual([]);
    expect(offered({ ...item("pdf", mail("invoice.pdf")), workspaceId: null })).toEqual([]);
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
    // Said at once, then settled in the same toast.
    expect(toast.loading).toHaveBeenCalledWith("Filing to Money…");
    expect(toast).toHaveBeenCalledWith("Filed to confirm in Money", expect.objectContaining({ id: "t1", action: expect.objectContaining({ label: "Open Money" }) }));
    (toast.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    expect(opened).toHaveBeenCalledWith({ workspaceId: "ws", view: "money" });
  });

  it("sends an attachment with no extension under its type's name", async () => {
    host.file = Uint8Array.from([1, 2, 3]);
    host.asked.length = 0;
    await fileItem(item("media", mail("scan", "image/jpeg")), "box");
    expect(host.asked.filter((a) => a.method === "work.money.receive").map((a) => a.params.name)).toEqual(["scan.jpg"]);
  });

  it("sends a file of the host by its place, for the host to copy", async () => {
    const source: CanvasSource = { at: "file", host: "box", path: "/home/ref/Downloads/scan.png" };
    await fileItem(item("media", source), "box");
    expect(host.asked.map((a) => a.method)).toEqual(["work.money.receive"]);
    expect(host.asked[0].params).toMatchObject({ workspaceId: "ws", name: "scan.png", file: source });
  });
});
