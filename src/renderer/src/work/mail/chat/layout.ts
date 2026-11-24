import { DOCK_FOLD_AT, dockShape } from "../../dock/shapes";

/**
 * Where the chat beside the mail sits (docs/DESIGN.md "The Mail view"): at the view's right edge, 360 to 720px,
 * Mail laying out its list and reader in what it leaves. Under 480px of room left it lies over the whole view.
 */
export const MAIL_BESIDE = 480;
/** The room at and under which Mail's list and reader take turns. */
export const MAIL_NARROW_AT = 640;
/** Where the window keeps the dock's width. */
export const DOCK_WIDTH_KEY = "tc.mail.dockWidth";

export interface MailRoom {
  /** the dock lies over the view */
  over: boolean;
  /** the dock's width beside the mail (0 over it) */
  dock: number;
  /** the room Mail lays out in */
  mail: number;
  /** Mail's list and reader take turns */
  narrow: boolean;
}

/** The room of a view `view` px wide, the dock open at `width` or closed. */
export function mailRoom(view: number, open: boolean, width: number): MailRoom {
  if (!open) return { over: false, dock: 0, mail: view, narrow: view > 0 && view <= MAIL_NARROW_AT };
  const shape = dockShape(view, width, MAIL_BESIDE);
  if (shape.over) return { over: true, dock: 0, mail: view, narrow: view > 0 && view <= MAIL_NARROW_AT };
  const mail = view > 0 ? view - shape.width : 0;
  return { over: false, dock: shape.width, mail, narrow: mail > 0 && mail <= MAIL_NARROW_AT };
}

export { DOCK_FOLD_AT };

export function readDockWidth(fallback: number): number {
  try {
    const kept = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return kept > 0 ? kept : fallback;
  } catch {
    return fallback;
  }
}

export function keepDockWidth(width: number): void {
  try {
    localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // A window that may not store keeps the width for its own life.
  }
}
