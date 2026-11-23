import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import type { MessagesUnansweredAnswer } from "@shared/contract-work-messages";
import type { ChatWaiting } from "@shared/work/messages";
import { loadToast } from "../../components/ui/toaster";
import { Chat } from "../icons";
import { goTo } from "../today/open";
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

/** A conversation's row key: one row a conversation, whichever host answered for it. */
export const chatKey = (chatId: string): string => `chat:${chatId}`;

const LEAD: NonNullable<TodayRow["lead"]> = { kind: "glyph", glyph: Chat };

/** The waiting conversations as rows, newest first: who wrote and where, their words, when. */
export function waitingRows(answers: readonly { workspace: TodayWorkspace; value: MessagesUnansweredAnswer }[], now: number, markRead: (chatId: string) => Promise<void> | void): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const { workspace, value } of answers) {
    for (const chat of value.rows) rows.push(rowOf(workspace, chat, now, markRead));
  }
  return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function rowOf(workspace: TodayWorkspace, chat: ChatWaiting, now: number, markRead: (chatId: string) => Promise<void> | void): TodayRow {
  // In a channel or a group the row says who wrote and where; one person's chat is named by them alone.
  const title = chat.who && chat.who !== chat.chat ? `${chat.who} in ${chat.chat}` : chat.chat;
  return {
    key: chatKey(chat.chatId),
    section: SECTION.id,
    sector: workspace.sector,
    title,
    ...(chat.text ? { detail: chat.text } : {}),
    // Newest first in a section that orders ascending.
    at: -chat.at,
    when: rowTime(chat.at, now),
    lead: LEAD,
    open: () => goTo(workspace, { view: "messages", chat: chat.chatId }),
    acts: [{ label: "Mark read", run: () => markRead(chat.chatId) }],
  };
}

function useWaiting(env: TodayEnv): TodayAnswer {
  const each = useEachWorkspace<MessagesUnansweredAnswer>(env, "work.messages.unanswered", (w) => ({ workspaceId: w.workspaceId }), { push: "work.messages" });
  const client = env.lifeos.client;
  return useMemo(() => {
    // His read mark is LifeOS's own: written on the page's one session, as the view writes it on a job's.
    const markRead = async (chatId: string): Promise<void> => {
      try {
        if (!client) throw new Error("LifeOS is not connected");
        await client.mutation(makeFunctionReference<"mutation">("chats:markRead"), { id: chatId });
      } catch {
        (await loadToast()).error("Couldn't mark it read");
      }
    };
    return { rows: waitingRows(each.answers, Date.now(), markRead), loading: each.loading, failed: each.failed };
  }, [each, client]);
}

export const source: TodaySource = { id: "messages", section: SECTION, use: useWaiting };
