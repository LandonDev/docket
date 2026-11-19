// @vitest-environment jsdom
/**
 * The media kind's body against a host that answers `work.media.*` from
 * memory (docs/agents/work-media.md, "The canvas"): a comment made at a
 * frame returns to that frame, the agent's waiting notes feed the pane's
 * stepper, and the mode, the written line and a stretch's chip say what
 * they should. jsdom has no decoder, so the seeks are recorded (seek.ts
 * has its own tests, and frameAccuracy.test.ts runs them in Chromium).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameTable, MediaNote, MediaVersion, MediaView } from "@shared/contract-work-media";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import type { CanvasShell, ReviewAdapter } from "../canvas/kind";

const host = vi.hoisted(() => ({ view: null as unknown as MediaView, calls: [] as Array<{ method: string; params: Record<string, unknown> }> }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      host.calls.push({ method, params });
      if (method === "work.media.view") return host.view;
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

import { Body, selectionChip } from "./MediaCanvas";
import { levelFor, scaleOf } from "./Picture";
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
    await waitFor(() => expect(shell.written).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/^Added 7 chapters, /) })));
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
    const line = shell.statusLine.mock.lastCall![0] as { action: { run(): Promise<void> } };
    await act(() => line.action.run());
    expect(host.calls.filter((c) => c.method === "work.media.view").at(-1)?.params).toMatchObject({ itemId: "item1", retry: true });
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
