import type { MailBox } from "work-kit/mail";
import type { MailChatKind } from "@shared/work/mailChat";

/**
 * The few things a fresh mail chat offers to ask (docs/DESIGN.md "The Mail view"): fixed by what the chat is about,
 * never written by a model, three at most, gone once he types or the thread exists.
 */
export interface StarterFacts {
  kind: MailChatKind;
  box: MailBox;
  query: string | null;
  /** the open mail's other party, by first name */
  firstName?: string | null;
  /** he wrote the newest message */
  wroteLast?: boolean;
  messageCount?: number;
  /** his own reply is open in the composer with words in it */
  replyOpen?: boolean;
}

export function starters(facts: StarterFacts): string[] {
  if (facts.kind === "picked") return ["Which of these need me?", "Summarize these"];
  if (facts.kind === "box") {
    if (facts.query?.trim()) return ["Summarize what this finds"];
    if (facts.box === "waiting") return ["Draft nudges for these"];
    if (facts.box === "inbox" || facts.box === "needsMe") return ["What needs me today?"];
    return [];
  }
  // A sender's name is the sender's to write: only a plain name-like word goes into his message, else none.
  const name = nameWord(facts.firstName);
  const ask = facts.wroteLast || !name ? "What is left to do here?" : `What does ${name} need from me?`;
  const last = (facts.messageCount ?? 0) >= 4 ? "Summarize this thread" : name ? `Find earlier mail with ${name}` : "Summarize this thread";
  const rows = [ask, "Draft a reply", last];
  return facts.replyOpen ? ["Rewrite my reply", ...rows.slice(0, 2)] : rows;
}

/** A first name fit to put in his words: one word of letters, an apostrophe or a hyphen, 24 at most; else null. */
export function nameWord(name: string | null | undefined): string | null {
  const word = name?.trim() ?? "";
  return /^[\p{L}][\p{L}'’-]{0,23}$/u.test(word) ? word : null;
}
