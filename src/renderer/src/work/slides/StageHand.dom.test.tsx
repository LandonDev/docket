// @vitest-environment jsdom
/**
 * His hand on the stage, in the real canvas pane (docs/agents/work-slides.md
 * "Typing on a slide"): an empty placeholder's prompt and the press that types
 * in it, a double-click that opens the box, and the box drawn at the shape's
 * own size.
 */
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckShape } from "@shared/contract-work-slides";
import { openMenus } from "../../chrome/menuRows";
import { harness, handView, TITLE } from "./stage.testkit";
import { slide, textShape } from "./testkit";

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
