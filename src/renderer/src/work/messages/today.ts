import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import type { MessagesUnansweredAnswer } from "@shared/contract-work-messages";
import type { ChatWaiting } from "@shared/work/messages";
import { loadToast } from "../../components/ui/toaster";
import { Chat } from "../icons";
import type { LifeosSession } from "../shell/lifeos";
import { shown } from "../today/lifeos";
import { goTo } from "../today/open";
import { comeBack, leave } from "../today/store";
import { useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "../today/types";
import { rowTime } from "./model";

/**
 * Messages on Today (docs/agents/work-today.md "Adding to Today"): the
 * conversations that wait on his answer, in every job. Each job's host
 * answers `work.messages.unanswered`, asked again on the `work.messages`
 * push, so the list moves as he reads and answers. A row opens its
 * conversation in the job's Messages view and offers Mark read.
 */

const SECTION: TodaySection = { id: "messages", title: "Messages", order: 45, empty: "No one is waiting on a reply", fold: 5, lifeos: true };

/**
 * A conversation's row key: one row a conversation, whichever host answered
 * for it, and one for each last message (`at`). A row he marked read is
 * hidden by its key until no source gives it (store.ts `gone`): a message
 * that comes after is a new key, so it shows.
 */
export const chatKey = (chatId: string, at: number): string => `chat:${chatId}:${at}`;

const LEAD: NonNullable<TodayRow["lead"]> = { kind: "glyph", glyph: Chat };

/** The waiting conversations as rows, newest first: who wrote and where, their words, when. */
export function waitingRows(answers: readonly { workspace: TodayWorkspace; value: MessagesUnansweredAnswer }[], now: number, markRead: (chatId: string, at: number) => Promise<void> | void): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const { workspace, value } of answers) {
    for (const chat of value.rows) rows.push(rowOf(workspace, chat, now, markRead));
  }
  return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function rowOf(workspace: TodayWorkspace, chat: ChatWaiting, now: number, markRead: (chatId: string, at: number) => Promise<void> | void): TodayRow {
  // In a channel or a group the row says who wrote and where; one person's chat is named by them alone.
  const title = chat.who && chat.who !== chat.chat ? `${chat.who} in ${chat.chat}` : chat.chat;
  return {
    key: chatKey(chat.chatId, chat.at),
    section: SECTION.id,
    sector: workspace.sector,
    // The workspace its host answered for: where two hosts hold the sector under two names, the one the press opens.
    job: workspace.name,
    title,
    ...(chat.text ? { detail: chat.text } : {}),
    // Newest first in a section that orders ascending.
    at: -chat.at,
    when: rowTime(chat.at, now),
    lead: LEAD,
    open: () => goTo(workspace, { view: "messages", chat: chat.chatId }),
    acts: [{ label: "Mark read", run: () => markRead(chat.chatId, chat.at) }],
  };
}

/**
 * Mark read from a row. His read mark is LifeOS's own: written on the page's
 * one session, as the view writes it on a job's. The row leaves by his act
 * as any row does (store.ts `leave`), and is back as it was if the write
 * fails, with a toast the page counts (lifeos.ts `shown`).
 */
export async function markChatRead(client: LifeosSession["client"], chatId: string, at: number): Promise<void> {
  const key = chatKey(chatId, at);
  leave(key);
  try {
    if (!client) throw new Error("LifeOS is not connected");
    await client.mutation(makeFunctionReference<"mutation">("chats:markRead"), { id: chatId });
  } catch {
    comeBack(key);
    (await loadToast()).error("Couldn't mark it read", shown().options);
  }
}

function useWaiting(env: TodayEnv): TodayAnswer {
  const each = useEachWorkspace<MessagesUnansweredAnswer>(env, "work.messages.unanswered", (w) => ({ workspaceId: w.workspaceId }), { push: "work.messages" });
  const client = env.lifeos.client;
  // The day is an input: a row's time ("2:00 PM", "Sat") is said from today, which turns at midnight with no push.
  const day = env.day.from;
  return useMemo(
    () => ({ rows: waitingRows(each.answers, Date.now(), (chatId, at) => markChatRead(client, chatId, at)), loading: each.loading, failed: each.failed, ...(each.stale ? { stale: true } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day`: the rows' times are said again when the day turns
    [each, client, day],
  );
}

export const source: TodaySource = { id: "messages", section: SECTION, use: useWaiting };
