import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTranscriptAnchor,
  saveTranscriptAnchor,
  TRANSCRIPT_ANCHOR_DEFAULT,
  isThemeKey,
  loadThemePreference,
  saveThemePreference,
  resolveColorScheme,
  THEME_PREFERENCE_DEFAULT,
} from "./appearance";

const SCHEME_KEY = "monocode.colorScheme";
const ANCHOR_KEY = "monocode.transcriptAnchor";

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

describe("transcript prompt-to-top setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(ANCHOR_KEY);
  });

  it("defaults to on", () => {
    expect(TRANSCRIPT_ANCHOR_DEFAULT).toBe(true);
    expect(loadTranscriptAnchor()).toBe(true);
  });

  it("persists across loads", () => {
    saveTranscriptAnchor(true);
    expect(loadTranscriptAnchor()).toBe(true);
    saveTranscriptAnchor(false);
    expect(loadTranscriptAnchor()).toBe(false);
  });
});

function mockSystemScheme(scheme: "dark" | "light") {
  Object.defineProperty(globalThis, "window", {
    value: {
      matchMedia: (query: string) => ({
        matches: query.includes("light") && scheme === "light",
      }),
    },
    configurable: true,
  });
}

describe("theme preference setting", () => {
  beforeEach(mockLocalStorage);
  afterEach(() => {
    localStorage.removeItem(SCHEME_KEY);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("defaults to dark", () => {
    expect(THEME_PREFERENCE_DEFAULT).toBe("dark");
    expect(loadThemePreference()).toBe("dark");
  });

  it("persists each preference", () => {
    for (const value of ["system", "light", "dark"] as const) {
      saveThemePreference("code", value);
      expect(localStorage.getItem(SCHEME_KEY)).toBe(value);
      expect(loadThemePreference()).toBe(value);
      expect(loadThemePreference("code")).toBe(value);
    }
  });

  it("still loads a Code choice saved before there were two", () => {
    localStorage.setItem(SCHEME_KEY, "light");
    expect(loadThemePreference("code")).toBe("light");
  });

  it("has Work follow Code until Work has a choice of its own", () => {
    expect(loadThemePreference("work")).toBe("dark");
    saveThemePreference("code", "light");
    expect(loadThemePreference("work")).toBe("light");
    saveThemePreference("code", "system");
    expect(loadThemePreference("work")).toBe("system");
    saveThemePreference("work", "dark");
    expect(localStorage.getItem("monocode.colorScheme.work")).toBe("dark");
    expect(loadThemePreference("work")).toBe("dark");
    // Work's own choice never moves Code's, and Code's no longer moves Work's.
    expect(loadThemePreference("code")).toBe("system");
    saveThemePreference("code", "light");
    expect(loadThemePreference("work")).toBe("dark");
    localStorage.removeItem("monocode.colorScheme.work");
  });

  it("ignores an unknown stored value for Work and follows Code", () => {
    saveThemePreference("code", "light");
    localStorage.setItem("monocode.colorScheme.work", "sepia");
    expect(loadThemePreference("work")).toBe("light");
    localStorage.removeItem("monocode.colorScheme.work");
  });

  it("knows the two keys that hold a theme", () => {
    expect(isThemeKey(SCHEME_KEY)).toBe(true);
    expect(isThemeKey("monocode.colorScheme.work")).toBe(true);
    expect(isThemeKey("monocode.placeKind")).toBe(false);
    expect(isThemeKey(null)).toBe(false);
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(SCHEME_KEY, "solarized");
    expect(loadThemePreference()).toBe(THEME_PREFERENCE_DEFAULT);
  });

  it("resolves system against the OS appearance", () => {
    mockSystemScheme("light");
    expect(resolveColorScheme("system")).toBe("light");
    mockSystemScheme("dark");
    expect(resolveColorScheme("system")).toBe("dark");
  });

  it("keeps explicit picks regardless of the OS appearance", () => {
    mockSystemScheme("light");
    expect(resolveColorScheme("dark")).toBe("dark");
    mockSystemScheme("dark");
    expect(resolveColorScheme("light")).toBe("light");
  });

  it("falls back to dark without matchMedia", () => {
    expect(resolveColorScheme("system")).toBe("dark");
  });
});
