import { firstWords, SOURCE_NAME, type ChatDetail, type ChatMessage, type ChatRow, type ChatSource } from "@shared/work/messages";
import { CornerDownRight } from "../../chrome/icons";
import type { ActViewProps } from "../acts/registry";
import { useLifeosQuery, useLifeosSession, type LifeosQuery } from "../shell/lifeos";
import { chatFact } from "./model";

/** A held reply's payload, as the host's `chat.reply` holds it. */
export interface ChatReplyPayload {
  chatId: string;
  replyTo?: string;
  source: ChatSource;
  chat: string;
  to?: string;
  text: string;
}

/** The fields of a payload this view can read; whatever is missing reads as nothing, never as a guess. */
export function replyOf(payload: unknown): ChatReplyPayload | null {
  const p = (payload ?? {}) as Partial<ChatReplyPayload>;
  if (typeof p.chatId !== "string" || typeof p.text !== "string" || typeof p.chat !== "string" || typeof p.source !== "string") return null;
  return { chatId: p.chatId, source: p.source, chat: p.chat, text: p.text, ...(p.replyTo ? { replyTo: p.replyTo } : {}), ...(p.to ? { to: p.to } : {}) };
}

/**
 * What a reply answers: the message it names, or, naming none, the
 * conversation's newest message from someone else, as LifeOS will choose it.
 * Read from the newest page; older than that, it is left unsaid.
 */
export function answeredOf(reply: Pick<ChatReplyPayload, "replyTo">, detail: ChatDetail | null | undefined, page: readonly ChatMessage[] | undefined): { who: string; text: string } | null {
  const id = reply.replyTo ?? detail?.chat.lastInId;
  const found = id ? page?.find((m) => m._id === id) : undefined;
  if (found) return { who: found.who.name, text: found.text };
  if (!reply.replyTo && detail && !detail.chat.lastFromMe && detail.chat.lastText) return { who: detail.chat.lastWho, text: detail.chat.lastText };
  return null;
}

/**
 * A thread's held reply in the Outbox (`chat.reply`): to whom and where it
 * goes ("Slack, Starboard Games"), the message it answers as one quoted line,
 * then its words exactly as they go. The conversation is read from LifeOS on
 * the item's own sector; until it answers, the payload's own words stand.
 */
export function View({ item, env }: ActViewProps) {
  const reply = replyOf(item.payload);
  const session = useLifeosSession(env, item.sector);
  const detail = useLifeosQuery<ChatDetail | null>(session, "chats:get", { id: reply?.chatId ?? "" });
  const page = useLifeosQuery<{ page: ChatMessage[] }>(session, "chats:messages", { chatId: reply?.chatId ?? "", paginationOpts: { numItems: 50, cursor: null } });
  if (!reply) return <div data-slot="act-payload" className="text-sm text-muted-foreground">This reply could not be read</div>;
  return <ReplyBody reply={reply} chat={ready(detail)?.chat} answered={answeredOf(reply, ready(detail), ready(page)?.page)} />;
}

/** The held reply as he reads it before his press: to whom, where, what it answers, its words. */
export function ReplyBody({ reply, chat, answered }: { reply: ChatReplyPayload; chat?: Pick<ChatRow, "source" | "accountName">; answered: { who: string; text: string } | null }) {
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        <dt className="truncate text-muted-foreground">To</dt>
        <dd className="min-w-0 break-words text-foreground">{reply.to ?? reply.chat}</dd>
        <dt className="truncate text-muted-foreground">In</dt>
        <dd className="min-w-0 break-words text-foreground">{chat ? chatFact(chat) : SOURCE_NAME[reply.source]}</dd>
      </dl>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        {answered ? (
          <p data-answers className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CornerDownRight aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              <span className="font-medium">{answered.who}</span> <span className="text-faint-foreground">{firstWords(answered.text, 80)}</span>
            </span>
          </p>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-sm leading-[22px] text-foreground">{reply.text}</div>
      </div>
    </div>
  );
}

const ready = <T,>(query: LifeosQuery<T>): T | undefined => (query.status === "ready" ? query.value : undefined);
