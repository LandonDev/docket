// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initMotion, loadMotionPreference, reducedMotion, saveMotionPreference, useReducedMotion } from "./motion";

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
afterEach(() => delete document.documentElement.dataset.motion);

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

  it("reads an unknown stored value as the default", () => {
    localStorage.setItem("docket.motion", "sideways");
    expect(loadMotionPreference()).toBe("system");
  });
});
