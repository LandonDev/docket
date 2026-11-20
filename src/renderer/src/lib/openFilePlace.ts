import { sessionStore } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import type { Session } from "./session";

/**
 * Where a file from outside opens in Work (docs/agents/work-canvas.md "Opening a file
 * from outside"): a Work thread's canvas, a Work draft's (made a thread first), or a
 * new thread's, started from a Work view. In the first paint for the File menu's
 * Open File… row, so it reads the stores and imports nothing of Work.
 */
export type FilePlace = { at: "thread" | "draft"; sessionId: string } | { at: "new" };

/** What the place is read from; a test hands in its own. */
export interface FileLook {
  meta(id: string): { scope?: string | null } | null;
  draft(id: string): Pick<Session, "scope" | "workspaceId"> | undefined;
  /** A tab whose thread has not loaded is no draft. */
  provisional(id: string): boolean;
  workspaceKind(id: string): string | null;
}

export const storeFileLook: FileLook = {
  meta: (id) => sessionStore.metaOf(id),
  draft: (id) => sessionStore.get(id),
  provisional: (id) => sessionStore.isProvisional(id),
  workspaceKind: (id) => workspaceStore.getSnapshot().workspaces.find((w) => w.id === id)?.kind ?? null,
};

/** A thread or draft of Work's, by its id: its place, else null. */
export function sessionFilePlace(id: string, look: FileLook = storeFileLook): FilePlace | null {
  const meta = look.meta(id);
  if (meta) return meta.scope === "work" ? { at: "thread", sessionId: id } : null;
  const draft = look.provisional(id) ? undefined : look.draft(id);
  if (!draft) return null;
  const work = draft.scope === "work" || (!!draft.workspaceId && look.workspaceKind(draft.workspaceId) === "work");
  return work ? { at: "draft", sessionId: id } : null;
}

/** Open File…'s place: a new thread while a Work view is in front, else the focused thread's or draft's; null greys it. */
export function filePlaceOf(focusedId: string | null, workViewOpen: boolean, look: FileLook = storeFileLook): FilePlace | null {
  if (workViewOpen) return { at: "new" };
  return focusedId ? sessionFilePlace(focusedId, look) : null;
}
