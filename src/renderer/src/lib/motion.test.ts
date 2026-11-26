// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initMotion, loadMotionPreference, onMotionChange, reducedMotion, saveMotionPreference, useReducedMotion } from "./motion";

/** A stand-in for the system's reduce-motion setting, which a test can turn. */
function systemSetting(reduce: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduce,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  };
  window.matchMedia = ((q: string) => (q === query.media ? query : { matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  return {
    turn(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  // A hook left mounted keeps the shared listeners up for the next case.
  cleanup();
  delete document.documentElement.dataset.motion;
});

describe("the motion rule", () => {
  it("follows this computer by default, live", () => {
    const system = systemSetting(true);
    const stop = initMotion();
    expect(loadMotionPreference()).toBe("system");
    expect(reducedMotion()).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("reduced");
    system.turn(false);
    expect(document.documentElement.dataset.motion).toBe("full");
    stop();
  });

  it("puts the person's choice over the computer's, either way", () => {
    systemSetting(true);
    const stop = initMotion();
    saveMotionPreference("full");
    expect(reducedMotion()).toBe(false);
    expect(document.documentElement.dataset.motion).toBe("full");
    systemSetting(false);
    saveMotionPreference("reduced");
    expect(reducedMotion()).toBe(true);
    expect(document.documentElement.dataset.motion).toBe("reduced");
    stop();
  });

  it("re-renders a reader when the choice changes", () => {
    systemSetting(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => saveMotionPreference("reduced"));
    expect(result.current).toBe(true);
  });

  it("a window of rows reading the rule shares one set of listeners, and each is told once", () => {
    systemSetting(false);
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const media = vi.spyOn(window, "matchMedia");
    try {
      const told = vi.fn();
      // The same function from 200 rows, as a shared callback would be.
      const stops = Array.from({ length: 200 }, () => onMotionChange(told));
      expect(added.mock.calls.map(([type]) => type).sort()).toEqual(["docket:motionchange", "storage"]);
      expect(media).toHaveBeenCalledTimes(1);
      saveMotionPreference("reduced");
      expect(told).toHaveBeenCalledTimes(200);
      for (const stop of stops.slice(1)) stop();
      expect(removed).not.toHaveBeenCalled();
      saveMotionPreference("full");
      expect(told).toHaveBeenCalledTimes(201);
      stops[0]!();
      stops[0]!();
      expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["docket:motionchange", "storage"]);
      saveMotionPreference("reduced");
      expect(told).toHaveBeenCalledTimes(201);
    } finally {
      added.mockRestore();
      removed.mockRestore();
      media.mockRestore();
    }
  });

  it("reads an unknown stored value as the default", () => {
    localStorage.setItem("docket.motion", "sideways");
    expect(loadMotionPreference()).toBe("system");
  });
});
