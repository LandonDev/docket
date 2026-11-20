// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../../../lib/computers";
import { registry } from "../../../lib/connection/registry";
import { closeFullWindow, fullWindowTarget, openFullWindow } from "../../../lib/fullWindow";
import { CAPTION_REST_MS, FullWindow, FullWindowView } from "./FullWindow";
import fixtures, { streamOf, tile } from "./FullWindow.fixtures";

const h = vi.hoisted(() => ({ tile: null as ComputerTile | null, streams: [] as { key: string; run: boolean }[] }));
vi.mock("../../../lib/computers", async (original) => ({ ...(await original<typeof import("../../../lib/computers")>()), useComputer: () => h.tile }));
vi.mock("./Viewport", async (original) => {
  const actual = await original<typeof import("./Viewport")>();
  return {
    ...actual,
    useLiveStream: (entry: { previewKey?: string } | null, run: boolean) => {
      h.streams.push({ key: entry?.previewKey ?? "", run });
      return { state: { status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true }, retry: () => undefined, canvas: { current: null }, ring: { current: null }, mode: "video", drive: null };
    },
  };
});

const calls: { host: string; method: string; params: unknown }[] = [];
let fail: string | null = null;
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@renderer/components/ui/toaster", () => ({ loadToast: async () => Object.assign(() => undefined, { error: toastError }) }));
const noop = (): void => undefined;

beforeEach(() => {
  calls.length = 0;
  fail = null;
  h.tile = null;
  h.streams.length = 0;
  toastError.mockReset();
  vi.spyOn(registry, "link").mockImplementation(
    (host: string) =>
      ({
        request: async (method: string, params: unknown) => {
          calls.push({ host, method, params });
          if (fail === method) throw new Error("no");
          return null;
        },
      }) as never,
  );
});
afterEach(() => {
  act(() => closeFullWindow());
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const flush = () => act(async () => {});
const view = (over: Partial<Parameters<typeof FullWindowView>[0]> = {}) => <FullWindowView tile={tile()} stream={streamOf({ status: "starting" })} room={{ width: 900, height: 700 }} name="Live view" onExit={noop} onOpenSession={noop} {...over} />;

describe("the full window's body", () => {
  it("draws every fixture: the picture or its line, and one caption under it", () => {
    for (const fixture of fixtures) {
      const v = render(<FullWindowView {...fixture.props} />);
      expect(v.container.querySelectorAll('[data-slot="full-window-caption"]'), fixture.name).toHaveLength(1);
      const over = fixture.props.stream.state.status === "ended" || fixture.props.tile === null;
      expect(!!v.container.querySelector('[data-face="live"]'), fixture.name).toBe(!over);
      expect(!!v.container.querySelector('[data-face="none"]'), fixture.name).toBe(over);
      v.unmount();
    }
  });

  it("holds the picture as large as the window allows in its shape, never past twice its own pixels", () => {
    const frame = { status: "live", app: "Chromium", window: "Concur", width: 1200, height: 800, drawn: true } as const;
    const big = render(view({ stream: streamOf(frame), room: { width: 2400, height: 1600 }, dpr: 2 }));
    // twice its 600-point width, however large the window
    expect((big.container.querySelector('[data-face="live"]')!.parentElement as HTMLElement).style.width).toBe("1200px");
    big.unmount();
    const small = render(view({ stream: streamOf(frame), room: { width: 640, height: 520 }, dpr: 2 }));
    expect((small.container.querySelector('[data-face="live"]')!.parentElement as HTMLElement).style.width).toBe("608px");
  });

  it("fades the caption when the pointer rests, and keeps it while the keyboard is in it", () => {
    const v = render(view({ captionShown: false }));
    const caption = v.container.querySelector<HTMLElement>('[data-slot="full-window-caption"]')!;
    expect(caption.className).toContain("opacity-0");
    expect(caption.className).toContain("has-focus-visible:opacity-100");
    v.rerender(view({ captionShown: true }));
    expect(caption.className).not.toContain("opacity-0");
  });

  it("Take over and Hand back are one call each to the host; Stop stops the one; Leave full window leaves", async () => {
    const exit = vi.fn();
    const v = render(view({ onExit: exit }));
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.drive", params: { computer: "browser:t1", driver: "owner" } }]);
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Stop File the March expense report" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.stop", params: { sessionId: "t1" } }]);
    fireEvent.click(screen.getByRole("button", { name: "Leave full window" }));
    expect(exit).toHaveBeenCalledTimes(1);
    calls.length = 0;
    v.rerender(view({ tile: tile({ driving: true, doing: null }) }));
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.drive", params: { computer: "browser:t1", driver: "agent" } }]);
  });

  it("a window on a Mac has Stop alone, and a press that fails says so once", async () => {
    fail = "computer.stop";
    render(view({ tile: tile({ browser: false, computer: "window:t1", title: "Tidy the Downloads folder" }) }));
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop Tidy the Downloads folder" }));
    await flush();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("says when nothing drives it any more, and still offers the way out", () => {
    render(view({ tile: null }));
    expect(screen.getByText("Nothing is driving this now")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Leave full window" })).not.toBeNull();
  });
});

describe("the full window, live", () => {
  it("opens over the whole app on the store's word, plays its computer's stream, and leaves on Escape", () => {
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view of Expense report in Chromium" }));
    expect(screen.getByRole("dialog", { name: "Live view of Expense report in Chromium" })).not.toBeNull();
    expect(h.streams.at(-1)).toEqual({ key: "t1", run: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fullWindowTarget()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves Escape to the page while the picture he drives holds the keyboard", () => {
    h.tile = tile({ driving: true, doing: null });
    render(
      <>
        <div data-driving tabIndex={0} data-testid="driven" />
        <FullWindow onOpenSession={noop} />
      </>,
    );
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    fireEvent.keyDown(screen.getByTestId("driven"), { key: "Escape" });
    expect(fullWindowTarget()).not.toBeNull();
  });

  it("its title press leaves and goes to the thread", () => {
    h.tile = tile();
    const opened = vi.fn();
    render(<FullWindow onOpenSession={opened} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(fullWindowTarget()).toBeNull();
    expect(opened).toHaveBeenCalledWith("t1", "box");
  });

  it("fades its caption two seconds after the pointer last moved, and brings it back when it moves", () => {
    vi.useFakeTimers();
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    const caption = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="full-window-caption"]')!;
    expect(caption().dataset.shown).toBe("true");
    act(() => vi.advanceTimersByTime(CAPTION_REST_MS));
    expect(caption().dataset.shown).toBeUndefined();
    act(() => void window.dispatchEvent(new Event("pointermove")));
    expect(caption().dataset.shown).toBe("true");
  });
});
