// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { itemsGone } from "../canvas/gone";
import type { PdfEngine } from "./engine";
import { KEPT_PDFS, keptPdfCount, resetKeptPdfs, usePdfItem } from "./item";
import { fakeDoc, fakePdfHost, pdfView } from "./testkit";

/**
 * A PDF tab shown again draws the file it had open and reads nothing: the open file outlives the body (the three left
 * last), the view alone is asked again, and the file goes with its item. pdf.js starts loading as the body mounts.
 */

/** An engine that reads the whole file once an open, counting opens, destroys and warms. */
function countingEngine() {
  const engine = {
    opened: 0,
    destroyed: 0,
    warmed: 0,
    warm() {
      engine.warmed++;
    },
    async open(file: Parameters<PdfEngine["open"]>[0]) {
      engine.opened++;
      await file.read(0, file.size);
      const doc = fakeDoc([{ runs: [] }]);
      return { ...doc, destroy: () => void engine.destroyed++ };
    },
  };
  return engine;
}

function readingHost() {
  const host = fakePdfHost(pdfView({ size: 1000, rev: "r1" }));
  const reads: number[] = [];
  host.read = async (_which, offset, length) => {
    reads.push(length);
    return new Uint8Array(length - offset);
  };
  return { host, reads };
}

afterEach(resetKeptPdfs);

describe("a PDF tab shown again", () => {
  it("mounted, unmounted and mounted: one open of the file, no second read, the view asked again", async () => {
    const engine = countingEngine();
    const { host, reads } = readingHost();
    const first = renderHook(() => usePdfItem(host, engine, "local\npdf1"));
    await waitFor(() => expect(first.result.current.doc.phase).toBe("ready"));
    expect(engine.warmed).toBeGreaterThan(0);
    first.unmount();
    expect(keptPdfCount()).toBe(1);
    expect(engine.destroyed).toBe(0);
    const again = renderHook(() => usePdfItem(host, engine, "local\npdf1"));
    expect(again.result.current.doc.phase).toBe("ready");
    await waitFor(() => expect(host.calls.filter((c) => c[0] === "open")).toHaveLength(2));
    expect(engine.opened).toBe(1);
    expect(reads).toEqual([1000]);
    expect(keptPdfCount()).toBe(0);
    again.unmount();
  });

  it("reads the file again when the fresh view names another revision", async () => {
    const engine = countingEngine();
    const { host, reads } = readingHost();
    const first = renderHook(() => usePdfItem(host, engine, "local\npdf1"));
    await waitFor(() => expect(first.result.current.doc.phase).toBe("ready"));
    first.unmount();
    host.view = pdfView({ size: 2000, rev: "r2" });
    const again = renderHook(() => usePdfItem(host, engine, "local\npdf1"));
    await waitFor(() => expect(engine.opened).toBe(2));
    await waitFor(() => expect(again.result.current.doc.phase).toBe("ready"));
    expect(reads).toEqual([1000, 2000]);
    expect(engine.destroyed).toBe(1);
    again.unmount();
  });

  it("keeps the files of the three tabs left last, and lets the oldest go", async () => {
    const engine = countingEngine();
    for (let i = 0; i <= KEPT_PDFS; i++) {
      const { host } = readingHost();
      const body = renderHook(() => usePdfItem(host, engine, `local\npdf${i}`));
      await waitFor(() => expect(body.result.current.doc.phase).toBe("ready"));
      body.unmount();
    }
    expect(keptPdfCount()).toBe(KEPT_PDFS);
    expect(engine.destroyed).toBe(1);
  });

  it("lets the file go with its item, and a body with no key keeps nothing", async () => {
    const engine = countingEngine();
    const { host } = readingHost();
    const body = renderHook(() => usePdfItem(host, engine, "local\npdf1"));
    await waitFor(() => expect(body.result.current.doc.phase).toBe("ready"));
    body.unmount();
    act(() => itemsGone(["pdf1"]));
    expect(keptPdfCount()).toBe(0);
    expect(engine.destroyed).toBe(1);
    const bare = renderHook(() => usePdfItem(host, engine));
    await waitFor(() => expect(bare.result.current.doc.phase).toBe("ready"));
    bare.unmount();
    expect(keptPdfCount()).toBe(0);
    expect(engine.destroyed).toBe(2);
  });
});
