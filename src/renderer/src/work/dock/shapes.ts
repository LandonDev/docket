/**
 * The sizes of a chat docked beside something (docs/DESIGN.md "The Files place", "The Mail view"): 360px to start,
 * never narrower (the chat's floor beside anything), never wider than 720px or than leaves what sits beside it its
 * `beside` px. Where the body cannot hold both, the chat lies over the whole body instead, its close still at its head.
 */
export const DOCK_SIZE = { width: 360, min: 360, max: 720 } as const;
/** Under this much view the sidebar folds itself away while a dock is open, and comes back when it closes. */
export const DOCK_FOLD_AT = 900;

/** The widest the dock may be in a body of `body` px that keeps `beside` px for what it sits beside (unmeasured, 0: the bound alone). */
export const dockMost = (body: number, beside: number): number => (body > 0 ? Math.max(DOCK_SIZE.min, Math.min(DOCK_SIZE.max, body - beside)) : DOCK_SIZE.max);

/** A dragged or kept width, held to the dock's bounds and to what the body leaves. */
export function clampDock(width: number, body: number, beside: number): number {
  return Math.round(Math.max(DOCK_SIZE.min, Math.min(dockMost(body, beside), Number.isFinite(width) ? width : DOCK_SIZE.width)));
}

/** How the dock sits in a body of `body` px: beside at its width, or over it where what it sits beside would get under `beside` px. */
export function dockShape(body: number, width: number, beside: number): { over: true } | { over: false; width: number } {
  if (body > 0 && body - DOCK_SIZE.min < beside) return { over: true };
  return { over: false, width: clampDock(width, body, beside) };
}

/** Whether the sidebar folds itself away: under `foldAt` of view always, under 900px while a chat is docked. */
export const sidebarFolds = (view: number, docked: boolean, foldAt: number): boolean => view > 0 && (view < foldAt || (docked && view < DOCK_FOLD_AT));
