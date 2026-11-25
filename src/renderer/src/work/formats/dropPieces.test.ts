import { describe, expect, it, vi } from "vitest";

/**
 * A file dropped on a document goes up in pieces (perf M9): the chunked upload the canvas's drops use, then an import
 * by its path. A 10 MB file makes at least three requests, none of them over 4.5 MB.
 */

const sent: Array<{ method: string; bytes: number }> = [];
const link = {
  request: vi.fn(async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, bytes: JSON.stringify(params).length });
    if (method === "attachment.begin") return { uploadId: "u1", chunkBytes: 2 * 1024 * 1024 };
    if (method === "attachment.commit") return { path: "/work/Brief.docx", name: "Brief.docx", size: 10 * 1024 * 1024 };
    return { ok: true };
  }),
};
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => link } }));

const { fromFile } = await import("./Import");

describe("a file dropped on a document", () => {
  it("goes up in pieces, none over 4.5 MB, and is imported from where it landed", async () => {
    const file = new File([new Uint8Array(10 * 1024 * 1024).fill(7)], "Brief.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const from = await fromFile("box", "t1", file, null);
    expect(from).toEqual({ at: "source", source: { at: "file", host: "box", path: "/work/Brief.docx" } });
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sent.map((s) => s.bytes))).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    expect(sent.filter((s) => s.method === "attachment.chunk")).toHaveLength(5);
    expect(link.request.mock.calls[0]).toEqual(["attachment.begin", expect.objectContaining({ sessionId: "t1", name: "Brief.docx", into: "workspace", size: 10 * 1024 * 1024 })]);
  });
});
