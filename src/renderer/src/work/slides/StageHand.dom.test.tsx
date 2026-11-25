// @vitest-environment jsdom
/**
 * His hand on the stage, in the real canvas pane (docs/agents/work-slides.md
 * "Typing on a slide"): an empty placeholder's prompt and the press that types
 * in it, a double-click that opens the box, and the box drawn at the shape's
 * own size, the pointer's cue for moving, sizing and turning a shape, the
 * notes he types, and the stage's Fit and zoom.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { openMenus } from "../../chrome/menuRows";
import { resizeCursor } from "./edit/Manipulate";
import { harness, handView, TITLE } from "./stage.testkit";
import { boxShape, slide, textShape } from "./testkit";

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

/** A blank deck's empty title, as the host reads it: no runs, the look its words will take, and its prompt. */
const EMPTY_TITLE: DeckShape = textShape(2, [{ level: 0, align: "center", list: "none", runs: [], end: { font: "Calibri Light", size: 44, color: "1F1F1F" } }], [0.1, 0.2, 0.9, 0.5], {
  label: "Title",
  prompt: "Click to add title",
  frame: { anchor: "middle", insets: [91440, 45720, 91440, 45720], fit: "shrink", wrap: true },
});
const blank = (over: Partial<ReturnType<typeof handView>> = {}) => handView({ slides: [slide(3, { number: 1, page: 1, title: "", shapes: [EMPTY_TITLE] }), slide(5, { number: 2, page: 2 })], ...over });

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

describe("a table", () => {
  const TABLE: DeckShape = boxShape(9, [0.1, 0.5, 0.5, 0.9], { kind: "table", label: "Table", cells: [["Team", "Seats"], ["Gold", "12"]] });

  it("a second press types in the cell pressed, in its words; Escape writes them to that cell", async () => {
    const { layer, press, shape } = await t.stage(handView({ slides: [slide(3, { number: 1, page: 1, shapes: [TITLE, TABLE] }), slide(5, { number: 2, page: 2 })] }));
    press(0.4, 0.8);
    expect(shape(9).getAttribute("aria-pressed")).toBe("true");
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
    press(0.4, 0.8);
    const words = await t.found("[data-slide-typing] [role=textbox]");
    expect(words.getAttribute("aria-label")).toBe("Row 2, column 2");
    expect(words.textContent).toBe("12");
    (words.querySelector('[data-r="0:0"]')!.firstChild as Text).data = "14";
    fireEvent.input(words);
    fireEvent.keyDown(words, { key: "Escape" });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
    expect(t.edits()[0]).toEqual([expect.objectContaining({ op: "runs", shape: 9, row: 1, col: 1 })]);
  });
});

describe("an empty placeholder", () => {
  it("shows its prompt in the look its words will take, and one press types in it; the prompt goes while the box is open", async () => {
    const { layer, press } = await t.stage(blank());
    const prompt = layer.querySelector<HTMLElement>("[data-slide-prompt]")!;
    expect(prompt.textContent).toBe("Click to add title");
    expect(prompt.getAttribute("aria-hidden")).toBe("true");
    expect(prompt.style.justifyContent).toBe("center");
    const words = prompt.firstElementChild as HTMLElement;
    expect(words.style.textAlign).toBe("center");
    expect(words.style.fontFamily).toContain("Calibri Light");
    expect(words.style.color).toBe("rgb(31, 31, 31)");
    press(0.5, 0.3);
    const box = await t.found("[data-slide-typing] [role=textbox]");
    expect(box.getAttribute("aria-label")).toBe("Title");
    // The box draws in the placeholder's look, not the deck's body size.
    expect((box.querySelector("[data-p]") as HTMLElement).style.fontSize).toBe(words.style.fontSize);
    expect(layer.querySelector("[data-slide-prompt]")).toBeNull();
  });

  it("in a shape that shrinks its words to fit, shrinks them as he types past its bottom", async () => {
    const { press } = await t.stage(blank());
    press(0.5, 0.3);
    const words = await t.found("[data-slide-typing] [role=textbox]");
    const shape = words.parentElement!;
    // The shape is 100px tall inside; the words take 150px at their own size, and less as they are drawn smaller.
    Object.defineProperty(shape, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(shape, "scrollHeight", { configurable: true, get: () => 150 * Number(words.style.zoom || 1) });
    (words.querySelector("[data-p]") as HTMLElement).textContent = "A title long enough to run past the shape";
    fireEvent.input(words);
    await waitFor(() => expect(Number(words.style.zoom)).toBeGreaterThan(0.6));
    expect(Number(words.style.zoom)).toBeLessThan(0.68);
    // Back within the shape, the words are their own size again.
    Object.defineProperty(shape, "scrollHeight", { configurable: true, get: () => 80 });
    (words.querySelector("[data-p]") as HTMLElement).textContent = "Short";
    fireEvent.input(words);
    await waitFor(() => expect(words.style.zoom).toBe(""));
  });

  it("shows no prompt where he cannot type: a deck he cannot edit by hand", async () => {
    const { layer } = await t.stage(blank({ hand: undefined }));
    expect(layer.querySelector("[data-shape='2']")).not.toBeNull();
    expect(layer.querySelector("[data-slide-prompt]")).toBeNull();
  });
});

describe("a double-click", () => {
  it("opens the typing box on a text shape that was not picked", async () => {
    const { layer, shape } = await t.stage();
    expect(shape(2).getAttribute("aria-pressed")).toBe("false");
    fireEvent.doubleClick(layer, { clientX: 500, clientY: 100 });
    const box = await t.found("[data-slide-typing] [role=textbox]");
    expect(box.textContent).toBe("Who comes");
    expect(shape(2).getAttribute("aria-pressed")).toBe("true");
  });

  it("does nothing on a shape with no words to type", async () => {
    const { layer } = await t.stage();
    fireEvent.doubleClick(layer, { clientX: 200, clientY: 350 });
    await new Promise((r) => setTimeout(r, 20));
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
  });
});

describe("the typing box's size", () => {
  it("is the shape's own height, so overflowing words lie as the picture will draw them; a shape that grows to its words grows", async () => {
    const { press, drawn } = await t.stage();
    press(0.5, 0.2);
    press(0.5, 0.2);
    const box = (await t.found("[data-slide-typing]")) as HTMLElement;
    const { h } = drawn();
    // TITLE lies from 10% to 30% of the slide's height.
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(h * 0.2, 0);
    expect(box.style.minHeight).toBe("");
    cleanup();
    resetCanvasStore();
    t.reset();
    const grows = { ...TITLE, frame: { ...TITLE.frame!, fit: "grow" as const } };
    const again = await t.stage(handView({ slides: [slide(3, { number: 1, page: 1, shapes: [grows] }), slide(5, { number: 2, page: 2 })] }));
    again.press(0.5, 0.2);
    again.press(0.5, 0.2);
    const growing = (await t.found("[data-slide-typing]")) as HTMLElement;
    await waitFor(() => expect(growing.style.minHeight).not.toBe(""));
    expect(growing.style.height).toBe("");
  });
});

describe("the pointer's cue", () => {
  it("names each handle's way, turned and mirrored with the shape", () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => resizeCursor(square, i))).toEqual(["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"]);
    // A wide shape's corner still points along its diagonal's way in its own axes.
    const wide = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 10 }];
    expect(resizeCursor(wide, 4)).toBe("nwse-resize");
    // Turned a quarter: its top edge stands upright, so the top handle sizes across.
    const turned = [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }];
    expect(resizeCursor(turned, 1)).toBe("ew-resize");
    // Turned an eighth: the side handles take the corners' cursors.
    const r = Math.SQRT1_2 * 10;
    const eighth = [{ x: 0, y: 0 }, { x: r, y: r }, { x: 0, y: 2 * r }, { x: -r, y: r }];
    expect(resizeCursor(eighth, 3)).toBe("nwse-resize");
    // Mirrored across: its own top-left handle is drawn at the top right, and points that way.
    const mirrored = [{ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }];
    expect(resizeCursor(mirrored, 0)).toBe("nesw-resize");
    expect(resizeCursor(mirrored, 2)).toBe("nwse-resize");
  });

  it("is move over a shape he can move, a handle's way on a handle, grab on the turn handle and grabbing while it turns", async () => {
    const { layer, press, drawn } = await t.stage();
    const at = (x: number, y: number): string => {
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: x, clientY: y });
      return layer.style.cursor;
    };
    // The box (0.5 to 0.7 of the slide) can be moved before it is picked; the bare slide has no cue.
    expect(at(600, 300)).toBe("move");
    expect(at(950, 450)).toBe("");
    press(0.6, 0.6);
    expect(at(700, 350)).toBe("nwse-resize");
    expect(at(600, 250)).toBe("ns-resize");
    expect(at(500, 300)).toBe("ew-resize");
    const up = 22 * (500 / drawn().h);
    expect(at(600, 250 - up)).toBe("grab");
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 600, clientY: 250 - up });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 200 });
    expect(at(700, 200)).toBe("grabbing");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 200 });
    expect(at(600, 300)).toBe("move");
  });

  it("gives no cue where his hand cannot move a shape: a deck he cannot edit", async () => {
    const { layer } = await t.stage(handView({ hand: undefined }));
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(layer.style.cursor).toBe("");
  });
});

describe("notes he types", () => {
  it("are a field under the stage, empty or not, whose words go into the file when he leaves it", async () => {
    await t.stage();
    const field = (await t.found("[data-slide-notes-field]")) as HTMLTextAreaElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Add notes");
    expect(document.querySelector("[data-slide-notes] label")!.textContent).toBe("Notes");
    field.focus();
    fireEvent.change(field, { target: { value: "Open with the turnout." } });
    expect(t.edits()).toEqual([]);
    fireEvent.blur(field);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "notes", slide: 3, text: "Open with the turnout.", was: "" }]]));
  });

  it("Escape keeps his words and gives the keyboard back to the slide", async () => {
    const { layer } = await t.stage(handView({ slides: [slide(3, { number: 1, page: 1, notes: "Say hello", shapes: [TITLE] }), slide(5, { number: 2, page: 2 })] }));
    const field = (await t.found("[data-slide-notes-field]")) as HTMLTextAreaElement;
    expect(field.value).toBe("Say hello");
    field.focus();
    fireEvent.change(field, { target: { value: "Say hello, then the plan" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "notes", slide: 3, text: "Say hello, then the plan", was: "Say hello" }]]));
    expect(document.activeElement).toBe(layer);
  });

  it("too long for the outline to carry whole are words he cannot type in, said once, so a key never saves them cut", async () => {
    const long = "x".repeat(20_000);
    await t.stage(handView({ slides: [slide(3, { number: 1, page: 1, notes: long, shapes: [TITLE] }), slide(5, { number: 2, page: 2 })] }));
    await t.found("[data-slides-stage]");
    expect(document.querySelector("[data-slide-notes-field]")).toBeNull();
    expect(document.querySelector("[data-slide-notes] p")!.textContent).toBe(long);
    expect(document.querySelector("[data-slide-notes]")!.textContent).toContain("Too long to edit here");
  });

  it("are read only where his hand cannot change the slide: a deck he cannot edit draws them as words, and none when there are none", async () => {
    await t.stage(handView({ hand: undefined, slides: [slide(3, { number: 1, page: 1, notes: "Say hello", shapes: [TITLE] }), slide(5, { number: 2, page: 2 })] }));
    expect(document.querySelector("[data-slide-notes-field]")).toBeNull();
    expect(document.querySelector("[data-slide-notes] p")!.textContent).toBe("Say hello");
    cleanup();
    resetCanvasStore();
    t.reset();
    await t.stage(handView({ hand: undefined }));
    expect(document.querySelector("[data-slide-notes]")).toBeNull();
  });
});

describe("the stage's size", () => {
  const width = (): number => Number.parseFloat(document.querySelector<HTMLElement>("[data-slides-stage]")!.style.width);

  it("fills the pane at Fit, the notes still starting on screen; a zoom from the bar sets the slide's own size and scrolls", async () => {
    await t.stage(handView(), { width: 1600, height: 900 });
    // The pane less the strip and the band's inset, short enough that 150px of the notes show under it.
    expect(width()).toBe(Math.floor(Math.min(1600 - 140 - 32, (900 - 150) * (16 / 9))));
    const zoom = await t.found("[data-slides-zoom]");
    expect(zoom.textContent).toBe("Fit");
    fireEvent.click(zoom);
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "150%" }));
    await waitFor(() => expect(width()).toBe(1920));
    expect(document.querySelector("[data-slides-main]")!.className).toContain("overflow-x-auto");
    expect((await t.found("[data-slides-zoom]")).textContent).toBe("150%");
    fireEvent.click(await t.found("[data-slides-zoom]"));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Fit" }));
    await waitFor(() => expect(width()).toBe(1333));
  });
});
