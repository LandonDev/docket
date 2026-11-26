// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "@renderer/hooks/paneVisibility";
import { Spinner } from "./spinner";

// jsdom has no Web Animations and no IntersectionObserver: each turn is a handle
// that knows whether it still runs, and the observer is one the test drives.
const turns: { startTime: number | null; running: boolean }[] = [];
const animate = vi.fn(() => {
  const turn = { startTime: null as number | null, running: true, cancel: () => (turn.running = false) };
  turns.push(turn);
  return turn as unknown as Animation;
});
const running = () => turns.filter((t) => t.running).length;

let report: ((entries: IntersectionObserverEntry[]) => void) | undefined;
const observed = new Set<Element>();
class Watcher {
  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    report = cb;
  }
  observe(el: Element) {
    observed.add(el);
  }
  unobserve(el: Element) {
    observed.delete(el);
  }
  disconnect() {}
}
const seen = (el: Element, isIntersecting: boolean) =>
  act(() => report?.([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry]));

const hidden = { value: false };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });

beforeEach(() => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  vi.stubGlobal("IntersectionObserver", Watcher);
  turns.length = 0;
  hidden.value = false;
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const inPane = (visible: boolean, n = 1) => (
  <PaneVisibilityContext.Provider value={visible}>
    {Array.from({ length: n }, (_, i) => (
      <Spinner key={i} />
    ))}
  </PaneVisibilityContext.Provider>
);

describe("Spinner: no running animation where no one can see it", () => {
  it("a spinner in a parked pane has no running animation", () => {
    render(inPane(false, 5));
    expect(animate).toHaveBeenCalledTimes(0);
    expect(running()).toBe(0);
  });

  it("parks and unparks with its pane, and turns again in phase", () => {
    const { rerender } = render(inPane(true, 3));
    expect(running()).toBe(3);
    rerender(inPane(false, 3));
    expect(running()).toBe(0);
    rerender(inPane(true, 3));
    expect(running()).toBe(3);
    expect(turns.slice(-3).map((t) => t.startTime)).toEqual([0, 0, 0]);
  });

  it("holds none while the document is hidden, and turns when it shows again", () => {
    const { rerender } = render(inPane(true, 2));
    expect(running()).toBe(2);
    act(() => {
      hidden.value = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    rerender(inPane(true, 2));
    expect(running()).toBe(0);
    act(() => {
      hidden.value = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(running()).toBe(2);
  });

  it("turns from its mount, drops the turn off screen and takes it up in phase on screen", () => {
    const { container, unmount } = render(inPane(true, 2));
    const [a, b] = [...container.querySelectorAll("[data-slot=spinner]")];
    expect(observed.size).toBe(2);
    expect(running()).toBe(2);
    seen(b, false);
    expect(running()).toBe(1);
    seen(b, false);
    expect(animate).toHaveBeenCalledTimes(2);
    seen(a, true);
    expect(animate).toHaveBeenCalledTimes(2);
    seen(b, true);
    expect(running()).toBe(2);
    expect(turns.at(-1)?.startTime).toBe(0);
    unmount();
    expect(running()).toBe(0);
    expect(observed.size).toBe(0);
  });
});
