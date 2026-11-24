import { createContext } from "react";

/**
 * Whether the place a guest is laid over is covered (a chat docked over the Files tab, a file at the side over it)
 * and whether the tab fills the window: what a canvas kind that mounts its own guest (a Microsoft form) passes to
 * `LiveBody`, as a live file's tab passes it directly. Outside a Files tab nothing covers it.
 */
export const LiveCover = createContext<{ covered: boolean; full: boolean }>({ covered: false, full: false });
