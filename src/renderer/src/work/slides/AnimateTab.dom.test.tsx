// @vitest-environment jsdom
/**
 * The Format sheet's Animate tab, in the real canvas pane (docs/DESIGN.md
 * "The slide editor"): the slide's transition and its builds, each change one
 * edit with its exact op; what only PowerPoint can set says so; a suggested
 * slide shows the proposed values.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { openMenus } from "../../chrome/menuRows";
import { harness, handView } from "./stage.testkit";

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

const toggle = (): HTMLElement => document.querySelector<HTMLElement>('[data-format-row] [data-format-item="format"] button')!;
const sheet = (): HTMLElement => document.querySelector<HTMLElement>("[data-slides-sheet]")!;
const none = { shapes: [], paras: [] };
/** The first slide with something of its own. */
const withFirst = (over: Partial<DeckSlide>): DeckView => {
  const view = handView();
  return { ...view, slides: [{ ...view.slides[0], ...over }, view.slides[1]] };
};

/** The deck on the stage, the sheet open on its Animate tab. */
async function animate(view?: DeckView): Promise<void> {
  await t.stage(view);
  fireEvent.click(toggle());
  await waitFor(() => expect(sheet()).toBeTruthy());
  fireEvent.click(within(sheet()).getByRole("tab", { name: "Animate" }));
  await waitFor(() => expect(within(sheet()).getByRole("tab", { name: "Animate" }).getAttribute("aria-selected")).toBe("true"));
}
async function pick(menu: string, item: string, role: "menuitemradio" | "menuitem" = "menuitemradio"): Promise<void> {
  fireEvent.click(within(sheet()).getByRole("button", { name: menu }));
  fireEvent.click(await screen.findByRole(role, { name: item }));
}
const rows = (): string[] => within(sheet()).queryAllByRole("listitem").map((li) => li.getAttribute("aria-label") ?? "");

describe("the Animate tab", () => {
  it("works with nothing picked, and the sheet opens again where he left it", async () => {
    await animate();
    expect(within(sheet()).getByRole("button", { name: "Transition" }).textContent).toContain("None");
    expect(within(sheet()).getByRole("checkbox", { name: "On click" }).getAttribute("aria-checked")).toBe("true");
    expect(within(sheet()).getByRole("button", { name: /Appear on click/ })).toBeTruthy();
    expect(sheet().textContent).not.toContain("Pick a shape on the slide");
    fireEvent.click(within(sheet()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector("[data-slides-sheet]")).toBeNull());
    fireEvent.click(toggle());
    await waitFor(() => expect(within(sheet()).getByRole("tab", { name: "Animate" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("sets a fade, a push from a side, the press and the wait, each as the whole transition", async () => {
    await animate();
    await pick("Transition", "Fade");
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "transition", slide: 3, kind: "fade", click: true, after: null }]]));
    await pick("Transition", "Push");
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "transition", slide: 3, kind: "push", dir: "u", click: true, after: null }]));
    await waitFor(() => expect(within(sheet()).getByRole("button", { name: "Direction" }).textContent).toContain("From bottom"));
    await pick("Direction", "From left");
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "transition", slide: 3, kind: "push", dir: "r", click: true, after: null }]));
    fireEvent.click(await within(sheet()).findByRole("checkbox", { name: "After" }));
    await waitFor(() => expect(t.edits()[3]).toEqual([{ op: "transition", slide: 3, kind: "push", dir: "r", click: true, after: 5 }]));
    const seconds = await within(sheet()).findByRole("textbox", { name: "Seconds" });
    act(() => seconds.focus());
    fireEvent.change(seconds, { target: { value: "2,5" } });
    fireEvent.keyDown(seconds, { key: "Enter" });
    await waitFor(() => expect(t.edits()[4]).toEqual([{ op: "transition", slide: 3, kind: "push", dir: "r", click: true, after: 2.5 }]));
    fireEvent.click(within(sheet()).getByRole("checkbox", { name: "On click" }));
    await waitFor(() => expect(t.edits()[5]).toEqual([{ op: "transition", slide: 3, kind: "push", dir: "r", click: false, after: 2.5 }]));
    await waitFor(() => expect(within(sheet()).getByRole("checkbox", { name: "On click" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("names a transition it does not play, says it plays in PowerPoint, and replaces it only on None, Fade or Push", async () => {
    await animate(withFirst({ transition: { kind: "randomBar", ms: 500, after: 3000 } }));
    expect(within(sheet()).getByRole("button", { name: "Transition" }).textContent).toContain("Random bar");
    expect(sheet().textContent).toContain("Plays in PowerPoint; a cut here");
    expect(within(sheet()).getByRole("checkbox", { name: "On click" }).hasAttribute("data-disabled")).toBe(true);
    await pick("Transition", "Fade");
    // What it had of its timing stays.
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "transition", slide: 3, kind: "fade", click: true, after: 3 }]]));
    await waitFor(() => expect(sheet().textContent).not.toContain("Plays in PowerPoint"));
  });

  it("lists the builds by what the stage reads, adds one from the slide, takes one out, and Undo walks it back", async () => {
    await animate(withFirst({ builds: { steps: [{ shapes: [2, 5], paras: [] }, { shapes: [5], paras: [] }, none], changed: 0, order: [2, 5] } }));
    expect(rows()).toEqual(["1. Title: Who comes", "2. Rectangle 4"]);
    await pick("Appear on click", "Picture", "menuitem");
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "builds", slide: 3, order: [2, 5, 4] }]]));
    await waitFor(() => expect(rows()).toEqual(["1. Title: Who comes", "2. Rectangle 4", "3. Picture"]));
    expect((within(sheet()).getByRole("button", { name: /Appear on click/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove Rectangle 4" }));
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "builds", slide: 3, order: [2, 4] }]));
    await waitFor(() => expect(rows()).toEqual(["1. Title: Who comes", "2. Picture"]));
    fireEvent.click(t.rowItem("undo"));
    await waitFor(() => expect(t.host.calls).toContainEqual(["step", "undo"]));
  });

  it("moves a build by ⌥↑ and ⌥↓ from the keyboard, keeping the keyboard on it; Delete takes it out", async () => {
    await animate(withFirst({ builds: { steps: [{ shapes: [2, 4, 5], paras: [] }, { shapes: [4, 5], paras: [] }, { shapes: [4], paras: [] }, none], changed: 0, order: [2, 5, 4] } }));
    const row = within(sheet()).getByRole("listitem", { name: "2. Rectangle 4" });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "builds", slide: 3, order: [5, 2, 4] }]]));
    await waitFor(() => expect(rows()).toEqual(["1. Rectangle 4", "2. Title: Who comes", "3. Picture"]));
    expect(document.activeElement?.getAttribute("data-build")).toBe("5");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "builds", slide: 3, order: [2, 4, 5] }]));
    // The last one goes no further.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    await waitFor(() => expect(t.edits()[3]).toEqual([{ op: "builds", slide: 3, order: [2, 4] }]));
    expect(t.edits()).toHaveLength(4);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-build")).toBe("4"));
  });

  it("lists a slide built by Fade, and each shape keeps its Fade through a new order, a shape added and one taken out", async () => {
    await animate(withFirst({ builds: { steps: [{ shapes: [2, 5], paras: [] }, { shapes: [5], paras: [] }, none], changed: 0, order: [2, 5], fade: [2, 5] } }));
    expect(sheet().textContent).not.toContain("Edit in PowerPoint");
    expect(rows()).toEqual(["1. Title: Who comes, Fade", "2. Rectangle 4, Fade"]);
    const row = within(sheet()).getByRole("listitem", { name: "2. Rectangle 4, Fade" });
    expect(within(row).getByText("Fade").className).toContain("text-muted-foreground");
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "builds", slide: 3, order: [5, 2], fade: [5, 2] }]]));
    await waitFor(() => expect(rows()).toEqual(["1. Rectangle 4, Fade", "2. Title: Who comes, Fade"]));
    // One added comes by Appear, and says nothing more than its name.
    await pick("Appear on click", "Picture", "menuitem");
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "builds", slide: 3, order: [5, 2, 4], fade: [5, 2] }]));
    await waitFor(() => expect(rows()).toEqual(["1. Rectangle 4, Fade", "2. Title: Who comes, Fade", "3. Picture"]));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove Rectangle 4" }));
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "builds", slide: 3, order: [2, 4], fade: [2] }]));
    await waitFor(() => expect(rows()).toEqual(["1. Title: Who comes, Fade", "2. Picture"]));
    // The last that fades taken out: the op names none.
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove Title: Who comes" }));
    await waitFor(() => expect(t.edits()[3]).toEqual([{ op: "builds", slide: 3, order: [4] }]));
  });

  it("brings a shape he took out back by Appear, even before the deck has come back without it", async () => {
    await animate(withFirst({ builds: { steps: [{ shapes: [2, 5], paras: [] }, { shapes: [5], paras: [] }, none], changed: 0, order: [2, 5], fade: [2, 5] } }));
    // The host answers nothing yet: the list is his own change, held.
    let answer = (): void => undefined;
    t.host.hold = new Promise<void>((done) => (answer = done));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove Rectangle 4" }));
    await waitFor(() => expect(rows()).toEqual(["1. Title: Who comes, Fade"]));
    await pick("Appear on click", "Rectangle 4", "menuitem");
    await waitFor(() => expect(rows()).toEqual(["1. Title: Who comes, Fade", "2. Rectangle 4"]));
    answer();
    await waitFor(() => expect(t.edits()).toHaveLength(2));
    expect(t.edits()[1]).toEqual([{ op: "builds", slide: 3, order: [2, 5], fade: [2] }]);
  });

  it.each([
    ["shown whole for a motion path", { builds: { steps: [none], changed: 2, whole: "a motion path" } }, "A shape moves along a path", true],
    ["paragraph by paragraph", { builds: { steps: [{ shapes: [], paras: [{ shape: 2, from: 0, to: 0 }] }, none], changed: 0 } }, "Its text comes in a paragraph at a time", true],
    ["with an exit", { builds: { steps: [none, { shapes: [5], paras: [] }], changed: 0 } }, "A shape leaves on a press", true],
    ["flying in", { builds: { steps: [{ shapes: [5], paras: [] }, none], changed: 1 } }, "Its effects are more than appear or fade on click", true],
    ["with a video", { shapes: [{ ...handView().slides[0].shapes[0] }, { id: 9, name: "Clip", label: "Media", kind: "media" as const, media: "video" as const, bbox: [0, 0, 1, 1] as [number, number, number, number], text: "" }] }, "It holds a video", false],
  ])("reads Edit in PowerPoint on a slide %s, offering nothing that would drop its effects unasked", async (_, over, why, replace) => {
    await animate(withFirst(over as Partial<DeckSlide>));
    expect(sheet().textContent).toContain("Edit in PowerPoint");
    expect(sheet().textContent).toContain(why);
    expect(within(sheet()).queryByRole("button", { name: /Appear on click/ })).toBeNull();
    expect(within(sheet()).queryAllByRole("listitem")).toHaveLength(0);
    expect(!!within(sheet()).queryByRole("button", { name: "Remove animations…" })).toBe(replace);
  });

  it("takes a slide's animations out only once he confirms, saying what goes", async () => {
    await animate(withFirst({ builds: { steps: [none], changed: 3, whole: "a trigger" } }));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove animations…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Every effect on this slide goes, in PowerPoint too");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(t.edits()).toEqual([]);
    fireEvent.click(within(sheet()).getByRole("button", { name: "Remove animations…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "builds", slide: 3, order: [], replace: true }]]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(within(sheet()).getByRole("button", { name: /Appear on click/ })).toBeTruthy());
  });

  it("shows a suggested slide's proposed transition and builds, read only, what the suggestion changes in the added tint", async () => {
    const view = withFirst({
      change: "c1",
      tint: "add",
      from: "proposed",
      transition: { kind: "push", dir: "l", ms: 750, after: 4000 },
      builds: { steps: [{ shapes: [2], paras: [] }, none], changed: 0, order: [2], fade: [2] },
    });
    await animate({ ...view, renders: { file: { rev: "f1", size: 10, pages: 2 }, proposed: { rev: "p1", size: 10, pages: 2 } }, changes: [{ id: "c1", kind: "changed", slideId: 3, label: "Slide 3", edits: [{ where: "Transition", before: "None", after: "Push, moves on after 4 s" }], by: "agent:local:t1" }] });
    expect(sheet().textContent).toContain("Accept or reject the suggestion on this slide first");
    expect(within(sheet()).queryByRole("button", { name: "Transition" })).toBeNull();
    expect(within(sheet()).queryByRole("checkbox")).toBeNull();
    expect(within(sheet()).queryByRole("button", { name: /Appear on click/ })).toBeNull();
    const push = within(sheet()).getByText("Push");
    expect(push.className).toContain("bg-(--add-bg)");
    expect(within(sheet()).getByText("From right").className).toContain("bg-(--add-bg)");
    expect(within(sheet()).getByText("On click, after 4 s")).toBeTruthy();
    // The builds the suggestion does not change: listed, untinted.
    expect(within(sheet()).getByText("Title: Who comes").className).not.toContain("bg-(--add-bg)");
    expect(within(within(sheet()).getByRole("listitem")).getByText("Fade")).toBeTruthy();
    expect(t.edits()).toEqual([]);
  });
});
