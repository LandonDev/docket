// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { registry } from "../../../lib/connection/registry";
import type { ComputerEntry } from "../../../lib/computerSessions";
import type { StreamHandle, StreamView, StreamWant } from "../../../lib/video/streams";
import { videoEdge } from "../../../lib/video/support";
import { ENDED_WORDS, RETRY_ENDS, VIEWPORT_INSETS, Viewport, ViewportLine, forgetLeaveSaid, liveFace, streamSize, useDrivingInput, useLiveStream } from "./Viewport";

/** The window's streams, stood in for: each acquire is kept, and the test says what its stream does. */
const h = vi.hoisted(() => ({ supported: true, acquired: [] as FakeStream[], said: [] as string[] }));
vi.mock("@renderer/components/ui/toaster", () => ({ loadToast: async () => Object.assign((words: string) => void h.said.push(words), { error: () => undefined }) }));

interface FakeStream {
  host: string;
  key: string;
  want: StreamWant;
  state: StreamView;
  listeners: Set<() => void>;
  counts: Set<(frames: number, fps: number) => void>;
  clicks: Set<(x: number, y: number) => void>;
  shown: HTMLCanvasElement[];
  hidden: number;
  retried: number;
  released: number;
  inputs: unknown[];
  pasted: string[];
  set(view: StreamView): void;
}

vi.mock("../../../lib/video/support", async (original) => ({ ...(await original<typeof import("../../../lib/video/support")>()), videoSupported: () => h.supported }));
vi.mock("../../../lib/video/streams", () => ({
  videoStreams: {
    acquire(host: string, key: string, want: StreamWant): StreamHandle {
      const stream: FakeStream = {
        host,
        key,
        want,
        state: { status: "opening" },
        listeners: new Set(),
        counts: new Set(),
        clicks: new Set(),
        shown: [],
        hidden: 0,
        retried: 0,
        released: 0,
        inputs: [],
        pasted: [],
        set(view) {
          stream.state = view;
          for (const fn of [...stream.listeners]) fn();
        },
      };
      h.acquired.push(stream);
      return {
        view: () => stream.state,
        subscribe: (fn) => (stream.listeners.add(fn), () => void stream.listeners.delete(fn)),
        show: (canvas) => (stream.shown.push(canvas), () => void stream.hidden++),
        onCount: (fn) => (stream.counts.add(fn), () => void stream.counts.delete(fn)),
        onClick: (fn) => (stream.clicks.add(fn), () => void stream.clicks.delete(fn)),
        input: (event) => void stream.inputs.push(event),
        paste: async (text) => void stream.pasted.push(text),
        retry: () => void stream.retried++,
        release: () => void stream.released++,
      };
    },
  },
}));

const calls: { method: string; params: Record<string, unknown> }[] = [];
const animate = vi.fn();
let width = 304;

beforeEach(() => {
  h.supported = true;
  h.acquired.length = 0;
  h.said.length = 0;
  forgetLeaveSaid();
  calls.length = 0;
  width = 304;
  const link = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method === "computer.preview.start" ? { preview: "pv_1", app: "Chromium", window: "Concur", width: 960, height: 600 } : null;
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  };
  vi.spyOn(registry, "link").mockImplementation(() => link as never);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as never;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: () => undefined })) as never;
  Element.prototype.animate = animate as never;
  Element.prototype.getAnimations = () => [];
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  animate.mockReset();
});

const row = (over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: "s1",
  since: 1,
  lastCallAt: 1,
  apps: [{ name: "Chromium", bundleId: "org.chromium.Chromium", window: "Concur" }],
  running: null,
  tier: "ax",
  ...over,
});
const entry = (key = "s1"): ComputerEntry => ({ host: "box", row: row({ threadId: key }), previewable: true, previewHost: "box", previewKey: key });
const flush = () => act(async () => {});

function Live({ entry: en, run, take, drive, inset = VIEWPORT_INSETS, onOpen, back }: { entry: ComputerEntry; run: boolean; take?: boolean; drive?: boolean; inset?: number; onOpen?: (from: DOMRect) => void; back?: "ready" | "busy" }) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const stream = useLiveStream(en, run, box, root, { inset, ...(take === undefined ? {} : { take }), ...(drive === undefined ? {} : { drive }) });
  useDrivingInput(stream, box);
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  return (
    <div ref={root} data-mode={stream.mode} data-testid="section">
      {back ? (
        <button type="button" data-hand-back disabled={back === "busy"}>
          Hand back
        </button>
      ) : null}
      <Viewport
        ref={box}
        face={over ? null : liveFace(stream, onOpen)}
        label="Live view of Concur in Chromium"
        size={streamSize(state)}
        line={over ? <ViewportLine words={state.status === "ended" ? ENDED_WORDS[state.reason] : "The preview stopped"} onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined} /> : null}
      />
    </div>
  );
}

type MountProps = { run?: boolean; take?: boolean; drive?: boolean; inset?: number; entry?: ComputerEntry; onOpen?: (from: DOMRect) => void; back?: "ready" | "busy" };
function mount(props: MountProps = {}) {
  const tree = (p: MountProps) => <Live entry={p.entry ?? entry()} run={p.run ?? true} take={p.take} drive={p.drive} inset={p.inset} onOpen={p.onOpen ?? props.onOpen} back={p.back} />;
  const view = render(tree(props));
  return { ...view, again: (p: MountProps) => view.rerender(tree(p)) };
}
const box = () => screen.getByRole("img");
const mode = () => screen.getByTestId("section").dataset.mode;
const previewStarts = () => calls.filter((c) => c.method === "computer.preview.start").length;

describe("the live viewport, as video", () => {
  it("asks for video first, at the box's edge in device pixels, as the thread on screen, and starts no picture stream", async () => {
    mount();
    await flush();
    expect(h.acquired).toHaveLength(1);
    expect(h.acquired[0]).toMatchObject({ host: "box", key: "s1", want: { edge: videoEdge(304 - VIEWPORT_INSETS, window.devicePixelRatio), take: true } });
    expect(mode()).toBe("video");
    expect(previewStarts()).toBe(0);
    // a place with nothing around the picture (a tile, the stage) asks for its whole width
    cleanup();
    h.acquired.length = 0;
    mount({ inset: 0 });
    await flush();
    expect(h.acquired[0]!.want.edge).toBe(videoEdge(304, window.devicePixelRatio));
    // a tile is not the thread on screen: it does not take the display
    cleanup();
    h.acquired.length = 0;
    mount({ take: false });
    await flush();
    expect(h.acquired[0].want.take).toBe(false);
  });

  it("shows the skeleton in the stream's shape, then the canvas once a frame is on it, drawn by the stream alone", async () => {
    mount();
    await flush();
    const stream = h.acquired[0];
    const canvas = box().querySelector("canvas")!;
    expect(stream.shown).toEqual([canvas]);
    expect(canvas.className).toContain("invisible");
    await act(async () => stream.set({ status: "opening", width: 1280, height: 800 }));
    expect(box().style.aspectRatio).toBe("1280 / 800");
    expect(box().querySelector('[data-slot="skeleton"]')).not.toBeNull();
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    expect(box().querySelector("canvas")).toBe(canvas);
    expect(canvas.className).not.toContain("invisible");
    expect(box().querySelector('[data-slot="skeleton"]')).toBeNull();
    // nothing here draws on a canvas that is the worker's
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("a box that opens the full view keeps the canvas that took the first frame: one box, a clear button over it, off until then", async () => {
    const onOpen = vi.fn();
    mount({ onOpen });
    await flush();
    const stream = h.acquired[0];
    const opener = screen.getByRole("button", { name: "Live view of Concur in Chromium" });
    const face = document.querySelector<HTMLElement>('[data-face="live"]')!;
    const canvas = face.querySelector("canvas")!;
    // The button lies over the picture; the box, not the button, holds the canvas.
    expect(opener.parentElement).toBe(face);
    expect(opener.querySelector("canvas")).toBeNull();
    expect(stream.shown).toEqual([canvas]);
    // Nothing to open before a frame is there: the same button, off.
    expect(opener.hasAttribute("disabled")).toBe(true);
    await act(async () => stream.set({ status: "opening", width: 1280, height: 800 }));
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    // The first frame swaps nothing: the same box, button and canvas, handed to the stream once.
    expect(document.querySelector('[data-face="live"]')).toBe(face);
    expect(screen.getByRole("button", { name: "Live view of Concur in Chromium" })).toBe(opener);
    expect(face.querySelector("canvas")).toBe(canvas);
    expect(stream.shown).toEqual([canvas]);
    expect(opener.hasAttribute("disabled")).toBe(false);
    fireEvent.click(opener);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("writes the frame count and the rate on the box by hand, and rings the agent's click", async () => {
    mount();
    await flush();
    const stream = h.acquired[0];
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    for (const fn of stream.counts) fn(240, 119);
    expect(box().dataset.frames).toBe("240");
    expect(box().dataset.fps).toBe("119");
    for (const fn of stream.clicks) fn(0.25, 0.5);
    const at = box().querySelector<HTMLElement>('[data-slot="click-mark-at"]')!;
    expect(at.style.left).toBe("25%");
    expect(at.style.top).toBe("50%");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(box().dataset.marks).toBe("1");
  });

  it("gives way to the 4 fps picture, on a canvas of its own, when there is no video to be had", async () => {
    mount();
    await flush();
    const stream = h.acquired[0];
    const videoCanvas = box().querySelector("canvas")!;
    await act(async () => stream.set({ status: "over", face: "picture" }));
    await flush();
    expect(mode()).toBe("picture");
    expect(previewStarts()).toBe(1);
    expect(stream.released).toBe(1);
    // the canvas the worker held is gone: the picture draws on one nothing was handed off
    const pictureCanvas = box().querySelector("canvas")!;
    expect(pictureCanvas).not.toBe(videoCanvas);
    expect(stream.shown).toEqual([videoCanvas]);
  });

  it("goes straight to the picture on a machine that cannot play video", async () => {
    h.supported = false;
    mount();
    await flush();
    expect(h.acquired).toEqual([]);
    expect(mode()).toBe("picture");
    expect(previewStarts()).toBe(1);
  });

  it("says a stream the host ended is over, in the preview's words, with Retry only where trying again can help", async () => {
    mount();
    await flush();
    const stream = h.acquired[0];
    await act(async () => stream.set({ status: "over", face: "stopped" }));
    expect(screen.getByText(ENDED_WORDS.closed)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(previewStarts()).toBe(0);
    await act(async () => stream.set({ status: "over", face: "permission" }));
    expect(screen.getByText(ENDED_WORDS.permission)).not.toBeNull();
    await act(async () => stream.set({ status: "over", face: "stopped", retry: true }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(stream.retried).toBe(1);
  });

  it("lets the stream go when it is not seen, and asks for video again when it is, though the picture stood in before", async () => {
    const view = mount();
    await flush();
    const first = h.acquired[0];
    await act(async () => first.set({ status: "over", face: "picture" }));
    await flush();
    expect(mode()).toBe("picture");
    view.again({ run: false });
    await flush();
    expect(calls.some((c) => c.method === "computer.preview.stop")).toBe(true);
    view.again({ run: true });
    await flush();
    // the display may be free now
    expect(h.acquired).toHaveLength(2);
    expect(mode()).toBe("video");
  });

  it("starts from nothing for another session: its own stream, and no frame of the last one", async () => {
    const view = mount();
    await flush();
    const first = h.acquired[0];
    await act(async () => first.set({ status: "live", width: 1280, height: 800 }));
    view.again({ entry: entry("s2") });
    await flush();
    expect(first.released).toBe(1);
    expect(h.acquired[1]).toMatchObject({ key: "s2" });
    expect(box().querySelector("canvas")!.className).toContain("invisible");
    expect(h.acquired[1].shown).toHaveLength(1);
  });

describe("driving the page from the picture", () => {
  const owned = (): ComputerEntry => ({ ...entry(), row: { ...entry().row, driver: "owner" } });

  it("asks for a stream he drives only for a page he drives, and only from a place that drives", async () => {
    mount();
    await flush();
    expect(h.acquired[0].want.drive).toBe(false);
    cleanup();
    h.acquired.length = 0;
    mount({ entry: owned() });
    await flush();
    expect(h.acquired[0].want.drive).toBe(true);
    // a place that only shows it (the Computer section, a tile)
    cleanup();
    h.acquired.length = 0;
    mount({ entry: owned(), drive: false });
    await flush();
    expect(h.acquired[0].want.drive).toBe(false);
  });

  it("makes the picture his keyboard and pointer once its video is live: a box that takes focus, with no full view to open", async () => {
    mount({ entry: owned() });
    await flush();
    const stream = h.acquired[0];
    // nothing to act on before a frame is on screen
    expect(screen.queryByRole("application")).toBeNull();
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    const box = screen.getByRole("application", { name: "Live view of Concur in Chromium" });
    expect(box.tabIndex).toBe(0);
    expect(box.className).toContain("focus-ring-held");
    expect(box.dataset.driving).toBe("");
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.keyDown(box, { code: "KeyA" });
    fireEvent.keyUp(box, { code: "KeyA" });
    fireEvent.pointerDown(box, { button: 0, clientX: 320, clientY: 100 });
    fireEvent.pointerUp(box, { button: 0, clientX: 320, clientY: 100 });
    expect(stream.inputs).toEqual([
      { type: "keyDown", key: 4, buttons: 0, modifiers: 0 },
      { type: "keyUp", key: 4, buttons: 0, modifiers: 0 },
      { type: "buttonDown", button: 1, x: 0.5, y: 0.25, buttons: 1, modifiers: 0 },
      { type: "buttonUp", button: 1, x: 0.5, y: 0.25, buttons: 0, modifiers: 0 },
    ]);
    // a key that is the page's is stopped here: the app does nothing with it
    const down = new KeyboardEvent("keydown", { code: "KeyK", bubbles: true, cancelable: true });
    box.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("keeps one box and the canvas that took a frame through Take over and Hand back, the full view's button there only while he does not drive", async () => {
    const onOpen = vi.fn();
    const view = mount({ onOpen });
    await flush();
    const watch = h.acquired[0];
    await act(async () => watch.set({ status: "live", width: 1280, height: 800 }));
    const face = document.querySelector<HTMLElement>('[data-face="live"]')!;
    const canvas = face.querySelector("canvas")!;
    const opener = () => document.querySelector<HTMLButtonElement>("[data-viewport-open]");
    expect(opener()!.disabled).toBe(false);
    expect(face.getAttribute("role")).toBeNull();
    // He takes over: a stream he drives, its frame on the canvas already there.
    view.again({ entry: owned(), onOpen });
    await flush();
    const driven = h.acquired.at(-1)!;
    expect(driven.want.drive).toBe(true);
    await act(async () => driven.set({ status: "live", width: 1280, height: 800 }));
    expect(document.querySelector('[data-face="live"]')).toBe(face);
    expect(face.querySelector("canvas")).toBe(canvas);
    expect(screen.getByRole("application", { name: "Live view of Concur in Chromium" })).toBe(face);
    expect(opener()).toBeNull();
    expect(driven.shown.at(-1)).toBe(canvas);
    // He hands back: the same box and canvas, a picture again, and its button back once a frame is on it.
    view.again({ entry: entry(), onOpen });
    await flush();
    const back = h.acquired.at(-1)!;
    await act(async () => back.set({ status: "live", width: 1280, height: 800 }));
    expect(document.querySelector('[data-face="live"]')).toBe(face);
    expect(face.querySelector("canvas")).toBe(canvas);
    expect(face.hasAttribute("data-driving")).toBe(false);
    expect(opener()!.disabled).toBe(false);
    fireEvent.click(opener()!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("lets go of everything he holds when the picture loses the keyboard, and when he hands back", async () => {
    const view = mount({ entry: owned() });
    await flush();
    const stream = h.acquired[0];
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    const box = screen.getByRole("application");
    fireEvent.keyDown(box, { code: "ShiftLeft" });
    fireEvent.blur(box);
    expect(stream.inputs.at(-1)).toEqual({ type: "releaseAll" });
    // he hands back: the row is the agent's once more, and the picture is no keyboard (the host lets go of his keys itself)
    view.again({ entry: entry() });
    await flush();
    expect(screen.queryByRole("application")).toBeNull();
    const sent = stream.inputs.length;
    fireEvent.keyDown(screen.getByRole("img"), { code: "KeyA" });
    expect(stream.inputs).toHaveLength(sent);
  });

  it("is no keyboard trap: Tab and Escape are the page's, and Ctrl+Alt alone takes the keyboard to Hand back", async () => {
    mount({ entry: owned(), back: "ready" });
    await flush();
    const stream = h.acquired[0];
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    const box = screen.getByRole("application");
    expect(box.getAttribute("aria-description")).toMatch(/^Press Control and (Alt|Option) together to leave the page$/);
    box.focus();
    expect(document.activeElement).toBe(box);
    for (const code of ["Tab", "Escape"]) {
      const down = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true });
      box.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      fireEvent.keyUp(box, { code });
    }
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(box, { code: "AltLeft", ctrlKey: true, altKey: true });
    expect(document.activeElement).toBe(box);
    fireEvent.keyUp(box, { code: "AltLeft", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hand back" }));
    // the picture lost the keyboard, so everything he held there is let go
    expect(stream.inputs.at(-1)).toEqual({ type: "releaseAll" });
  });

  it("gives the keyboard up even with no Hand back to take it (a press in flight)", async () => {
    mount({ entry: owned(), back: "busy" });
    await flush();
    await act(async () => h.acquired[0].set({ status: "live", width: 1280, height: 800 }));
    const box = screen.getByRole("application");
    box.focus();
    fireEvent.keyDown(box, { code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(box, { code: "AltLeft", ctrlKey: true, altKey: true });
    fireEvent.keyUp(box, { code: "ControlLeft", altKey: true });
    expect(document.activeElement).not.toBe(box);
  });

  it("says the chord once, when a picture first becomes his to drive, and not at the next take over", async () => {
    const view = mount({ entry: owned() });
    await flush();
    expect(h.said).toEqual([]);
    await act(async () => h.acquired[0].set({ status: "live", width: 1280, height: 800 }));
    await flush();
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toMatch(/^Press (Ctrl\+Alt|⌃⌥) to leave the page$/);
    view.again({ entry: entry() });
    await flush();
    view.again({ entry: owned() });
    await flush();
    await act(async () => h.acquired.at(-1)!.set({ status: "live", width: 1280, height: 800 }));
    await flush();
    expect(h.said).toHaveLength(1);
  });

  it("hands a paste to the host as his clipboard's text", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "hunter2" } });
    mount({ entry: owned() });
    await flush();
    const stream = h.acquired[0];
    await act(async () => stream.set({ status: "live", width: 1280, height: 800 }));
    const box = screen.getByRole("application");
    fireEvent.keyDown(box, { code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(box, { code: "KeyV", ctrlKey: true });
    await flush();
    expect(stream.pasted).toEqual(["hunter2"]);
    expect(stream.inputs.filter((e) => (e as { key?: number }).key === 25)).toEqual([]);
  });
});
});
