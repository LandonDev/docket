import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const play = vi.fn();
const setEnabled = vi.fn();
const setVolume = vi.fn();

vi.mock("cuelume", () => ({
  play: (...args: unknown[]) => play(...args),
  setEnabled: (...args: unknown[]) => setEnabled(...args),
  setVolume: (...args: unknown[]) => setVolume(...args),
}));

import {
  announceUpdateAvailable,
  loadSoundsEnabled,
  playCue,
  resetSoundCues,
  saveSoundsEnabled,
  SOUNDS_DEFAULT,
  SOUNDS_VOLUME,
} from "./sounds";

const KEY = "docket.sounds";

function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("sounds", () => {
  beforeEach(() => {
    mockLocalStorage();
    play.mockClear();
    setEnabled.mockClear();
    setVolume.mockClear();
    resetSoundCues();
  });

  afterEach(() => {
    localStorage.removeItem(KEY);
    resetSoundCues();
  });

  it("defaults to on", () => {
    expect(SOUNDS_DEFAULT).toBe(true);
    expect(loadSoundsEnabled()).toBe(true);
  });

  /** The engine is its own chunk: a cue plays once the import has answered. */
  const engineAnswered = () => vi.dynamicImportSettled();

  it("persists an off switch", async () => {
    playCue("switch");
    await engineAnswered();
    saveSoundsEnabled(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect(loadSoundsEnabled()).toBe(false);
    await engineAnswered();
    expect(setEnabled).toHaveBeenLastCalledWith(false);
    saveSoundsEnabled(true);
    expect(loadSoundsEnabled()).toBe(true);
    await engineAnswered();
    expect(setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("plays the mapped cue when enabled", async () => {
    playCue("turnFinished");
    await engineAnswered();
    expect(setVolume).toHaveBeenCalledWith(SOUNDS_VOLUME);
    expect(play).toHaveBeenCalledWith("success");
    playCue("updateAvailable");
    await engineAnswered();
    expect(play).toHaveBeenCalledWith("arrival");
    playCue("switch");
    await engineAnswered();
    expect(play).toHaveBeenCalledWith("toggle");
    playCue("copy");
    await engineAnswered();
    expect(play).toHaveBeenCalledWith("scan");
  });

  it("is silent when muted", async () => {
    saveSoundsEnabled(false);
    play.mockClear();
    playCue("turnFinished");
    await engineAnswered();
    expect(play).not.toHaveBeenCalled();
  });

  it("is silent when he mutes while a cue's engine is still loading", async () => {
    playCue("turnFinished");
    saveSoundsEnabled(false);
    await engineAnswered();
    expect(play).not.toHaveBeenCalled();
  });

  it("dings once per update version", async () => {
    announceUpdateAvailable("0.2.0");
    await engineAnswered();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith("arrival");
    announceUpdateAvailable("0.2.0");
    await engineAnswered();
    expect(play).toHaveBeenCalledTimes(1);
    announceUpdateAvailable("0.2.1");
    await engineAnswered();
    expect(play).toHaveBeenCalledTimes(2);
  });
});
