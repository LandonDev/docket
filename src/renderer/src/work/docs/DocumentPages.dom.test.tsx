// @vitest-environment jsdom
/**
 * Pages in the document pane (docs/DESIGN.md "Work editors: Document pages";
 * docs/agents/work-docs.md "Pages"): which view and zoom an item opens in,
 * his own pick kept per item, "Page 2 of 5" in the kind's bar, the sheets
 * handed to Print and the PDF preview, and Preview's Page rows writing the
 * document's own set-up. The editor and the frame are stand-ins that keep
 * the props they are given: each has its own test.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLES, defaultSetup, type DocumentPage } from "work-kit/editor/page";
import { TEMPCODE_THEME } from "work-kit/format/theme";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, MoreEntry } from "../canvas/kind";
import { MARGIN_PRESETS, type PreviewSource } from "../formats/preview";
import type { DocState } from "./DocumentCanvas";

const FILE = { at: "file", host: "box", path: "/w/Run of show.tcdoc" } as const;
const PAGE = { schema: 1, styles: Object.fromEntries(DEFAULT_STYLES.map((style) => [style.name, style])), theme: TEMPCODE_THEME, setup: { ...defaultSetup(), header: true }, header: { start: [], center: [], end: [] }, footer: { start: [], center: [], end: [] } } as DocumentPage;

const canvas = vi.hoisted(() => ({ width: 1000 }));
const opened = vi.hoisted(() => ({ role: "edit" as "edit" | "view", page: null as unknown, props: [] as Record<string, unknown>[] }));
const calls = vi.hoisted(() => [] as { method: string; params: Record<string, unknown> }[]);

vi.mock("./host", () => ({
  docHost: (env: string) => ({
    env,
    open: async () => ({ doc: "file:abc", source: { at: "file", host: "box", path: "/w/Run of show.tcdoc" }, title: "Run of show", role: opened.role, shared: false, mode: "writes", written: null, me: "owner", names: { owner: "You" }, schema: 2 }),
    token: async () => ({ token: "t", expiresAt: 0 }),
    threads: async () => ({ rows: [], names: {} }),
    onPush: () => () => undefined,
    socket: class {},
  }),
  servedBy: () => null,
}));
vi.mock("../../lib/connection", () => ({
  registry: {
    onLink: () => () => undefined,
    linkOf: () => ({
      onPush: () => () => undefined,
      // The host, standing in: it prints the page it is handed and keeps what it was asked.
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "work.formats.preview") return { rev: "0".repeat(32), size: 8, pages: 2, drawnBy: "tempcode", name: "Run of show.pdf", warnings: [] };
        if (method === "work.formats.previewRead") return { data: btoa("%PDF-1.7") };
        return { branches: [], names: {} };
      },
    }),
  },
}));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: () => undefined }) }));
vi.mock("../guests/Share", () => ({ ShareButton: () => <button type="button">Share</button> }));
vi.mock("../formats/fonts", async (original) => ({ ...(await original<typeof import("../formats/fonts")>()), printFonts: async () => ({ faces: "@font-face{font-family:Carlito}", body: "Calibri" }) }));
vi.mock("work-kit/editor", async (original) => {
  const { useEffect } = await import("react");
  return {
    ...(await original<typeof import("work-kit/editor")>()),
    // The shared editor, standing in: it says the document's page, then hands over an editor, as the real one does once the document is read.
    DocumentEditor: (props: { onEditor?(editor: unknown): void; onPage?(page: unknown): void } & Record<string, unknown>) => {
      const { onEditor, onPage } = props;
      opened.props.push(props);
      useEffect(() => {
        onPage?.(opened.page);
        onEditor?.({ document: [], domElement: document.createElement("div"), focus: () => undefined, onChange: () => () => undefined, prosemirrorState: { doc: { firstChild: null } }, blocksToHTMLLossy: async () => "<p>the text in its column</p>" });
        return () => onEditor?.(null);
      }, [onEditor, onPage]);
      return <div data-fake-editor tabIndex={0} />;
    },
  };
});
const previews = vi.hoisted(() => [] as { source: unknown }[]);
vi.mock("../formats/PreviewFrame", () => ({
  Preview: (props: { source: unknown }) => {
    previews.push({ source: props.source });
    return <div data-fake-preview />;
  },
}));

const { Body, Bar, openingView, openingZoom, pagesSettled, PAGES_FROM, TRUE_SIZE_FROM } = await import("./DocumentCanvas");

// The canvas's width, as the pane measures it.
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => canvas.width }));

afterEach(() => {
  cleanup();
  canvas.width = 1000;
  opened.role = "edit";
  opened.page = null;
  opened.props.length = 0;
  previews.length = 0;
  calls.length = 0;
});

const ITEM = { id: "d1", sessionId: "t1", kind: "document", title: "Run of show", source: FILE } as CanvasItem;
const given = (): Record<string, unknown> => opened.props.at(-1)!;

/** The item as the canvas holds it: its bar over its body, and its state kept between them. */
async function mount({ width = 1000, styled = true, state: initial }: { width?: number; styled?: boolean; state?: DocState } = {}) {
  canvas.width = width;
  opened.page = styled ? PAGE : null;
  const states: (DocState | undefined)[] = [];
  let more: MoreEntry[] = [];
  const shell = { statusLine: () => {}, ready: () => {}, more: (rows: MoreEntry[] | null) => void (more = rows ?? []), mode: () => {}, written: () => {}, review: () => {}, presence: () => {}, ask: () => {} } as unknown as CanvasShell;
  function Item() {
    const [state, setState] = useState<DocState | undefined>(initial);
    states.push(state);
    const props = { item: ITEM, source: FILE, env: "box", state, setState, shell };
    return (
      <>
        <div data-bar>
          <Bar {...props} />
        </div>
        <Body {...props} />
      </>
    );
  }
  const view = render(<Item />);
  await waitFor(() => expect(view.container.querySelector("[data-fake-editor]")).not.toBeNull());
  await waitFor(() => expect(more.some((row) => row.id === "export")).toBe(true));
  return { ...view, state: () => states.at(-1), more: () => more };
}

const fact = (): string | null => document.querySelector("[data-bar] [data-doc-page]")?.textContent ?? null;

describe("the view a document opens in", () => {
  it("a styled document opens in Pages on a canvas of 640px and in Flow on one of 639px", async () => {
    expect([PAGES_FROM, openingView(639), openingView(640)]).toEqual([640, "flow", "pages"]);
    await mount({ width: 640 });
    expect(given().view).toBe("pages");
    cleanup();
    opened.props.length = 0;
    await mount({ width: 639 });
    expect(given().view).toBe("flow");
    // Every draw of it was Flow: it never stood in Pages for a frame.
    expect(opened.props.every((props) => props.view === "flow")).toBe(true);
  });

  it("a classic document is Flow at any width, and stays in Flow when he styles it", async () => {
    await mount({ width: 1400, styled: false });
    await waitFor(() => expect(given().view).toBe("flow"));
    // His first font or colour makes it a styled document: the text does not jump onto sheets under his hands.
    await act(async () => (given().onPage as (page: unknown) => void)(PAGE));
    expect(given().view).toBe("flow");
    expect(fact()).toBeNull();
  });

  it("his own switch is kept in the item's state and wins over the width from then on", async () => {
    const wide = await mount({ width: 1000 });
    expect(given().view).toBe("pages");
    await act(async () => (given().onView as (view: string) => void)("flow"));
    expect(wide.state()).toMatchObject({ view: "flow" });
    expect(given().view).toBe("flow");
    cleanup();
    // The item again, beside a thread this time: Pages, as he left it, though the canvas is under 640px.
    await mount({ width: 500, state: { view: "pages" } });
    expect(given().view).toBe("pages");
    cleanup();
    await mount({ width: 1400, state: { view: "flow" } });
    expect(given().view).toBe("flow");
  });

  it("Pages opens at true size where a sheet fits at it and fitted to the width where it does not; his own zoom is kept", async () => {
    expect([TRUE_SIZE_FROM, openingZoom(863), openingZoom(864)]).toEqual([864, "width", 100]);
    await mount({ width: 700 });
    expect(given().zoom).toBe("width");
    cleanup();
    const wide = await mount({ width: 1400 });
    expect(given().zoom).toBe(100);
    await act(async () => (given().onZoom as (zoom: unknown) => void)("page"));
    expect(wide.state()).toMatchObject({ zoom: "page" });
    expect(given().zoom).toBe("page");
    cleanup();
    await mount({ width: 1400, state: { zoom: 150 } });
    expect(given().zoom).toBe(150);
  });

  it("a scroll, his switch and his zoom each keep what the others set", async () => {
    const view = await mount();
    await act(async () => (given().onView as (view: string) => void)("flow"));
    await act(async () => (given().onZoom as (zoom: unknown) => void)(125));
    const scroller = document.querySelector<HTMLElement>("[data-doc-scroller]")!;
    scroller.scrollTop = 420;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(view.state()).toEqual({ view: "flow", zoom: 125, scrollTop: 420 }));
  });

  it("the editor is told the file's name and the reader's locale, for a header's fields and Page set-up's lengths", async () => {
    await mount();
    expect(given()).toMatchObject({ title: "Run of show", locale: navigator.language });
  });
});

describe("the pane around the sheets", () => {
  it("gives the stage the scroller edge to edge and the column's whole width wherever the editor draws sheets", async () => {
    await mount();
    // Said in CSS on what the editor draws, so the frame that draws the sheets is the frame that makes room.
    const scroller = document.querySelector<HTMLElement>("[data-doc-scroller]")!;
    expect(scroller.className).toContain("has-[.te-pages-stage]:p-0");
    expect(scroller.className).toContain("has-[.te-pages-stage]:bg-(--stage)");
    const column = document.querySelector<HTMLElement>("[data-editor-keys='document'].group\\/doc")!;
    expect(column.className).toContain("has-[.te-pages-stage]:max-w-none");
    expect(document.querySelector("[data-fake-editor]")!.parentElement!.className).toContain("group-has-[.te-pages-stage]/doc:px-0");
  });

  it("comments open at their words in Pages and stand in the margin in Flow", async () => {
    await mount({ width: 1400 });
    await waitFor(() => expect(given().threadMargin).toBeUndefined());
    await act(async () => (given().onView as (view: string) => void)("flow"));
    expect(given().threadMargin).toBe("side");
  });
});

describe("Page 2 of 5 in the kind's bar", () => {
  it("says the sheet he is on as the editor tells it, and follows him", async () => {
    await mount();
    expect(fact()).toBeNull();
    await act(async () => (given().onPages as (at: unknown) => void)({ page: 2, count: 5 }));
    expect(fact()).toBe("Page 2 of 5");
    expect(screen.getAllByText("Page 2 of 5")).toHaveLength(1);
    await act(async () => (given().onPages as (at: unknown) => void)({ page: 5, count: 5 }));
    expect(fact()).toBe("Page 5 of 5");
    // One muted tabular fact, at the tools' end, that goes whole in a narrow bar.
    const el = document.querySelector<HTMLElement>("[data-doc-page]")!;
    expect(el.className).toContain("tabular-nums");
    expect(el.className).toContain("text-muted-foreground");
    expect(el.hasAttribute("data-narrow-hide")).toBe(true);
  });

  it("is gone in Flow, and when the document goes", async () => {
    const view = await mount();
    await act(async () => (given().onPages as (at: unknown) => void)({ page: 2, count: 5 }));
    expect(fact()).toBe("Page 2 of 5");
    await act(async () => (given().onView as (view: string) => void)("flow"));
    expect(fact()).toBeNull();
    await act(async () => (given().onView as (view: string) => void)("pages"));
    await act(async () => (given().onPages as (at: unknown) => void)({ page: 1, count: 4 }));
    expect(fact()).toBe("Page 1 of 4");
    view.unmount();
    render(
      <div data-bar>
        <Bar item={ITEM} source={FILE} env="box" state={undefined} setState={() => {}} shell={{} as CanvasShell} />
      </div>,
    );
    expect(fact()).toBeNull();
  });
});

describe("one print contract", () => {
  const sheets = "<!doctype html><html><body><div class=\"te-pages-stage\">the sheets</div></body></html>";
  const handle = (over: Record<string, unknown> = {}) => ({ scrollToPage: () => true, openPageSetup: () => undefined, setSetup: vi.fn(() => true), pagesHtml: vi.fn((): string | null => sheets), ...over });
  const preview = async (view: Awaited<ReturnType<typeof mount>>): Promise<PreviewSource> => {
    await act(async () => view.more().find((row) => row.id === "export")!.run());
    return previews.at(-1)!.source as PreviewSource;
  };
  const printed = (): string => String(calls.filter((call) => call.method === "work.formats.preview").at(-1)!.params.html);

  it("Print and the PDF preview are the sheets he sees: the editor's own page, with the faces inlined", async () => {
    const view = await mount();
    const pages = handle();
    await act(async () => (given().onDocumentHandle as (handle: unknown) => void)(pages));
    const source = await preview(view);
    await source.draw("pdf", { signal: new AbortController().signal });
    expect(pages.pagesHtml).toHaveBeenLastCalledWith({ title: "Run of show", faces: "@font-face{font-family:Carlito}" });
    expect(printed()).toBe(sheets);
    await source.draw("print", { signal: new AbortController().signal });
    expect(printed()).toBe(sheets);
    expect(pages.pagesHtml).toHaveBeenCalledTimes(2);
  });

  it("in Flow the editor answers no page, and the page written from the blocks goes as before", async () => {
    const view = await mount({ width: 500 });
    const pages = handle({ pagesHtml: vi.fn(() => null) });
    await act(async () => (given().onDocumentHandle as (handle: unknown) => void)(pages));
    const source = await preview(view);
    await source.draw("pdf", { signal: new AbortController().signal });
    expect(pages.pagesHtml).toHaveBeenCalledTimes(1);
    expect(printed()).toContain("the text in its column");
    expect(printed()).not.toContain("the sheets");
  });

  it("Preview's Page rows read the document's own set-up and write it back through the editor", async () => {
    const view = await mount();
    const pages = handle();
    await act(async () => (given().onDocumentHandle as (handle: unknown) => void)(pages));
    const source = await preview(view);
    const setup = source.setup!;
    expect(setup).toMatchObject({ kind: "document", columns: 1, differentFirst: false, common: { paper: "Letter", orientation: "portrait", margins: MARGIN_PRESETS.Normal, header: true, footer: false } });
    // Tabloid is no paper of a document's.
    expect(setup.common.papers).toEqual(["Letter", "A4", "Legal", "A3", "A5"]);
    await setup.set({ common: { ...setup.common, paper: "A4", orientation: "landscape", margins: { ...MARGIN_PRESETS.Narrow } } });
    expect(pages.setSetup).toHaveBeenLastCalledWith({ paper: "A4", orientation: "landscape", margins: MARGIN_PRESETS.Narrow, header: true, footer: false });
    // The document's page as the editor then says it is what Preview reads next.
    await act(async () => (given().onPage as (page: unknown) => void)({ ...PAGE, setup: { ...PAGE.setup, paper: "A4", orientation: "landscape", margins: { ...MARGIN_PRESETS.Narrow } } }));
    expect(source.setup!.common).toMatchObject({ paper: "A4", orientation: "landscape", margins: MARGIN_PRESETS.Narrow });
  });

  it("under Preview the editor draws the document alone: find is closed and no change in review is drawn, so the sheets printed carry neither", async () => {
    const view = await mount();
    const closed = vi.fn();
    await act(async () => (given().onFind as (handle: unknown) => void)({ open: () => undefined, close: closed }));
    expect(given().review).not.toBeNull();
    await preview(view);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(given().review).toBeNull();
  });

  it("a print waits until the sheets have gone three frames without laying out again, and a second at most", async () => {
    const scope = document.createElement("div");
    const frame = scope.appendChild(Object.assign(document.createElement("div"), { className: "te-pages" }));
    let frames = 0;
    let moving = 4;
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((run) => {
      // The editor counts each layout on its frame (`data-settles`): four more of them, then it is still.
      if (++frames <= moving) frame.dataset.settles = String(frames);
      queueMicrotask(() => run(0));
      return 0;
    });
    await pagesSettled(scope);
    expect(frames).toBe(7);
    // Sheets that never come to rest do not hold a print for ever.
    frames = 0;
    moving = Number.POSITIVE_INFINITY;
    const start = performance.now();
    await pagesSettled(scope, 3, 30);
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
    expect(frames).toBeGreaterThan(3);
    raf.mockRestore();
  });

  it("a reader prints the sheets and has no Page rows; a classic document has neither", async () => {
    opened.role = "view";
    const reader = await mount();
    const pages = handle();
    await act(async () => (given().onDocumentHandle as (handle: unknown) => void)(pages));
    const source = await preview(reader);
    expect(source.setup).toBeUndefined();
    await source.draw("pdf", { signal: new AbortController().signal });
    expect(printed()).toBe(sheets);
    expect(pages.setSetup).not.toHaveBeenCalled();
    cleanup();
    opened.role = "edit";
    const classic = await preview(await mount({ styled: false }));
    expect(classic.setup).toBeUndefined();
  });
});
