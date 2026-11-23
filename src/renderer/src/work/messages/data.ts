import { createContext, useContext } from "react";
import type { ChatDetail, ChatHit, ChatMessage, ChatRow, ChatSourceState } from "@shared/work/messages";
import type { LifeosQuery } from "../shell/lifeos";
import type { ChatFilter } from "./model";

/**
 * The one seam between the Messages screens and what they show
 * (docs/agents/work-messages.md). `live.ts` answers it from LifeOS on the
 * workspace's sector session; `fixtures.ts` from made-up conversations, for
 * the preview and the tests. The screens read nothing else. The composer's
 * phase adds its verbs here (send, undo, retry, the drafts, the held reply).
 */

/** A list LifeOS pages: what is held, whether it is all, and a way to ask for more (one live query, grown). */
export interface Paged<T> {
  rows: readonly T[];
  done: boolean;
  more(): void;
}

export interface MessagesData {
  /** The job's conversations, newest first, under a filter. */
  useChats(filter: ChatFilter): LifeosQuery<Paged<ChatRow>>;
  /** How many of the job's conversations wait unread; null until known. */
  useUnread(): number | null;
  /** One conversation: its row, its source, its route and its link. Null when it is gone. */
  useChat(id: string | null): LifeosQuery<ChatDetail | null>;
  /** A conversation's messages, newest first, as LifeOS answers them; `more` reaches back 50 further. */
  useMessages(chatId: string | null): LifeosQuery<Paged<ChatMessage>>;
  /** The job's chat sources (none: no chat is linked to it). */
  useSources(): LifeosQuery<readonly ChatSourceState[]>;
  /** The job's messages that hold the words. */
  useSearch(text: string): LifeosQuery<readonly ChatHit[]>;
  /** The conversations a thread's draft waits in, for the row's amber mark. */
  useDrafted(): ReadonlySet<string>;
  /** Now, moved on each minute, so "2:14 PM" turns to "Yesterday" at midnight. */
  useNow(): number;
  markRead(chatId: string): void;
  markUnread(chatId: string): void;
}

const NONE: ReadonlySet<string> = new Set();
const LOADING = { status: "loading" } as const;

/** Every answer still on its way: the frame the view lands in while its session opens. */
export const WAITING: MessagesData = {
  useChats: () => LOADING,
  useUnread: () => null,
  useChat: () => LOADING,
  useMessages: () => LOADING,
  useSources: () => LOADING,
  useSearch: () => LOADING,
  useDrafted: () => NONE,
  useNow: () => Date.now(),
  markRead: () => {},
  markUnread: () => {},
};

const Data = createContext<MessagesData>(WAITING);
export const MessagesDataProvider = Data.Provider;
export const useMessagesData = (): MessagesData => useContext(Data);
