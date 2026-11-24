/**
 * Where he was in each Work workspace (docs/agents/work-return.md): the column's view, a meeting page's event, the
 * thread shown, each view's place by its key. Per window: a reload keeps it, a relaunch takes the last window's. The
 * first paint holds this read alone; the writer is Work's (work/shell/returnRecord.ts).
 */
export interface WorkSpot {
  /** The column's view; null: a thread. */
  view?: string | null;
  event?: string;
  thread?: string;
  places?: Record<string, unknown>;
}

export const RETURN_KEY = "work.return.v1";
export type Kept = Record<string, { at: number; spots: Record<string, WorkSpot> }>;

export function keptReturns(): Kept {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(RETURN_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Kept) : {};
  } catch {
    return {};
  }
}

/** This window's spots, else (a new window) the last window's. */
export function windowSpots(id: string, all = keptReturns()): Record<string, WorkSpot> {
  return { ...(all[id] ?? Object.values(all).sort((a, b) => b.at - a.at)[0])?.spots };
}

/** The window's id, kept in sessionStorage for its life. */
export function returnWindow(): string {
  try {
    const id = globalThis.sessionStorage?.getItem(RETURN_KEY);
    if (id) return id;
    const made = `w${Math.random().toString(36).slice(2, 10)}`;
    globalThis.sessionStorage?.setItem(RETURN_KEY, made);
    return made;
  } catch {
    return "w";
  }
}

export const returnOf = (workspaceId: string): WorkSpot => windowSpots(returnWindow())[workspaceId] ?? {};
