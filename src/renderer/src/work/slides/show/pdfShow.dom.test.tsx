// @vitest-environment jsdom
/**
 * The show over any PDF's pages (`presentPdf`, the PDF kind's Present): each page a slide, no notes and no
 * builds, the bytes read at the PDF's own rev, from a page he names; and the host refuses a read at another rev.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeDoc, fakeEngine } from "../../pdf/testkit";
import { RENDER_CHANGED } from "../deck";
import { pdfShowHost, type PdfBytes } from "./pdfShow";
import type { ShowPlace, Surface } from "./places";
import { presentPdf } from "./Show";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.replaceChildren();
});

const WIDE = { width: 480, height: 270 };
const pages = (count: number) => fakeDoc(Array.from({ length: count }, (_, i) => ({ size: WIDE, runs: [{ str: `Page ${i + 1}`, box: [0.1, 0.1, 0.6, 0.2] as [number, number, number, number] }] })));
function bytes(pagesIn: number): PdfBytes & { reads: number } {
  const all = new TextEncoder().encode("%PDF-1.7 a file of its own");
  const pdf = { rev: "pdf-rev-1", size: all.length, pages: pagesIn, reads: 0, read: async (offset: number, length: number) => (pdf.reads++, all.slice(offset, offset + length)) };
  return pdf;
}
function place(surface: Surface): ShowPlace {
  const body = document.createElement("div");
  document.body.appendChild(body);
  return { surface, win: window, body, onGone: () => () => undefined, close: () => body.remove() };
}
const text = (p: ShowPlace, selector: string): string | null => p.body.querySelector(selector)?.textContent ?? null;

describe("a PDF presented", () => {
  it("is a show of its pages: one a slide, no notes and no builds, read at its own rev", async () => {
    const pdf = bytes(5);
    const host = pdfShowHost(pdf, "Handbook");
    const deck = await host.show();
    expect(deck.render).toEqual({ rev: "pdf-rev-1", size: pdf.size, pages: 5 });
    expect(deck.slides.map((s) => [s.number, s.page, s.notes, s.hidden, s.steps, s.media, s.transition])).toEqual([1, 2, 3, 4, 5].map((n) => [n, n, "", false, undefined, undefined, undefined]));
    expect(deck.changed).toBeUndefined();
    expect(await host.read(0, 4, "pdf-rev-1")).toEqual(new TextEncoder().encode("%PDF"));
    await expect(host.read(0, 4, "another")).rejects.toThrow(RENDER_CHANGED);
    expect(() => pdfShowHost(bytes(0), "Empty")).toThrow("no pages");
  });

  it("starts the show from the page he names, steps through the pages, and ends after the last", async () => {
    const pdf = bytes(5);
    const places: Partial<Record<Surface, ShowPlace>> = {};
    let handle!: Awaited<ReturnType<typeof presentPdf>>;
    await act(async () => {
      handle = await presentPdf({ pdf, title: "Handbook", from: 3, mode: "windowed", engine: fakeEngine(() => pages(5)), native: null, open: (surface) => (places[surface] = place(surface)) });
    });
    const presenter = places.presenter!;
    await waitFor(() => expect(text(presenter, "[data-show-place]")).toBe("3 / 5"));
    fireEvent.keyDown(presenter.body, { key: "ArrowRight" });
    expect(text(places.audience!, "[data-show-place]")).toBe("4 / 5");
    await act(async () => handle.end());
    await handle.done;
    // A page past the end starts on the last.
    await act(async () => {
      handle = await presentPdf({ pdf, title: "Handbook", from: 99, mode: "windowed", engine: fakeEngine(() => pages(5)), native: null, open: (surface) => (places[surface] = place(surface)) });
    });
    await waitFor(() => expect(text(places.presenter!, "[data-show-place]")).toBe("5 / 5"));
    await act(async () => handle.end());
  });
});
