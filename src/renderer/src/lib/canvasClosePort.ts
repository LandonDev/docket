/**
 * ⌘W (File → Close Tab) with focus on the item side of a Work thread's pane closes the item shown there, as it closes
 * a Files tab, never the thread (docs/agents/work-canvas.md "Closing an item"). First-paint code: the port alone. Each
 * mounted canvas seat puts its close here under its thread's id and marks its tab row `data-canvas-seat`; App's Close
 * Tab asks the port first.
 */

const closers = new Map<string, () => void>();

export const canvasClosePort = {
  /** A seat's close of its shown item. Returns its off, which leaves a newer seat's close in place. */
  set(sessionId: string, close: () => void): () => void {
    closers.set(sessionId, close);
    return () => {
      if (closers.get(sessionId) === close) closers.delete(sessionId);
    };
  },
  /** Closes the item shown beside a thread when focus is on its side of the pane; answers whether one was. */
  run(target: Element | null): boolean {
    const board = target?.closest?.("[data-board]");
    const sessionId = board?.querySelector("[data-canvas-seat]")?.getAttribute("data-canvas-seat");
    const close = sessionId ? closers.get(sessionId) : undefined;
    if (!close) return false;
    close();
    return true;
  },
};
