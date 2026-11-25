// @vitest-environment jsdom
/**
 * The live-status clause, built once (lifeosLive.ts): a reader holding a saved cause says what the host's live status
 * says now, and reads again once a status heard since says connected.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeosStatus } from "@shared/contract-work-lifeos";
import { resetLifeos, setLifeosStatus, setLifeosUnanswered } from "./lifeos";
import { liveDownOf, savedOf, useLiveDown, type SavedDown } from "./lifeosLive";

const ENV = "env_box";
const st = (state: string): LifeosStatus => ({ lifeos: { state, ...(state === "pairing" ? { expiresAt: 1 } : {}) }, keys: [] }) as unknown as LifeosStatus;

afterEach(() => {
  cleanup();
  resetLifeos();
});

describe("savedOf", () => {
  it("reads the host's sentences and its silence", () => {
    expect(savedOf(Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" }))).toBe("unanswered");
    expect(savedOf(new Error("LifeOS is not signed in on this host."))).toBe(null);
    expect(savedOf(new Error("Not signed in to LifeOS"))).toBe("signed-out");
    expect(savedOf(new Error("LifeOS is still connecting"))).toBe("connecting");
    expect(savedOf(new Error("LifeOS is unreachable"))).toBe("unreachable");
    expect(savedOf(new Error("disk full"))).toBe(null);
  });
});

describe("liveDownOf", () => {
  it("lets a live state that is down win over a saved one", () => {
    expect(liveDownOf("signed-out", st("pairing"), false, true)).toEqual({ down: "pairing", waits: false });
    expect(liveDownOf("signed-out", st("connecting"), false, false)).toEqual({ down: null, waits: true });
  });

  it("keeps a silence heard after the status until a newer status comes", () => {
    expect(liveDownOf("unanswered", st("signed-out"), false, false)).toEqual({ down: "unanswered", waits: false });
    expect(liveDownOf("unanswered", st("signed-out"), false, true)).toEqual({ down: "signed-out", waits: false });
  });

  it("says the host's silence over a status that is not connected, and keeps a computer kept from LifeOS", () => {
    expect(liveDownOf(null, st("signed-out"), true, false)).toEqual({ down: "unanswered", waits: false });
    expect(liveDownOf("withheld", st("connected"), false, true)).toEqual({ down: "withheld", waits: false });
  });

  it("says a saved connecting as a wait, and nothing for nothing", () => {
    expect(liveDownOf("connecting", st("connected"), false, false)).toEqual({ down: null, waits: true });
    expect(liveDownOf(null, st("connected"), false, true)).toEqual({ down: null, waits: false });
    expect(liveDownOf(null, null, false, false)).toEqual({ down: null, waits: false });
  });
});

describe("useLiveDown", () => {
  it("follows the status as it changes and reads again on connected, once", () => {
    setLifeosStatus(ENV, st("signed-out"));
    const onBack = vi.fn();
    const { result } = renderHook(({ saved }: { saved: SavedDown }) => useLiveDown(saved, ENV, onBack), { initialProps: { saved: "signed-out" as SavedDown } });
    expect(result.current).toEqual({ down: "signed-out", waits: false });
    act(() => setLifeosStatus(ENV, st("pairing")));
    expect(result.current).toEqual({ down: "pairing", waits: false });
    act(() => setLifeosStatus(ENV, st("connecting")));
    expect(result.current).toEqual({ down: null, waits: true });
    expect(onBack).not.toHaveBeenCalled();
    act(() => setLifeosStatus(ENV, st("connected")));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reads again after a drop it heard live, with no saved cause", () => {
    setLifeosStatus(ENV, st("connected"));
    const onBack = vi.fn();
    const { result } = renderHook(() => useLiveDown(null, ENV, onBack));
    act(() => setLifeosStatus(ENV, st("signed-out")));
    expect(result.current.down).toBe("signed-out");
    act(() => setLifeosStatus(ENV, st("connected")));
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => setLifeosStatus(ENV, st("connected")));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("asks nothing again for a status that was connected all along", () => {
    setLifeosStatus(ENV, st("connected"));
    const onBack = vi.fn();
    renderHook(() => useLiveDown(null, ENV, onBack));
    act(() => setLifeosStatus(ENV, st("connected")));
    expect(onBack).not.toHaveBeenCalled();
  });

  it("says the host's silence", () => {
    setLifeosUnanswered(ENV);
    const { result } = renderHook(() => useLiveDown(null, ENV));
    expect(result.current).toEqual({ down: "unanswered", waits: false });
  });
});
