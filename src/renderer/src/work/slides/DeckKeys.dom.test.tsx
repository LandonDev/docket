// @vitest-environment jsdom
/**
 * The deck's own keys in the real canvas pane (docs/agents/work-slides.md
 * "Copy and paste"): ⌘D on the picked shape, ⌘C and ⌘V as the window's copy
 * and paste events, and none of them heard in a field.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
function clipboardEvent(type: "copy" | "paste", data: Map<string, string>): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData: (k: string, v: string) => void data.set(k, v), getData: (k: string) => data.get(k) ?? "", files: [], items: [] } });
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
