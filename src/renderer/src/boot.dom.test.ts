// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlaceKind, loadThemePreference, resolveColorScheme } from "./lib/appearance";

/**
 * boot.js sets the theme's class before the splash paints. It reads the kind
 * of place from the window's address (else the last one saved) and that
 * kind's choice, exactly as lib/appearance.ts does once the bundle runs, so
 * the page never paints one theme and settles on another.
 */
const source = readFileSync(join(__dirname, "../public/boot.js"), "utf8");
const root = document.documentElement;
const boot = (): void => void new Function(source)();

function system(scheme: "dark" | "light" | null): void {
  if (scheme === null) return void Reflect.deleteProperty(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", { value: (query: string) => ({ matches: query.includes("light") && scheme === "light" }), configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  system("dark");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  system(null);
});

const CHOICES = [null, "dark", "light", "system", "sepia"] as const;

describe("boot.js", () => {
  it("is dark for a window that never chose, whatever the system says", () => {
    system("light");
    boot();
    expect(root.classList.contains("theme-light")).toBe(false);
  });

  it("sets the class lib/appearance.ts would, for every kind, choice and system", () => {
    let cases = 0;
    for (const query of [null, "", "code", "work", "elsewhere"])
      for (const saved of [null, "code", "work"])
        for (const code of CHOICES)
          for (const work of CHOICES)
            for (const os of ["dark", "light"] as const) {
              localStorage.clear();
              root.className = "";
              window.history.replaceState(null, "", query === null ? "/" : `/?place=${query}`);
              if (saved) localStorage.setItem("monocode.placeKind", saved);
              if (code) localStorage.setItem("monocode.colorScheme", code);
              if (work) localStorage.setItem("monocode.colorScheme.work", work);
              system(os);
              boot();
              const wanted = resolveColorScheme(loadThemePreference(loadPlaceKind()));
              expect(root.classList.contains("theme-light"), JSON.stringify({ query, saved, code, work, os })).toBe(wanted === "light");
              cases++;
            }
    expect(cases).toBe(5 * 3 * 5 * 5 * 2);
  });

  it("takes the kind in the window's own address over the one another window saved", () => {
    localStorage.setItem("monocode.placeKind", "code");
    localStorage.setItem("monocode.colorScheme", "dark");
    localStorage.setItem("monocode.colorScheme.work", "light");
    window.history.replaceState(null, "", "/?place=work");
    boot();
    expect(root.classList.contains("theme-light")).toBe(true);
  });

  it("has Work follow Code until Work has a choice", () => {
    localStorage.setItem("monocode.colorScheme", "light");
    window.history.replaceState(null, "", "/?place=work");
    boot();
    expect(root.classList.contains("theme-light")).toBe(true);
  });

  it("reads none of the retired appearance keys and sets none of their classes or variables", () => {
    expect(source).not.toMatch(/themeHue|themeSaturation|sidebarOpacity|bodyGlass|glass-body|--theme-|--sidebar-opacity/);
    for (const key of ["themeHue", "themeSaturation", "sidebarOpacity", "bodyGlass"]) localStorage.setItem(`monocode.${key}`, "1");
    boot();
    expect(root.getAttribute("style")).toBeNull();
    expect([...root.classList].filter((name) => name !== "is-mac")).toEqual([]);
  });

  it("leaves the page as it is when storage cannot be read", () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(boot).not.toThrow();
      expect(root.classList.contains("theme-light")).toBe(false);
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});
