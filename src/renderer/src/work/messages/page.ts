import { useSyncExternalStore } from "react";
import type { RowAnchor } from "../../lib/transcriptWindow";
import type { ChatFilter } from "./model";

/**
 * What each workspace's Messages shows, kept while the window lives, so
 * coming back finds it as it was (as Mail's page does): the open
 * conversation, the filter, the search, where the list and each
 * conversation were scrolled, and what he typed in each. The places and the
 * words are kept outside React: a scroll or a key re-renders nothing.
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

export const listTopOf = (workspaceId: string): number => listTops.get(workspaceId) ?? 0;
export const keepListTop = (workspaceId: string, top: number): void => void listTops.set(workspaceId, top);

export const placeOf = (workspaceId: string, chatId: string): RowAnchor | undefined => places.get(key(workspaceId, chatId));
export function keepPlace(workspaceId: string, chatId: string, anchor: RowAnchor | null): void {
  if (anchor) places.set(key(workspaceId, chatId), anchor);
  else places.delete(key(workspaceId, chatId));
}

/** What he typed in a conversation and has not sent; the composer reads it back. */
export const typedIn = (workspaceId: string, chatId: string): string => typed.get(key(workspaceId, chatId)) ?? "";
export function keepTyped(workspaceId: string, chatId: string, text: string): void {
  if (text) typed.set(key(workspaceId, chatId), text);
  else typed.delete(key(workspaceId, chatId));
}

/** Test seam: every workspace back to blank. */
export function resetPages(): void {
  pages.clear();
  listTops.clear();
  places.clear();
  typed.clear();
  for (const listener of listeners) listener();
}
