import { IS_MAC } from "./platform";

const PROJECT_RAIL_OPEN_KEY = "monocode.projectRailOpen";
const SCHEME_KEY = "monocode.colorScheme";
const WORK_SCHEME_KEY = "monocode.colorScheme.work";
const PLACE_KIND_KEY = "monocode.placeKind";
const PROJECT_RAIL_WIDTH_KEY = "monocode.projectRailWidth";
const TRANSCRIPT_ANCHOR_KEY = "monocode.transcriptAnchor";
const EDITOR_FONT_SIZE_KEY = "monocode.editorFontSize";

/** Keys of settings that are gone: the tint, Glass, sidebar opacity, main-pane
 *  glass, the Classic layout with its sidebar and tab order, and the two
 *  transcript toggles A7 retired. Boot clears them. */
const RETIRED_KEYS = [
  "monocode.themeHue",
  "monocode.themeSaturation",
  "monocode.sidebarOpacity",
  "monocode.bodyGlass",
  "monocode.glass",
  "monocode.sidebarLayout",
  "monocode.sidebarOpen",
  "monocode.sidebarTabOrder",
  "monocode.transcriptLayout",
  "monocode.transcriptZen",
  "monocode.tc.projectFolds",
];

export type ColorScheme = "dark" | "light";
export type ThemePreference = ColorScheme | "system";
/** The two kinds of place a window can be on, each with a theme of its own
 *  (docs/DESIGN.md "Appearance by place"): a code workspace or Chats, and a
 *  Work workspace or Work Chats. */
export type PlaceKind = "code" | "work";
const SCHEME_KEYS: Record<PlaceKind, string> = { code: SCHEME_KEY, work: WORK_SCHEME_KEY };

export const THEME_PREFERENCE_DEFAULT: ThemePreference = "dark";

/** Fired on `window` whenever the color scheme flips (detail: ColorScheme). */
export const SCHEME_CHANGE_EVENT = "monocode:schemechange";



export const TRANSCRIPT_ANCHOR_DEFAULT = true;

/** Fired on `window` whenever prompt-to-top anchoring flips (detail: boolean). */
export const TRANSCRIPT_ANCHOR_CHANGE_EVENT = "monocode:transcriptanchorchange";

export const PROJECT_RAIL_WIDTH_MIN = 180;
export const PROJECT_RAIL_WIDTH_MAX = 360;
export const PROJECT_RAIL_WIDTH_DEFAULT = 200;

/** The editor's type sizes, CodeMirror's and Monaco's alike. */
export const EDITOR_FONT_SIZES = [12, 13, 14] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];
export const EDITOR_FONT_SIZE_DEFAULT: EditorFontSize = 13;

/** Fired on `window` whenever the editor's type size changes (detail: EditorFontSize). */
export const EDITOR_FONT_CHANGE_EVENT = "monocode:editorfontchange";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // private mode / quota
  }
}

function readFlag(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return raw === "1" || raw === "true";
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
}

/** The class, the retired keys and the editor's type size. The theme is the
 *  place's: lib/placeScheme.ts `initPlaceScheme` sets it, right after this. */
export function initAppearance() {
  document.documentElement.classList.toggle("is-mac", IS_MAC);
  clearRetiredKeys();
  applyEditorFontSize(loadEditorFontSize());
}

function clearRetiredKeys() {
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch {
    // private mode
  }
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

/** The theme chosen for a kind of place. Code is Dark until it is chosen;
 *  Work follows Code until it has a choice of its own. */
export function loadThemePreference(kind: PlaceKind = "code"): ThemePreference {
  try {
    const own = localStorage.getItem(SCHEME_KEYS[kind]);
    if (isThemePreference(own)) return own;
    const code = kind === "work" ? localStorage.getItem(SCHEME_KEY) : null;
    return isThemePreference(code) ? code : THEME_PREFERENCE_DEFAULT;
  } catch {
    return THEME_PREFERENCE_DEFAULT;
  }
}

export function saveThemePreference(kind: PlaceKind, value: ThemePreference) {
  try {
    localStorage.setItem(SCHEME_KEYS[kind], value);
  } catch {
    // private mode / quota
  }
}

/** True for a storage key that holds a theme: another window changed a setting. */
export function isThemeKey(key: string | null): boolean {
  return key === SCHEME_KEY || key === WORK_SCHEME_KEY;
}

/** The kind of place this window opens on: the one main put in its address
 *  (each window has its own), else the last any window saved, which serves
 *  the web /ui and a first launch. boot.js reads the same two. */
export function loadPlaceKind(): PlaceKind {
  try {
    const named = new URLSearchParams(window.location.search).get("place") || localStorage.getItem(PLACE_KIND_KEY);
    return named === "work" ? "work" : "code";
  } catch {
    return "code";
  }
}

export function savePlaceKind(kind: PlaceKind) {
  try {
    localStorage.setItem(PLACE_KIND_KEY, kind);
  } catch {
    // private mode / quota
  }
}

export function systemQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: light)");
}

function systemColorScheme(): ColorScheme {
  return systemQuery()?.matches ? "light" : "dark";
}

export function resolveColorScheme(value: ThemePreference): ColorScheme {
  return value === "system" ? systemColorScheme() : value;
}

export function isLightScheme(): boolean {
  return document.documentElement.classList.contains("theme-light");
}

export function loadProjectRailOpen(): boolean {
  return readFlag(PROJECT_RAIL_OPEN_KEY) ?? true;
}

export function saveProjectRailOpen(value: boolean) {
  writeFlag(PROJECT_RAIL_OPEN_KEY, value);
}

export function loadProjectRailWidth(): number {
  return Math.round(
    clamp(
      readNumber(PROJECT_RAIL_WIDTH_KEY) ?? PROJECT_RAIL_WIDTH_DEFAULT,
      PROJECT_RAIL_WIDTH_MIN,
      PROJECT_RAIL_WIDTH_MAX,
    ),
  );
}

export function saveProjectRailWidth(value: number) {
  writeNumber(
    PROJECT_RAIL_WIDTH_KEY,
    Math.round(
      clamp(value, PROJECT_RAIL_WIDTH_MIN, PROJECT_RAIL_WIDTH_MAX),
    ),
  );
}

export function loadTranscriptAnchor(): boolean {
  return readFlag(TRANSCRIPT_ANCHOR_KEY) ?? TRANSCRIPT_ANCHOR_DEFAULT;
}

export function saveTranscriptAnchor(value: boolean) {
  writeFlag(TRANSCRIPT_ANCHOR_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(TRANSCRIPT_ANCHOR_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

function isEditorFontSize(value: unknown): value is EditorFontSize {
  return EDITOR_FONT_SIZES.includes(value as EditorFontSize);
}

export function loadEditorFontSize(): EditorFontSize {
  const raw = readNumber(EDITOR_FONT_SIZE_KEY);
  return isEditorFontSize(raw) ? raw : EDITOR_FONT_SIZE_DEFAULT;
}

/** Saves the nearest size on the list and applies it. */
export function saveEditorFontSize(value: number): EditorFontSize {
  const next = EDITOR_FONT_SIZES.reduce((best, size) => (Math.abs(size - value) < Math.abs(best - value) ? size : best));
  writeNumber(EDITOR_FONT_SIZE_KEY, next);
  applyEditorFontSize(next);
  return next;
}

/** CodeMirror reads `--font-size-code`; Monaco's mounts follow the event. */
export function applyEditorFontSize(size: EditorFontSize) {
  document.documentElement.style.setProperty("--font-size-code", `${size}px`);
  window.dispatchEvent(new CustomEvent<EditorFontSize>(EDITOR_FONT_CHANGE_EVENT, { detail: size }));
}

/** Monaco's size and line height for the editor's type size. */
export function editorFontOptions(size: EditorFontSize = loadEditorFontSize()): { fontSize: number; lineHeight: number } {
  return { fontSize: size, lineHeight: { 12: 18, 13: 20, 14: 22 }[size] };
}
