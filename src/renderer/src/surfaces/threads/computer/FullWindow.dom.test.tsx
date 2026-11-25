// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../../../lib/computers";
import { registry } from "../../../lib/connection/registry";
import { closeFullWindow, fullWindowTarget, openFullWindow } from "../../../lib/fullWindow";
import { saveMotionPreference } from "../../../lib/motion";
import { BAR_LEAVE_MS, BAR_REST_MS, EDGE, FullWindow, FullWindowView, growFrom, inEdge } from "./FullWindow";
import { FULL_SCREEN_HINT_MS, FullScreenHint } from "./FullScreenHint";
import fixtures, { streamOf, tile } from "./FullWindow.fixtures";

const h = vi.hoisted(() => ({
  tile: null as ComputerTile | null,
  streams: [] as { key: string; run: boolean }[],
  // main's answers: whether the window was full before each ask, and what it tells of its full screen
  asks: [] as { on: boolean; popOut?: boolean }[],
  wasFull: false,
  told: null as ((state: { on: boolean; popOut: boolean }) => void) | null,
  // the stream's drive while he drives, and what the page asks of main's keyboard hold
  drive: null as null | { send: () => void; paste: () => void; copy: () => Promise<string> },
  holds: [] as boolean[],
  heldKey: null as ((key: "freed" | "closeWindow") => void) | null,
}));
vi.mock("../../../lib/native", async (original) => ({
  ...(await original<typeof import("../../../lib/native")>()),
  setWindowFullScreen: async (ask: { on: boolean; popOut?: boolean }) => (h.asks.push(ask), h.wasFull),
  onWindowFullScreen: (fn: (state: { on: boolean; popOut: boolean }) => void) => ((h.told = fn), () => void (h.told = null)),
  holdKeyboard: async (on: boolean) => (h.holds.push(on), on),
  onHeldKey: (fn: (key: "freed" | "closeWindow") => void) => ((h.heldKey = fn), () => void (h.heldKey = null)),
}));
vi.mock("../../../lib/computers", async (original) => ({ ...(await original<typeof import("../../../lib/computers")>()), useComputer: () => h.tile }));
vi.mock("./Viewport", async (original) => {
  const actual = await original<typeof import("./Viewport")>();
  return {
    ...actual,
    useLiveStream: (entry: { previewKey?: string } | null, run: boolean) => {
      h.streams.push({ key: entry?.previewKey ?? "", run });
      return { state: { status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true }, retry: () => undefined, canvas: { current: null }, ring: { current: null }, mode: "video", drive: h.drive };
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
  h.asks.length = 0;
  h.wasFull = false;
  h.told = null;
  h.drive = null;
  h.holds.length = 0;
  h.heldKey = null;
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
  it("draws every fixture: the picture or its line, and one bar over it", () => {
    for (const fixture of fixtures) {
      const v = render(<FullWindowView {...fixture.props} />);
      expect(v.container.querySelectorAll('[data-slot="full-window-bar"]'), fixture.name).toHaveLength(1);
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
    // 608 would be 1.01 screen pixels a pixel: it is drawn one to one, 600, and sharp (stageLayout.ts fitStage)
    expect((small.container.querySelector('[data-face="live"]')!.parentElement as HTMLElement).style.width).toBe("600px");
  });

  it("fills the display with a whole computer's screen, and holds a window's picture to twice its pixels, pixelated at 2:1", () => {
    const vm = { status: "live", app: "Windows", window: "Desktop", width: 1280, height: 800, drawn: true } as const;
    const picture = (v: ReturnType<typeof render>): HTMLElement => v.container.querySelector<HTMLElement>('[data-face="live"]')!;
    // the ASUS: 2880 by 1800 of its 3200 by 1800 points, drawn smooth at 4.5 screen pixels a pixel
    const asus = render(view({ tile: tile({ computer: "vm:windows" }), stream: streamOf(vm), room: { width: 3200, height: 1800 }, dpr: 2 }));
    expect(picture(asus).parentElement!.style.width).toBe("2880px");
    expect(picture(asus).dataset.pixelated).toBeUndefined();
    asus.unmount();
    // the MacBook: its full width, 1728
    const mac = render(view({ tile: tile({ computer: "vm:windows" }), stream: streamOf(vm), room: { width: 1728, height: 1117 }, dpr: 2 }));
    expect(picture(mac).parentElement!.style.width).toBe("1728px");
    mac.unmount();
    // a window's picture of that size stops at 1280, two screen pixels to each of its own, and is drawn crisp
    const win = render(view({ stream: streamOf(vm), room: { width: 3200, height: 1800 }, dpr: 2 }));
    expect(picture(win).parentElement!.style.width).toBe("1280px");
    expect(picture(win).dataset.pixelated).toBe("true");
    expect(picture(win).className).toContain("[image-rendering:pixelated]");
  });

  it("floats the computer's bar over the top edge's middle, on the popover's ground, 8px down and no wider than 560", () => {
    const v = render(view());
    const bar = v.container.querySelector<HTMLElement>('[data-slot="full-window-bar"]')!;
    expect(bar.className).toContain("absolute top-2 left-1/2");
    expect(bar.className).toContain("w-[min(560px,calc(100%-32px))]");
    expect(bar.className).toContain("bg-popover");
    expect(bar.querySelector('[data-slot="computer-bar"]')).not.toBeNull();
    // narrow by design, it gives nothing way: the delay and Pop out stay
    expect(bar.querySelector('[data-slot="computer-bar"]')!.className).not.toContain("@container/bar");
  });

  it("away, the bar is gone from the eye, the pointer and a screen reader; called, it comes back", () => {
    const v = render(view({ barShown: false }));
    const bar = v.container.querySelector<HTMLElement>('[data-slot="full-window-bar"]')!;
    expect(bar.className).toContain("opacity-0");
    expect(bar.className).toContain("pointer-events-none");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    v.rerender(view({ barShown: true }));
    expect(bar.className).not.toContain("opacity-0");
    expect(bar.hasAttribute("aria-hidden")).toBe(false);
  });

  it("Take over and Hand back are one call each to the host; Stop stops the one; Leave full screen leaves", async () => {
    const exit = vi.fn();
    const v = render(view({ onExit: exit }));
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.drive", params: { computer: "browser:t1", driver: "owner" } }]);
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Stop File the March expense report" }));
    await flush();
    expect(calls).toEqual([{ host: "box", method: "computer.stop", params: { sessionId: "t1" } }]);
    fireEvent.click(screen.getByRole("button", { name: "Leave full screen" }));
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
    expect(screen.getByRole("button", { name: "Leave full screen" })).not.toBeNull();
  });
});

describe("full screen, live", () => {
  it("takes the window full screen as it opens and puts it back as it closes; a window full before stays full", async () => {
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    expect(screen.getByRole("dialog").className).toContain("bg-matte");
    await flush();
    expect(h.asks).toEqual([{ on: true }]);
    act(() => closeFullWindow());
    await flush();
    expect(h.asks).toEqual([{ on: true }, { on: false }]);
    h.asks.length = 0;
    h.wasFull = true;
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    await flush();
    act(() => closeFullWindow());
    await flush();
    expect(h.asks).toEqual([{ on: true }]);
  });

  it("closes when the window leaves full screen some other way, and not for its pop-out's", async () => {
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    await flush();
    act(() => h.told?.({ on: false, popOut: true }));
    expect(fullWindowTarget()).not.toBeNull();
    act(() => h.told?.({ on: false, popOut: false }));
    expect(fullWindowTarget()).toBeNull();
  });

  it("leaves on a double click on a picture he does not drive", () => {
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    fireEvent.doubleClick(screen.getByRole("img", { name: "Live view" }));
    expect(fullWindowTarget()).toBeNull();
  });

  it("holds a pressed picture unseen until it grows from its place; a key's entry shows at once", async () => {
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view", from: { x: 100, y: 80, width: 640, height: 400 } }));
    const picture = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="full-window-picture"]')!;
    expect(picture().style.opacity).toBe("0");
    act(() => closeFullWindow());
    expect(document.querySelector('[data-slot="full-window-picture"]')).toBeNull();
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    expect(picture().style.opacity).toBe("");
  });
});

describe("the grow from a pressed picture", () => {
  const el = (): HTMLElement & { played: [Keyframe[], KeyframeAnimationOptions][] } => {
    const div = document.createElement("div") as HTMLElement & { played: [Keyframe[], KeyframeAnimationOptions][] };
    div.played = [];
    div.style.opacity = "0";
    div.animate = ((frames: Keyframe[], timing: KeyframeAnimationOptions) => (div.played.push([frames, timing]), {})) as never;
    div.getBoundingClientRect = () => ({ left: 160, top: 0, width: 2880, height: 1800, right: 3040, bottom: 1800, x: 160, y: 0, toJSON: noop });
    return div;
  };

  it("scales by transform from where it was to where it is, over the slow time", () => {
    const div = el();
    growFrom(div, { x: 400, y: 300, width: 1440, height: 900 });
    expect(div.style.opacity).toBe("");
    const [[frames, timing]] = div.played;
    expect(frames).toEqual([{ transform: "translate(240px, 300px) scale(0.5, 0.5)" }, { transform: "none" }]);
    expect(timing.duration).toBe(240);
  });

  it("fades over the fast time with reduced motion", () => {
    saveMotionPreference("reduced");
    try {
      const div = el();
      growFrom(div, { x: 400, y: 300, width: 1440, height: 900 });
      expect(div.played).toEqual([[[{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 120 })]]);
    } finally {
      saveMotionPreference("system");
    }
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
    // ⌃⌥ calls the bar
    fireEvent.keyDown(window, { key: "Alt", ctrlKey: true, altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(fullWindowTarget()).toBeNull();
    expect(opened).toHaveBeenCalledWith("t1", "box");
  });

  it("calls its bar when the pointer rests 250 ms on the top edge's middle 240px, and sends it 600 ms after the pointer leaves, never while a menu is open", () => {
    vi.useFakeTimers();
    h.tile = tile();
    render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    const bar = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="full-window-bar"]')!;
    const move = (x: number, y: number): void => void act(() => void window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y })));
    const mid = window.innerWidth / 2;
    // hidden until called: the display is the picture's
    expect(bar().dataset.shown).toBeUndefined();
    // the corner of the edge is Windows' own: nothing comes
    move(10, 2);
    act(() => vi.advanceTimersByTime(BAR_REST_MS * 2));
    expect(bar().dataset.shown).toBeUndefined();
    move(mid + EDGE.width / 2 - 1, 2);
    act(() => vi.advanceTimersByTime(BAR_REST_MS - 1));
    expect(bar().dataset.shown).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(bar().dataset.shown).toBe("true");
    // the pointer leaves: it stays 600 ms, then goes
    move(mid, 400);
    act(() => vi.advanceTimersByTime(BAR_LEAVE_MS - 1));
    expect(bar().dataset.shown).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(bar().dataset.shown).toBeUndefined();
    expect(inEdge(mid, EDGE.height + 1, window.innerWidth)).toBe(false);
  });

  it("a menu of the bar open keeps it; a poor link calls it by itself", () => {
    vi.useFakeTimers();
    h.tile = tile();
    const v = render(<FullWindow onOpenSession={noop} reading={{ delayMs: 40, link: "good" }} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    const bar = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="full-window-bar"]')!;
    expect(bar().dataset.shown).toBeUndefined();
    v.rerender(<FullWindow onOpenSession={noop} reading={{ delayMs: 212, link: "poor" }} />);
    expect(bar().dataset.shown).toBe("true");
    const delay = within(bar()).getByRole("button", { name: "Link poor, details" });
    // opened, the delay's popover holds the bar past its time
    fireEvent.click(delay);
    act(() => vi.advanceTimersByTime(10_000));
    expect(bar().dataset.shown).toBe("true");
  });
});

describe("the ways out, said on entry", () => {
  const drive = () => ({ send: () => undefined, paste: () => undefined, copy: async () => "" });
  const hint = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-slot="full-screen-hint"]');

  it("says both for three seconds on each entry while he drives, in key caps", () => {
    vi.useFakeTimers();
    h.tile = tile({ driving: true, doing: null });
    h.drive = drive();
    render(<FullWindow onOpenSession={noop} />);
    for (let entry = 0; entry < 2; entry++) {
      act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
      expect(hint()?.dataset.shown, `entry ${entry}`).toBe("true");
      expect(hint()?.getAttribute("role")).toBe("status");
      expect([...hint()!.querySelectorAll("kbd")].map((cap) => cap.textContent)).toEqual(["Ctrl+Alt", "F11"]);
      expect(hint()?.textContent).toBe("Ctrl+Altfrees the keyboardF11leaves full screen");
      act(() => vi.advanceTimersByTime(FULL_SCREEN_HINT_MS - 1));
      expect(hint()?.dataset.shown).toBe("true");
      act(() => vi.advanceTimersByTime(1));
      expect(hint()?.dataset.shown).toBeUndefined();
      expect(hint()?.getAttribute("aria-hidden")).toBe("true");
      act(() => closeFullWindow());
      expect(hint()).toBeNull();
    }
  });

  it("names a Mac's keys on a Mac", () => {
    render(<FullScreenHint driving mac />);
    expect([...hint()!.querySelectorAll("kbd")].map((cap) => cap.textContent)).toEqual(["⌃⌥", "⌃⌘F"]);
  });

  it("says nothing while he only watches, and says it once he takes over", () => {
    vi.useFakeTimers();
    h.tile = tile();
    const { rerender } = render(<FullScreenHint driving={false} />);
    expect(hint()).toBeNull();
    rerender(<FullScreenHint driving />);
    expect(hint()?.dataset.shown).toBe("true");
    // handed back, it goes at once
    rerender(<FullScreenHint driving={false} />);
    expect(hint()?.dataset.shown).toBeUndefined();
  });

  it("asks main to hold the keyboard while the picture he drives has it, and lets go as full screen closes", async () => {
    h.tile = tile({ driving: true, doing: null });
    const { rerender } = render(<FullWindow onOpenSession={noop} />);
    act(() => openFullWindow({ host: "box", threadId: "t1", name: "Live view" }));
    // the drive stream comes once full screen is open
    h.drive = drive();
    rerender(<FullWindow onOpenSession={noop} />);
    const picture = document.querySelector<HTMLElement>("[data-driving]")!;
    act(() => picture.focus());
    await flush();
    expect(h.holds).toEqual([true]);
    // main let go (⌃⌥, a blur): the keyboard goes to Hand back
    act(() => h.heldKey?.("freed"));
    expect(document.activeElement?.hasAttribute("data-hand-back")).toBe(true);
    act(() => closeFullWindow());
    expect(h.holds.at(-1)).toBe(false);
  });
});
