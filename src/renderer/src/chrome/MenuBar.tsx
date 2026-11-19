import { defineChunk } from "../lib/lazyChunk";

/**
 * The in-app menu bar (MenuBarView.tsx) draws only on the /ui page off macOS,
 * never in a desktop window, so it and the menu tree load from a chunk of
 * their own and stay out of every window's first paint. It draws nothing
 * until a lone Alt opens it, so nothing stands in while it loads.
 */
const menuBarChunk = defineChunk("menuBar", () => import("./MenuBarView"));

export const MenuBar = menuBarChunk.surface("MenuBar", null);
