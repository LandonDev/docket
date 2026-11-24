// @vitest-environment jsdom
/**
 * The show's readers of step pictures and clips (stage.tsx): what is still on its way when the show ends is let go,
 * and nothing more of it is asked for.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfDoc, PdfEngine } from "../../pdf/engine";
import { useMediaUrls, useStepDocs } from "./stage";

afterEach(() => vi.unstubAllGlobals());

/** A read the test answers by hand. */
function reads() {
  const asked: Array<{ offset: number; done: (bytes: Uint8Array) => void }> = [];
  const read = (_rev: string, offset: number) => new Promise<Uint8Array>((done) => asked.push({ offset, done }));
  return { asked, read };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("a show's readers once the show ends", () => {
  it("asks for no more of a clip, and makes no object URL of it", async () => {
    const made = vi.fn(() => "blob:clip");
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: made, revokeObjectURL: vi.fn() }));
    const { asked, read } = reads();
    const clip = { rev: "0123456789abcdef", size: 9 * 1024 * 1024, type: "video/mp4" };
    const { unmount } = renderHook(() => useMediaUrls(read, [clip]));
    expect(asked).toHaveLength(1);
    unmount();
    asked[0].done(new Uint8Array(4));
    await flush();
    expect(asked).toHaveLength(1);
    expect(made).not.toHaveBeenCalled();
  });

  it("lets go of a step picture that opens after it", async () => {
    const destroy = vi.fn();
    let opened!: (doc: PdfDoc) => void;
    const engine: PdfEngine = { open: () => new Promise<PdfDoc>((done) => (opened = done)) };
    const { read } = reads();
    const { unmount } = renderHook(() => useStepDocs(engine, read, [{ rev: "0123456789abcdef", size: 10 }]));
    unmount();
    opened({ destroy, pages: 1 } as unknown as PdfDoc);
    await flush();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
