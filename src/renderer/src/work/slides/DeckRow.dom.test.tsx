// @vitest-environment jsdom
/**
 * The deck's format row as SLD5 grows it, in the real canvas pane
 * (docs/DESIGN.md "The slide editor"): the layout select offering only the
 * layouts that map, shape fill, Arrange, each of Insert's rows (a picture
 * through the attach pieces), Theme, and the view switch.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECK_THEMES, themeEdit } from "@shared/work/deckThemes";
import { openMenus } from "../../chrome/menuRows";
import { chartAt, pictureAt, SAMPLE_CHART, shapeAt, tableAt, textBoxAt } from "./edit/add";
import { BOX, harness, handView } from "./stage.testkit";

const holder = vi.hoisted(() => ({ current: null as never, pushes: new Set<(push: never) => void>(), opens: new Set<() => void>(), toasts: [] as string[] }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => (holder.current as unknown as { link: { request(m: string, p?: unknown): unknown } }).link.request(method, params),
    onPush: (listener: (push: never) => void) => (holder.pushes.add(listener), () => holder.pushes.delete(listener)),
    onOpen: (listener: () => void) => (holder.opens.add(listener), () => holder.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});
vi.mock("./show/Show", () => ({ startShow: async () => ({ end: () => undefined, done: Promise.resolve() }) }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void holder.toasts.push(m), { error: (m: string) => void holder.toasts.push(`error: ${m}`) }),
}));

import { resetCanvasStore } from "../canvas/store";

const t = harness(holder as never);
const SIZE = { width: 12_192_000, height: 6_858_000 };

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  t.reset();
  holder.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

/** The row's control by its name: jsdom measures nothing, so the row has folded it, and its trigger still opens it. */
const ID: Record<string, string> = { Layout: "layout", "Shape fill": "fill", Arrange: "arrange", Insert: "insert", Theme: "theme" };
const control = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-format-row] [data-format-item="${ID[name]}"] button`)!;
/** A row of the menu or popover open now, by its words. */
const row = (name: string | RegExp): Promise<HTMLElement> => screen.findByRole("menuitem", { name });

describe("the layout", () => {
  it("is the slide's, and its menu offers only the layouts whose places hold what the slide holds", async () => {
    await t.stage();
    expect(control("Layout").textContent).toBe("Title and Content");
    fireEvent.click(control("Layout"));
    const offered = await waitFor(() => {
      const rows = screen.getAllByRole("menuitemradio");
      expect(rows.length).toBeGreaterThan(0);
      return rows.map((r) => r.textContent);
    });
    // Title Slide has no body place, Title Only and Blank no place for the slide's body: absent, not greyed.
    expect(offered).toEqual(["Title and Content", "Two Content"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Two Content" }));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "layout", slide: 3, layout: "Two Content" }]]));
  });

  it("with a picture of the layouts, draws each it offers as its thumbnail, three across, the current one marked", async () => {
    await t.stage({ ...handView(), layoutsPic: { rev: "l1", size: 10 } } as never);
    fireEvent.click(control("Layout"));
    const tiles = await waitFor(() => {
      const got = [...document.querySelectorAll<HTMLElement>("[data-layout]")];
      expect(got).toHaveLength(2);
      return got;
    });
    expect(tiles.map((tile) => [tile.dataset.layout, tile.getAttribute("aria-selected")])).toEqual([
      ["Title and Content", "true"],
      ["Two Content", "false"],
    ]);
    expect(tiles[0].querySelector("[data-slide-picture]")).not.toBeNull();
    fireEvent.click(tiles[1]);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "layout", slide: 3, layout: "Two Content" }]]));
  });
});

describe("the shape's own controls", () => {
  it("fill lays a theme colour as the theme's, or none, on the picked shape; it rests with no shape picked", async () => {
    const { press } = await t.stage();
    expect(control("Shape fill").hasAttribute("disabled")).toBe(true);
    press(0.6, 0.6);
    await waitFor(() => expect(control("Shape fill").hasAttribute("disabled")).toBe(false));
    fireEvent.click(control("Shape fill"));
    fireEvent.click(await screen.findByRole("button", { name: "Accent 1" }));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "fill", slide: 3, shape: 5, color: { slot: "accent1" } }]]));
    fireEvent.click(control("Shape fill"));
    fireEvent.click(await screen.findByRole("button", { name: "No fill" }));
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "fill", slide: 3, shape: 5, color: null }]));
  });

  it("Arrange moves the picked shape among the others", async () => {
    const { press } = await t.stage();
    press(0.6, 0.6);
    fireEvent.click(control("Arrange"));
    fireEvent.click(await row("Send to back"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "order", slide: 3, shape: 5, to: "back" }]]));
    // The deck now holds it at the back.
    await waitFor(() => expect(t.host.view.slides[0].shapes[0].id).toBe(BOX.id));
  });
});

describe("Insert", () => {
  const open = async () => {
    fireEvent.click(control("Insert"));
    return row("Text box");
  };

  it("a text box lands in the slide's middle, picked, its box open with its words selected", async () => {
    const { layer } = await t.stage();
    fireEvent.click(await open());
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "text", box: textBoxAt(SIZE), text: "Text" }]]));
    const words = await t.found("[data-slide-typing] [role=textbox]");
    expect(words.textContent).toBe("Text");
    expect(document.getSelection()!.toString()).toBe("Text");
    expect(layer.querySelector('[data-shape="6"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a shape from the short list, each drawn as its own outline", async () => {
    await t.stage();
    await open();
    fireEvent.click(await row("Shape"));
    const oval = await row("Oval");
    expect(oval.querySelector("svg path")).not.toBeNull();
    fireEvent.click(oval);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "shape", box: shapeAt(SIZE, "ellipse"), preset: "ellipse" }]]));
    expect(document.querySelector('[data-shape="6"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a table by its rows and columns on a grid", async () => {
    await t.stage();
    await open();
    fireEvent.click(await row("Table"));
    const cell = await waitFor(() => document.querySelector<HTMLElement>('[data-table-cell="3x4"]')!);
    fireEvent.pointerEnter(cell);
    expect(screen.getByText("3 × 4")).toBeTruthy();
    fireEvent.click(cell);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "table", box: tableAt(SIZE, 3, 4), rows: 3, cols: 4 }]]));
  });

  it("a chart with PowerPoint's own data to start from", async () => {
    await t.stage();
    await open();
    fireEvent.click(await row("Chart"));
    fireEvent.click(await row("Line"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "chart", box: chartAt(SIZE), chart: { type: "line", ...SAMPLE_CHART } }]]));
  });

  it("a picture: read for its proportions, brought in pieces, named by its token, its place shown while it comes", async () => {
    t.measureMedia(async () => ({ width: 1600, height: 900 }));
    const { layer } = await t.stage();
    let land!: () => void;
    t.host.hold = new Promise<void>((done) => (land = done));
    const input = document.querySelector<HTMLInputElement>('[data-slides-insert="picture"]')!;
    const file = new File([new Uint8Array(1234)], "booth.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(t.host.calls).toContainEqual(["attach", { name: "booth.png", size: 1234 }]));
    // While it is on its way, its place on the slide says so.
    await waitFor(() => expect(layer.querySelector("[data-slide-adding]")).not.toBeNull());
    act(() => land());
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "picture", box: pictureAt(SIZE, 1600, 900), file: "token:booth.png" }]]));
    await waitFor(() => expect(layer.querySelector("[data-slide-adding]")).toBeNull());
    expect(layer.querySelector('[data-shape="6"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a video the same way", async () => {
    t.measureMedia(async () => null);
    await t.stage();
    const input = document.querySelector<HTMLInputElement>('[data-slides-insert="video"]')!;
    Object.defineProperty(input, "files", { value: [new File([new Uint8Array(10)], "intro.mp4", { type: "video/mp4" })], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "video", box: pictureAt(SIZE, 0, 0), file: "token:intro.mp4" }]]));
  });

  it("a new slide after the one on the stage, in its layout, goes on the stage", async () => {
    await t.stage();
    await open();
    fireEvent.click(await row("New slide"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "add", after: 3, layout: "Title and Content" }]]));
    await waitFor(() => expect(document.querySelector('[data-slide="6"]')!.getAttribute("aria-current")).toBe("true"));
  });
});

describe("Theme", () => {
  it("lists the themes as their colours and fonts, marks the deck's, and one press gives the deck another", async () => {
    await t.stage({ ...handView(), theme: { colors: { ...DECK_THEMES[0].colours }, major: DECK_THEMES[0].fonts.heading, minor: DECK_THEMES[0].fonts.body } });
    fireEvent.click(control("Theme"));
    const rows = await waitFor(() => {
      const got = [...document.querySelectorAll<HTMLElement>("[data-theme]")];
      expect(got).toHaveLength(DECK_THEMES.length);
      return got;
    });
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[2].textContent).toContain("Cambria and Calibri");
    fireEvent.click(rows[2]);
    await waitFor(() => expect(t.edits()).toEqual([[themeEdit(DECK_THEMES[2])]]));
  });
});

describe("the view switch", () => {
  it("is Slide and Sorter at the row's end, and Sorter puts every slide in a grid", async () => {
    await t.stage();
    const views = within(document.querySelector<HTMLElement>("[data-format-row]")!).getByRole("radiogroup", { name: "View" });
    // In jsdom the row has no width: the switch is its glyphs, each named.
    expect(within(views).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.textContent)).toEqual(["Slide", "Sorter"]);
    fireEvent.click(within(views).getByRole("radio", { name: /Sorter/ }));
    await t.found("[data-slides-sorter]");
    expect(document.querySelector("[data-slides-stage]")).toBeNull();
  });
});
