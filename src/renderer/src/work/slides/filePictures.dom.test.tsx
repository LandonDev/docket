// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { itemsGone } from "../canvas/gone";
import type { PdfDoc, PdfEngine } from "../pdf/engine";
import { fakeDoc } from "../pdf/testkit";
import type { DeckHost } from "./deck";
import { FilePictures, KEPT_DECKS, keptDeckCount, pictureIn, resetFilePictures, SLIDE_READS_MOST, useFilePictures } from "./filePictures";

/**
 * The deck's own slides are pictured slide by slide: the first view reads the whole render, and an edit reads only the
 * slides whose picture changed (`work.slides.slide`), keeping the rest; a deck's tab shown again reads nothing.
 */

const slide = (n: number, pic: string): DeckSlide => ({ key: `s${n}`, id: 100 + n, number: n, title: `Slide ${n}`, notes: "", hidden: false, from: "file", page: n, change: null, tint: null, shapes: [], changed: [], pic: { rev: pic, size: 5000 } });
const viewOf = (rev: string, pics: string[]): DeckView => ({ itemId: "d1", renders: { file: { rev, size: 60_000 } }, slides: pics.map((p, i) => slide(i + 1, p)) }) as unknown as DeckView;
const TWELVE = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);

function counting() {
  const calls = { whole: 0, slide: [] as number[] };
  const host = {
    read: async (_which: string, _offset: number, length: number) => (calls.whole++, new Uint8Array(length)),
    slide: async (_which: string, id: number, _offset: number, length: number) => (calls.slide.push(id), new Uint8Array(length)),
  } as unknown as DeckHost;
  const docs: Array<PdfDoc & { gone: boolean }> = [];
  const engine: PdfEngine = {
    async open(file) {
      await file.read(0, file.size);
      const doc = Object.assign(fakeDoc([{ runs: [] }]), { gone: false });
      doc.destroy = () => void (doc.gone = true);
      docs.push(doc);
      return doc;
    },
  };
  return { host, engine, calls, docs };
}

const settled = async (pictures: FilePictures, rev: string): Promise<void> => waitFor(() => expect(pictures.get().rev).toBe(rev));

afterEach(resetFilePictures);

describe("the deck's file pictures", () => {
  it("an edit where 1 of 12 slides changed reads that slide alone, and no whole render", async () => {
    const { host, engine, calls, docs } = counting();
    const pictures = new FilePictures(host, engine);
    pictures.update(viewOf("r1", TWELVE));
    await settled(pictures, "r1");
    expect(calls).toEqual({ whole: 1, slide: [] });
    const whole = docs[0]!;
    pictures.update(viewOf("r2", TWELVE.map((p, i) => (i === 4 ? "p5b" : p))));
    await settled(pictures, "r2");
    expect(calls).toEqual({ whole: 1, slide: [105] });
    const shown = pictures.get().shown;
    expect(pictureIn(shown, { key: "s5", page: 5 })).toMatchObject({ doc: docs[1], page: 1 });
    expect(pictureIn(shown, { key: "s4", page: 4 })).toMatchObject({ doc: whole, page: 4 });
    expect(whole.gone).toBe(false);
  });

  it("the same view pushed again reads nothing", async () => {
    const { host, engine, calls } = counting();
    const pictures = new FilePictures(host, engine);
    pictures.update(viewOf("r1", TWELVE));
    await settled(pictures, "r1");
    pictures.update(viewOf("r1", TWELVE));
    expect(calls).toEqual({ whole: 1, slide: [] });
  });

  it(`more than ${SLIDE_READS_MOST} slides changed read the whole render again, and the docs no slide shows go`, async () => {
    const { host, engine, calls, docs } = counting();
    const pictures = new FilePictures(host, engine);
    pictures.update(viewOf("r1", TWELVE));
    await settled(pictures, "r1");
    pictures.update(viewOf("r2", TWELVE.map((p, i) => (i === 0 ? "x" : p))));
    await settled(pictures, "r2");
    pictures.update(viewOf("r3", TWELVE.map((p) => `${p}c`)));
    await settled(pictures, "r3");
    expect(calls.whole).toBe(2);
    expect(calls.slide).toEqual([101]);
    expect(docs.map((d) => d.gone)).toEqual([true, true, false]);
  });

  it("a slide with no picture of its own reads the whole render", async () => {
    const { host, engine, calls } = counting();
    const pictures = new FilePictures(host, engine);
    pictures.update(viewOf("r1", TWELVE));
    await settled(pictures, "r1");
    const next = viewOf("r2", TWELVE);
    delete (next.slides[2] as { pic?: unknown }).pic;
    pictures.update(next);
    await settled(pictures, "r2");
    expect(calls).toEqual({ whole: 2, slide: [] });
  });

  it("a deck's tab shown again draws its pictures at once and reads nothing; the three left last are kept, and a closed deck's go", async () => {
    const { host, engine, calls, docs } = counting();
    const view = viewOf("r1", TWELVE);
    const first = renderHook(() => useFilePictures(host, "d1", engine, view, () => undefined));
    await waitFor(() => expect(first.result.current.state.rev).toBe("r1"));
    first.unmount();
    const again = renderHook(() => useFilePictures(host, "d1", engine, view, () => undefined));
    expect(again.result.current.state.rev).toBe("r1");
    expect(calls).toEqual({ whole: 1, slide: [] });
    again.unmount();
    for (let i = 2; i <= KEPT_DECKS + 1; i++) {
      const other = renderHook(() => useFilePictures(host, `d${i}`, engine, view, () => undefined));
      await waitFor(() => expect(other.result.current.state.rev).toBe("r1"));
      other.unmount();
    }
    expect(keptDeckCount()).toBe(KEPT_DECKS);
    expect(docs[0]!.gone).toBe(true);
    act(() => itemsGone(["d2"]));
    expect(keptDeckCount()).toBe(KEPT_DECKS - 1);
    expect(docs[1]!.gone).toBe(true);
  });
});
