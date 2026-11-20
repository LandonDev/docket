// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerTile } from "../../../lib/computers";
import { closePopOut, openPopOut, popOutTarget } from "../../../lib/popOut";
import { streamOf, tile } from "./FullWindow.fixtures";
import { LEFT_AFTER_MS, PopOut, PopOutView, mirrorDocument } from "./PopOut";

const h = vi.hoisted(() => ({ tile: null as ComputerTile | null, streams: [] as { key: string; run: boolean }[], shapes: [] as number[] }));
vi.mock("../../../lib/computers", async (original) => ({ ...(await original<typeof import("../../../lib/computers")>()), useComputer: () => h.tile }));
vi.mock("../../../lib/native", async (original) => ({ ...(await original<typeof import("../../../lib/native")>()), setPopOutShape: (r: number) => void h.shapes.push(r) }));
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

const noop = (): void => undefined;
beforeEach(() => {
  h.tile = null;
  h.streams.length = 0;
  h.shapes.length = 0;
});
afterEach(() => {
  act(() => closePopOut());
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A window.open stand-in: a real document of its own, and what was done to it. */
function childWindow() {
  // a document with a window of its own, as the child window's is
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const closed = { n: 0 };
  const listeners = new Map<string, () => void>();
  const w = { document: doc, close: () => void closed.n++, addEventListener: (t: string, fn: () => void) => listeners.set(t, fn), removeEventListener: (t: string) => listeners.delete(t) } as unknown as Window;
  return { w, doc, closed, fire: (t: string) => listeners.get(t)?.() };
}

describe("the pop-out's body", () => {
  const view = (over: Partial<Parameters<typeof PopOutView>[0]> = {}) => <PopOutView tile={tile()} stream={streamOf({ status: "live", app: "Chromium", window: "Concur", width: 1280, height: 800, drawn: true })} name="Live view" onBack={noop} onClose={noop} {...over} />;

  it("is the picture and one bar: the title, Take over and Stop, Back to the page and Close", () => {
    const back = vi.fn();
    const close = vi.fn();
    render(view({ onBack: back, onClose: close }));
    const bar = document.querySelector<HTMLElement>('[data-slot="pop-out-bar"]')!;
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(within(bar).getByText("File the March expense report")).not.toBeNull();
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Take over", "Stop File the March expense report", "Back to the page", "Close"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to the page" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect([back.mock.calls.length, close.mock.calls.length]).toEqual([1, 1]);
  });

  it("offers Hand back alone while he drives, nothing to stop on an idle page, and no Take over on a person's own window", () => {
    const v = render(view({ tile: tile({ driving: true, doing: null }) }));
    expect(screen.getByRole("button", { name: "Hand back" }).hasAttribute("data-hand-back")).toBe(true);
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    v.rerender(view({ tile: tile({ idle: true }) }));
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    v.rerender(view({ tile: tile({ browser: false, computer: "window:t1" }) }));
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    v.rerender(view({ tile: null }));
    expect(screen.getByText("Nothing is driving this now")).not.toBeNull();
  });
});

describe("the pop-out's look", () => {
  it("wears the main window's stylesheets and theme, and follows a change of theme and a stylesheet added later", async () => {
    const { doc } = childWindow();
    const style = document.createElement("style");
    style.textContent = ".x{}";
    document.head.appendChild(style);
    document.documentElement.className = "theme-light";
    const stop = mirrorDocument(document, doc);
    expect(doc.head.querySelectorAll("style").length).toBeGreaterThan(0);
    expect(doc.documentElement.className).toBe("theme-light");
    document.documentElement.className = "";
    const late = document.createElement("style");
    late.textContent = ".late{}";
    document.head.appendChild(late);
    await act(async () => {});
    expect(doc.documentElement.className).toBe("");
    expect([...doc.head.querySelectorAll("style")].some((s) => s.textContent === ".late{}")).toBe(true);
    stop();
    style.remove();
    late.remove();
  });
});

describe("the pop-out, live", () => {
  it("opens one child window under the frame name main lets through, draws its computer there on the shared stream, and closes it", () => {
    h.tile = tile();
    const child = childWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(child.w);
    render(<PopOut onBack={noop} />);
    act(() => openPopOut({ host: "box", threadId: "t1", name: "Live view of Expense report in Chromium" }));
    expect(open).toHaveBeenCalledWith("about:blank", "tc-popout");
    expect(child.doc.body.querySelector('[data-slot="pop-out"]')).not.toBeNull();
    expect(child.doc.title).toBe("File the March expense report");
    expect(h.streams.at(-1)).toEqual({ key: "t1", run: true });
    // the window keeps the picture's shape
    expect(h.shapes.at(-1)).toBeCloseTo(1.6, 3);
    act(() => closePopOut());
    expect(child.closed.n).toBe(1);
  });

  it("closes when its computer has left, and when the window went by itself", () => {
    vi.useFakeTimers();
    h.tile = tile();
    const child = childWindow();
    vi.spyOn(window, "open").mockReturnValue(child.w);
    const v = render(<PopOut onBack={noop} />);
    act(() => openPopOut({ host: "box", threadId: "t1", name: "Live view" }));
    h.tile = null;
    v.rerender(<PopOut onBack={noop} />);
    act(() => vi.advanceTimersByTime(LEFT_AFTER_MS - 1));
    expect(popOutTarget()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(popOutTarget()).toBeNull();
    // the system closed it (the main window went)
    h.tile = tile();
    act(() => openPopOut({ host: "box", threadId: "t1", name: "Live view" }));
    act(() => child.fire("pagehide"));
    expect(popOutTarget()).toBeNull();
  });

  it("Back to the page hands the page its computer and closes the pop-out", () => {
    h.tile = tile();
    const child = childWindow();
    vi.spyOn(window, "open").mockReturnValue(child.w);
    const back = vi.fn();
    render(<PopOut onBack={back} />);
    act(() => openPopOut({ host: "box", threadId: "t1", name: "Live view" }));
    // a click in the child's own document reaches React through the portal's container
    fireEvent.click(within(child.doc.body).getByRole("button", { name: "Back to the page" }));
    expect(back).toHaveBeenCalledWith({ host: "box", threadId: "t1" });
    expect(popOutTarget()).toBeNull();
  });
});
