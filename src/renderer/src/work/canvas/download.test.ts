import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/** A fetched item's Download reads its first piece, then the rest a few at a time (perf M9), and saves the same bytes. */

const file = new Uint8Array(17 * 1024 * 1024).map((_, i) => (i * 31) % 251);
let flying = 0;
let most = 0;
const asked: number[] = [];
vi.mock("../../lib/connection", () => ({
  registry: {
    onLink: () => () => undefined,
    linkOf: () => ({
      request: async (_method: string, p: { offset: number; length: number }) => {
        asked.push(p.offset);
        flying++;
        most = Math.max(most, flying);
        await new Promise((r) => setTimeout(r, 2));
        flying--;
        return { data: Buffer.from(file.subarray(p.offset, p.offset + p.length)).toString("base64"), size: file.length };
      },
    }),
  },
}));
const saved = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock("../../lib/native", () => ({ saveDownload: async (_name: string, bytes: Uint8Array) => void (saved.bytes = bytes) }));

const { downloadItem, DOWNLOAD_AT_ONCE } = await import("./fetched");
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("a fetched item's Download", () => {
  it("reads the rest a few pieces at a time and saves the same bytes", async () => {
    await downloadItem("box", { id: "i1", title: "Report.pdf", source: { at: "file", host: "box", path: "/x" } } as never);
    expect(asked).toHaveLength(5);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(DOWNLOAD_AT_ONCE);
    expect(sha(saved.bytes!)).toBe(sha(file));
  });
});
