import type { ContextChip } from "@shared/work";

/**
 * Where "Mention in a thread" puts a mail while the chat beside the mail is open: that chat's composer, so he can
 * bring a second mail into it on purpose. Set by the Mail view while its dock is open; null otherwise.
 */
let target: ((chip: ContextChip) => void) | null = null;

export const mailDockPort = {
  get: (): ((chip: ContextChip) => void) | null => target,
  set(next: ((chip: ContextChip) => void) | null): void {
    target = next;
  },
};
