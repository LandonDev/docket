import { afterEach, describe, expect, it, vi } from "vitest";

/** An Excel file's decode goes to a worker with its bytes transferred (perf M9): one message out, one back. */

const posted: Array<{ data: { id: number; bytes: ArrayBuffer }; transfer: Transferable[] }> = [];
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(data: { id: number; bytes: ArrayBuffer }, transfer: Transferable[]) {
    posted.push({ data, transfer });
    const picture = new Uint8Array([1, 2, 3]);
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, got: { workbook: { id: "book" }, objects: { pictures: [], charts: [] }, media: [{ part: "xl/media/image1.png", bytes: picture, type: "image/png" }] } } } as MessageEvent));
  }
}
vi.mock("./xlsxDecode.worker?worker", () => ({ default: FakeWorker }));
// (the window's own decode is never reached while a worker answers)
vi.mock("./xlsxDecode", () => ({ decodeXlsx: () => { throw new Error("decoded on the main thread"); } }));

afterEach(() => vi.unstubAllGlobals());

describe("an Excel file's decode", () => {
  it("is posted to the worker once, its buffer transferred, and the book comes back with its pictures", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { univerGrid } = await import("./grid");
    const bytes = new Uint8Array([80, 75, 3, 4, 9, 9]);
    const book = await univerGrid.decode(bytes, "xlsx");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.transfer).toEqual([posted[0]!.data.bytes]);
    expect(new Uint8Array(posted[0]!.data.bytes)).toEqual(new Uint8Array([80, 75, 3, 4, 9, 9]));
    expect(book.workbook).toEqual({ id: "book" });
    expect(book.media?.get("xl/media/image1.png")).toEqual({ bytes: new Uint8Array([1, 2, 3]), type: "image/png" });
  });
});
