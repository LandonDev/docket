// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionRow } from "@server/shared/contract-computer";
import { registry } from "../../../lib/connection/registry";
import type { ComputerEntry } from "../../../lib/computerSessions";
import type { StreamHandle, StreamView, StreamWant } from "../../../lib/video/streams";
import { videoEdge } from "../../../lib/video/support";
import { ENDED_WORDS, RETRY_ENDS, VIEWPORT_INSETS, Viewport, ViewportLine, liveFace, streamSize, useLiveStream } from "./Viewport";

/** The window's streams, stood in for: each acquire is kept, and the test says what its stream does. */
const h = vi.hoisted(() => ({ supported: true, acquired: [] as FakeStream[] }));

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

function Live({ entry: en, run, take }: { entry: ComputerEntry; run: boolean; take?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const stream = useLiveStream(en, run, box, root, take === undefined ? undefined : { take });
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  return (
    <div ref={root} data-mode={stream.mode} data-testid="section">
      <Viewport
        ref={box}
        face={over ? null : liveFace(stream)}
        label="Live view of Concur in Chromium"
        size={streamSize(state)}
        line={over ? <ViewportLine words={state.status === "ended" ? ENDED_WORDS[state.reason] : "The preview stopped"} onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined} /> : null}
      />
    </div>
  );
}

function mount(props: { run?: boolean; take?: boolean; entry?: ComputerEntry } = {}) {
  const tree = (p: { run?: boolean; take?: boolean; entry?: ComputerEntry }) => <Live entry={p.entry ?? entry()} run={p.run ?? true} take={p.take} />;
  const view = render(tree(props));
  return { ...view, again: (p: { run?: boolean; take?: boolean; entry?: ComputerEntry }) => view.rerender(tree(p)) };
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
});
