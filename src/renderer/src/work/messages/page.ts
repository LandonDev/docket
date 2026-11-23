import { useSyncExternalStore } from "react";
import type { RowAnchor } from "../../lib/transcriptWindow";
import type { ChatFilter } from "./model";

/**
 * What each workspace's Messages shows, kept while the window lives, so
 * coming back finds it as it was (as Mail's page does): the open
 * conversation, the filter, the search, where the list and each
 * conversation were scrolled, and what he typed in each. The places are kept
 * outside React, so a scroll re-renders nothing; the words wake only the
 * composer that reads them.
 */

export interface MessagesPage {
  chatId: string | null;
  filter: ChatFilter;
  query: string;
}

const BLANK: MessagesPage = { chatId: null, filter: "all", query: "" };
const pages = new Map<string, MessagesPage>();
const listeners = new Set<() => void>();

export const pageOf = (workspaceId: string): MessagesPage => pages.get(workspaceId) ?? BLANK;

/** Changes what a workspace's Messages shows. The preview sets its scenes through it. */
export function patchPage(workspaceId: string, next: Partial<MessagesPage>): void {
  pages.set(workspaceId, { ...pageOf(workspaceId), ...next });
  for (const listener of listeners) listener();
}

export function usePage(workspaceId: string): MessagesPage {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => pageOf(workspaceId),
    () => pageOf(workspaceId),
  );
}

// ── Kept without a render ──

const listTops = new Map<string, number>();
/** Where a conversation was scrolled when he left it: a block and how far up from its foot; none at the foot. */
const places = new Map<string, RowAnchor>();
const typed = new Map<string, string>();
const key = (workspaceId: string, chatId: string): string => `${workspaceId}\u0000${chatId}`;

/** Where the list was scrolled, each filter its own place. */
export const listTopOf = (workspaceId: string, filter: ChatFilter): number => listTops.get(`${workspaceId}\u0000${filter}`) ?? 0;
export const keepListTop = (workspaceId: string, filter: ChatFilter, top: number): void => void listTops.set(`${workspaceId}\u0000${filter}`, top);

/** The row the list gives the keys back to when he comes back from a conversation under 640px. */
const returns = new Map<string, string>();
export const returnTo = (workspaceId: string, chatId: string): void => void returns.set(workspaceId, chatId);
/** Taken once: the row to stand on, if he just came back. */
export function takeReturn(workspaceId: string): string | undefined {
  const chatId = returns.get(workspaceId);
  returns.delete(workspaceId);
  return chatId;
}

export const placeOf = (workspaceId: string, chatId: string): RowAnchor | undefined => places.get(key(workspaceId, chatId));
export function keepPlace(workspaceId: string, chatId: string, anchor: RowAnchor | null): void {
  if (anchor) places.set(key(workspaceId, chatId), anchor);
  else places.delete(key(workspaceId, chatId));
}

/** What he typed in a conversation and has not sent; the composer reads it back. */
export const typedIn = (workspaceId: string, chatId: string): string => typed.get(key(workspaceId, chatId)) ?? "";
const typedListeners = new Set<() => void>();
export function keepTyped(workspaceId: string, chatId: string, text: string): void {
  if (text) typed.set(key(workspaceId, chatId), text);
  else typed.delete(key(workspaceId, chatId));
  for (const listener of typedListeners) listener();
}
/** What he typed in one conversation, live: an Undo puts a reply's words back here. */
export function useTyped(workspaceId: string, chatId: string): string {
  return useSyncExternalStore(
    (fn) => {
      typedListeners.add(fn);
      return () => void typedListeners.delete(fn);
    },
    () => typedIn(workspaceId, chatId),
    () => typedIn(workspaceId, chatId),
  );
}

// ── A message to bring into view ──

/** A message asked for from elsewhere (a search hit, a sent chip, a tell): held until the conversation has shown it once. */
const wanted = new Map<string, { chatId: string; messageId: string }>();
const wantedListeners = new Set<() => void>();
const tellWanted = (): void => {
  for (const listener of wantedListeners) listener();
};

/** Opens a conversation on one of its messages. */
export function wantMessage(workspaceId: string, chatId: string, messageId: string): void {
  wanted.set(workspaceId, { chatId, messageId });
  patchPage(workspaceId, { chatId });
  tellWanted();
}
/** The message a conversation is asked to bring into view, if any. */
export function useWanted(workspaceId: string, chatId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      wantedListeners.add(fn);
      return () => void wantedListeners.delete(fn);
    },
    () => {
      const want = wanted.get(workspaceId);
      return want?.chatId === chatId ? want.messageId : null;
    },
  );
}
/** Done with it: shown, or not to be found. */
export function dropWanted(workspaceId: string): void {
  if (wanted.delete(workspaceId)) tellWanted();
}

/** Test seam: every workspace back to blank. */
export function resetPages(): void {
  pages.clear();
  listTops.clear();
  places.clear();
  typed.clear();
  wanted.clear();
  returns.clear();
  for (const listener of listeners) listener();
}
