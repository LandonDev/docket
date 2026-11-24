import type { MailtoDraft } from "work-kit/mail";

/**
 * A new mail asked for from outside Mail (a person's Write): the mail kit's `onMailto`. The newest
 * mailbox on the page hears it; one asked for before any mailbox listens waits for the next to
 * mount, since the ask opens the Mail view first. A draft for one job's workspace (Running late,
 * from another job's Agenda) goes only to that workspace's mailbox: never to the one on screen
 * before the window moves, and never to another job's that mounts next, which drops it, since he
 * went elsewhere. It only opens the composer: sending is the composer's own, held as always.
 */
type Listener = { hear: (draft: MailtoDraft) => void; workspaceId?: string };
let waiting: { draft: MailtoDraft; workspaceId?: string } | null = null;
const listeners: Listener[] = [];

export function writeMail(draft: MailtoDraft, workspaceId?: string): void {
  const newest = listeners.at(-1);
  if (newest && (!workspaceId || newest.workspaceId === workspaceId)) newest.hear(draft);
  else waiting = { draft, ...(workspaceId ? { workspaceId } : {}) };
}

/** `workspaceId`: the workspace whose Mail this mailbox is; absent, a mailbox of no one job (a preview). */
export function onMailto(hear: (draft: MailtoDraft) => void, workspaceId?: string): () => void {
  const listener: Listener = { hear, ...(workspaceId ? { workspaceId } : {}) };
  listeners.push(listener);
  if (waiting && (!waiting.workspaceId || waiting.workspaceId === workspaceId)) {
    const { draft } = waiting;
    waiting = null;
    // After the mailbox's own effects, so its composer is ready for it.
    queueMicrotask(() => hear(draft));
  } else if (waiting && workspaceId) waiting = null;
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** A mail to these addresses and nothing else. */
export const mailTo = (to: readonly string[]): MailtoDraft => ({ to: [...to], cc: [], bcc: [], subject: "", body: "" });
