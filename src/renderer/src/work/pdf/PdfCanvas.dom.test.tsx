// @vitest-environment jsdom
/**
 * The PDF kind in the real canvas pane, with a host that keeps one item's
 * view and a file of words in place of pdf.js: the pages, the pager, the
 * agent's values stepped from the bar, his own value, signing, the find, a
 * citation landing on its clause, a moved file and a locked one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfView } from "@shared/contract-work-pdf";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { deliverCite, resetCites } from "./cite";
import { navOf, resetNavs } from "./nav";
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
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

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

async function open(view: PdfView, options: { password?: string } = {}) {
  pdfHost = fakePdfHost(view);
  const doc = fakeDoc(FILE);
  engine = fakeEngine(doc, options);
  host.current = fakeHost([ITEM], host as never);
  const r = render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
  return { ...r, doc };
}

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
afterEach(cleanup);

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
    const { doc } = await open(pdfView());
    await waitFor(() => expect(pages()[0]).toBe(1));
    expect(pages().length).toBeLessThan(FILE.length);
    expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("1 / 14");
    await waitFor(() => expect(doc.painted).toContain(1));
    expect(document.querySelector('[data-pdf-page="1"]')?.textContent).toContain("Page 1");
    // A file of 14 pages has no thumbnail rail; the mode is the agent's, switchable.
    expect(document.querySelector("[data-pdf-rail]")).toBeNull();
    expect(screen.getByRole("button", { name: /Agent suggests/ })).toBeTruthy();
  });

  it("goes to the next page from the pager", async () => {
    await open(pdfView());
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("2 / 14"));
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
    await waitFor(() => expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByText("1/1")).toBeTruthy());
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
    await waitFor(() => expect(document.querySelector("[data-pdf-find-count]")?.textContent).toBe("1 of 14"));
    expect(document.querySelector('[data-pdf-hit="current"]')).not.toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.querySelector("[data-pdf-find-count]")?.textContent).toBe("2 of 14"));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find" })).toBeNull());
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
    const line = await found('[data-canvas-state="needs"]');
    expect(line.textContent).toContain("Ballroom contract.pdf moved");
    expect(line.textContent).toContain("Read only, as of");
    expect(screen.queryByRole("button", { name: /Agent suggests/ })).toBeNull();
    await waitFor(() => expect(pages()[0]).toBe(1));
  });

  it("shows what the agent wrote directly with its Undo, in the stepper's place", async () => {
    await open(pdfView({ mode: "writes", written: { id: "w1", text: "Filled 5 fields", at: Date.now() } }));
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
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("1 / 300"));
    expect(rail.querySelectorAll("button").length).toBeLessThan(40);
    fireEvent.click(within(rail).getByRole("button", { name: "Page 3" }));
    await waitFor(() => expect(document.querySelector("[data-pdf-pager]")?.textContent).toBe("3 / 300"));
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
    engine = {
      open: async (file) => {
        if (++tries === 1) {
          // pdf.js opened, then a range it needed never came.
          setTimeout(() => file.onFail?.("The host stopped sending this file."), 0);
        }
        return fakeDoc(FILE);
      },
    };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("The host stopped sending this file.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
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
