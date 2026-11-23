// @vitest-environment jsdom
/**
 * His hand on a shape, in the real canvas pane (docs/agents/work-slides.md
 * "Moving a shape"): a drag sends one geometry edit, Escape puts it back,
 * the carried picture waits for the new paint, guides and the snap, resize
 * by a corner with Shift, the turn, the arrows' nudge and Delete.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMenus } from "../../chrome/menuRows";
import { nudge, type Own } from "./edit/drag";
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
const W = 12_192_000;
const H = 6_858_000;
/** The box's own box before any edit. */
const OWN = BOX.own!;
/** A client point on the 1000 by 500 layer for a point of the slide in EMU. */
const client = (x: number, y: number) => ({ clientX: (x / W) * 1000, clientY: (y / H) * 500 });

HTMLElement.prototype.setPointerCapture ??= () => undefined;
HTMLElement.prototype.releasePointerCapture ??= () => undefined;

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

/** The box picked, and a drag of it started at its middle. */
async function grab() {
  const got = await t.stage();
  got.press(0.6, 0.6);
  expect(got.shape(5).getAttribute("aria-pressed")).toBe("true");
  fireEvent.pointerDown(got.layer, { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
  return got;
}

describe("moving a shape", () => {
  it("a drag sends one geometry edit with the box where he left it, its picture carried at 80% under an outline, its size by the corner", async () => {
    const { layer } = await grab();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 650, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 300 });
    // While he drags: the handles step aside, the outline follows, the shape's picture rides along.
    expect(layer.querySelector("[data-slide-selection]")).toBeNull();
    expect(layer.querySelector("[data-slide-dragging=move] polygon")).not.toBeNull();
    const carry = layer.querySelector<HTMLElement>("[data-slide-carry]")!;
    expect(carry.className).toContain("opacity-80");
    expect(carry.firstElementChild).not.toBeNull();
    expect(layer.querySelector("[data-slide-drag-label]")!.textContent).toBe("2.67 × 1.50 in");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 300 });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "geometry", slide: 3, shape: 5, box: [OWN.box[0] + W / 10, OWN.box[1], OWN.box[2], OWN.box[3]] }]]));
    // The press that ends a drag picks nothing and opens nothing.
    fireEvent.click(layer, { clientX: 700, clientY: 300 });
    expect(layer.querySelector("[data-slide-typing]")).toBeNull();
    expect(layer.querySelector('[data-shape="5"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the carried picture where he left it until the stage paints the new revision", async () => {
    const paint = t.holdPictures();
    const { layer } = await grab();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 320 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 320 });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
    // Written, but the new picture is still being drawn: the carried one stays, and the handles are back on the new place.
    await waitFor(() => expect(layer.querySelector("[data-slide-selection] rect[data-handle]")).not.toBeNull());
    expect(layer.querySelector("[data-slide-carry]")?.firstElementChild).not.toBeNull();
    act(() => paint());
    await waitFor(() => expect(layer.querySelector("[data-slide-carry]")?.firstElementChild ?? null).toBeNull());
  });

  it("Escape during a drag puts it back: nothing is sent, the picture and the handles are as they were", async () => {
    const { layer } = await grab();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 760, clientY: 360 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(layer.querySelector("[data-slide-carry]")!.firstElementChild).toBeNull();
    expect(layer.querySelector("[data-slide-dragging]")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 760, clientY: 360 });
    expect(t.edits()).toEqual([]);
    expect(layer.querySelector("[data-slide-selection] rect[data-handle]")).not.toBeNull();
    // Escape took the drag, not the selection.
    expect(layer.querySelector('[data-shape="5"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("a guide shows exactly when an edge or the centre meets a line, the snap pulls within a few pixels, and Alt lets it lie", async () => {
    const { layer } = await grab();
    // Moved across only: its top still lies on the slide's middle (and the picture's top), its bottom on the picture's
    // middle. A guide across at each, once; none down.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 650, clientY: 300 });
    expect([...layer.querySelectorAll('[data-slide-guide="y"]')].map((g) => Number(g.getAttribute("y1")))).toEqual([expect.closeTo(t.stageHeight() * 0.5, 1), expect.closeTo(t.stageHeight() * 0.7, 1)]);
    expect(layer.querySelectorAll('[data-slide-guide="x"]')).toHaveLength(0);
    // Its centre (0.6 of the width) carried to 3px right of the slide's middle: pulled onto it, a guide down.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 503, clientY: 300 });
    expect(layer.querySelectorAll('[data-slide-guide="x"]')).toHaveLength(1);
    // With Alt the pointer is the place.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 503, clientY: 300, altKey: true });
    expect(layer.querySelectorAll('[data-slide-guide="x"]')).toHaveLength(0);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 503, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 503, clientY: 300 });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
    const [op] = t.edits()[0] as Array<{ box: number[] }>;
    expect(op.box[0] + op.box[2] / 2).toBe(W / 2);
  });

  it("a shape not yet picked is picked and moved by one drag", async () => {
    const { layer } = await t.stage();
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 620, clientY: 330 });
    expect(layer.querySelector('[data-shape="5"]')!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 620, clientY: 330 });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
  });
});

describe("resizing and turning", () => {
  it("a corner keeps the far corner; Shift keeps the proportions", async () => {
    const { layer, press } = await t.stage();
    press(0.6, 0.6);
    // The bottom-right handle, at the box's corner (0.7, 0.7 of the slide).
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 700, clientY: 350 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800, clientY: 360, shiftKey: true });
    expect(layer.querySelector("[data-slide-dragging=resize]")).not.toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 800, clientY: 360, shiftKey: true });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
    // Pulled 1.5 times across and 1.1 times down: with Shift, 1.5 times both ways, the top-left where it was.
    expect(t.edits()[0]).toEqual([{ op: "geometry", slide: 3, shape: 5, box: [OWN.box[0], OWN.box[1], OWN.box[2] * 1.5, OWN.box[3] * 1.5] }]);
  });

  it("a press on a handle never lets the shape go", async () => {
    const { layer, press } = await t.stage();
    press(0.6, 0.6);
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 700, clientY: 350 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 350 });
    fireEvent.click(layer, { clientX: 700, clientY: 350 });
    expect(layer.querySelector('[data-shape="5"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.edits()).toEqual([]);
  });

  it("the turn handle turns it about its centre, by 15 degree steps with Shift, the angle by the corner", async () => {
    const { layer, press, drawn } = await t.stage();
    press(0.6, 0.6);
    const { h } = drawn();
    // The turn handle, 22px of the stage over the middle of the top edge.
    const up = 22 * (500 / h);
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 600, clientY: 250 - up });
    // 40 degrees round from straight up, in the slide's own measure.
    const c = { x: OWN.box[0] + OWN.box[2] / 2, y: OWN.box[1] + OWN.box[3] / 2 };
    const r = ((40 - 90) * Math.PI) / 180;
    const to = client(c.x + Math.cos(r) * 2_000_000, c.y + Math.sin(r) * 2_000_000);
    fireEvent.pointerMove(window, { pointerId: 1, ...to });
    expect(layer.querySelector("[data-slide-drag-label]")!.textContent).toBe("40°");
    fireEvent.pointerMove(window, { pointerId: 1, ...to, shiftKey: true });
    expect(layer.querySelector("[data-slide-drag-label]")!.textContent).toBe("45°");
    fireEvent.pointerUp(window, { pointerId: 1, ...to, shiftKey: true });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "geometry", slide: 3, shape: 5, rot: 45 }]]));
  });

  it("a table offers no turn handle; a shape in a turned group is outlined with no handles and does not move", async () => {
    const table = { ...BOX, id: 7, kind: "table" as const };
    const grouped = { ...BOX, id: 8, own: undefined, quad: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]] as never, bbox: [0.1, 0.1, 0.3, 0.3] as never };
    const view = handView();
    const { layer, press } = await t.stage({ ...view, slides: [{ ...view.slides[0], shapes: [grouped, table] }, view.slides[1]] });
    press(0.6, 0.6);
    expect(layer.querySelectorAll("[data-slide-selection] rect[data-handle]")).toHaveLength(8);
    expect(layer.querySelector('[data-slide-selection] circle[data-handle="rotate"]')).toBeNull();
    press(0.2, 0.2);
    expect(layer.querySelector('[data-shape="8"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(layer.querySelectorAll("[data-slide-selection] [data-handle]")).toHaveLength(0);
    fireEvent.pointerDown(layer, { button: 0, pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260, clientY: 140 });
    expect(layer.querySelector("[data-slide-dragging]")).toBeNull();
    expect(t.edits()).toEqual([]);
  });
});

describe("the keys on a picked shape", () => {
  it("the arrows nudge it by a pixel of the stage, Shift by ten, and the run goes as one edit", async () => {
    const { shape, drawn } = await t.stage();
    act(() => shape(5).focus());
    fireEvent.keyDown(shape(5), { key: "ArrowRight" });
    fireEvent.keyDown(shape(5), { key: "ArrowRight" });
    fireEvent.keyDown(shape(5), { key: "ArrowDown", shiftKey: true });
    expect(document.querySelector("[data-slide-carry]")!.firstElementChild).not.toBeNull();
    expect(t.edits()).toEqual([]);
    const per = W / drawn().w;
    const want = [[1, 0], [1, 0], [0, 10]].reduce((own: Own, [dx, dy]) => nudge(own, dx, dy, per), OWN);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "geometry", slide: 3, shape: 5, box: want.box }]]), { timeout: 2000 });
    expect(document.activeElement).toBe(shape(5));
  });

  it("a run of nudges goes as its own edit when he tabs on to another shape and nudges that", async () => {
    const { shape } = await t.stage();
    act(() => shape(5).focus());
    fireEvent.keyDown(shape(5), { key: "ArrowLeft" });
    act(() => shape(4).focus());
    fireEvent.keyDown(shape(4), { key: "ArrowLeft" });
    await waitFor(() => expect(t.edits()).toHaveLength(1));
    expect((t.edits()[0] as Array<{ shape: number }>)[0].shape).toBe(5);
  });

  it("Delete takes it off the slide; the keys stay the deck's", async () => {
    const { shape, layer } = await t.stage();
    act(() => shape(5).focus());
    fireEvent.keyDown(shape(5), { key: "Delete" });
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "delete", slide: 3, shape: 5 }]]));
    await waitFor(() => expect(layer.querySelector('[data-shape="5"]')).toBeNull());
    expect(layer.contains(document.activeElement)).toBe(true);
    // Backspace too, on the picture.
    act(() => shape(4).focus());
    fireEvent.keyDown(shape(4), { key: "Backspace" });
    await waitFor(() => expect(t.edits()).toHaveLength(2));
  });

  it("the keys reach the picked shape when the keyboard lies on the layer itself, as after a press on a handle", async () => {
    // In a real window a mouse press on a handle (or on the shape already picked) moves the keyboard to the layer.
    const { shape, layer } = await t.stage();
    act(() => shape(5).focus());
    act(() => layer.focus());
    expect(document.activeElement).toBe(layer);
    fireEvent.keyDown(layer, { key: "ArrowRight" });
    await waitFor(() => expect(t.edits()).toHaveLength(1), { timeout: 2000 });
    expect((t.edits()[0] as Array<{ op: string; shape: number }>)[0]).toMatchObject({ op: "geometry", shape: 5 });
    act(() => layer.focus());
    fireEvent.keyDown(layer, { key: "Delete" });
    await waitFor(() => expect(t.edits()).toHaveLength(2));
    expect((t.edits()[1] as Array<{ op: string; shape: number }>)[0]).toEqual({ op: "delete", slide: 3, shape: 5 });
  });

  it("a shape on a slide a suggestion changes neither moves nor goes", async () => {
    const view = handView();
    const { shape, layer } = await t.stage({ ...view, slides: [{ ...view.slides[0], change: "c1", tint: "add" }, view.slides[1]], changes: [{ id: "c1", kind: "changed", slideId: 3, label: "", edits: [], by: "agent:local:t1" }] });
    act(() => shape(5).focus());
    fireEvent.keyDown(shape(5), { key: "ArrowRight" });
    fireEvent.keyDown(shape(5), { key: "Delete" });
    expect(layer.querySelectorAll("[data-slide-selection] [data-handle]")).toHaveLength(0);
    await new Promise((done) => setTimeout(done, 500));
    expect(t.edits()).toEqual([]);
  });

  it("an agent's suggested move or added shape is tinted where it now lies, from the host's boxes, and the stepper's words are the host's", async () => {
    const view = handView();
    const moved = { ...BOX, bbox: [0.6, 0.6, 0.8, 0.8] as [number, number, number, number] };
    const added = { ...BOX, id: 9, bbox: [0.1, 0.6, 0.3, 0.8] as [number, number, number, number] };
    const edits = [
      { where: "Rectangle 4, look", before: "Where it was", after: "Moved or resized" },
      { where: "Rectangle 8", before: "", after: "Added" },
    ];
    const { layer } = await t.stage({
      ...view,
      slides: [{ ...view.slides[0], shapes: [moved, added], change: "c1", tint: "add", changed: [moved.bbox, added.bbox], removed: [[0.3, 0.1, 0.5, 0.2]] }, view.slides[1]],
      changes: [{ id: "c1", kind: "changed", slideId: 3, label: "Slide 3", edits, by: "agent:local:t1" }],
    });
    const tints = [...layer.querySelectorAll<HTMLElement>("[data-slide-changed]")];
    expect(tints.map((el) => [el.style.left, el.style.top])).toEqual([
      ["60%", "60%"],
      ["10%", "60%"],
    ]);
    expect(document.querySelector("[data-slide-edits]")!.textContent).toContain("Moved or resized");
    expect(document.querySelector("[data-slide-edits]")!.textContent).toContain("Added");
    // Where a shape the suggestion takes away lay is tinted as removed, never as added.
    const gone = [...layer.querySelectorAll<HTMLElement>("[data-slide-removed]")];
    expect(gone.map((el) => [el.style.left, el.style.top])).toEqual([["30%", "10%"]]);
    expect(gone[0].className).toMatch(/del-bg/);
    expect(gone[0].className).not.toMatch(/add-bg/);
  });
});
