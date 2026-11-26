// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockForTest } from "../lib/turnClock";
import type { ThreadRow } from "../lib/workspaceSessions";
import { ThreadLine } from "./WorkspaceSessions";

// jsdom has no IntersectionObserver: one the test drives.
let report: ((entries: IntersectionObserverEntry[]) => void) | undefined;
class Watcher {
  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    report = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const hidden = { value: false };
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });

const row = (over: Partial<ThreadRow> = {}): ThreadRow =>
  ({ id: "t1", title: "Index the calls", status: "running", updatedAt: 1, unread: false, paused: false, running: true, failed: false, needsYou: false, busySince: Date.now() - 60_000, threadType: "implementation", frozenActiveElapsed: null, environmentId: "local", ...over }) as ThreadRow;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", Watcher);
  hidden.value = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a card line's clock", () => {
  it("runs the second hand only while its line can be seen: on screen, the document shown", () => {
    const { container } = render(<ThreadLine kind="working" thread={row()} />);
    const line = container.querySelector("[data-card-line]")!;
    expect(clockForTest.listeners()).toBe(1);
    expect(line.textContent).toMatch(/1m/);
    act(() => report?.([{ target: line, isIntersecting: false } as unknown as IntersectionObserverEntry]));
    expect(clockForTest.listeners()).toBe(0);
    // Off screen it keeps its text on the half-minute hand.
    expect(line.textContent).toMatch(/1m/);
    act(() => report?.([{ target: line, isIntersecting: true } as unknown as IntersectionObserverEntry]));
    expect(clockForTest.listeners()).toBe(1);
    act(() => {
      hidden.value = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(clockForTest.listeners()).toBe(0);
  });
});
