// @vitest-environment jsdom
/**
 * The deck's own keys in the real canvas pane (docs/agents/work-slides.md
 * "Copy and paste", "A picture pasted or dropped"): ⌘D on the picked shape,
 * ⌘C and ⌘V as the window's copy and paste events, a picture pasted or
 * dropped on the slide, and none of them heard in a field.
 */
import { act, cleanup, createEvent, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMenus } from "../../chrome/menuRows";
import { IS_MAC } from "../../lib/platform";
import { COPY_STEP, forgetHeld, SHAPE_TYPE } from "./edit/clipboard";
import { harness, handView, TITLE } from "./stage.testkit";

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
  forgetHeld();
  holder.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

/** The platform's own chord: ⌘ on a Mac, Ctrl elsewhere. */
const mod = (key: string) => ({ key, metaKey: IS_MAC, ctrlKey: !IS_MAC });
/** A copy or a paste as the window sends it (Edit → Copy, ⌘C), on what holds the keyboard, with its clipboard. */
function clipboardEvent(type: "copy" | "paste", data: Map<string, string>, files: File[] = []): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData: (k: string, v: string) => void data.set(k, v), getData: (k: string) => data.get(k) ?? "", files, items: [] } });
  return (document.activeElement ?? document.body).dispatchEvent(event);
}
const thumbs = () => [...document.querySelectorAll<HTMLElement>("[data-slide]")];

describe("⌘D", () => {
  it("duplicates the picked shape 12 points down and right, and picks the copy", async () => {
    const { shape } = await t.stage();
    act(() => shape(2).focus());
    fireEvent.keyDown(shape(2), mod("d"));
    const [x, y, w, h] = TITLE.own!.box;
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "copy", slide: 3, shape: 2, box: [x + COPY_STEP, y + COPY_STEP, w, h] }]]));
    const made = t.host.view.slides[0].shapes.at(-1)!;
    await waitFor(() => expect(shape(made.id).getAttribute("aria-pressed")).toBe("true"));
  });

  it("does nothing in a field, with nothing picked, or on a deck he cannot edit", async () => {
    const { layer } = await t.stage();
    fireEvent.keyDown(layer, mod("d"));
    const field = (await t.found("[data-slide-notes-field]")) as HTMLTextAreaElement;
    field.focus();
    fireEvent.keyDown(field, mod("d"));
    await new Promise((done) => setTimeout(done, 20));
    expect(t.edits()).toEqual([]);
    cleanup();
    const read = await t.stage(handView({ hand: undefined }));
    act(() => read.shape(2).focus());
    fireEvent.keyDown(read.shape(2), mod("d"));
    await new Promise((done) => setTimeout(done, 20));
    expect(t.edits()).toEqual([]);
  });
});

describe("⌘C and ⌘V", () => {
  it("copy the picked shape and its words; a paste lays it on the slide on the stage, in its own place", async () => {
    const { shape } = await t.stage();
    act(() => shape(2).focus());
    const data = new Map<string, string>();
    expect(clipboardEvent("copy", data)).toBe(false);
    expect(data.get("text/plain")).toBe("Who comes");
    expect(data.get(SHAPE_TYPE)).toBeTruthy();
    // A press on the second slide in the strip, which takes the keyboard there.
    act(() => thumbs()[1].focus());
    fireEvent.click(thumbs()[1]);
    await waitFor(() => expect(thumbs()[1].getAttribute("aria-current")).toBe("true"));
    expect(clipboardEvent("paste", data)).toBe(false);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "copy", slide: 3, shape: 2, to: 5, box: TITLE.own!.box }]]));
  });

  it("a paste of anything else, or into a field, is left to go on; nothing is copied with no shape picked", async () => {
    const { layer, shape } = await t.stage();
    act(() => layer.focus());
    const none = new Map<string, string>();
    expect(clipboardEvent("copy", none)).toBe(true);
    expect(none.size).toBe(0);
    act(() => shape(2).focus());
    const data = new Map<string, string>();
    clipboardEvent("copy", data);
    // Words from another app since: the clipboard's mark is gone.
    expect(clipboardEvent("paste", new Map([["text/plain", "Who comes"]]))).toBe(true);
    const field = (await t.found("[data-slide-notes-field]")) as HTMLTextAreaElement;
    field.focus();
    expect(clipboardEvent("paste", data)).toBe(true);
    await new Promise((done) => setTimeout(done, 20));
    expect(t.edits()).toEqual([]);
  });
});

describe("a picture pasted or dropped", () => {
  /** Where an 800 by 600 picture lies fitted to three fifths of the slide: 5,486,400 by 4,114,800 EMU. */
  const [W, H] = [5_486_400, 4_114_800];
  const png = (bytes = 10) => new File([new Uint8Array(bytes)], "image.png", { type: "image/png" });

  it("a picture on the clipboard goes in the slide's middle, as Insert → Picture… puts one, and is picked", async () => {
    const { layer } = await t.stage();
    act(() => layer.focus());
    expect(clipboardEvent("paste", new Map(), [png()])).toBe(false);
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "picture", box: [(12_192_000 - W) / 2, (6_858_000 - H) / 2, W, H], file: "token:image.png" }]]));
    expect(t.host.calls.filter(([name]) => name === "attach")).toEqual([["attach", { name: "image.png", size: 10 }]]);
    const made = t.host.view.slides[0].shapes.at(-1)!;
    await waitFor(() => expect(document.querySelector(`[data-shape="${made.id}"]`)?.getAttribute("aria-pressed")).toBe("true"));
    // A file that is no picture is left to go on; in a field, so is a picture.
    expect(clipboardEvent("paste", new Map(), [new File(["x"], "notes.txt", { type: "text/plain" })])).toBe(true);
    const field = (await t.found("[data-slide-notes-field]")) as HTMLTextAreaElement;
    field.focus();
    expect(clipboardEvent("paste", new Map(), [png()])).toBe(true);
  });

  it("a picture dropped on the slide lies centred where he let it go, kept on the slide; the pane does not open it", async () => {
    await t.stage();
    const stage = document.querySelector<HTMLElement>("[data-slides-stage]")!;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 562.5, right: 1000, bottom: 562.5, x: 0, y: 0, toJSON: () => ({}) });
    const file = png();
    const transfer = { files: [file], items: [{ kind: "file", type: "image/png" }], types: ["Files"], dropEffect: "none" };
    expect(fireEvent.dragOver(stage, { dataTransfer: transfer })).toBe(false);
    // jsdom has no DragEvent: the drop is given its point as the window's would carry it.
    const drop = createEvent.drop(stage, { dataTransfer: transfer });
    Object.defineProperties(drop, { clientX: { value: 250 }, clientY: { value: 140.625 } });
    expect(fireEvent(stage, drop)).toBe(false);
    // Its middle at a quarter across and down: its left 304,800 EMU in; its top would be above the slide, so it is 0.
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "insert", slide: 3, what: "picture", box: [3_048_000 - W / 2, 0, W, H], file: "token:image.png" }]]));
    // A document dropped there keeps its old meaning: the stage leaves it be.
    const doc = { files: [new File(["x"], "plan.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })], items: [{ kind: "file", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }], types: ["Files"] };
    expect(fireEvent.dragOver(stage, { dataTransfer: doc })).toBe(true);
  });

  it("is not taken on a deck he cannot edit", async () => {
    await t.stage(handView({ hand: undefined }));
    const stage = document.querySelector<HTMLElement>("[data-slides-stage]")!;
    expect(fireEvent.dragOver(stage, { dataTransfer: { files: [png()], items: [{ kind: "file", type: "image/png" }], types: ["Files"] } })).toBe(true);
  });
});
