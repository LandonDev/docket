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
import type { CanvasShell, ReviewAdapter } from "../canvas/kind";

const host = vi.hoisted(() => ({ view: null as unknown as MediaView, calls: [] as Array<{ method: string; params: Record<string, unknown> }>, viewFails: null as string | null, hold: false }));
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
const seeks = vi.hoisted(() => ({ to: [] as number[], step: 0 }));
vi.mock("./seek", () => ({
  seekToFrame: async (_v: unknown, _t: unknown, n: number) => (seeks.to.push(n), n),
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
import { Bar, Body, selectionChip } from "./MediaCanvas";
import { levelFor, scaleOf } from "./Picture";
import { FEED_FAILED, nativeErrorWords } from "./Player";
import { resetMediaStore } from "./store";

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
  HTMLElement.prototype.setPointerCapture ??= () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.play = async () => undefined;
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

describe("the media canvas", () => {
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

  it("shows a version that failed by the pane's state line alone, with Retry asking the host to start it again", async () => {
    host.view = { itemId: "item1", kind: "video", versions: [{ ...V3, state: "failed", error: "ffprobe could not read it", plays: [] }], notes: [], mode: "writes", shared: false, rev: 1 };
    const shell = fakeShell();
    render(<Body item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={shell} />);
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "trailer v3.mp4 could not be shown", detail: "ffprobe could not read it" })));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.body.textContent).not.toContain("Making a copy");
    // The empty stage under the line, never the player's bones waiting for nothing.
    expect(document.querySelector("[data-media-failed]")).not.toBeNull();
    expect(document.querySelector("[data-media-loading]")).toBeNull();
    const line = shell.statusLine.mock.lastCall![0] as { action: { run(): Promise<void> } };
    await act(() => line.action.run());
    expect(host.calls.filter((c) => c.method === "work.media.view").at(-1)?.params).toMatchObject({ itemId: "item1", retry: true });
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
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't play this video", detail: "The element has no supported sources." })));
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

  it("draws a host that did not answer as the empty stage under the state line, with no bones in the body or the bar", async () => {
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
    await waitFor(() => expect(shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't open this file" })));
    expect(document.querySelector("[data-media-failed]")).not.toBeNull();
    expect(document.querySelector("[data-media-loading]")).toBeNull();
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("holds one bone in the bar while the host reads the file, so the body does not drop when it lands", async () => {
    host.hold = true;
    host.view = { itemId: "item1", kind: "video", versions: [V3], notes: [], mode: "writes", shared: false, rev: 1 };
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("puts History at the bar's end, labelled, and two cuts one over the other in a narrow player", async () => {
    const V2: MediaVersion = { ...V3, id: "v2", n: 2, name: "trailer v2.mp4", addedAt: 0 };
    await mount({ versions: [V2, V3] });
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const history = screen.getByRole("button", { name: "History" });
    expect(history.className).toContain("ms-auto");
    cleanup();
    host.view = { itemId: "item1", kind: "video", versions: [V2, V3], notes: [], mode: "writes", shared: false, rev: 1 };
    render(<Body item={ITEM} source={ITEM.source} env="local" state={{ compare: "v2" }} setState={() => undefined} shell={fakeShell()} />);
    const cuts = await waitFor(() => document.querySelector<HTMLElement>("[data-media-cuts]")!);
    expect(cuts.className).toContain("@[600px]:grid-cols-2");
    expect(cuts.className.split(" ")).not.toContain("grid-cols-2");
    expect(cuts.closest("[data-media-player]")!.className).toContain("@container");
  });

  it("keeps every bar tool whole in a narrow bar: History's word and a picker's day go, the glyph and the version stay", async () => {
    const V2: MediaVersion = { ...V3, id: "v2", n: 2, name: "trailer v2.mp4", addedAt: 0 };
    await mount({ versions: [V2, V3] });
    render(<Bar item={ITEM} source={ITEM.source} env="local" state={undefined} setState={() => undefined} shell={fakeShell()} />);
    const word = within(screen.getByRole("button", { name: "History" })).getByText("History");
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
      await new Promise((r) => setTimeout(r, 500));
    });
    expect((await screen.findByText("Full screen", { selector: "[data-slot=tooltip-content] *, [data-slot=tooltip-content]" })).closest("[data-slot=tooltip-content]")).toBeTruthy();
  });

  it("hands Ask a stretch as the thread reads it, with its exact frames", () => {
    const chip = selectionChip({ title: "Skyblock trailer v3", source: ITEM.source, version: V3, table, stretch: { from: 2112, to: 2304 } });
    expect(chip).toEqual({ kind: "selection", label: "1:28 to 1:36, Skyblock trailer v3", ref: ITEM.source, quote: "v3, frames 2112 to 2304 (00:01:28:00 to 00:01:36:00)" });
    const region = selectionChip({ title: "LAN poster draft", source: ITEM.source, version: { ...V3, plays: [] }, table: null, region: { x: 0.27, y: 0.12, w: 0.31, h: 0.53 } });
    expect(region.label).toBe("Region of LAN poster draft");
    expect(region.quote).toContain("x 0.27, y 0.12, w 0.31, h 0.53");
  });

  it("fits a picture without enlarging it, and draws a huge one from the tile level its zoom needs", () => {
    expect(scaleOf("fit", { width: 1080, height: 1350 }, { width: 600, height: 700 })).toBeCloseTo(652 / 1350);
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
