import { diffWords, type InlineOp } from "work-kit/formats/diff";

/** An agent's rewrite as LifeOS keeps it on the draft (`outbox.proposed`). */
export interface Proposal {
  subject?: string;
  text?: string;
  by?: string;
  at?: number;
}

/** The rewrite against the draft: the subject's words and the body's, each as kept, taken and put-in runs; null for a part it leaves alone. */
export function proposalDiff(draft: { subject: string; text: string }, proposed: Proposal): { subject: InlineOp[] | null; body: InlineOp[] | null } {
  const subject = proposed.subject !== undefined && proposed.subject !== draft.subject ? diffWords(draft.subject, proposed.subject) : null;
  const body = proposed.text !== undefined && proposed.text.trim() !== draft.text.trim() ? diffWords(draft.text.trim(), proposed.text.trim()) : null;
  return { subject, body };
}
