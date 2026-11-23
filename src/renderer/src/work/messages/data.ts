import { createContext, useContext } from "react";
import type { ChatDetail, ChatFile, ChatHit, ChatMessage, ChatRow, ChatSourceState } from "@shared/work/messages";
import type { LifeosQuery } from "../shell/lifeos";
import type { ChatFilter } from "./model";

/**
 * The one seam between the Messages screens and what they show
 * (docs/agents/work-messages.md). `live.ts` answers it from LifeOS on the
 * workspace's sector session; `fixtures.ts` from made-up conversations, for
 * the preview and the tests. The screens read nothing else, and every write
 * goes through here: the read mark to LifeOS, his replies through the host.
 */

/** A list LifeOS pages: what is held, whether it is all, and a way to ask for more (one live query, grown). */
export interface Paged<T> {
  rows: readonly T[];
  done: boolean;
  more(): void;
}

/**
 * A thread's draft waiting in a conversation: a held reply (`chat.reply`, in
 * the Outbox) that his Send presses, or words left where nothing here can
 * send, which he copies.
 */
export interface ThreadDraft {
  id: string;
  held: boolean;
  text: string;
  /** The thread that wrote it, to open; null when it is gone. */
  threadId: string | null;
  /** Its title, when the host still holds it. */
  thread?: string;
}

/** What a press on a file does: show it beside the conversation, or save it to Downloads. */
export type FileVerb = "view" | "save";

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
  /** His own reply, through the host; LifeOS holds it for its undo time. Rejects with LifeOS's words. */
  send(chatId: string, text: string): Promise<void>;
  /** Takes a reply back inside its undo time and answers its words. */
  undo(chatId: string, replyId: string): Promise<string>;
  /** Sends a failed reply again. */
  retry(chatId: string, replyId: string): Promise<void>;
  /** The threads' drafts waiting in a conversation, the held ones first. */
  useDrafts(chatId: string | null): readonly ThreadDraft[];
  /** Presses a held draft with these words: an edit is saved to it first. Rejects with why nothing went. */
  sendDraft(draft: ThreadDraft, text: string): Promise<void>;
  /** Discards a held draft, or drops a copy-only one. */
  dropDraft(draft: ThreadDraft): Promise<void>;
  /** Asks LifeOS's worker to fetch a message's files it only listed; rejects when LifeOS did not take the ask. */
  requestFiles(messageId: string): Promise<void>;
  /** What a press on a file does here. */
  fileVerb(file: ChatFile): FileVerb;
  /** Opens a stored file beside the conversation, or saves it. */
  openFile(chatId: string, message: ChatMessage, file: ChatFile): void;
}

const NONE: ReadonlySet<string> = new Set();
const NO_DRAFTS: readonly ThreadDraft[] = [];
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
  send: () => Promise.reject(new Error("LifeOS is not connected")),
  undo: () => Promise.reject(new Error("LifeOS is not connected")),
  retry: () => Promise.reject(new Error("LifeOS is not connected")),
  useDrafts: () => NO_DRAFTS,
  sendDraft: () => Promise.reject(new Error("LifeOS is not connected")),
  dropDraft: () => Promise.resolve(),
  requestFiles: () => Promise.reject(new Error("LifeOS is not connected")),
  fileVerb: () => "save",
  openFile: () => {},
};

const Data = createContext<MessagesData>(WAITING);
export const MessagesDataProvider = Data.Provider;
export const useMessagesData = (): MessagesData => useContext(Data);
