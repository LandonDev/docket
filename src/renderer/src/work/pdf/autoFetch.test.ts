// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { openPdf, type Loaded } from "./engine";

/**
 * pdf.js reads a file by range and asks for nothing it was not asked for (`disableAutoFetch`): a 40-page file opened
 * to page 1 reads a small share of its bytes, and find and a selection still read any page's words by range. Real
 * pdf.js (its legacy build, in node with its own fake worker) on a file built here.
 */

/** A PDF of `pages` pages, each with its words and a content stream padded to `pad` bytes, the xref at its end. */
function pdfOf(pages: number, pad: number): Uint8Array {
  const parts: string[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (text: string): void => {
    parts.push(text);
    at += text.length;
  };
  const obj = (n: number, body: string): void => {
    offsets[n] = at;
    put(`${n} 0 obj\n${body}\nendobj\n`);
  };
  put("%PDF-1.4\n");
  const pageIds = Array.from({ length: pages }, (_, i) => 4 + i * 2);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // The page objects together after the tree, as most writers lay them, and each page's words after them. (pdf.js's own
  // check of the last page reads every page object of a flat tree: had each sat between two padded streams, that
  // check alone would read the whole file, whatever auto-fetch says.)
  for (const id of pageIds) obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
  for (let i = 0; i < pages; i++) {
    const id = pageIds[i]!;
    const words = `BT /F1 12 Tf 72 720 Td (Clause ${i + 1} of the agreement) Tj ET\n`;
    const content = words + `% ${"x".repeat(Math.max(0, pad - words.length - 3))}\n`;
    obj(id + 1, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  const count = 4 + pages * 2;
  const xref = at;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new TextEncoder().encode(parts.join(""));
}

async function legacy(): Promise<Loaded> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as Loaded["pdfjs"];
  pdfjs.GlobalWorkerOptions.workerSrc = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return { pdfjs };
}

/** Waits until no read has been asked for a while: what pdf.js would go on to fetch on its own has been asked by then. */
async function quiet(reads: () => number): Promise<void> {
  for (let still = 0, last = -1; still < 10; ) {
    await new Promise((r) => setTimeout(r, 20));
    const now = reads();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

describe("a PDF read by range with auto-fetch off", () => {
  const file = pdfOf(40, 200_000);
  let bytes = 0;
  let reads = 0;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    reads++;
    const got = file.slice(offset, offset + length);
    bytes += got.length;
    return got;
  };

  it("opened to page 1 reads under a quarter of a 40-page file, and find still reads page 40's words", async () => {
    const doc = await openPdf(legacy, { size: file.length, read });
    expect(doc.pages).toBe(40);
    await doc.text(1);
    await quiet(() => reads);
    expect(bytes / file.length).toBeLessThan(0.25);
    const before = bytes;
    const runs = await doc.text(40);
    expect(runs.map((r) => r.str).join(" ")).toContain("Clause 40 of the agreement");
    expect(bytes).toBeGreaterThan(before);
    doc.destroy();
  }, 30_000);

  it("asks for the file's first frame without waiting for pdf.js to load", async () => {
    const order: string[] = [];
    let loaded!: () => void;
    const gate = new Promise<void>((r) => (loaded = r));
    const opening = openPdf(
      async () => {
        await gate;
        order.push("pdf.js");
        return legacy();
      },
      {
        size: file.length,
        read: async (offset, length) => {
          order.push(`read ${offset}`);
          return file.slice(offset, offset + length);
        },
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["read 0"]);
    loaded();
    (await opening).destroy();
  }, 30_000);
});
