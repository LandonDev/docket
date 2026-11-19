import type { DocThreadRow } from "@shared/contract-work-docs";
import type { ThreadRow, ThreadsAdapter, ThreadWriteApi } from "work-kit/editor";
import type { DocHost } from "./host";

/**
 * A document's comment threads as the shared editor reads them
 * (`ThreadsAdapter`), from the host's `work.docs.threads`. Asked again after
 * every write of his and whenever the host says they changed (another
 * window, LifeOS desktop, an agent's `doc_comment`). One per open document.
 */

export interface DocThreads {
  adapter: ThreadsAdapter;
  /** names for every author the rows hold */
  names(): Record<string, string>;
  /** Ask again: the host said the rows changed. */
  refresh(): void;
}

export function docThreads(host: DocHost, doc: string): DocThreads {
  let rows: readonly ThreadRow[] | null | undefined;
  let names: Record<string, string> = {};
  let failed = false;
  let asking: Promise<void> | null = null;
  let again = false;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const l of listeners) l();
  };

  const load = (): void => {
    if (asking) {
      again = true;
      return;
    }
    asking = host
      .threads()
      .then((got) => {
        rows = got.rows as ThreadRow[];
        names = got.names;
        failed = false;
      })
      .catch(() => {
        // Keep what was shown; with nothing yet, the editor says the threads could not be read.
        if (rows === undefined) rows = null;
        failed = true;
      })
      .finally(() => {
        asking = null;
        tell();
        if (again) {
          again = false;
          load();
        }
      });
  };

  const after = async <T>(write: Promise<T>): Promise<T> => {
    try {
      return await write;
    } finally {
      load();
    }
  };

  const writes: ThreadWriteApi = {
    createThread: ({ body, quote }) => after(host.thread<DocThreadRow>({ op: "create", body, ...(quote ? { quote } : {}) })) as Promise<ThreadRow>,
    addComment: ({ threadPublicId, body }) => after(host.thread({ op: "reply", threadId: threadPublicId, body })) as Promise<ThreadRow["comments"][number]>,
    updateComment: ({ commentPublicId, body }) => after(host.thread({ op: "edit", commentId: commentPublicId, body })),
    deleteComment: ({ commentPublicId }) => after(host.thread({ op: "deleteComment", commentId: commentPublicId })),
    deleteThread: ({ threadPublicId }) => after(host.thread({ op: "deleteThread", threadId: threadPublicId })),
    setResolved: ({ threadPublicId, resolved }) => after(host.thread({ op: "resolve", threadId: threadPublicId, resolved })),
    setReaction: ({ commentPublicId, emoji, reacted }) => after(host.thread({ op: "react", commentId: commentPublicId, emoji, reacted })),
  };

  const adapter: ThreadsAdapter = {
    subscribe(name, listener) {
      if (name !== doc) return () => undefined;
      listeners.add(listener);
      if (rows === undefined && !asking) load();
      return () => listeners.delete(listener);
    },
    rows: (name) => (name === doc ? rows : null),
    state: (name) => ({ retry: name === doc && failed ? load : null, waiting: name === doc && asking !== null }),
    writes: () => writes,
  };
  return { adapter, names: () => names, refresh: load };
}
