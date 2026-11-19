import type { ContextChip } from "@shared/work";
import { htmlWords } from "../outbox/model";

/**
 * The mail pillar's pure parts on the screen (docs/agents/work-mail.md):
 * the chip a thread is started from, and a held mail as the Outbox shows
 * it. An agent's waiting rewrite is proposal.ts.
 */

/** What Start thread puts in a new thread's composer: the mail, by its LifeOS thread. */
export function mailChip(threadId: string, subject: string | null | undefined): ContextChip {
  return { kind: "mail", label: subject?.trim() || "A mail", ref: { at: "lifeos", table: "mailThreads", id: threadId } };
}

interface Address {
  name?: string;
  address: string;
}

/** A held mail as it will go: who it is from and to, its subject, its words. */
export interface MailActView {
  rows: Array<{ label: string; people?: Address[]; text?: string }>;
  body: string;
  files: string[];
  /** an agent's rewrite waits in the draft */
  proposed: boolean;
}

export function mailActView(payload: unknown): MailActView {
  const p = (payload ?? {}) as { message?: Record<string, unknown>; proposed?: unknown };
  const m = p.message ?? {};
  const list = (key: string): Address[] => (Array.isArray(m[key]) ? (m[key] as Address[]).filter((a) => typeof a?.address === "string") : []);
  const from = m.from && typeof (m.from as Address).address === "string" ? [m.from as Address] : [];
  const rows: MailActView["rows"] = [];
  if (from.length) rows.push({ label: "From", people: from });
  for (const [key, label] of [["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"]] as const) {
    const people = list(key);
    if (people.length) rows.push({ label, people });
  }
  rows.push({ label: "Subject", text: typeof m.subject === "string" && m.subject.trim() ? m.subject : "(no subject)" });
  const files = Array.isArray(m.attachments) ? (m.attachments as Array<{ name?: unknown }>).flatMap((a) => (typeof a?.name === "string" ? [a.name] : [])) : [];
  // The html is what goes when there is one, so the view reads from it (the hold review's finding 11).
  const body = typeof m.html === "string" && m.html.trim() ? htmlWords(m.html) : typeof m.text === "string" ? m.text.trim() : "";
  return { rows, body, files, proposed: !!p.proposed };
}
