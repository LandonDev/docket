// @vitest-environment jsdom
/**
 * The PDF kind in the real canvas pane, with a host that keeps one item's
 * view and a file of words in place of pdf.js: the pages, the pager, the
 * agent's values stepped from the bar, his own value, signing, the find, a
 * citation landing on its clause, a moved file and a locked one.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfView } from "@shared/contract-work-pdf";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { deliverCite, resetCites } from "./cite";
import { navOf, resetNavs } from "./nav";
import { resetKeptPdfs } from "./item";
import type { PdfEngine } from "./engine";
import { fakeDoc, fakeEngine, fakePdfHost, field, pdfView } from "./testkit";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  // The file's computer by name, so a failure that names it can be read.
  const environment = (id: string) => (id === "local" ? { id, name: "Studio Mac" } : undefined);
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, environment, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

const toasts = vi.hoisted(() => ({ errors: [] as unknown[][] }));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () => ({ error: (...args: unknown[]) => void toasts.errors.push(args) }),
}));

import { CanvasSeat } from "../canvas/CanvasSeat";
import { resetCanvasStore } from "../canvas/store";

const ITEM: CanvasItem = canvasItem("pdf1", { kind: "pdf", title: "Ballroom contract.pdf", source: { at: "file", host: "local", path: "/work/contract.pdf" } });
const page = (lines: string[]) => ({ runs: lines.map((str, i) => ({ str, box: [0.1, 0.1 + i * 0.03, 0.8, 0.12 + i * 0.03] as [number, number, number, number] })) });
const FILE = Array.from({ length: 14 }, (_, i) => page(i === 5 ? ["7. Cancellation.", "7.2 If Licensee cancels after March 1, 2027, Purdue keeps the deposit."] : [`Page ${i + 1}`, "A deposit of 50 percent is due."]));

let pdfHost: ReturnType<typeof fakePdfHost>;
let engine: PdfEngine;

function kinds(): Record<string, CanvasKindDef> {
  const module = import("./PdfCanvas").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} host={pdfHost} engine={engine} width={600} height={800} />,
    Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<undefined>)} host={pdfHost} />,
  }));
  return { ...CANVAS, pdf: { ...CANVAS.pdf, chunk: defineChunk("test-pdf", () => module) } };
}

async function open(view: PdfView, options: { password?: string; firstPaint?: Promise<void> } = {}) {
  pdfHost = fakePdfHost(view);
  const doc = fakeDoc(FILE);
  const paint = doc.paint.bind(doc);
  doc.paint = async (...args) => {
    if (args[0] === 1) await options.firstPaint;
    return paint(...args);
  };
  engine = fakeEngine(doc, options);
  host.current = fakeHost([ITEM], host as never);
  const r = render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
  return { ...r, doc };
}

// A loaded box (load 13) can take more than the default second to load the kind's chunk and open the file:
// the waits keep their conditions, with a longer ceiling.
configure({ asyncUtilTimeout: 5000 });

beforeEach(async () => {
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLElement.prototype.releasePointerCapture ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  localStorage.clear();
  resetCanvasStore();
  resetCites();
  resetNavs();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(() => {
  cleanup();
  resetKeptPdfs();
});

/** An element once it is there: waitFor retries only on a throw. */
const found = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    return el!;
  });
const pages = () => [...document.querySelectorAll<HTMLElement>("[data-pdf-page]")].map((el) => Number(el.dataset.pdfPage));

describe("the PDF kind", () => {
  it("draws the pages near the top as paper and counts them in the pager", async () => {
    const paint = Promise.withResolvers<void>();
    const { doc } = await open(pdfView(), { firstPaint: paint.promise });
    // Each part arrives on its own beat (the column, the bar once the kind's chunk is in, the mode once the file opens): wait for each.
    await waitFor(() => expect(pages()[0]).toBe(1));
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("1/14"));
    expect(doc.painted).not.toContain(1);
    await act(async () => paint.resolve());
    await waitFor(() => expect(document.querySelector('[data-pdf-page="1"]')?.textContent).toContain("Page 1"));
    expect(doc.painted).toContain(1);
    expect(await screen.findByRole("button", { name: /Agent suggests/ })).toBeTruthy();
    // Settled: only a window of the 14 pages is mounted, and a file this short has no thumbnail rail.
    expect(pages().length).toBeLessThan(FILE.length);
    expect(document.querySelector("[data-pdf-rail]")).toBeNull();
  });

  it("goes to the next page from the pager", async () => {
    await open(pdfView());
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("2/14"));
    const column = document.querySelector<HTMLElement>("[data-pdf-column]")!;
    expect(column.scrollTop).toBeGreaterThan(0);
  });

  it("steps through the agent's values from the bar, outlined in turn, and accepts one", async () => {
    await open(
      pdfView({
        fields: [
          field("name", { label: "Contact name", page: 1, bbox: [0.1, 0.3, 0.5, 0.33], state: "proposed", proposed: "Landon Hale", provenance: [{ kind: "file", label: "Purdue profile", quote: "Landon Hale" }], by: "agent:local:t1" }),
          field("mail", { label: "Email", page: 1, bbox: [0.1, 0.4, 0.5, 0.43], state: "proposed", proposed: "landon@purdue.edu", provenance: [{ kind: "mail", label: "Events booking" }], by: "agent:local:t1" }),
        ],
      }),
    );
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(within(bar).getByText("1/2")).toBeTruthy();
    const name = document.querySelector<HTMLElement>('[data-pdf-field="name"]')!;
    expect(name.textContent).toBe("Landon Hale");
    expect(name.className).toContain("bg-(--add-bg-paper)");
    expect(name.className).toContain("outline-1");
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-pdf-field="mail"]')!.className).toContain("outline-1"));
    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(pdfHost.calls).toContainEqual(["review", { keys: ["mail"], verdict: "accept" }]));
    // One change left: the stepper keeps its verbs and drops the count it could not step through.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Next change" })).toBeNull());
    expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(document.querySelector<HTMLElement>('[data-pdf-field="mail"]')!.className).not.toContain("add-bg-paper");
  });

  it("opens a field to type his own value, under where the agent's came from", async () => {
    await open(pdfView({ fields: [field("org", { label: "Organization", state: "proposed", proposed: "Purdue Esports", provenance: [{ kind: "file", label: "Purdue profile", quote: "Purdue Esports, RecWell" }], by: "agent:local:t1" })] }));
    const box = await found('[data-pdf-field="org"]');
    fireEvent.click(box);
    expect(await screen.findByText("From Purdue profile: “Purdue Esports, RecWell”")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Organization" }) as HTMLInputElement;
    expect(input.value).toBe("Purdue Esports");
    fireEvent.change(input, { target: { value: "Purdue Esports, RecWell" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(pdfHost.calls).toContainEqual(["setField", { key: "org", value: "Purdue Esports, RecWell" }]));
  });

  it("asks for a signature the first time he signs, saves it, and places it", async () => {
    await open(pdfView({ fields: [field("sig", { label: "Signature", type: "signature", origin: "overlay", state: "needs-owner" })] }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign" }));
    const pad = (await found("[data-signature-pad]")) as unknown as SVGSVGElement;
    pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 480, height: 160, right: 480, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    (pad as unknown as HTMLElement).setPointerCapture = () => undefined;
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 60, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(pad, { pointerId: 1 });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(pdfHost.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["setSignature", "sign"])));
    expect((pdfHost.calls.find((c) => c[0] === "setSignature")![1] as { strokes: unknown[] }).strokes).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Signature" }).querySelector("polyline")).not.toBeNull());
  });

  it("signs with the saved signature at once, with no pad", async () => {
    await open(pdfView({ hasSignature: true, fields: [field("sig", { type: "signature", origin: "overlay", state: "needs-owner" })] }));
    await pdfHost.setSignature({ width: 10, height: 10, strokes: [[[1, 1], [5, 5]]] });
    const sign = await screen.findByRole("button", { name: "Sign" });
    pdfHost.calls.length = 0;
    fireEvent.click(sign);
    await waitFor(() => expect(pdfHost.calls).toEqual([["sign", true]]));
    expect(document.querySelector("[data-signature-pad]")).toBeNull();
  });

  it("finds words across the file and steps to them", async () => {
    await open(pdfView());
    fireEvent.click(await screen.findByRole("button", { name: "Find" }));
    const input = screen.getByRole("textbox", { name: "Find" });
    fireEvent.change(input, { target: { value: "deposit" } });
    await waitFor(() => expect(document.querySelector("[data-pdf-find-count]")?.textContent).toBe("1/14"));
    expect(document.querySelector('[data-pdf-hit="current"]')).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-pdf-find-count]")?.textContent).toBe("2/14"));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
  });

  it("gives the focus back to Find on Escape and on Close find, never to the body", async () => {
    await open(pdfView());
    fireEvent.click(await screen.findByRole("button", { name: "Find" }));
    let input = screen.getByRole("textbox", { name: "Find" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    input = screen.getByRole("textbox", { name: "Find" });
    const close = screen.getByRole("button", { name: "Close find" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find" }));
  });

  it("gives the focus to the page when the narrow bar holds no Find to return to", async () => {
    await open(pdfView());
    fireEvent.click(await screen.findByRole("button", { name: "Find" }));
    const input = screen.getByRole("textbox", { name: "Find" });
    input.focus();
    // A change waits in a narrow canvas: once Find closes, the stepper's room leaves no Find in the bar.
    act(() => {
      navOf("pdf1").review(true);
      navOf("pdf1").measured(420);
    });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Find" })).toBeNull();
    const page = document.querySelector<HTMLElement>('[data-pdf-column="pdf1"]')!;
    expect(document.activeElement).toBe(page);
    expect(page.tabIndex).toBe(-1);
    expect(page.className).toContain("focus-ring");
  });

  it("opens Find on ⌘F or Ctrl+F while the PDF has the focus, and not otherwise", async () => {
    await open(pdfView());
    const find = await screen.findByRole("button", { name: "Find" });
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull();
    find.focus();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: "Find" })).toBeTruthy();
  });

  it("scrolls a citation's page into view and marks its clause", async () => {
    await open(pdfView());
    await waitFor(() => expect(pages()[0]).toBe(1));
    act(() => deliverCite({ itemId: "pdf1", page: 6, bbox: [0.1, 0.13, 0.8, 0.15] }));
    await waitFor(() => expect(pages()).toContain(6));
    const mark = document.querySelector<HTMLElement>('[data-pdf-page="6"] [data-pdf-cite]')!;
    expect(mark).not.toBeNull();
    expect(mark.style.top).toBe("13%");
    expect(document.querySelector<HTMLElement>("[data-pdf-column]")!.scrollTop).toBeGreaterThan(0);
  });

  it("says once when the file moved, and shows the copy kept from before", async () => {
    await open(pdfView({ missing: { asOf: Date.UTC(2026, 10, 16, 14) } }));
    // Read only asks nothing of him: the quiet line, not amber.
    const line = await found('[data-canvas-state="quiet"]');
    // The tab already names the file: the line says only that it moved.
    expect(line.textContent).toContain("Moved.");
    expect(line.textContent).not.toContain("Ballroom contract.pdf");
    // It names which copy is shown, by its time, as one sentence.
    expect(line.textContent).toMatch(/The copy from Nov 16, \d+:00\sAM/);
    expect(line.textContent).not.toContain("as of");
    expect(screen.queryByRole("button", { name: /Agent suggests/ })).toBeNull();
    await waitFor(() => expect(pages()[0]).toBe(1));
  });

  it("says a form only Adobe's apps fill on the quiet line, in plain words: no red, no XFA", async () => {
    await open(pdfView({ xfaOnly: true }));
    const line = await found('[data-canvas-state="quiet"]');
    // One sentence, never two that say the same thing.
    expect(line.textContent).toBe("Only Adobe's apps fill this form");
    expect(line.textContent).not.toContain("XFA");
    expect(document.querySelector('[data-canvas-state="failed"]')).toBeNull();
  });

  it("ticks a checkbox at the press, before the host answers, and puts it back when the host refuses", async () => {
    await open(pdfView({ fields: [field("ok", { label: "I agree", type: "checkbox" })] }));
    const box = await screen.findByRole("checkbox", { name: "I agree" });
    const answer = Promise.withResolvers<PdfView>();
    pdfHost.setField = () => answer.promise;
    fireEvent.click(box);
    // At once: the tick is his press, not the round trip.
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.querySelector("svg")).not.toBeNull();
    await act(async () => answer.reject(new Error("refused")));
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("false"));
    expect(box.querySelector("svg")).toBeNull();
    expect(toasts.errors.at(-1)?.[0]).toBe("Couldn't change the field");
  });

  it("names the file's computer when a field's answer was lost", async () => {
    await open(pdfView({ fields: [field("ok", { label: "I agree", type: "checkbox" })] }));
    const box = await screen.findByRole("checkbox", { name: "I agree" });
    pdfHost.setField = async () => {
      throw new Error("No answer in 30s");
    };
    toasts.errors.length = 0;
    fireEvent.click(box);
    await waitFor(() => expect(toasts.errors.at(-1)?.[0]).toBe("Couldn't change the field"));
    expect(JSON.stringify(toasts.errors.at(-1)?.[1])).toContain("Studio Mac");
  });

  it("makes a saved copy only once every tick he sees is written, and none when a write fails", async () => {
    await open(pdfView({ fields: [field("ok", { label: "I agree", type: "checkbox" })] }));
    URL.createObjectURL ??= () => "blob:copy";
    URL.revokeObjectURL ??= () => undefined;
    const box = await screen.findByRole("checkbox", { name: "I agree" });
    const exports: string[] = [];
    pdfHost.export = async () => (exports.push("export"), { name: "Ballroom contract.pdf", size: 0, warnings: [] });
    const real = pdfHost.setField.bind(pdfHost);
    let answer = Promise.withResolvers<void>();
    pdfHost.setField = async (key, value) => (await answer.promise, real(key, value));
    fireEvent.click(box);
    fireEvent.click(await screen.findByRole("button", { name: "Save a copy" }));
    await new Promise((done) => setTimeout(done, 20));
    expect(exports).toEqual([]);
    await act(async () => answer.resolve());
    await waitFor(() => expect(exports).toEqual(["export"]));
    expect(pdfHost.calls.filter(([m]) => m === "setField")).toHaveLength(1);
    // A write the host refused: the tick goes back, and no copy is made of a page he no longer sees.
    answer = Promise.withResolvers<void>();
    toasts.errors.length = 0;
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save a copy" }));
    await act(async () => answer.reject(new Error("refused")));
    await waitFor(() => expect(toasts.errors.map((e) => e[0])).toContain("Couldn't save a copy"));
    expect(exports).toEqual(["export"]);
  });

  it("reads a saved copy by its own revision, so a second Save a Copy made meanwhile never lends it bytes", async () => {
    await open(pdfView({}));
    URL.createObjectURL ??= () => "blob:copy";
    URL.revokeObjectURL ??= () => undefined;
    pdfHost.export = async () => ({ name: "Ballroom contract.pdf", size: 6 * 1024 * 1024, rev: "r1", warnings: [] });
    const reads: Array<string | undefined> = [];
    pdfHost.read = async (which, _offset, length, rev) => (which === "export" && reads.push(rev), new Uint8Array(length));
    fireEvent.click(await screen.findByRole("button", { name: "Save a copy" }));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads).toEqual(["r1", "r1"]);
  });

  it("spins Sign and holds it while the host places a saved signature, so a second press cannot sign again", async () => {
    await open(pdfView({ hasSignature: true, fields: [field("sig", { type: "signature", origin: "overlay", state: "needs-owner" })] }));
    await pdfHost.setSignature({ width: 10, height: 10, strokes: [[[1, 1], [5, 5]]] });
    const sign = await screen.findByRole("button", { name: "Sign" });
    const placed = Promise.withResolvers<void>();
    const real = pdfHost.sign.bind(pdfHost);
    pdfHost.sign = async (signed) => {
      await placed.promise;
      return real(signed);
    };
    pdfHost.calls.length = 0;
    fireEvent.click(sign);
    expect((sign as HTMLButtonElement).disabled).toBe(true);
    expect(sign.getAttribute("aria-busy")).toBe("true");
    expect(sign.querySelector('[data-slot="spinner"]')).not.toBeNull();
    fireEvent.click(sign);
    await act(async () => placed.resolve());
    await waitFor(() => expect(pdfHost.calls).toEqual([["sign", true]]));
  });

  it("shows Find still reading after its count until every page is read", async () => {
    const { doc } = await open(pdfView());
    const last = Promise.withResolvers<void>();
    const text = doc.text.bind(doc);
    doc.text = async (n) => {
      if (n === FILE.length) await last.promise;
      return text(n);
    };
    fireEvent.click(await screen.findByRole("button", { name: "Find" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "deposit" } });
    await waitFor(() => expect(document.querySelector("[data-pdf-find-count]")?.textContent).toMatch(/^1\/\d+$/));
    expect(document.querySelector("[data-pdf-find-reading]")).not.toBeNull();
    await act(async () => last.resolve());
    await waitFor(() => expect(document.querySelector("[data-pdf-find-reading]")).toBeNull());
    expect(document.querySelector("[data-pdf-find-count]")?.textContent).toBe("1/14");
  });

  it("puts what a narrow bar drops in the pane's More: the zoom and Save a Copy", async () => {
    await open(pdfView());
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")).not.toBeNull());
    act(() => navOf("pdf1").measured(420));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save a copy" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Save a Copy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom: 125%" }));
    await waitFor(() => expect(navOf("pdf1").get().zoom).toBe(1.25));
  });

  it("keeps none of the bar's tools in More while the bar has room for them", async () => {
    await open(pdfView());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save a copy" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Save a Copy" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Zoom/ })).toBeNull();
  });

  it("offers Highlight and Copy at Ask's 24px, Copy with its tip, and keeps the selection's tint until the mark lands", async () => {
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    await open(pdfView());
    const pageEl = await found('[data-pdf-page="1"]');
    await waitFor(() => expect(pageEl.textContent).toContain("deposit"));
    pageEl.getBoundingClientRect = () => new DOMRect(0, 0, 400, 500);
    const words = pageEl.querySelector("[data-pdf-text]") ?? pageEl;
    const node = document.createTextNode("A deposit of 50 percent");
    words.appendChild(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    range.getClientRects = () => [new DOMRect(40, 100, 200, 12)] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect(40, 100, 200, 12);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    fireEvent.pointerUp(document.querySelector("[data-pdf-column]")!);
    const highlight = await screen.findByRole("button", { name: "Highlight" });
    const copy = screen.getByRole("button", { name: "Copy" });
    for (const tool of [highlight, copy]) expect(tool.className).toMatch(/\bh-6\b|\bsize-6\b/);
    await act(async () => {
      fireEvent.pointerEnter(copy, { pointerType: "mouse" });
      fireEvent.mouseEnter(copy);
      fireEvent.mouseMove(copy);
    });
    expect((await screen.findByText("Copy", { selector: "[data-slot=tooltip-content] *, [data-slot=tooltip-content]" })).closest("[data-slot=tooltip-content]")).toBeTruthy();

    const made = Promise.withResolvers<PdfView>();
    pdfHost.mark = (page, quads, text) => (pdfHost.calls.push(["mark", { page, quads, text }]), made.promise);
    fireEvent.click(highlight);
    const tint = await found("[data-pdf-marking]");
    expect(tint.className).toContain("sel-bg-paper");
    const view = { ...pdfHost.view, marks: [{ id: "m1", page: 1, quads: [[0.1, 0.2, 0.6, 0.224]], text: "A deposit of 50 percent", at: 0 }] } as PdfView;
    await act(async () => made.resolve(view));
    await waitFor(() => expect(document.querySelector("[data-pdf-marking]")).toBeNull());
    expect(document.querySelector('[data-pdf-mark="m1"]')).not.toBeNull();
  });

  it("lets a cited clause go on Escape in the column", async () => {
    await open(pdfView());
    await waitFor(() => expect(pages()[0]).toBe(1));
    act(() => deliverCite({ itemId: "pdf1", page: 1, bbox: [0.1, 0.13, 0.8, 0.15] }));
    await found("[data-pdf-cite]");
    // The key is the clause's: a full-window tab's Escape (it skips a key taken) does not leave as well.
    expect(fireEvent.keyDown(document.querySelector("[data-pdf-column]")!, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(document.querySelector("[data-pdf-cite]")).toBeNull());
  });

  it("lets a cited clause go on a press in the column", async () => {
    await open(pdfView());
    await waitFor(() => expect(pages()[0]).toBe(1));
    act(() => deliverCite({ itemId: "pdf1", page: 1, bbox: [0.1, 0.13, 0.8, 0.15] }));
    await found("[data-pdf-cite]");
    fireEvent.pointerDown(document.querySelector('[data-pdf-page="1"]')!);
    await waitFor(() => expect(document.querySelector("[data-pdf-cite]")).toBeNull());
  });

  it("shows what the agent wrote directly with its Undo, in the stepper's place", async () => {
    await open(pdfView({ mode: "writes", written: { id: "w1", text: "Filled 5 fields", at: Date.UTC(2026, 10, 23, 17) } }));
    const written = await found("[data-canvas-written]");
    expect(written.textContent).toContain("Filled 5 fields");
    fireEvent.click(within(written).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(pdfHost.calls).toContainEqual(["undo", "w1"]));
  });

  it("asks for a password when the file has one, and opens with it", async () => {
    await open(pdfView(), { password: "ballroom" });
    expect(await screen.findByText("This file needs a password")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("That password didn't open it")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ballroom" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(pages()[0]).toBe(1));
  });

  it("draws the pages before the form is read, with no field over them, and the fields once the whole view comes", async () => {
    await open(pdfView({ formPending: true, fields: [field("name", { state: "filled", value: "Kai" })] }));
    await waitFor(() => expect(document.querySelector('[data-pdf-page="1"]')?.textContent).toContain("Page 1"));
    expect(document.querySelector("[data-pdf-field]")).toBeNull();
    act(() => pdfHost.push(pdfView({ fields: [field("name", { state: "filled", value: "Kai" })] })));
    await waitFor(() => expect(document.querySelector('[data-pdf-field="name"]')).not.toBeNull());
  });

  it("follows the host's push when the agent proposes a value", async () => {
    await open(pdfView());
    await waitFor(() => expect(pages()[0]).toBe(1));
    act(() => pdfHost.push(pdfView({ fields: [field("phone", { state: "proposed", proposed: "(765) 494-0627", by: "agent:local:t1" })] })));
    expect(await screen.findByRole("toolbar", { name: "Review changes" })).toBeTruthy();
  });
});

describe("a long file", () => {
  it("has the thumbnail rail, and a thumbnail goes to its page", async () => {
    pdfHost = fakePdfHost(pdfView());
    engine = fakeEngine(fakeDoc(Array.from({ length: 300 }, (_, i) => page([`Page ${i + 1}`]))));
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    const rail = await found("[data-pdf-rail]");
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("1/300"));
    expect(rail.querySelectorAll("button").length).toBeLessThan(40);
    // A press steps the thumbnail's fill at once, as every row's does (DESIGN.md "Motion values"); nothing scales.
    const third = within(rail).getByRole("button", { name: "Page 3" });
    expect(third.className.split(" ")).toEqual(expect.arrayContaining(["active:bg-foreground/12", "active:transition-none"]));
    expect(third.className).not.toMatch(/active:scale/);
    fireEvent.click(third);
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("3/300"));
    expect(pages().length).toBeLessThan(12);
  });
});

describe("memory on a long file", () => {
  it("lets pdf.js free a page once it leaves the window", async () => {
    pdfHost = fakePdfHost(pdfView());
    const doc = fakeDoc(Array.from({ length: 300 }, (_, i) => page([`Page ${i + 1}`])));
    engine = fakeEngine(doc);
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    await waitFor(() => expect(doc.painted).toContain(1));
    act(() => navOf("pdf1").goTo(150));
    await waitFor(() => expect(pages()).toContain(150));
    expect(doc.released).toContain(1);
    expect(doc.released).not.toContain(150);
  });
});

describe("a file the host stops sending", () => {
  it("says so with Retry, and Retry opens it again", async () => {
    pdfHost = fakePdfHost(pdfView());
    let tries = 0;
    let fail: (() => void) | undefined;
    let land: (() => void) | undefined;
    engine = {
      open: async (file) => {
        if (++tries === 1) {
          // pdf.js opened, then a range it needed never came.
          fail = () => file.onFail?.("The host stopped sending this file.");
          return fakeDoc(FILE);
        }
        await new Promise<void>((go) => (land = go));
        return fakeDoc(FILE);
      },
    };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    await waitFor(() => expect(pages()[0]).toBe(1));
    await act(async () => fail!());
    expect(await screen.findByText("The host stopped sending this file.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Council round 12 (the walk): Retry dropped to bones at once. The failure stays, Retry spinning, until the file answers.
    await waitFor(() => expect(land).toBeDefined());
    expect(screen.getByText("The host stopped sending this file.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
    await act(async () => land!());
    await waitFor(() => expect(pages()[0]).toBe(1));
    expect(tries).toBe(2);
  });
});

describe("reading a version", () => {
  it("reads at the view's rev, and opens again when the host no longer keeps that version", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { usePdfItem } = await import("./item");
    const h = fakePdfHost(pdfView({ rev: "r1", size: 100 }));
    const reads: Array<string | undefined> = [];
    h.read = async (_which, _offset, _length, rev) => {
      reads.push(rev);
      if (rev === "r1") throw new Error("This file changed since it was opened: open it again.");
      return new Uint8Array(4);
    };
    const reading: PdfEngine = { open: async (file) => (await file.read(0, 4), fakeDoc([{ runs: [] }])) };
    const opens = () => h.calls.filter(([m]) => m === "open").length;
    h.open = async () => {
      h.calls.push(["open", null]);
      return opens() > 1 ? pdfView({ rev: "r2", size: 100 }) : h.view;
    };
    const { result } = renderHook(() => usePdfItem(h, reading));
    await waitFor(() => expect(result.current.doc.phase).toBe("ready"));
    expect(reads).toEqual(["r1", "r2"]);
    expect(result.current.view?.rev).toBe("r2");
  });
});

describe("the bar and failures", () => {
  it("holds a bone in the bar while the file opens, and drops it once the pages land", async () => {
    pdfHost = fakePdfHost(pdfView());
    let land: ((doc: ReturnType<typeof fakeDoc>) => void) | null = null;
    engine = { open: () => new Promise((resolve) => (land = resolve)) };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    await found("[data-pdf-bar-bone]");
    await waitFor(() => expect(land).not.toBeNull());
    await act(async () => land!(fakeDoc(FILE)));
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("1/14"));
    expect(document.querySelector("[data-pdf-bar-bone]")).toBeNull();
  });

  it("says a view the host did not send with Retry, and no bone stays in the bar", async () => {
    pdfHost = fakePdfHost(pdfView());
    const open = pdfHost.open;
    let tries = 0;
    pdfHost.open = async () => {
      // The wire's own words: the shared failure says them as every viewer does (`OpenFailed`, `workErrorWords`).
      if (++tries === 1) throw new Error("No answer in 4 s");
      if (tries === 2) await new Promise<void>((go) => (answer = go));
      return open();
    };
    let answer: (() => void) | undefined;
    engine = fakeEngine(fakeDoc(FILE));
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("That computer did not answer. Try again once it is connected.")).toBeTruthy();
    expect(document.querySelector("[data-canvas-failed]")!.textContent).toContain("Couldn't open this PDF");
    expect(screen.queryByText("No answer in 4 s")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-pdf-bar-bone]")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // Council round 12 (the walk): the failure stays, Retry spinning, until the view answers.
    await waitFor(() => expect(answer).toBeDefined());
    expect(document.querySelector("[data-canvas-failed]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
    await act(async () => answer!());
    await waitFor(() => expect(pages()[0]).toBe(1));
    expect(tries).toBe(2);
  });

  it("says a page pdf.js could not draw in its place, and Retry draws it again", async () => {
    pdfHost = fakePdfHost(pdfView());
    const doc = fakeDoc(FILE);
    const paint = doc.paint.bind(doc);
    let refused = false;
    doc.paint = async (n, el, scale, text, signal) => {
      if (n === 1 && !refused) {
        refused = true;
        throw new Error("Bad XRef entry");
      }
      return paint(n, el, scale, text, signal);
    };
    engine = fakeEngine(doc);
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    const page1 = await found('[data-pdf-page="1"]');
    await waitFor(() => expect(within(page1).getByText("Couldn't draw this page")).toBeTruthy());
    fireEvent.click(within(page1).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(doc.painted).toContain(1));
    await waitFor(() => expect(page1.querySelector("[data-pdf-page-failed]")).toBeNull());
  });

  it("draws a page not yet drawn as its bones on paper, a thumbnail faint, each let go once it paints", async () => {
    pdfHost = fakePdfHost(pdfView());
    const doc = fakeDoc(Array.from({ length: 300 }, (_, i) => page([`Page ${i + 1}`])));
    const paint = doc.paint.bind(doc);
    const held: (() => void)[] = [];
    // Every paint waits for the test: the first look is what a jump or a fast scroll shows.
    doc.paint = (n, el, scale, text, signal) => new Promise<void>((done) => held.push(() => void paint(n, el, scale, text, signal).then(done)));
    engine = fakeEngine(doc);
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    const page1 = await found('[data-pdf-page="1"]');
    expect(page1.querySelector("[data-pdf-page-waiting] [data-paper-bones='page']")).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-pdf-thumb-waiting]")).not.toBeNull());
    await waitFor(() => expect(held.length).toBeGreaterThan(1));
    await act(async () => {
      for (const go of held.splice(0)) go();
    });
    await waitFor(() => expect(page1.querySelector("[data-pdf-page-waiting]")).toBeNull());
    // A thumbnail asks after its pause (and again as the rail settles): each paint asked is let through.
    const rail = document.querySelector("[data-pdf-rail]")!;
    await waitFor(async () => {
      await act(async () => {
        for (const go of held.splice(0)) go();
      });
      expect(rail.querySelector('[aria-label="Page 1"] [data-pdf-thumb-waiting]')).toBeNull();
    });
  });

  it("says what a saved copy could not keep as the toast's own line, never under an empty title", async () => {
    await open(pdfView());
    pdfHost.export = async () => ({ name: "Ballroom contract.pdf", size: 0, warnings: ["The signature is not in the copy."] });
    URL.createObjectURL ??= () => "blob:copy";
    URL.revokeObjectURL ??= () => undefined;
    toasts.errors.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: "Save a copy" }));
    await waitFor(() => expect(toasts.errors).toEqual([["The signature is not in the copy."]]));
  });

  it("finds in the system's search field, whose ring is the field's own", async () => {
    await open(pdfView());
    fireEvent.click(await screen.findByRole("button", { name: "Find" }));
    const field = screen.getByRole("textbox", { name: "Find" }).closest('[data-slot="input-group"]');
    expect(field?.getAttribute("role")).toBe("search");
    expect(field?.className).toContain("focus-field");
  });
});

describe("the PDF's loading bones", () => {
  it("stand on the paper's own side inset, 24px and 12px under the narrow width, so the page does not widen as it lands", async () => {
    const { PageSkeleton } = await import("./PdfCanvas");
    const { NARROW, sideInset } = await import("./layout");
    render(<PageSkeleton />);
    const bones = document.querySelector("[data-pdf-bones]")!;
    expect(bones.parentElement!.className).toContain("@container");
    expect(bones.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "px-6", `@max-[${NARROW}px]:px-3`]));
    expect([sideInset(NARROW), sideInset(NARROW - 1)]).toEqual([24, 12]);
  });
});
