import type { ReactNode } from "react";
import { errorText } from "@shared/work";
import { isSilence, lifeosHostName, lifeosStateOf } from "../shell/lifeos";
import { downIsSilence, downOf, downWords, useDownPress, type LifeosDown } from "../shell/lifeosDown";
import { useDownAction } from "../shell/DownSignIn";

/**
 * Why a held LifeOS mail could not be read whole, by the read's own cause: the host's LifeOS state, said by the rule
 * with the item's host named and the rule's press (Retry for silence, which reads the mail again; Sign in, Show the
 * code or Open Settings where this window may, else who can), or, for any other cause, "The mail did not load" with
 * Retry. "wait" for a LifeOS that is still connecting: the quote's bone stays, and the mail is read again once it is back.
 */
export function unreadDown(err: unknown): LifeosDown | "wait" | null {
  if (isSilence(err)) return "unanswered";
  const state = lifeosStateOf(errorText(err));
  if (!state) return null;
  if (state === "connecting" || state === "connected") return "wait";
  return downOf({ client: null, state }) ?? null;
}

/** What the unread note says: its words, whether it is red (silence, or a cause with no state), the press, and who can. */
export interface MailUnreadSaid {
  words: string;
  red: boolean;
  cause: LifeosDown | null;
  elsewhere: string | null;
  action: { label: string; run: () => void | Promise<void> } | undefined;
  dialog: ReactNode;
}

/** The unread note's words and press; null with no failed read, or while LifeOS is still connecting (a wait). Hooks run on every render. */
export function useMailUnread(error: unknown, failed: boolean, environmentId: string, onRetry: () => void): MailUnreadSaid | null {
  const down = failed ? unreadDown(error) : "wait";
  const cause = down === "wait" ? null : down;
  const { press, elsewhere } = useDownPress(cause, environmentId);
  const { action, dialog } = useDownAction(cause ? press : "retry", environmentId, onRetry);
  if (down === "wait") return null;
  return { words: cause ? downWords(cause, lifeosHostName(environmentId)) : "The mail did not load", red: !cause || downIsSilence(cause), cause, elsewhere, action, dialog };
}
