// @vitest-environment jsdom
/**
 * His own hand on a deck, in the real canvas pane (docs/agents/work-slides.md
 * "Typing on a slide"): the typing box's whole life, the format row, the
 * keys, History in the bar and what saved means, with a host that keeps one
 * view and pages of words in place of pdf.js.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckShape, DeckView } from "@shared/contract-work-slides";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef, CanvasSelection, CanvasShell, SavedLine } from "../canvas/kind";
import type { PdfDoc, PdfEngine } from "../pdf/engine";
import { fakeDoc } from "../pdf/testkit";
import { writeSel } from "./edit/dom";
import { FIRST_WORDS } from "./edit/History";
import { deckView, fakeDeckHost, slide, textShape } from "./testkit";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
  toasts: [] as string[],
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
vi.mock("./show/Show", () => ({ startShow: async () => ({ end: () => undefined, done: Promise.resolve() }) }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void host.toasts.push(m), { error: (m: string) => void host.toasts.push(`error: ${m}`) }),
}));

import { CanvasSeat } from "../canvas/CanvasSeat";
import { resetCanvasStore } from "../canvas/store";

const WIDE = { width: 640 * 0.75, height: 360 * 0.75 };
const pageOf = (words: string) => ({ size: WIDE, runs: [{ str: words, box: [0.1, 0.1, 0.9, 0.3] as [number, number, number, number] }] });
/** The file before his edit, then after it. */
let pictures: PdfDoc[] = [];
/** While set, every picture open after the first waits on it: the new picture is still being drawn. */
let gate: Promise<void> | null = null;
let deckHost: ReturnType<typeof fakeDeckHost>;
let item: CanvasItem;
let saved: Array<SavedLine | null> = [];
let selections: Array<CanvasSelection | null> = [];

const TITLE: DeckShape = textShape(
  2,
  [{ level: 0, align: "left", list: "none", runs: [{ text: "Who ", font: "Calibri", size: 40, color: "1F1F1F" }, { text: "comes", font: "Calibri", size: 40, bold: true, color: "1F1F1F" }] }],
  [0.1, 0.1, 0.9, 0.3],
  { label: "Title" },
);
const PICTURE: DeckShape = { id: 4, name: "Picture 3", label: "Picture", kind: "picture", bbox: [0.6, 0.5, 0.9, 0.9], quad: [[0.6, 0.5], [0.9, 0.5], [0.9, 0.9], [0.6, 0.9]], text: "" };

function handView(over: Partial<DeckView> = {}): DeckView {
  return deckView({
    slides: [slide(3, { number: 1, page: 1, shapes: [TITLE, PICTURE] }), slide(5, { number: 2, page: 2 })],
    renders: { file: { rev: "f1", size: 10, pages: 2 }, proposed: null },
    hand: { undo: false, redo: false },
    size: { width: 12_192_000, height: 6_858_000 },
    theme: { colors: { dk1: "000000", lt1: "FFFFFF", accent1: "4472C4" }, major: "Calibri Light", minor: "Calibri" },
    ...over,
  });
}

/** The pane's shell, with what the body says of saving kept for the test. */
const spied = new WeakMap<CanvasShell, CanvasShell>();
function spy(shell: CanvasShell): CanvasShell {
  let got = spied.get(shell);
  if (!got) {
    got = {
      ...shell,
      saved: (line: SavedLine | null) => void saved.push(line),
      selection: (selection: CanvasSelection | null) => {
        selections.push(selection);
        shell.selection(selection);
      },
    };
    spied.set(shell, got);
  }
  return got;
}

function kinds(): Record<string, CanvasKindDef> {
  let opened = 0;
  const engine: PdfEngine = {
    open: async () => {
      const at = opened++;
      if (at > 0 && gate) await gate;
      return pictures[Math.min(at, pictures.length - 1)];
    },
  };
  const module = import("./SlidesCanvas").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} shell={spy(props.shell)} host={deckHost} engine={engine} width={800} height={700} />,
    Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<undefined>)} host={deckHost} engine={engine} />,
    TabEnd: m.TabEnd as never,
  }));
  return { ...CANVAS, slides: { ...CANVAS.slides, chunk: defineChunk(`test-hand-${Math.random()}`, () => module) } };
}

let n = 0;
function open(view: DeckView) {
  item = canvasItem(`hand${++n}`, { kind: "slides", title: "Sponsor deck.pptx", source: { at: "file", host: "local", path: "/work/deck.pptx" } });
  deckHost = fakeDeckHost({ ...view, itemId: item.id });
  host.current = fakeHost([item], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div />
    </CanvasSeat>,
  );
}

const found = (selector: string): Promise<HTMLElement> =>
  waitFor(
    () => {
      const el = document.querySelector<HTMLElement>(selector);
      expect(el).not.toBeNull();
      return el!;
    },
    { timeout: 5000 },
  );

/** The stage given a box, so a press has a place on the slide. */
async function stage(view = handView()) {
  open(view);
  // The stage settled: its picture painted, so the layer a press lands on is the one that stays.
  await waitFor(() => expect(picture()).not.toBe(""), { timeout: 5000 });
  const layer = await found("[data-slides-shapes]");
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
  const press = (x: number, y: number): boolean => fireEvent.click(layer, { clientX: x * 1000, clientY: y * 500 });
  const title = (): HTMLElement => layer.querySelector<HTMLElement>('[data-shape="2"]')!;
  return { layer, press, title };
}

/** Opens the box on the title by a second press, and answers its editable words. */
async function typing() {
  const got = await stage();
  got.press(0.5, 0.2);
  got.press(0.5, 0.2);
  const words = await found("[data-slide-typing] [role=textbox]");
  return { ...got, words };
}

const picture = (): string => document.querySelector("[data-slides-stage] > span > span[aria-hidden]")?.textContent ?? "";
const stateLine = (): string => document.querySelector("[data-canvas-state]")?.textContent ?? "";
const rowItem = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-format-row] [data-format-item="${id}"] button, [data-format-row] [data-format-item="${id}"] input`)!;
const edits = () => deckHost.calls.filter(([name]) => name === "edit").map(([, ops]) => ops);
/** He selects words in the box: the page's selection, then the event the page sends. */
function selectWords(words: HTMLElement, from: [number, number], to: [number, number]): void {
  act(() => {
    writeSel(words, { from, to });
    document.dispatchEvent(new Event("selectionchange"));
  });
}

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  pictures = [fakeDoc([pageOf("Who comes"), pageOf("Slide 2")]), fakeDoc([pageOf("Who comes today"), pageOf("Slide 2")])];
  gate = null;
  saved = [];
  selections = [];
  host.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

describe("typing on a slide", () => {
  it("a second press on a picked text shape opens the box over it in its words and look; Escape puts them back", async () => {
    const { press, title, layer } = await stage();
    press(0.5, 0.2);
    expect(title().getAttribute("aria-pressed")).toBe("true");
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
    press(0.5, 0.2);
    const words = await found("[data-slide-typing] [role=textbox]");
    expect(words.getAttribute("aria-label")).toBe("Title");
    expect(document.activeElement).toBe(words);
    expect(words.textContent).toBe("Who comes");
    const comes = words.querySelector<HTMLElement>('[data-r="0:1"]')!;
    expect(comes.style.fontWeight).toBe("700");
    // 40pt on the stage's width of a 13.33in slide.
    const w = Number.parseFloat(document.querySelector<HTMLElement>("[data-slides-stage]")!.style.width);
    expect(Number.parseFloat(comes.style.fontSize)).toBeCloseTo((40 * 12_700 * w) / 12_192_000, 1);
    // Laid on the shape's own corners, at the stage's scale.
    const box = layer.querySelector<HTMLElement>("[data-slide-typing]")!;
    expect([box.style.left, box.style.top, box.style.width].map((v) => Number.parseFloat(v))).toEqual([0.1 * w, Math.round(w / (16 / 9)) * 0.1, 0.8 * w].map((v) => expect.closeTo(v, 1)));
    // Its outline and handles stay on it.
    expect(layer.querySelector("[data-slide-selection]")).not.toBeNull();
    fireEvent.keyDown(words, { key: "Escape" });
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
    expect(document.activeElement).toBe(title());
    expect(edits()).toEqual([]);
  });

  it("Return on a picked shape opens it with its words selected, F2 with the caret at their end; a picture takes neither", async () => {
    const { title, layer } = await stage();
    act(() => title().focus());
    fireEvent.keyDown(title(), { key: "Enter" });
    const words = await found("[data-slide-typing] [role=textbox]");
    expect(document.getSelection()!.toString()).toBe("Who comes");
    fireEvent.keyDown(words, { key: "Escape" });
    fireEvent.keyDown(title(), { key: "F2" });
    await found("[data-slide-typing]");
    const sel = document.getSelection()!;
    expect(sel.isCollapsed).toBe(true);
    fireEvent.keyDown(document.querySelector("[data-slide-typing] [role=textbox]")!, { key: "Escape" });
    const pic = layer.querySelector<HTMLElement>('[data-shape="4"]')!;
    act(() => pic.focus());
    fireEvent.keyDown(pic, { key: "Enter" });
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
  });

  it("commits one runs edit with a press outside: each run from where it came, only what he set on it", async () => {
    const { words } = await typing();
    const comes = words.querySelector('[data-r="0:1"]')!.firstChild as Text;
    comes.data = "comes today";
    fireEvent.input(words);
    selectWords(words, [0, 10], [0, 15]);
    fireEvent.keyDown(words, { key: "i", code: "KeyI", ctrlKey: true });
    expect(words.querySelector('[data-r="0:2"]')?.textContent).toBe("today");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(edits()).toHaveLength(1));
    expect(edits()[0]).toEqual([
      { op: "runs", slide: 3, shape: 2, was: [["Who ", "comes"]], paragraphs: [{ from: 0, runs: [{ text: "Who ", from: [0, 0] }, { text: "comes ", from: [0, 1] }, { text: "today", from: [0, 1], italic: true }] }] },
    ]);
  });

  it("a press on the shape while his words land opens a new box at once, on the words as they now stand", async () => {
    let paint!: () => void;
    gate = new Promise<void>((done) => (paint = done));
    const { words, layer, press } = await typing();
    (words.querySelector('[data-r="0:1"]')!.firstChild as Text).data = "comes today";
    fireEvent.input(words);
    fireEvent.keyDown(words, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(layer.querySelector("[data-slide-typing]")?.getAttribute("data-phase")).toBe("landing"));
    press(0.5, 0.2);
    const again = await found("[data-slide-typing][data-phase=typing] [role=textbox]");
    expect(again).not.toBe(words);
    expect(document.activeElement).toBe(again);
    expect(again.textContent).toBe("Who comes today");
    act(() => paint());
    // The new box is his now: the picture landing does not take it away.
    await waitFor(() => expect(picture()).toBe("Who comes today"));
    expect(layer.querySelector("[data-slide-typing]")?.getAttribute("data-phase")).toBe("typing");
  });

  it("sends nothing when nothing changed", async () => {
    const { layer } = await typing();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(layer.querySelector("[data-slide-typing]")).toBeNull());
    expect(edits()).toEqual([]);
  });

  it("keeps the old picture and the box, showing his words and taking no pointer, until the new picture paints", async () => {
    let paint!: () => void;
    gate = new Promise<void>((done) => (paint = done));
    const { words, layer } = await typing();
    await waitFor(() => expect(picture()).toBe("Who comes"));
    (words.querySelector('[data-r="0:1"]')!.firstChild as Text).data = "comes today";
    fireEvent.input(words);
    fireEvent.keyDown(words, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(layer.querySelector("[data-slide-typing]")?.getAttribute("data-phase")).toBe("landing"));
    const box = layer.querySelector<HTMLElement>("[data-slide-typing]")!;
    expect(box.className).toContain("pointer-events-none");
    expect(box.textContent).toBe("Who comes today");
    expect(words.getAttribute("contenteditable")).toBe("false");
    // The stage did not blank: the file's old picture is still drawn under the box.
    expect(picture()).toBe("Who comes");
    act(() => paint());
    await waitFor(() => expect(picture()).toBe("Who comes today"));
    await waitFor(() => expect(layer.querySelector("[data-slide-typing]")).toBeNull());
  });

  it("a refused edit keeps the box open with his words and says why on the pane's one state line, with Retry", async () => {
    const { words, layer } = await typing();
    deckHost.refuse = "Nothing was written: the deck could not be read.";
    (words.querySelector('[data-r="0:0"]')!.firstChild as Text).data = "Who now ";
    fireEvent.input(words);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(stateLine()).toContain("Couldn't save your words"));
    expect(stateLine()).toContain("Nothing was written: the deck could not be read.");
    const box = layer.querySelector<HTMLElement>("[data-slide-typing]")!;
    expect(box.getAttribute("data-phase")).toBe("typing");
    expect(box.textContent).toBe("Who now comes");
    deckHost.refuse = null;
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-canvas-state]")!).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(edits()).toHaveLength(2));
    await waitFor(() => expect(stateLine()).toBe(""));
  });

  it("words over a shape that changed under him are a conflict: kept in the box, the line offers Reload, which keeps them over the new words", async () => {
    const { words, layer } = await typing();
    (words.querySelector('[data-r="0:0"]')!.firstChild as Text).data = "Who now ";
    fireEvent.input(words);
    const moved = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who goes", size: 40 }] }], [0.1, 0.1, 0.9, 0.3], { label: "Title" });
    act(() => deckHost.push({ ...deckHost.view, rev: "r2", slides: [slide(3, { number: 1, page: 1, shapes: [moved, PICTURE] }), slide(5, { number: 2, page: 2 })] }));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(stateLine()).toContain("The deck changed while you typed"));
    expect(edits()).toEqual([]);
    expect(layer.querySelector("[data-slide-typing]")!.textContent).toBe("Who now comes");
    expect(saved.at(-1)).toMatchObject({ state: "conflict", detail: "The deck changed while you typed" });
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-canvas-state]")!).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(stateLine()).toBe(""));
    expect(layer.querySelector("[data-slide-typing]")!.textContent).toBe("Who now comes");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(edits()).toHaveLength(1));
    // The first run is still the new words' first run; the second has no run there any more.
    // It names the words it is now put over, so the host writes it only while they are still there.
    expect(edits()[0]).toEqual([{ op: "runs", slide: 3, shape: 2, was: [["Who goes"]], paragraphs: [{ from: 0, runs: [{ text: "Who now ", from: [0, 0] }, { text: "comes" }] }] }]);
  });

  it("Return makes a paragraph, Shift-Return a line break, a paste is plain text, and ⌘Z in the box is the box's own", async () => {
    const { words } = await typing();
    fireEvent.keyDown(words, { key: "Enter" });
    expect(words.querySelectorAll("[data-p]")).toHaveLength(2);
    fireEvent.keyDown(words, { key: "Enter", shiftKey: true });
    expect(words.querySelectorAll("[data-p='1'] br").length).toBeGreaterThan(0);
    fireEvent.keyDown(words, { key: "z", code: "KeyZ", ctrlKey: true });
    fireEvent.keyDown(words, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(words.querySelectorAll("[data-p]")).toHaveLength(1);
    fireEvent.paste(words, { clipboardData: { getData: (type: string) => (type === "text/plain" ? " first\nlast" : "<b>rich</b>") } });
    expect([...words.querySelectorAll("[data-p]")].map((p) => p.textContent)).toEqual(["Who comes first", "last"]);
    expect(words.querySelector("b")).toBeNull();
    // The deck's own Undo was not asked.
    expect(deckHost.calls.some(([name]) => name === "step")).toBe(false);
  });

  it("Shift-Tab goes up to the format row with the box still open, and Escape there takes the keyboard back to his words", async () => {
    const { words, layer } = await typing();
    selectWords(words, [0, 4], [0, 9]);
    fireEvent.keyDown(words, { key: "Tab", shiftKey: true });
    const stop = document.activeElement as HTMLElement;
    expect(stop.closest("[data-format-row]")).not.toBeNull();
    expect(layer.querySelector("[data-slide-typing]")?.getAttribute("data-phase")).toBe("typing");
    fireEvent.keyDown(stop, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(words));
    expect(document.getSelection()!.toString()).toBe("comes");
    expect(edits()).toEqual([]);
  });

  it("a box open when the tab closes commits", async () => {
    const { words } = await typing();
    (words.querySelector('[data-r="0:0"]')!.firstChild as Text).data = "Who else ";
    fireEvent.input(words);
    cleanup();
    await waitFor(() => expect(edits()).toHaveLength(1));
  });

  it("a slide an agent's suggestion changes takes no typing, and the press says why", async () => {
    const { press, layer } = await stage(handView({ slides: [slide(3, { number: 1, page: 1, from: "file", change: "c3", tint: "add", shapes: [TITLE] })], changes: [{ id: "c3", kind: "changed", slideId: 3, label: "Slide 3", edits: [], by: "agent:local:t1" }] }));
    press(0.5, 0.2);
    press(0.5, 0.2);
    await waitFor(() => expect(host.toasts).toContain("error: Accept or reject the suggestion on this slide first"));
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
  });
});

describe("the floating bar", () => {
  it("is anchored under the slide's bottom-left corner, so it lies over no shape, and steps aside while he types", async () => {
    const { press } = await stage();
    const slideBox = { left: 200, top: 100, width: 600, height: 337.5, right: 800, bottom: 437.5, x: 200, y: 100, toJSON: () => ({}) };
    document.querySelector<HTMLElement>("[data-slides-stage]")!.getBoundingClientRect = () => slideBox as DOMRect;
    press(0.5, 0.2);
    const fed = selections.filter((s): s is CanvasSelection => s !== null).at(-1)!;
    expect(fed.chip.label).toBe("“Who comes”, slide 1");
    expect([fed.rect.left, fed.rect.top]).toEqual([200, 437.5 + 42]);
    // The frame lays its 32px bar 6px above its anchor: the bar's top is under the picture.
    expect(fed.rect.top - 6 - 32).toBeGreaterThan(slideBox.bottom);
    press(0.5, 0.2);
    await found("[data-slide-typing]");
    expect(selections.at(-1)).toBeNull();
  });
});

describe("the format row", () => {
  it("is the body's first row where he can edit the deck by hand, with Present at its end and History in the bar", async () => {
    open(handView());
    const row = await found("[data-format-row]");
    expect(within(row).getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    expect(row.parentElement!.firstElementChild).toBe(row);
    expect(row.querySelector('[aria-label="Present"]')).not.toBeNull();
    const bar = await found("[data-canvas-bar]");
    expect(bar.querySelector("[data-present]")).toBeNull();
    expect(within(bar).getByRole("button", { name: "History" })).toBeTruthy();
    expect(document.querySelector("[data-slides]")!.getAttribute("data-editor-keys")).toBe("slides");
  });

  it("is absent, not greyed, where he cannot edit the deck by hand: Present stays in the bar, and there is no History", async () => {
    open(handView({ hand: undefined }));
    await found("[data-slides-stage]");
    expect(document.querySelector("[data-format-row]")).toBeNull();
    const bar = await found("[data-canvas-bar]");
    await waitFor(() => expect(bar.querySelector("[data-present]")).not.toBeNull());
    expect(within(bar).queryByRole("button", { name: "History" })).toBeNull();
    expect(document.querySelector("[data-slides]")!.getAttribute("data-editor-keys")).toBe("read");
  });

  it("rests with nothing to act on; Undo and Redo follow what the host says of his edits", async () => {
    open(handView());
    await found("[data-format-row]");
    expect(rowItem("bold").hasAttribute("disabled") || rowItem("bold").getAttribute("aria-disabled") === "true").toBe(true);
    expect(rowItem("undo").getAttribute("aria-disabled")).toBe("true");
    act(() => deckHost.push({ ...deckHost.view, hand: { undo: true, redo: false } }));
    await waitFor(() => expect(rowItem("undo").getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(rowItem("undo"));
    await waitFor(() => expect(deckHost.calls).toContainEqual(["step", "undo"]));
  });

  it("shows the picked shape's look, mixed where its words differ, and lays a look on the whole shape at once", async () => {
    const { press } = await stage();
    press(0.5, 0.2);
    await waitFor(() => expect(rowItem("size")).toBeTruthy());
    expect((rowItem("size") as HTMLInputElement).value).toBe("40");
    // "Who " is plain and "comes" bold: Bold is not on for the shape.
    expect(rowItem("bold").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(rowItem("italic"));
    await waitFor(() => expect(edits()).toEqual([[{ op: "format", slide: 3, shape: 2, set: { italic: true } }]]));
    // A picture is no text: the row rests again.
    press(0.75, 0.7);
    await waitFor(() => expect(rowItem("bold").getAttribute("aria-pressed")).toBe("false"));
    expect(rowItem("bold").hasAttribute("disabled") || rowItem("bold").getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("in the box it acts on his selection and shows its look", async () => {
    const { words } = await typing();
    selectWords(words, [0, 4], [0, 9]);
    await waitFor(() => expect(rowItem("bold").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(rowItem("underline"));
    expect(words.querySelector('[data-r="0:1"]')!.getAttribute("style")).toContain("underline");
    // Nothing goes to the host until he leaves the box.
    expect(edits()).toEqual([]);
  });

  it("the keys are the editor's while the keyboard is in the deck: ⌘B on the picked shape, ⌘Z the deck's undo", async () => {
    const { press, title } = await stage(handView({ hand: { undo: true, redo: false } }));
    press(0.5, 0.2);
    fireEvent.keyDown(title(), { key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(edits()).toEqual([[{ op: "format", slide: 3, shape: 2, set: { bold: true } }]]));
    fireEvent.keyDown(title(), { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(deckHost.calls).toContainEqual(["step", "undo"]));
  });
});

describe("History", () => {
  it("lists the kept versions newest first, marks the first, and Restore puts one back", async () => {
    open(handView());
    deckHost.kept = [
      { id: "v2", at: Date.now() - 60_000, size: 10, first: false },
      { id: "v1", at: Date.now() - 3_600_000, size: 10, first: true },
    ];
    const bar = await found("[data-canvas-bar]");
    fireEvent.click(within(bar).getByRole("button", { name: "History" }));
    const rows = await waitFor(() => {
      const got = document.querySelectorAll("[data-version]");
      expect(got).toHaveLength(2);
      return [...got] as HTMLElement[];
    });
    expect(rows.map((r) => r.dataset.version)).toEqual(["v2", "v1"]);
    expect(rows[1].textContent).toContain(FIRST_WORDS);
    expect(rows[0].textContent).not.toContain(FIRST_WORDS);
    fireEvent.click(within(rows[1]).getByRole("button", { name: /^Restore/ }));
    await waitFor(() => expect(deckHost.calls).toContainEqual(["restore", "v1"]));
    await waitFor(() => expect(document.querySelector("[data-version]")).toBeNull());
  });

  it("shows its loading rows while the versions come, and says when there are none", async () => {
    open(handView());
    let answer!: () => void;
    deckHost.hold = new Promise<void>((done) => (answer = done));
    const bar = await found("[data-canvas-bar]");
    fireEvent.click(within(bar).getByRole("button", { name: "History" }));
    await found("[data-slides-history-loading]");
    act(() => answer());
    expect(await screen.findByText("No versions yet")).toBeTruthy();
  });
});

describe("what saved means", () => {
  it("says saving while his edit is on its way and saved with the time after", async () => {
    const { words } = await typing();
    await waitFor(() => expect(saved.at(-1)).toEqual({ state: "saved" }));
    let write!: () => void;
    deckHost.hold = new Promise<void>((done) => (write = done));
    (words.querySelector('[data-r="0:0"]')!.firstChild as Text).data = "Who now ";
    fireEvent.input(words);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(saved.at(-1)).toEqual({ state: "saving" }));
    act(() => write());
    await waitFor(() => expect(saved.at(-1)).toMatchObject({ state: "saved", at: expect.any(Number) }));
  });
});
