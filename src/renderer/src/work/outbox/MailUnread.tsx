import type { ReactNode } from "react";
import { errorText } from "@shared/work";
import { isSilence, lifeosHostName, lifeosStateOf } from "../shell/lifeos";
import { downIsSilence, downOf, downWords, useDownPress, type LifeosDown } from "../shell/lifeosDown";
import { useDownAction } from "../shell/DownSignIn";
import { useLiveDown } from "../shell/lifeosLive";
import { connectingWords } from "../shell/lifeosWords";

/**
 * Why a held LifeOS mail could not be read whole, by the read's own cause: the host's LifeOS state, said by the rule
 * with the item's host named and the rule's press (Retry for silence, which reads the mail again; Sign in, Show the
 * code or Open Settings where this window may, else who can), or, for any other cause, "The mail did not load" with
 * Retry. "wait" for a LifeOS that is still connecting: the quote's bone stays beside the note's named wait, and the mail
 * is read again once it is back.
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
  /** The state said, or "connecting" for the named wait (no press), or null for a cause with no state. */
  cause: LifeosDown | "connecting" | null;
  elsewhere: string | null;
  action: { label: string; run: () => void | Promise<void> } | undefined;
  dialog: ReactNode;
}

/**
 * The unread note's words and press; null with no failed read. While the host's LifeOS is still connecting it is the
 * muted wait, its computer named ("LifeOS is still connecting on the box"), with no press. The cause
 * is the host's live status's over the one the read saved (`useLiveDown`): a sign-in begun elsewhere is Show the code at
 * once. The detail reads the mail again once that host says connected. Hooks run on every render.
 */
export function useMailUnread(error: unknown, failed: boolean, environmentId: string, onRetry: () => void): MailUnreadSaid | null {
  const was = failed ? unreadDown(error) : null;
  const live = useLiveDown(was === "wait" ? "connecting" : was, environmentId);
  const cause = live.down;
  const { press, elsewhere } = useDownPress(cause, environmentId);
  const { action, dialog } = useDownAction(cause ? press : "retry", environmentId, onRetry);
  if (!failed) return null;
  if (live.waits) return { words: connectingWords(lifeosHostName(environmentId)), red: false, cause: "connecting", elsewhere: null, action: undefined, dialog: null };
  return { words: cause ? downWords(cause, lifeosHostName(environmentId)) : "The mail did not load", red: !cause || downIsSilence(cause), cause, elsewhere, action, dialog };
}
