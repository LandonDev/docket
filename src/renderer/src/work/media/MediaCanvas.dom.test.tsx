// @vitest-environment jsdom
/**
 * The media kind's body against a host that answers `work.media.*` from
 * memory (docs/agents/work-media.md, "The canvas"): a comment made at a
 * frame returns to that frame, the agent's waiting notes feed the pane's
 * stepper, and the mode, the written line and a stretch's chip say what
 * they should. jsdom has no decoder, so the seeks are recorded (seek.ts
 * has its own tests, and frameAccuracy.test.ts runs them in Chromium).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameTable, MediaNote, MediaVersion, MediaView } from "@shared/contract-work-media";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import type { CanvasShell, ReviewAdapter, StatusLine } from "../canvas/kind";

const host = vi.hoisted(() => ({ view: null as unknown as MediaView, calls: [] as Array<{ method: string; params: Record<string, unknown> }>, viewFails: null as string | null, noteFails: undefined as string | undefined, hold: false }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      host.calls.push({ method, params });
      if (method === "work.media.view") {
        if (host.hold) return new Promise(() => undefined);
        if (host.viewFails) throw new Error(host.viewFails);
        return host.view;
      }
      if (method === "work.media.note") {
        if (host.noteFails) throw new Error(host.noteFails);
        const note: MediaNote = { id: `n${host.view.notes.length + 1}`, itemId: host.view.itemId, kind: "comment", anchor: params.anchor as MediaNote["anchor"], body: String(params.body), by: "owner", state: "kept", resolved: false, createdAt: 9, updatedAt: 9 };
        host.view = { ...host.view, notes: [...host.view.notes, note], rev: host.view.rev + 1 };
        return note;
      }
      if (method === "work.media.decide" || method === "work.media.undo" || method === "work.media.mode") return { ...host.view, rev: host.view.rev + 1 };
      throw new Error(`unexpected ${method}`);
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (l: (x: typeof link, e: string) => void) => (l(link, "added"), () => undefined) } };
});
const seeks = vi.hoisted(() => ({ to: [] as number[], step: 0, hold: false }));
vi.mock("./seek", () => ({
  // `hold`: a seek still out, as one over the link is while he drags.
  seekToFrame: (_v: unknown, _t: unknown, n: number) => (seeks.to.push(n), seeks.hold ? new Promise<number>(() => undefined) : Promise.resolve(n)),
  stepFrame: async () => seeks.step,
  watchFrames: () => () => undefined,
}));
// The proxy's feeder, recorded: jsdom has no Media Source. Each feed keeps what it would tell the player of a failed segment.
const feeds = vi.hoisted(() => [] as Array<{ onError?: (err: unknown) => void; destroyed: boolean }>);
vi.mock("./segments", async (original) => ({
  ...(await original<typeof import("./segments")>()),
  attachSegments: (_video: unknown, _source: unknown, _bytes: unknown, onError?: (err: unknown) => void) => {
    const feed = { onError, destroyed: false };
    feeds.push(feed);
    return { update: () => undefined, destroy: () => void (feed.destroyed = true) };
  },
}));

import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import { dayTime } from "../../lib/duration";
import { StateLine } from "../canvas/CanvasPane";
import { itemsGone } from "../canvas/gone";
import { Bar, Body, fittedSize, selectionChip, stepZoom } from "./MediaCanvas";
import { levelFor, scaleOf } from "./Picture";
import { FEED_FAILED, nativeErrorWords, playWords } from "./Player";
import { Notes } from "./Notes";
import { loadMedia, resetMediaStore } from "./store";

const table: FrameTable = { kind: "cfr", start: 0, rate: { num: 24, den: 1 }, count: 3216 };
const V3: MediaVersion = {
  id: "v3",
  n: 3,
  name: "trailer v3.mp4",
  source: { at: "file", host: "local", path: "/work/trailer v3.mp4" },
  addedAt: 1,
  addedBy: "owner",
  state: "ready",
  probe: { kind: "video", container: "mov,mp4", size: 1, mtimeMs: 1, width: 1920, height: 1080, rotation: 0, codec: "h264", rate: { num: 24, den: 1 }, durationS: 134, frames: 3216 },
  plays: [{ via: "original", url: "tempcode-asset://file/x/trailer.mp4", mime: "video/mp4", table }],
};
const ITEM: CanvasItem = { id: "item1", sessionId: "t1", workspaceId: "w1", kind: "media", title: "Skyblock trailer v3", source: V3.source, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 };
const agentNote = (id: string, frame: number): MediaNote => ({ id, itemId: "item1", kind: "comment", anchor: { versionId: "v3", frame }, body: `note at ${frame}`, by: "agent:local:t1", state: "suggested", resolved: false, createdAt: frame, updatedAt: frame });

function fakeShell(): CanvasShell & { [K in keyof CanvasShell]: ReturnType<typeof vi.fn> } {
  return { review: vi.fn(), selection: vi.fn(), presence: vi.fn(), mode: vi.fn(), statusLine: vi.fn(), written: vi.fn(), detail: vi.fn(), openHistory: vi.fn(), held: vi.fn() } as never;
}

async function mount(view: Partial<MediaView> = {}) {
  host.view = { itemId: "item1", kind: "video", versions: [V3], notes: [], mode: "writes", shared: false, rev: 1, ...view };
  const shell = fakeShell();
  const utils = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />);
  await screen.findByRole("slider", { name: "Frame" });
  return { shell, ...utils };
}

beforeEach(async () => {
  resetMediaStore();
  host.calls = [];
  host.viewFails = null;
  host.hold = false;
  seeks.to = [];
  seeks.hold = false;
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.play = async () => undefined;
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

describe("the media canvas", () => {
  it("shows the spinner over the frame once a stall lasts 300ms, until it plays again; a short wait shows nothing", async () => {
    await mount();
    const video = document.querySelector("video")!;
    const frame = document.querySelector("[data-media-frame]")!;
    fireEvent(video, new Event("waiting"));
    await new Promise((done) => setTimeout(done, 150));
    expect(frame.querySelector("[data-media-stalled]")).toBeNull();
    fireEvent(video, new Event("playing"));
    await new Promise((done) => setTimeout(done, 300));
    expect(frame.querySelector("[data-media-stalled]")).toBeNull();
    // A real stall: the spinner after 300ms, at the frame's centre, and gone once a seek lands or it plays.
    fireEvent(video, new Event("waiting"));
    await waitFor(() => expect(frame.querySelector("[data-media-stalled] [data-slot=spinner]")).not.toBeNull());
    expect(frame.querySelector("[data-media-stalled]")!.getAttribute("role")).toBe("status");
    fireEvent(video, new Event("seeked"));
    await waitFor(() => expect(frame.querySelector("[data-media-stalled]")).toBeNull());
  });

  it("draws the scrubber's head and the clock at the pointer's frame while he drags, before the seek lands", async () => {
    await mount();
    const slider = screen.getByRole("slider", { name: "Frame" });
    slider.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 24);
    seeks.hold = true;
    fireEvent.pointerDown(slider, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 500, pointerId: 1 });
    // Frame 1608 of 3216 (half way, 1:07), though no seek has landed.
    expect(slider.getAttribute("aria-valuenow")).toBe("1608");
    const head = slider.querySelector<HTMLElement>("[data-media-head]")!;
    expect(parseFloat(head.style.left)).toBeCloseTo(50, 0);
    expect(document.querySelector("[data-media-player]")!.textContent).toContain("1:07");
    // Let go with the seek still out: the head stays at the pointer, never back to the frame before.
    fireEvent.pointerUp(slider, { clientX: 500, pointerId: 1 });
    expect(slider.getAttribute("aria-valuenow")).toBe("1608");
  });

  it("draws a vertical short's loading frame at its own shape, the box the player's frame takes, and the transport at its height", async () => {
    const tall: MediaVersion = { ...V3, probe: { ...V3.probe!, width: 1080, height: 1920 } };
    // Still making the copy this viewer plays: the bones, at the probe's shape.
    host.view = { itemId: "item1", kind: "video", versions: [{ ...tall, state: "preparing", plays: [] }], notes: [], mode: "writes", shared: false, rev: 1 };
    const loading = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    // Before the view is read the frame is a bone at 16:9; once the probe is in, it stands at the short's own shape.
    const bone = await waitFor(() => {
      const el = loading.container.querySelector<HTMLElement>("[data-media-frame-bone]");
      expect(el?.getAttribute("style")).toContain(`aspect-ratio: ${1080 / 1920}`);
      return el!;
    });
    const boneBox = bone.getAttribute("style");
    expect(boneBox).toContain(`aspect-ratio: ${1080 / 1920}`);
    expect(loading.container.querySelector("[data-media-track-bone]")!.className).toContain("mt-1.5 flex h-6");
    expect(loading.container.querySelector("[data-media-transport-bone]")!.className).toContain("h-8");
    loading.unmount();
    resetMediaStore();
    // Ready: the player's frame stands in the very box the bones held.
    const { container } = await mount({ versions: [tall] });
    expect(container.querySelector("[data-media-frame]")!.getAttribute("style")).toBe(boneBox);
  });

  it("makes the scrubber the player's one Tab stop, a focusable slider that takes the stepping keys itself", async () => {
    await mount();
    const slider = screen.getByRole("slider", { name: "Frame" });
    const player = document.querySelector<HTMLElement>("[data-media-player]")!;
    expect(slider.tabIndex).toBe(0);
    expect(slider.className.split(" ")).toContain("focus-ring");
    // The player itself is no Tab stop: a click on the picture or full screen gives it the focus.
    expect(player.tabIndex).toBe(-1);
    slider.focus();
    expect(document.activeElement).toBe(slider);
    seeks.step = 984;
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(slider.getAttribute("aria-valuenow")).toBe("984"));
    // One step a key: the player does not step again as the key passes it.
    seeks.to = [];
    fireEvent.keyDown(slider, { key: "Home" });
    await waitFor(() => expect(seeks.to).toEqual([0]));
  });

  it("keeps a comment at the frame it was made on, and a click on it goes back to that frame", async () => {
    await mount();
    // Step to frame 984 (0:41), as the arrow keys do.
    seeks.step = 984;
    fireEvent.keyDown(document.querySelector("[data-media-player]")!, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Frame" }).getAttribute("aria-valuenow")).toBe("984"));

    fireEvent.click(screen.getByRole("button", { name: "Comment at this frame" }));
    const field = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "Title card is still the old logo" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(host.calls.find((c) => c.method === "work.media.note")?.params).toMatchObject({ itemId: "item1", anchor: { versionId: "v3", frame: 984 }, body: "Title card is still the old logo" }));

    // Elsewhere, then back by the row.
    seeks.step = 12;
    fireEvent.keyDown(document.querySelector("[data-media-player]")!, { key: "ArrowLeft" });
    const row = await screen.findByRole("button", { name: /Title card is still the old logo/ });
    expect(row.querySelector("time")!.textContent).toBe("0:41");
    seeks.to = [];
    fireEvent.click(row);
    await waitFor(() => expect(seeks.to).toEqual([984]));
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
  });

  it("says a comment that did not post in his words, never the host's raw line", async () => {
    await mount();
    host.noteFails = "work.media.note: no answer in 30 s";
    try {
      fireEvent.click(screen.getByRole("button", { name: "Comment at this frame" }));
      const field = await screen.findByRole("textbox", { name: "Comment" });
      fireEvent.change(field, { target: { value: "Title card" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(await screen.findByText("The comment did not post.")).toBeTruthy();
      expect(screen.queryByText(/work\.media/i)).toBeNull();
    } finally {
      host.noteFails = undefined;
    }
  });

  it("feeds the agent's waiting notes to the stepper: a step goes to the note's frame, Accept makes it the person's", async () => {
    const { shell } = await mount({ shared: true, mode: "suggests", notes: [agentNote("a", 432), agentNote("b", 1560)] });
    await waitFor(() => expect(shell.review).toHaveBeenLastCalledWith(expect.objectContaining({ count: 2, index: 0 })));
    const review = shell.review.mock.lastCall![0] as ReviewAdapter;
    seeks.to = [];
    act(() => review.step(1));
    await waitFor(() => expect(seeks.to).toEqual([1560]));
    await act(() => review.accept(0));
    expect(host.calls.find((c) => c.method === "work.media.decide")?.params).toEqual({ itemId: "item1", which: "a", accept: true });
    await act(() => review.reject("all"));
    expect(host.calls.filter((c) => c.method === "work.media.decide").at(-1)?.params).toEqual({ itemId: "item1", which: "all", accept: false });
    // A shared cut: the agent suggests, and the person cannot switch it here.
    expect(shell.mode).toHaveBeenLastCalledWith({ value: "suggests", note: "Others review this, so the agent's notes wait for you" });
  });

  it("says what the agent wrote straight onto the person's own file, with its Undo", async () => {
    const { shell } = await mount({ lastWrite: { id: "w1", text: "Added 7 chapters", at: Date.UTC(2026, 10, 18, 19, 4) } });
    // The time in the app's one form: the day named when it was not today.
    await waitFor(() => expect(shell.written).toHaveBeenLastCalledWith(expect.objectContaining({ text: `Added 7 chapters, ${dayTime(Date.UTC(2026, 10, 18, 19, 4))}` })));
    const line = shell.written.mock.lastCall![0] as { undo(): Promise<void> };
    await act(() => line.undo());
    expect(host.calls.find((c) => c.method === "work.media.undo")?.params).toEqual({ itemId: "item1", writeId: "w1" });
    const mode = shell.mode.mock.lastCall![0] as { value: string; set(v: string): void };
    expect(mode.value).toBe("writes");
    await act(async () => mode.set("suggests"));
    expect(host.calls.find((c) => c.method === "work.media.mode")?.params).toEqual({ itemId: "item1", mode: "suggests" });
  });

  it("shows a version that failed as the centred failure with its reason, Retry asking the host to start it again", async () => {
    host.view = { itemId: "item1", kind: "video", versions: [{ ...V3, state: "failed", error: "ffprobe could not read it", plays: [] }], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />);
    const failed = await waitFor(() => {
      const el = document.querySelector("[data-media-failed] [data-canvas-failed]");
      if (!el) throw new Error("no failure drawn yet");
      return el;
    });
    expect(failed.textContent).toContain("Couldn't open this file");
    expect(failed.textContent).toMatch(/ffprobe could not read it/i);
    // Said once: no state line over it, and never the player's bones waiting for nothing.
    expect(shell.statusLine).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "failed" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.body.textContent).not.toContain("Making a copy");
    expect(document.querySelector("[data-media-loading]")).toBeNull();
    // Council round 12 (the walk): Retry spins in place, the failure kept, while the host has not answered.
    host.hold = true;
    try {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      await act(async () => new Promise((settle) => setTimeout(settle, 10)));
      expect(host.calls.filter((c) => c.method === "work.media.view").at(-1)?.params).toMatchObject({ itemId: "item1", retry: true });
      const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      expect(retry.disabled).toBe(true);
      expect(retry.querySelector("[data-busy]")).not.toBeNull();
      expect(document.querySelector("[data-media-failed]")).not.toBeNull();
    } finally {
      host.hold = false;
    }
  });


  it("says a Play the video refused on the state line, with Retry that reads the view again and plays", async () => {
    let refuse = true;
    const plays: number[] = [];
    let loads = 0;
    HTMLMediaElement.prototype.load = () => void loads++;
    HTMLMediaElement.prototype.play = async () => {
      plays.push(Date.now());
      if (refuse) throw new DOMException("The element has no supported sources.", "NotSupportedError");
    };
    const { shell } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    // In his words, never the browser's own message.
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't play this video", detail: "Its format does not play here" })));
    refuse = false;
    const viewsBefore = host.calls.filter((c) => c.method === "work.media.view").length;
    const line = shell.statusLine.mock.lastCall![0] as { action: { label: string; run(): Promise<void> } };
    expect(line.action.label).toBe("Retry");
    await act(() => line.action.run());
    expect(host.calls.filter((c) => c.method === "work.media.view").length).toBe(viewsBefore + 1);
    expect(loads).toBeGreaterThan(0);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(null));
    expect(plays).toHaveLength(2);
  });

  it("says a proxy segment that failed after Play on the state line, and Retry builds the feed again where it stood", async () => {
    feeds.length = 0;
    const plays: number[] = [];
    HTMLMediaElement.prototype.load = () => undefined;
    HTMLMediaElement.prototype.play = async () => void plays.push(Date.now());
    const HLS: MediaVersion = { ...V3, plays: [{ via: "hls", init: "init", segments: [{ start: 0, duration: 4 }], ended: true, mime: 'video/mp4; codecs="avc1.640028"', table, why: "long" }] };
    const { shell } = await mount({ versions: [HLS] });
    await waitFor(() => expect(feeds).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(plays).toHaveLength(1));
    // The picture plays, then a segment does not come: the feed stops, and the state line says why.
    act(() => feeds[0]!.onError?.(new Error("socket closed")));
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't play this video", detail: FEED_FAILED })));
    const line = shell.statusLine.mock.lastCall![0] as { action: { label: string; run(): Promise<void> } };
    expect(line.action.label).toBe("Retry");
    await act(() => line.action.run());
    // A new feed in the old one's place, and the video plays again from there.
    await waitFor(() => expect(feeds).toHaveLength(2));
    expect(feeds[0]!.destroyed).toBe(true);
    expect(feeds[1]!.destroyed).toBe(false);
    await waitFor(() => expect(plays).toHaveLength(2));
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(null));
  });

  it("says the video element's own error after Play on the state line, and Retry loads it again where it stood and plays", async () => {
    const plays: number[] = [];
    let loads = 0;
    HTMLMediaElement.prototype.load = () => void loads++;
    HTMLMediaElement.prototype.play = async () => void plays.push(Date.now());
    const { shell } = await mount();
    const video = document.querySelector("video")!;
    let at = 0;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => at, set: (t: number) => void (at = t) });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(plays).toHaveLength(1));
    // It plays to 0:41, then the connection drops: the element fails with no refusal from Play.
    at = 41;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't play this video", detail: "The video stopped loading" })));
    const line = shell.statusLine.mock.lastCall![0] as { action: { label: string; run(): Promise<void> } };
    expect(line.action.label).toBe("Retry");
    // The load sends the element back to the start; Retry puts it back where it stood.
    HTMLMediaElement.prototype.load = function (this: HTMLMediaElement) {
      loads++;
      if (this === video) at = 0;
    };
    Object.defineProperty(video, "error", { configurable: true, value: null });
    await act(() => line.action.run());
    expect(loads).toBeGreaterThan(0);
    expect(at).toBe(41);
    await waitFor(() => expect(plays).toHaveLength(2));
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(null));
  });

  it("hears nothing of an element error from its own teardown or a source it swapped", async () => {
    const { shell } = await mount();
    const video = document.querySelector("video")!;
    // A swap aborts the old source.
    Object.defineProperty(video, "error", { configurable: true, value: { code: 1 } });
    fireEvent.error(video);
    // A teardown takes the source away, then loads nothing.
    video.removeAttribute("src");
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);
    await act(async () => await Promise.resolve());
    expect(shell.statusLine).not.toHaveBeenCalledWith(expect.objectContaining({ word: "Couldn't play this video" }));
  });

  it("says a refused Play by its kind, never the browser's message", () => {
    expect(playWords("NotSupportedError")).toBe("Its format does not play here");
    expect(playWords("NotAllowedError")).toBe("Its file did not load");
    expect(playWords(undefined)).toBe("Its file did not load");
  });

  it("names each element error by its code", () => {
    const el = (code: number | null, src: string | null = "x.mp4") => ({ error: code === null ? null : ({ code } as MediaError), getAttribute: () => src });
    expect(nativeErrorWords(el(null))).toBeNull();
    expect(nativeErrorWords(el(1))).toBeNull();
    expect(nativeErrorWords(el(2))).toBe("The video stopped loading");
    expect(nativeErrorWords(el(3))).toBe("Part of the video could not be read");
    expect(nativeErrorWords(el(4))).toBe("This video cannot be played here");
    expect(nativeErrorWords(el(4, null))).toBeNull();
  });

  it("takes a Pause that cut a starting Play for no refusal", async () => {
    HTMLMediaElement.prototype.play = async () => {
      throw new DOMException("The play() request was interrupted by a call to pause().", "AbortError");
    };
    const { shell } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await act(async () => await Promise.resolve());
    expect(shell.statusLine).not.toHaveBeenCalledWith(expect.objectContaining({ word: "Couldn't play this video" }));
  });

  it("draws a host that did not answer as the centred failure, with no state line and no bones in the body or the bar", async () => {
    host.viewFails = "The host did not answer";
    host.view = { itemId: "item1", kind: "video", versions: [V3], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    render(
      <>
        <Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />
        <div data-bar>
          <Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />
        </div>
      </>,
    );
    const failed = await waitFor(() => {
      const el = document.querySelector("[data-media-failed] [data-canvas-failed]");
      if (!el) throw new Error("no failure drawn yet");
      return el;
    });
    expect(failed.textContent).toContain("Couldn't open this file");
    expect(shell.statusLine).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "failed" }));
    expect(document.querySelector("[data-media-loading]")).toBeNull();
    expect(document.querySelector("[data-bone], [skullet-loading]")).toBeNull();
  });

  it("holds one bone in the bar while the host reads the file, so the body does not drop when it lands", async () => {
    host.hold = true;
    host.view = { itemId: "item1", kind: "video", versions: [V3], notes: [], mode: "writes", shared: false, rev: 1 };
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    expect(document.querySelector("[data-media-bar-bone]")).not.toBeNull();
  });

  it("puts Versions at the bar's end, labelled, with its tip, and two cuts one over the other in a narrow player", async () => {
    const V2: MediaVersion = { ...V3, id: "v2", n: 2, name: "trailer v2.mp4", addedAt: 0 };
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    await mount({ versions: [V2, V3] });
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const versions = screen.getByRole("button", { name: "Versions" });
    expect(versions.className).toContain("ms-auto");
    // In the narrow bar it is the glyph alone: the tip names it.
    await act(async () => {
      fireEvent.pointerEnter(versions, { pointerType: "mouse" });
      fireEvent.mouseEnter(versions);
      fireEvent.mouseMove(versions);
    });
    expect((await screen.findByText("Versions", { selector: "[data-slot=tooltip-content] *, [data-slot=tooltip-content]" })).closest("[data-slot=tooltip-content]")).toBeTruthy();
    cleanup();
    host.view = { itemId: "item1", kind: "video", versions: [V2, V3], notes: [], mode: "writes", shared: false, rev: 1 };
    render(<Body item={ITEM} source={ITEM.source} env="local" state={{ compare: "v2" }} setState={() => undefined} shell={fakeShell()} />);
    const cuts = await waitFor(() => document.querySelector<HTMLElement>("[data-media-cuts]")!);
    expect(cuts.className).toContain("@[600px]:grid-cols-2");
    expect(cuts.className.split(" ")).not.toContain("grid-cols-2");
    expect(cuts.closest("[data-media-player]")!.className).toContain("@container");
  });

  it("keeps every bar tool whole in a narrow bar: Versions' word and a picker's day go, the glyph and the version stay", async () => {
    const V2: MediaVersion = { ...V3, id: "v2", n: 2, name: "trailer v2.mp4", addedAt: 0 };
    await mount({ versions: [V2, V3] });
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const word = within(screen.getByRole("button", { name: "Versions" })).getByText("Versions");
    expect(word.hasAttribute("data-narrow-hide")).toBe(true);
    expect(word.className).toContain("@max-[560px]/bar:hidden");
    cleanup();
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={{ compare: "v2" }} setState={() => undefined} shell={fakeShell()} />);
    const pickers = screen.getAllByRole("button").filter((b) => /^v\d/.test(b.textContent ?? ""));
    expect(pickers).toHaveLength(2);
    for (const picker of pickers) {
      const day = picker.querySelector("[data-narrow-hide]");
      expect(day?.className).toContain("@max-[560px]/bar:hidden");
    }
  });

  it("starts a chapter's title 8px after its time, with no empty author column", async () => {
    const chapter: MediaNote = { id: "c1", itemId: "item1", kind: "chapter", anchor: { versionId: "v3", frame: 240 }, body: "Intro", by: "owner", state: "kept", resolved: false, createdAt: 1, updatedAt: 1 };
    await mount({ notes: [chapter] });
    const row = screen.getByRole("button", { name: /Intro/ });
    expect(row.children).toHaveLength(2);
    expect(row.children[1].className).toContain("col-span-2");
  });

  it("names every icon control in the transport on hover", async () => {
    await mount();
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      warmTooltips();
      await tooltipChunk.load();
      await Promise.resolve();
    });
    const full = screen.getByRole("button", { name: "Full screen" });
    await act(async () => {
      fireEvent.pointerEnter(full, { pointerType: "mouse" });
      fireEvent.mouseEnter(full);
      fireEvent.mouseMove(full);
    });
    expect((await screen.findByText("Full screen", { selector: "[data-slot=tooltip-content] *, [data-slot=tooltip-content]" })).closest("[data-slot=tooltip-content]")).toBeTruthy();
  });

  it("puts the whole player full screen, the track and the transport with the frame, and gives it the focus", async () => {
    await mount();
    const asked: Element[] = [];
    const before = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = function (this: HTMLElement) {
      asked.push(this);
      Object.defineProperty(document, "fullscreenElement", { value: this, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    try {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Full screen" })));
      const player = document.querySelector<HTMLElement>("[data-media-player]")!;
      expect(asked).toEqual([player]);
      expect(player.contains(screen.getByRole("slider", { name: "Frame" }))).toBe(true);
      // Space plays from the player now, never presses Full screen again.
      await waitFor(() => expect(document.activeElement).toBe(player));
      expect(screen.getByRole("button", { name: "Leave full screen" })).toBeTruthy();
      // Full screen lifts the frame's 58vh cap to the screen less the track and the transport.
      expect(player.className).toContain("[&:fullscreen]:[--frame-cap:calc(100vh_-_96px)]");
      expect(document.querySelector("[data-media-frame]")!.getAttribute("style")).toContain("var(--frame-cap, 58vh)");
    } finally {
      HTMLElement.prototype.requestFullscreen = before;
      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    }
  });

  it("opens Comment and Speed inside the player while it is full screen, where the screen draws them", async () => {
    await mount();
    const player = document.querySelector<HTMLElement>("[data-media-player]")!;
    Object.defineProperty(document, "fullscreenElement", { value: player, configurable: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Comment at this frame" }));
      const field = await screen.findByRole("textbox", { name: "Comment" });
      // The browser draws nothing over a full-screen element: the box is inside it, so Space types where he sees.
      expect(player.contains(field)).toBe(true);
      fireEvent.keyDown(field, { key: "Escape" });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "1×" })));
      expect(player.contains(await screen.findByRole("menu", { name: "Speed" }))).toBe(true);
    } finally {
      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    }
  });

  it("drops a stall's spinner and its timer when the first video changes, so the new version never shows the old wait", async () => {
    const V4: MediaVersion = { ...V3, id: "v4", n: 4, name: "trailer v4.mp4" };
    host.view = { itemId: "item1", kind: "video", versions: [V3, V4], notes: [], mode: "writes", shared: false, rev: 1 };
    const props = { item: ITEM, source: ITEM.source, env: "local", setState: () => undefined, shell: fakeShell() };
    const { rerender } = render(<Body {...props} state={{ versionId: "v3" }} />);
    await screen.findByRole("slider", { name: "Frame" });
    fireEvent(document.querySelector("video")!, new Event("waiting"));
    rerender(<Body {...props} state={{ versionId: "v4" }} />);
    await new Promise((done) => setTimeout(done, 400));
    expect(document.querySelector("[data-media-stalled]")).toBeNull();
  });

  it("hands the pane a lost answer as it came, so the pane words it once and names the computer", async () => {
    const { shell } = await mount();
    host.viewFails = "No answer in 30s";
    await act(async () => void (await loadMedia("local", "item1").catch(() => undefined)));
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't open this file", detail: "No answer in 30s" })));
  });

  it("says a copy being made to play as getting it ready, its share at the end, in the frame's place", async () => {
    host.view = { itemId: "item1", kind: "video", versions: [{ ...V3, state: "preparing", plays: [], progress: 0.34 }], notes: [], mode: "writes", shared: false, rev: 1 };
    const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const preparing = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-media-preparing]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(preparing.textContent).toContain("Getting it ready to play 34%");
    expect(container.textContent).not.toContain("this viewer");
    // In the frame's bone, not under it beside the notes' bones.
    expect(preparing.closest("[data-media-frame-bone]")).not.toBeNull();
    expect(container.querySelectorAll("[data-media-frame-bone]")).toHaveLength(1);
  });

  it("shows a saved comment at once, before the view is read again", async () => {
    await mount();
    host.hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Comment at this frame" }));
    const field = await screen.findByRole("textbox", { name: "Comment" });
    fireEvent.change(field, { target: { value: "Logo too small" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // The view read after it never answers here: the row comes from the note's own answer.
    expect(await screen.findByRole("button", { name: /Logo too small/ })).toBeTruthy();
  });

  it("steps every note row's fill on a press, the waiting and the playing rows too", () => {
    const kept: MediaNote = { ...agentNote("k1", 24), by: "owner", state: "kept" };
    render(<Notes notes={[kept, agentNote("a1", 48), { ...kept, id: "k2", anchor: { versionId: "v3", frame: 72 } }]} table={table} current="k2" playing={null} onPick={() => undefined} />);
    const rows = document.querySelectorAll<HTMLElement>("[data-note]");
    for (const row of rows) {
      expect(row.className.split(" ")).toEqual(expect.arrayContaining(["active:bg-foreground/12", "active:transition-none"]));
      expect(row.className).not.toMatch(/active:scale/);
    }
    // A plain row hovers; a waiting or a current row keeps its own fill.
    expect(rows[0].className).toContain("hover:bg-foreground/5");
    expect(rows[1].className).toContain("bg-(--add-bg)");
    expect(rows[2].className).toContain("bg-muted");
  });

  it("says a compare's failed version in his words, never the host's raw line", async () => {
    const V2: MediaVersion = { ...V3, id: "v2", n: 2, name: "trailer v2.mp4", state: "failed", error: "ffprobe: /srv/work/trailer v2.mp4: Invalid data found", plays: [] };
    host.view = { itemId: "item1", kind: "video", versions: [V2, V3], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    render(<Body item={ITEM} source={ITEM.source} env="local" state={{ compare: "v2" }} setState={() => undefined} shell={shell} />);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "trailer v2.mp4 could not be shown" })));
    // The pane words the reason once (`StateLine`): a raw line shows no detail, only the line's own word.
    const line = shell.statusLine.mock.lastCall![0] as StatusLine;
    render(<StateLine line={line} />);
    const shown = document.querySelector("[data-canvas-state=failed]")!;
    expect(shown.textContent).toContain("trailer v2.mp4 could not be shown");
    expect(shown.textContent).not.toContain("ffprobe");
  });

  it("hands Ask a stretch as the thread reads it, with its exact frames", () => {
    const chip = selectionChip({ title: "Skyblock trailer v3", source: ITEM.source, version: V3, table, stretch: { from: 2112, to: 2304 } });
    expect(chip).toEqual({ kind: "selection", label: "1:28 to 1:36, Skyblock trailer v3", ref: ITEM.source, quote: "v3, frames 2112 to 2304 (00:01:28:00 to 00:01:36:00)" });
    const region = selectionChip({ title: "LAN poster draft", source: ITEM.source, version: { ...V3, plays: [] }, table: null, region: { x: 0.27, y: 0.12, w: 0.31, h: 0.53 } });
    expect(region.label).toBe("Region of LAN poster draft");
    expect(region.quote).toContain("x 0.27, y 0.12, w 0.31, h 0.53");
  });

  it("says a picture whose bytes did not load on the state line, keeps its frame's size, and Retry loads it afresh", async () => {
    const IMG: MediaVersion = { ...V3, id: "p1", name: "LAN poster.png", plays: [{ via: "image", url: "tempcode-asset://file/x/poster.png", width: 1080, height: 1350 }] };
    host.view = { itemId: "item1", kind: "image", versions: [IMG], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />);
    const picture = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>("[data-media-picture]");
      expect(el).not.toBeNull();
      return el!;
    });
    const frame = picture.parentElement!;
    const box = frame.getAttribute("style");
    // The bytes do not load: the state line says so, with Retry; the frame keeps its size and shows no broken mark.
    fireEvent.error(picture);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't show this image" })));
    expect(frame.getAttribute("style")).toBe(box);
    expect(frame.getAttribute("style")).toContain("aspect-ratio");
    expect(container.querySelector("[data-media-picture]")!.className).toContain("invisible");
    // Retry reads the view again and loads the picture afresh (a new element), then the line clears once it draws.
    const viewsBefore = host.calls.filter((c) => c.method === "work.media.view").length;
    const line = shell.statusLine.mock.lastCall![0] as { action: { label: string; run(): Promise<void> } };
    expect(line.action.label).toBe("Retry");
    await act(() => line.action.run());
    expect(host.calls.filter((c) => c.method === "work.media.view").length).toBe(viewsBefore + 1);
    const again = container.querySelector<HTMLImageElement>("[data-media-picture]")!;
    expect(again).not.toBe(picture);
    fireEvent.load(again);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(null));
    expect(again.className).not.toContain("invisible");
  });

  it("keeps a picture's fit only while its item is open (perf M11)", async () => {
    const IMG: MediaVersion = { ...V3, id: "p1", name: "LAN poster.png", plays: [{ via: "image", url: "tempcode-asset://file/x/poster.png", width: 1080, height: 1350 }] };
    host.view = { itemId: "item1", kind: "image", versions: [IMG], notes: [], mode: "writes", shared: false, rev: 1 };
    render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    await waitFor(() => expect(fittedSize()).toBe(1));
    itemsGone(["another"]);
    expect(fittedSize()).toBe(1);
    itemsGone([ITEM.id]);
    expect(fittedSize()).toBe(0);
  });

  it("holds a bone in the picture's frame until its bytes land, under the picture, and never after", async () => {
    const IMG: MediaVersion = { ...V3, id: "p1", name: "LAN poster.png", plays: [{ via: "image", url: "tempcode-asset://file/x/poster.png", width: 1080, height: 1350 }] };
    host.view = { itemId: "item1", kind: "image", versions: [IMG], notes: [], mode: "writes", shared: false, rev: 1 };
    const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const picture = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>("[data-media-picture]");
      expect(el).not.toBeNull();
      return el!;
    });
    const bone = picture.parentElement!.querySelector("[data-media-picture-loading]")!;
    expect(bone).not.toBeNull();
    // First in the frame, so the picture paints over it as it draws.
    expect(picture.parentElement!.firstElementChild).toBe(bone);
    fireEvent.load(picture);
    await waitFor(() => expect(container.querySelector("[data-media-picture-loading]")).toBeNull());
  });

  it("says a tiled picture whose preview did not load on the state line, with Retry", async () => {
    const BIG: MediaVersion = {
      ...V3,
      id: "p2",
      name: "Arena map.tif",
      plays: [{ via: "tiles", preview: "tempcode-asset://file/x/map-preview.jpg", width: 8192, height: 4096, tile: 254, overlap: 1, levels: 14, minLevel: 9, format: "jpg" }],
    };
    host.view = { itemId: "item1", kind: "image", versions: [BIG], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />);
    const preview = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>("[data-media-picture]");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.error(preview);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't show this image" })));
    const line = shell.statusLine.mock.lastCall![0] as { action: { run(): Promise<void> } };
    await act(() => line.action.run());
    fireEvent.load(container.querySelector<HTMLImageElement>("[data-media-picture]")!);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(null));
  });

  it("draws a picture 12px in at radius 8, and its size and bytes as one sentence in the bar", async () => {
    const IMG: MediaVersion = { ...V3, id: "p1", name: "LAN poster.png", probe: { ...V3.probe!, kind: "image", size: 2_100_000 }, plays: [{ via: "image", url: "tempcode-asset://file/x/poster.png", width: 1600, height: 2000 }] };
    host.view = { itemId: "item1", kind: "image", versions: [IMG], notes: [], mode: "writes", shared: false, rev: 1 };
    const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const picture = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-media-picture]");
      expect(el).not.toBeNull();
      return el!;
    });
    const frame = picture.parentElement!;
    expect(frame.className).toContain("rounded-lg");
    expect(frame.parentElement!.className.split(" ")).toContain("p-3");
    expect(frame.getAttribute("style")).toContain("100cqw - 24px");
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    expect(document.querySelector("[data-media-facts]")!.textContent).toBe("1600 × 2000, 2.1 MB");
  });

  it("steps the zoom from the scale Fit shows, never as if Fit were 100%", async () => {
    expect(stepZoom("fit", 0.3, 1)).toBe(0.5);
    expect(stepZoom("fit", 0.3, -1)).toBe(0.25);
    expect(stepZoom("fit", undefined, 1)).toBe(2);
    expect(stepZoom(4, undefined, 1)).toBeUndefined();
    // In the bar: a poster fitted to a small stage at about 35% zooms in to 50%, and out to 25%, never larger.
    const IMG: MediaVersion = { ...V3, id: "p1", name: "LAN poster.png", plays: [{ via: "image", url: "tempcode-asset://file/x/poster.png", width: 1080, height: 1350 }] };
    host.view = { itemId: "item1", kind: "image", versions: [IMG], notes: [], mode: "writes", shared: false, rev: 1 };
    const sizes = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-media-stage") ? 400 : 0;
    });
    const heights = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-media-stage") ? 500 : 0;
    });
    try {
      const { container } = render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
      await waitFor(() => expect(container.querySelector("[data-media-picture]")).not.toBeNull());
      const set = vi.fn();
      render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={set} shell={fakeShell()} />);
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(set).toHaveBeenLastCalledWith({ zoom: 0.5 });
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      expect(set).toHaveBeenLastCalledWith({ zoom: 0.25 });
    } finally {
      sizes.mockRestore();
      heights.mockRestore();
    }
  });

  it("fits a picture without enlarging it, and draws a huge one from the tile level its zoom needs", () => {
    // Inside the 12px inset on each side.
    expect(scaleOf("fit", { width: 1080, height: 1350 }, { width: 600, height: 700 })).toBeCloseTo(676 / 1350);
    expect(scaleOf("fit", { width: 200, height: 100 }, { width: 600, height: 700 })).toBe(1);
    expect(scaleOf(2, { width: 1, height: 1 }, { width: 0, height: 0 })).toBe(2);
    // 8192 px wide: levels 0 to 13 (14 of them), tiles cut from level 9 up.
    expect(levelFor(1, 14, 9)).toBe(13);
    expect(levelFor(0.5, 14, 9)).toBe(12);
    expect(levelFor(0.3, 14, 9)).toBe(12);
    expect(levelFor(0.2, 14, 9)).toBe(11);
    expect(levelFor(0.02, 14, 9)).toBeNull();
  });
});
