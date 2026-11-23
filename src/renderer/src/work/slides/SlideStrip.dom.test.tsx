// @vitest-environment jsdom
/**
 * His hand on the deck's slides, in the real canvas pane (docs/agents/work-slides.md
 * "Slides by hand"): the slide's menu in the strip and the Sorter, reorder by
 * drag in both, Delete, a hidden slide marked, sections, and the Sorter's
 * press back to the stage.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "@shared/contract-work-slides";
import { openMenus } from "../../chrome/menuRows";
import { dropIndex } from "./Sorter";
import { harness, handView } from "./stage.testkit";
import { slide } from "./testkit";

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
// A glide lands at once.
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  animate: (_from: number, to: number, options: { onUpdate?: (v: number) => void; onComplete?: () => void }) => {
    options.onUpdate?.(to);
    options.onComplete?.();
    return { stop: () => undefined };
  },
}));

import { resetCanvasStore } from "../canvas/store";

const t = harness(holder as never);
HTMLElement.prototype.setPointerCapture ??= () => undefined;
HTMLElement.prototype.releasePointerCapture ??= () => undefined;

/** Four slides, the third hidden, two sections. */
function deck(): DeckView {
  const view = handView();
  return {
    ...view,
    slides: [
      { ...view.slides[0], section: "Intro" },
      view.slides[1],
      slide(7, { number: 3, page: 3, hidden: true, layout: "Title and Content", section: "Numbers" }),
      slide(9, { number: 4, page: 4, layout: "Title and Content" }),
    ],
  };
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
  t.reset();
  holder.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const thumb = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-slides-strip] [data-slide="${key}"]`)!;
const menu = async (el: HTMLElement): Promise<HTMLElement> => {
  fireEvent.contextMenu(el);
  return screen.findByRole("menu");
};
const item = (name: string | RegExp) => screen.findByRole("menuitem", { name });

describe("the strip", () => {
  it("marks a hidden slide, and its menu shows it again", async () => {
    await t.stage(deck());
    expect(thumb("7").getAttribute("data-hidden")).toBe("true");
    expect(thumb("7").getAttribute("aria-label")).toBe("Slide 3, hidden: Slide 7");
    expect(thumb("7").querySelector(".opacity-45")).not.toBeNull();
    await menu(thumb("7"));
    fireEvent.click(await item("Show slide"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "hide", slide: 7, hidden: false }]]));
    await waitFor(() => expect(thumb("7").hasAttribute("data-hidden")).toBe(false));
  });

  it("a slide's menu: duplicate goes to the copy, a new slide after in a layout, the layouts that map", async () => {
    await t.stage(deck());
    await menu(thumb("3"));
    fireEvent.click(await item("Duplicate"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "duplicate", slide: 3 }]]));
    await waitFor(() => expect(thumb("10")?.getAttribute("aria-current")).toBe("true"));
    const rows = await menu(thumb("5"));
    fireEvent.click(within(rows).getByRole("menuitem", { name: "New slide after" }));
    fireEvent.click(await item("Blank"));
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "add", after: 5, layout: "Blank" }]));
    // The layouts a slide can take, its own checked.
    const again = await menu(thumb("9"));
    fireEvent.click(within(again).getByRole("menuitem", { name: "Layout" }));
    const two = await screen.findByRole("menuitemcheckbox", { name: "Two Content" });
    expect(screen.getByRole("menuitemcheckbox", { name: "Title and Content" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("menuitemcheckbox", { name: "Blank" })).toBeNull();
    fireEvent.click(two);
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "layout", slide: 9, layout: "Two Content" }]));
  });

  it("sections: added at a slide with a name, renamed and removed by their place", async () => {
    await t.stage(deck());
    await menu(thumb("5"));
    fireEvent.click(await item("Add section here"));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByRole("textbox");
    expect((field as HTMLInputElement).value).toBe("Untitled section");
    fireEvent.change(field, { target: { value: "Why" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "section", act: "add", at: 5, name: "Why" }]]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Numbers is the third section now.
    await menu(thumb("7"));
    fireEvent.click(await item("Rename section…"));
    const rename = await screen.findByRole("dialog");
    expect((within(rename).getByRole("textbox") as HTMLInputElement).value).toBe("Numbers");
    fireEvent.change(within(rename).getByRole("textbox"), { target: { value: "Figures" } });
    fireEvent.submit(rename.querySelector("form")!);
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "section", act: "rename", section: 2, name: "Figures" }]));
    await menu(thumb("3"));
    fireEvent.click(await item("Remove section"));
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "section", act: "remove", section: 0 }]));
  });

  it("Delete takes the focused slide out; the menu's Delete slide too", async () => {
    await t.stage(deck());
    fireEvent.click(thumb("9"));
    act(() => thumb("9").focus());
    fireEvent.keyDown(thumb("9"), { key: "Delete" });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "remove", slide: 9 }]]));
    // The slide in its place takes the keyboard.
    await waitFor(() => expect(document.activeElement).toBe(thumb("7")));
    await menu(thumb("5"));
    fireEvent.click(await item("Delete slide"));
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "remove", slide: 5 }]));
  });

  it("a slide dragged down the strip moves after the one it lands below, in one move edit", async () => {
    await t.stage(deck());
    // Each thumbnail 60px tall, one under another, as a browser lays them out.
    const keys = ["3", "5", "7", "9"];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const at = keys.indexOf(this.dataset.slide ?? "");
      const y = parseFloat((this.style.translate || "0px 0px").split(" ")[1]!) || 0;
      const top = (at < 0 ? 0 : at * 60) + y;
      return { left: 0, right: 120, width: 120, top, bottom: top + 60, height: 60, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    fireEvent.pointerDown(thumb("3"), { button: 0, pointerId: 1, clientX: 50, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 130 });
    expect(document.querySelector("[data-slide-drop]")).not.toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 50, clientY: 130 });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "move", slide: 3, after: 7 }]]));
    // The press that ended the drag does not pick.
    fireEvent.click(thumb("3"));
    expect(thumb("3").getAttribute("aria-current")).toBe("true");
    expect([...document.querySelectorAll("[data-slides-strip] [data-slide]")].map((b) => b.getAttribute("data-slide"))).toEqual(["5", "7", "3", "9"]);
  });

  it("offers no menu and no drag while a suggestion waits: the strip's order is the proposed one", async () => {
    const view = deck();
    await t.stage({ ...view, changes: [{ id: "c1", kind: "changed", slideId: 9, label: "", edits: [], by: "agent:local:t1" }], slides: view.slides.map((s) => (s.id === 9 ? { ...s, change: "c1", tint: "add" as const } : s)) });
    fireEvent.contextMenu(thumb("5"));
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(thumb("5"), { key: "Delete" });
    expect(t.edits()).toEqual([]);
  });
});

describe("the Sorter", () => {
  const sorter = async () => {
    await t.stage(deck());
    act(() => t.host.view && void 0);
    fireEvent.click(document.querySelector<HTMLElement>('[data-format-row] [role=radio][aria-label="Sorter"], [data-format-row] [role=radio]:last-child')!);
    return t.found("[data-slides-sorter]");
  };

  it("lays every slide in a grid under its section with a count, a hidden one at 45%, and a press goes back to it on the stage", async () => {
    const grid = await sorter();
    expect([...grid.querySelectorAll("[data-sorter-section]")].map((h) => h.textContent)).toEqual(["Intro2", "Numbers2"]);
    const cells = [...grid.querySelectorAll<HTMLElement>("[data-sorter-slide]")];
    expect(cells.map((c) => c.textContent)).toEqual(["1Slide 3", "2Slide 5", "3Slide 7", "4Slide 9"]);
    expect(cells[2].querySelector(".opacity-45")).not.toBeNull();
    fireEvent.click(cells[3]);
    await t.found("[data-slides-stage]");
    expect(thumb("9").getAttribute("aria-current")).toBe("true");
  });

  it("has the strip's menu, Delete, and the arrows four ways", async () => {
    const grid = await sorter();
    const cell = (key: string) => grid.querySelector<HTMLElement>(`[data-slide="${key}"]`)!;
    fireEvent.contextMenu(cell("7"));
    fireEvent.click(await item("Show slide"));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "hide", slide: 7, hidden: false }]]));
    act(() => cell("3").focus());
    fireEvent.keyDown(cell("3"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("5"));
    fireEvent.keyDown(cell("5"), { key: "Delete" });
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "remove", slide: 5 }]));
  });

  it("a slide dragged across the grid shows where it will land, carried at 80%, and moves there", async () => {
    const grid = await sorter();
    // Four across, each 100 by 70, 12px apart.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const at = ["3", "5", "7", "9"].indexOf(this.dataset.slide ?? "");
      if (this.hasAttribute("data-slides-sorter")) return { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      const left = (at < 0 ? 0 : at) * 112 + 16;
      return { left, right: left + 100, width: 100, top: 16, bottom: 86, height: 70, x: left, y: 16, toJSON: () => ({}) } as DOMRect;
    });
    const first = grid.querySelector<HTMLElement>('[data-slide="3"]')!;
    fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 60, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 50 });
    expect(grid.querySelector("[data-sorter-carry]")!.className).toContain("opacity-80");
    expect(grid.querySelector("[data-sorter-drop]")).not.toBeNull();
    // Its own place is a dashed frame while it is carried.
    expect(first.firstElementChild!.className).toContain("outline-dashed");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 50 });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "move", slide: 3, after: 7 }]]));
    expect(grid.querySelector("[data-sorter-carry]")).toBeNull();
  });

  it("finds where a drop lands from the nearest slide's side", () => {
    const rects = [0, 1, 2, 3].map((i) => ({ left: i * 112, right: i * 112 + 100, top: 0, bottom: 70 }));
    expect(dropIndex(rects, 0, 260, 35)).toBe(1);
    expect(dropIndex(rects, 0, 290, 35)).toBe(2);
    expect(dropIndex(rects, 3, 10, 35)).toBe(0);
    expect(dropIndex(rects, 1, 60, 35)).toBe(1);
  });
});
