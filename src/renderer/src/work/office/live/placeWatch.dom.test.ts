// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLACE_EVERY_MS, watchPlace } from "./LiveBody";

/**
 * A live Office tab's place is read when something may have moved it (a size change of it, above it or beside what is
 * above it, a scroll, the window's resize), and otherwise once a second: it was read every 200 ms.
 */

const observed: Element[] = [];
const callbacks: Array<() => void> = [];
class FakeResize {
  constructor(cb: () => void) {
    callbacks.push(cb);
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  observed.length = 0;
  callbacks.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResize);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function tree() {
  document.body.innerHTML = `<div id="app"><aside id="rail"></aside><main id="main"><div id="pane"><div id="body"></div></div></main></div>`;
  return { body: document.getElementById("body")!, rail: document.getElementById("rail")!, pane: document.getElementById("pane")! };
}

describe("a live Office tab's place", () => {
  it("is read once a second at rest, five times fewer than before", () => {
    const { body } = tree();
    const place = vi.fn();
    const off = watchPlace(body, place);
    vi.advanceTimersByTime(10_000);
    expect(place).toHaveBeenCalledTimes(10_000 / PLACE_EVERY_MS);
    expect(10_000 / PLACE_EVERY_MS).toBeLessThanOrEqual(10_000 / 200 / 5);
    off();
  });

  it("is read as a rail beside what holds it changes size, as anything scrolls, and as the window resizes", () => {
    const { body, rail, pane } = tree();
    const place = vi.fn();
    const off = watchPlace(body, place);
    expect(observed).toEqual(expect.arrayContaining([body, pane, rail, document.body]));
    callbacks[0]!();
    document.getElementById("main")!.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(place).toHaveBeenCalledTimes(3);
    off();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(5_000);
    expect(place).toHaveBeenCalledTimes(3);
  });
});
