// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_FONT_CHANGE_EVENT,
  EDITOR_FONT_SIZE_DEFAULT,
  editorFontOptions,
  initAppearance,
  loadEditorFontSize,
  loadPlaceKind,
  saveEditorFontSize,
  savePlaceKind,
} from "./appearance";

const root = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  root.removeAttribute("style");
});
afterEach(() => vi.restoreAllMocks());

describe("editor font size", () => {
  it("defaults to 13px", () => {
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(13);
    expect(loadEditorFontSize()).toBe(13);
  });

  it("saves, loads and clamps to the list", () => {
    expect(saveEditorFontSize(14)).toBe(14);
    expect(loadEditorFontSize()).toBe(14);
    expect(saveEditorFontSize(40)).toBe(14);
    expect(saveEditorFontSize(3)).toBe(12);
    localStorage.setItem("monocode.editorFontSize", "15");
    expect(loadEditorFontSize()).toBe(13);
  });

  it("sets the code size variable and tells the editors", () => {
    const heard = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGE_EVENT, heard);
    saveEditorFontSize(12);
    window.removeEventListener(EDITOR_FONT_CHANGE_EVENT, heard);
    expect(root.style.getPropertyValue("--font-size-code")).toBe("12px");
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toBe(12);
  });

  it("gives Monaco a line height for each size", () => {
    expect(editorFontOptions(12)).toEqual({ fontSize: 12, lineHeight: 18 });
    expect(editorFontOptions(13)).toEqual({ fontSize: 13, lineHeight: 20 });
    expect(editorFontOptions(14)).toEqual({ fontSize: 14, lineHeight: 22 });
  });
});

describe("initAppearance", () => {
  it("clears the retired keys and applies the font size", () => {
    for (const key of [
      "themeHue",
      "themeSaturation",
      "sidebarOpacity",
      "bodyGlass",
      "glass",
      "sidebarLayout",
      "sidebarOpen",
      "sidebarTabOrder",
      "transcriptLayout",
      "transcriptZen",
    ]) {
      localStorage.setItem(`monocode.${key}`, "1");
    }
    localStorage.setItem("monocode.colorScheme", "dark");
    localStorage.setItem("monocode.editorFontSize", "14");
    initAppearance();
    expect(Object.keys(localStorage).sort()).toEqual(["monocode.colorScheme", "monocode.editorFontSize"]);
    // The theme is the place's, set by lib/placeScheme.ts: this sets no class of its own.
    expect(root.classList.contains("theme-light")).toBe(false);
    expect(root.style.getPropertyValue("--font-size-code")).toBe("14px");
    expect(root.classList.contains("glass")).toBe(false);
  });

  it("keeps no sidebar layout setting: no key is read and none is exported", async () => {
    const appearance = await import("./appearance");
    for (const name of ["loadSidebarLayout", "saveSidebarLayout", "SIDEBAR_LAYOUT_DEFAULT", "LAYOUT_CHANGE_EVENT"]) {
      expect(name in appearance).toBe(false);
    }
  });
});

describe("the kind of place a window opens on", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("is the one in the window's own address, else the last one saved, else code", () => {
    expect(loadPlaceKind()).toBe("code");
    savePlaceKind("work");
    expect(localStorage.getItem("monocode.placeKind")).toBe("work");
    expect(loadPlaceKind()).toBe("work");
    // Each window's address wins over what another window saved last.
    window.history.replaceState(null, "", "/?place=code");
    expect(loadPlaceKind()).toBe("code");
    savePlaceKind("code");
    window.history.replaceState(null, "", "/?place=work");
    expect(loadPlaceKind()).toBe("work");
    window.history.replaceState(null, "", "/?place=elsewhere");
    expect(loadPlaceKind()).toBe("code");
  });
});
