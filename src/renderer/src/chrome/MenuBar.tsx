import { defineChunk } from "../lib/lazyChunk";
import { isWebMode, nativePlatform } from "../lib/native";
import { IS_MAC } from "../lib/platform";

/**
 * The in-app menu bar (MenuBarView.tsx) draws on the /ui page off macOS and
 * in a Windows desktop window, whose native bar is hidden (a Mac's and a
 * Linux window's are the system's), so it and the menu tree load from a
 * chunk of their own and stay out of every window's first paint. It draws
 * nothing until a lone Alt opens it, so nothing stands in while it loads.
 */
const menuBarChunk = defineChunk("menuBar", () => import("./MenuBarView"));

export const MenuBar = menuBarChunk.surface("MenuBar", null);

/** Where the bar mounts, and whose rows it lists: a browser's (no terminal, no second window, none of
 *  main's rows) or a Windows desktop window's (every row but Quit); null where the system draws the menu. */
export function menuBarPlace(): "web" | "desktop" | null {
  if (isWebMode()) return IS_MAC ? null : "web";
  return nativePlatform() === "win32" ? "desktop" : null;
}
