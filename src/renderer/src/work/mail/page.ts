import { useSyncExternalStore } from "react";
import { opening, type ComposeState, type MailBox } from "work-kit/mail";
import type { MailInView } from "./chat/subject";

/**
 * What each workspace's Mail shows (docs/agents/work-mail.md): its mailbox, the open mail, a mail being written and
 * the chat beside it, kept while the window lives so coming back finds it as it was. Its own module, so the chat's
 * cards in any transcript can put a draft in the reply box without loading the Mail view.
 */

export interface MailPage {
  account: string | null;
  /** The mailbox the list shows. */
  box: MailBox;
  threadId: string | null;
  sheetOpen: boolean;
  compose: ComposeState | null;
  /** The chat beside the mail is open. */
  chat: boolean;
  /** What the chat stays about while a mail opened from inside it is shown; null follows his moves. */
  chatAt: MailInView | null;
}

export const BLANK: MailPage = { account: null, box: "inbox", threadId: null, sheetOpen: false, compose: null, chat: false, chatAt: null };

// What each workspace's Mail showed (its mailbox, the open mail, a mail being written), kept while the window lives, so coming back finds it as it was.
export const pages = new Map<string, MailPage>();
const listeners = new Set<() => void>();

/** Changes what a workspace's Mail shows. Exported for the preview page, which sets a scene. */
export function patch(workspaceId: string, next: Partial<MailPage>): void {
  pages.set(workspaceId, { ...(pages.get(workspaceId) ?? BLANK), ...next });
  for (const listener of listeners) listener();
}

export function usePage(workspaceId: string): MailPage {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => pages.get(workspaceId) ?? BLANK,
  );
}

/** What a workspace's Mail shows now. */
export const pageOf = (workspaceId: string): MailPage => pages.get(workspaceId) ?? BLANK;

/** What each workspace's Mail shows now, so a mail opened from a chip can keep the chat on what it was about. */
export const liveViews = new Map<string, MailInView>();

/**
 * Opens a mail by the view's own way in (a sent chip, a chip in the chat): an open chat does not move with it, it
 * stays on what it was about until his own next move in the list.
 */
export function showMail(workspaceId: string, threadId: string): void {
  const now = pages.get(workspaceId) ?? BLANK;
  if (now.chat && !now.chatAt) patch(workspaceId, { chatAt: liveViews.get(workspaceId) ?? null });
  patch(workspaceId, { threadId, compose: null });
}

/** The row id of his own reply open in each workspace's Mail once the composer saved it (work-kit's `onView`), else null. */
export const liveDraftIds = new Map<string, string | null>();

/**
 * Puts a draft in Mail's reply box (the chat's Put in reply): in the thread it answers, opened there if it is not, or
 * as a new mail. His own reply that was open stays saved in Drafts; the answer is what Undo puts back (that mail, and
 * his reply opened again on its saved row), or null when no words of his were open.
 */
export function putInReply(workspaceId: string, draft: { id: string; threadId?: string | null }): Pick<MailPage, "threadId" | "compose"> | null {
  const { threadId, compose } = pageOf(workspaceId);
  const open = compose?.open as { kind?: string; id?: string } | undefined;
  // His reply as a saved row: the row it was opened on, else the row his composer saved it to.
  const his = open?.kind === "row" ? (open.id ?? null) : (liveDraftIds.get(workspaceId) ?? null);
  const back = compose && his && his !== draft.id ? { threadId, compose: opening(compose.threadId ? { open: { kind: "row", id: his }, threadId: compose.threadId, full: compose.full } : { open: { kind: "row", id: his }, full: true }) } : null;
  if (draft.threadId && threadId !== draft.threadId) showMail(workspaceId, draft.threadId);
  patch(workspaceId, {
    compose: opening(draft.threadId ? { open: { kind: "row", id: draft.id }, threadId: draft.threadId, full: false } : { open: { kind: "row", id: draft.id }, full: true }),
  });
  return back;
}
