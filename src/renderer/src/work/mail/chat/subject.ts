import type { ContextChip } from "@shared/work";
import type { MailChatKind } from "@shared/work/mailChat";
import { MAIL_BOX_LABELS, type MailBox } from "work-kit/mail";
import { mailChip } from "../model";

/**
 * What the chat beside the mail is about (docs/agents/work-mail.md "The chat beside the mail"), from what Mail
 * already holds: the open mail, else two or more ticked rows, else the mailbox or the search in view. Pure: the
 * dock reads nothing to know it.
 */

/** What Mail shows, as the dock reads it. */
export interface MailInView {
  box: MailBox;
  threadId: string | null;
  /** the open mail's subject, once its thread has come */
  subject: string | null;
  /** the search as he typed it */
  query: string | null;
  /** the ticked rows' thread ids */
  picked: readonly string[];
}

export interface MailChatSubject {
  kind: MailChatKind;
  /** one chat a key, kept per workspace */
  key: string;
  /** what the dock's head says */
  title: string;
  /** what the first send carries: the mail, or a selection that names ids alone */
  chip: ContextChip;
  mailThreadId?: string;
}

/** A selection chip of the mail pillar's: its label and its quote, never a word a sender wrote. */
const listChip = (id: "picked" | "box", label: string, quote: string): ContextChip => ({ kind: "selection", label, quote, ref: { at: "work", pillar: "mail", id } });

export function mailChatSubject(workspaceId: string, view: MailInView): MailChatSubject {
  const at = `mail/${workspaceId}`;
  if (view.threadId) {
    // A chip's label holds 500 at most (ContextChipSchema); a subject is the sender's words, kept to one line.
    const title = (view.subject?.replace(/\s+/g, " ").trim() || "A mail").slice(0, 300);
    return { kind: "mail", key: `${at}/mail:${view.threadId}`, title, chip: mailChip(view.threadId, title), mailThreadId: view.threadId };
  }
  if (view.picked.length >= 2) {
    const ids = [...view.picked].sort();
    const title = `${ids.length} mails`;
    return { kind: "picked", key: `${at}/picked:${ids.join(",")}`, title, chip: listChip("picked", title, ids.join("\n")) };
  }
  const query = view.query?.trim();
  if (query) {
    const title = `Search: ${query}`;
    return { kind: "box", key: `${at}/search:${query}`, title, chip: listChip("box", title, title) };
  }
  const title = MAIL_BOX_LABELS[view.box] ?? "Mail";
  return { kind: "box", key: `${at}/box:${view.box}`, title, chip: listChip("box", title, `Mailbox: ${view.box}`) };
}
