import type { MailtoDraft } from "work-kit/mail";

/**
 * A new mail asked for from outside Mail (a person's Write): the mail kit's `onMailto`. The newest
 * mailbox on the page hears it; one asked for before any mailbox listens waits for the next to
 * mount, since the ask opens the Mail view first. It only opens the composer: sending is the
 * composer's own, held as always.
 */
let waiting: MailtoDraft | null = null;
const listeners: ((draft: MailtoDraft) => void)[] = [];

export function writeMail(draft: MailtoDraft): void {
  const newest = listeners.at(-1);
  if (newest) newest(draft);
  else waiting = draft;
}

export function onMailto(listener: (draft: MailtoDraft) => void): () => void {
  listeners.push(listener);
  if (waiting) {
    const draft = waiting;
    waiting = null;
    // After the mailbox's own effects, so its composer is ready for it.
    queueMicrotask(() => listener(draft));
  }
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/** A mail to these addresses and nothing else. */
export const mailTo = (to: readonly string[]): MailtoDraft => ({ to: [...to], cc: [], bcc: [], subject: "", body: "" });
