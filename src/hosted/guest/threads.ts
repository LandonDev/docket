import type { ThreadRow, ThreadsAdapter, ThreadWriteApi } from "work-kit/editor";
import { textOf, type Session } from "./session";

/**
 * A document's comments on the guest's page, as the shared editor reads them
 * (`ThreadsAdapter`). A guest may start a comment and reply; the service
 * takes plain words only and refuses the rest, so editing, deleting,
 * resolving and reactions are not offered here at all.
 */
export function guestThreads(session: Session, doc: string): { adapter: ThreadsAdapter; names(): Record<string, string>; refresh(): void } {
  let rows: readonly ThreadRow[] | null | undefined;
  let names: Record<string, string> = {};
  let failed = false;
  let asking: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const tell = () => listeners.forEach((l) => l());

  const load = (): void => {
    if (asking) return;
    asking = session
      .threads()
      .then((got) => {
        rows = got.rows as ThreadRow[];
        names = got.names;
        failed = false;
      })
      .catch(() => {
        if (rows === undefined) rows = null;
        failed = true;
      })
      .finally(() => {
        asking = null;
        tell();
      });
  };
  const refused = () => Promise.reject(new Error("A guest can comment and reply, nothing more."));

  const writes: ThreadWriteApi = {
    async createThread({ body, quote }) {
      const made = await session.comment({ quote: quote ?? "", text: textOf(body) });
      load();
      const now = Date.now();
      return {
        thread: { publicId: made.threadId!, ...(quote ? { quote } : {}), resolved: false, resolvedAt: null, resolvedByMemberId: null, createdAt: now, updatedAt: now, deletedAt: null },
        comments: [{ publicId: `${made.threadId}c`, body, authorMemberId: session.mode.kind === "guest" ? `guest:${session.mode.id}` : "owner", reactions: [], createdAt: now, updatedAt: now, deletedAt: null }],
      } as ThreadRow;
    },
    async addComment({ threadPublicId, body }) {
      const made = await session.comment({ threadId: threadPublicId, text: textOf(body) });
      load();
      const now = Date.now();
      return { publicId: made.commentId!, body, authorMemberId: session.mode.kind === "guest" ? `guest:${session.mode.id}` : "owner", reactions: [], createdAt: now, updatedAt: now, deletedAt: null } as ThreadRow["comments"][number];
    },
    updateComment: refused,
    deleteComment: refused,
    deleteThread: refused,
    setResolved: refused,
    setReaction: refused,
  };

  const adapter: ThreadsAdapter = {
    subscribe(name, listener) {
      if (name !== doc) return () => undefined;
      listeners.add(listener);
      if (rows === undefined) load();
      return () => listeners.delete(listener);
    },
    rows: (name) => (name === doc ? rows : null),
    state: (name) => ({ retry: name === doc && failed ? load : null, waiting: name === doc && asking !== null }),
    writes: () => writes,
  };
  return { adapter, names: () => names, refresh: load };
}
