import { useEffect, useRef, useState } from "react";
import { SOURCE_NAME, type ChatDetail, type ChatMessage, type ChatRow, type ChatSource } from "@shared/work/messages";
import { CornerDownRight } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
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
 * What a reply answers, the very message LifeOS's `chats:reply` will choose:
 * the message it names; else the conversation's newest from someone else
 * (`lastInId`); else, a conversation with only his own words, his newest
 * there (`ownIn(...).first()`, newest first), shown as "You: …", since Slack
 * threads the reply under it. Read from the newest page; older than that,
 * and with nothing of his on the page, it is left unsaid.
 */
export function answeredOf(reply: Pick<ChatReplyPayload, "replyTo">, detail: ChatDetail | null | undefined, page: readonly ChatMessage[] | undefined): { who: string; text: string } | null {
  const id = reply.replyTo ?? detail?.chat.lastInId;
  const found = id ? page?.find((m) => m._id === id) : undefined;
  if (found) return { who: found.who.me ? "You" : found.who.name, text: wordsOf(found.text) };
  if (!reply.replyTo && detail && !detail.chat.lastFromMe && detail.chat.lastText) return { who: detail.chat.lastWho, text: detail.chat.lastText };
  if (!reply.replyTo && detail && !detail.chat.lastInId) {
    // The page is newest first, as LifeOS's own index for his messages is: the first of his is the one it answers.
    const mine = page?.find((m) => m.who.me);
    if (mine) return { who: "You", text: wordsOf(mine.text) };
  }
  return null;
}

/** A parent with no words of its own still says what it is. */
const wordsOf = (text: string | undefined): string => (text?.trim() ? text : "A picture or file");

/** What `rawMessages:get` answers for one message. */
type RawMessage = { message: { author?: { name?: string }; fromMe?: boolean; text?: string } | null } | null;

/** What the quote's place holds: the message it answers, a line on its way, the word that it is gone or could not be read, or nothing. */
export type Answered = { who: string; text: string } | "loading" | "gone" | "unreadable" | null;

/**
 * The message a held reply answers, as the quote's place shows it: from the
 * newest page when it is there; else read by its id on the item's own sector
 * (also when the page itself did not load, if the reply names it); "loading"
 * until LifeOS has answered, so the words never jump; "gone" only when LifeOS
 * answers that it is absent; "unreadable" when that read failed, or when the
 * conversation's own read failed and so no message to answer could be found.
 */
export function answerOf(reply: Pick<ChatReplyPayload, "replyTo">, detail: LifeosQuery<ChatDetail | null>, page: LifeosQuery<{ page: ChatMessage[] }>, byId: LifeosQuery<RawMessage> | null): Answered {
  // Naming no message, the conversation's own read is the only way to its target: failed, the page cannot help, so the
  // line says so at once, with Retry, whatever the page is doing.
  if (!reply.replyTo && detail.status === "failed") return "unreadable";
  if (detail.status === "loading" && !reply.replyTo) return "loading";
  if (page.status === "loading") return "loading";
  const inPage = page.status === "ready" ? answeredOf(reply, ready(detail), page.value.page) : null;
  if (inPage) return inPage;
  const id = reply.replyTo ?? ready(detail)?.chat?.lastInId;
  if (!id) return detail.status === "loading" ? "loading" : detail.status === "failed" && !reply.replyTo ? "unreadable" : null;
  if (!byId || byId.status === "loading") return "loading";
  if (byId.status === "failed") return "unreadable";
  const message = byId.value?.message;
  if (!message) return "gone";
  return { who: message.fromMe ? "You" : (message.author?.name ?? "Someone"), text: wordsOf(message.text) };
}

/**
 * A thread's held reply in the Outbox (`chat.reply`): to whom and where it
 * goes ("Slack, Starboard Games"), the message it answers as one quoted line,
 * then its words exactly as they go. The conversation is read from LifeOS on
 * the item's own sector; until it answers, the payload's own words stand and a
 * line of bones holds the quote's place. A quote that could not be read offers
 * Retry, which reads afresh.
 */
export function View(props: ActViewProps) {
  const [attempt, setAttempt] = useState(0);
  // Retry mounts the reads afresh and takes its own button away: when that button held the keys, the quote's slot takes
  // them and keeps them while the quote reads again.
  const [keys, setKeys] = useState(false);
  const retry = (): void => {
    setKeys(document.activeElement?.closest("[data-quote-slot]") != null);
    setAttempt((n) => n + 1);
  };
  return <Reads key={attempt} {...props} retry={retry} focusQuote={keys} />;
}

function Reads({ item, env, retry, focusQuote }: ActViewProps & { retry: () => void; focusQuote: boolean }) {
  const reply = replyOf(item.payload);
  const session = useLifeosSession(env, item.sector);
  const detail = useLifeosQuery<ChatDetail | null>(session, "chats:get", { id: reply?.chatId ?? "" });
  const page = useLifeosQuery<{ page: ChatMessage[] }>(session, "chats:messages", { chatId: reply?.chatId ?? "", paginationOpts: { numItems: 50, cursor: null } });
  // The answered message by its id, asked when the newest page does not hold it or did not load.
  const target = reply?.replyTo ?? ready(detail)?.chat?.lastInId;
  const missing = Boolean(target) && (page.status === "failed" || (page.status === "ready" && !page.value.page.some((m) => m._id === target)));
  const byId = useLifeosQuery<RawMessage>(missing ? session : { ...session, client: null, state: "connecting" }, "rawMessages:get", { id: target ?? "" });
  if (!reply) return <div data-slot="act-payload" className="text-sm text-muted-foreground">This reply could not be read</div>;
  return <ReplyBody reply={reply} chat={ready(detail)?.chat} answered={answerOf(reply, detail, page, missing ? byId : null)} onRetry={retry} focusQuote={focusQuote} />;
}

/** The held reply as he reads it before his press: to whom, where, what it answers, its words. */
export function ReplyBody({
  reply,
  chat,
  answered,
  onRetry,
  focusQuote = false,
}: {
  reply: ChatReplyPayload;
  chat?: Pick<ChatRow, "source" | "accountName" | "kind">;
  answered: Answered;
  onRetry?: () => void;
  /** The quote's slot takes the keys as it mounts: Retry held them. */
  focusQuote?: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusQuote) slot.current?.focus({ preventScroll: true });
  }, [focusQuote]);
  // In a direct chat the writer is left out when it is the one the reply goes to, named on the To line already; his own
  // words still say "You".
  const named = chat?.kind === "direct" && answered !== null && typeof answered === "object" && answered.who === (reply.to ?? reply.chat);
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-4">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        <dt className="truncate text-muted-foreground">To</dt>
        <dd className="min-w-0 break-words text-foreground">{reply.to ?? reply.chat}</dd>
        <dt className="truncate text-muted-foreground">In</dt>
        <dd className="min-w-0 break-words text-foreground">{chat ? chatFact(chat) : SOURCE_NAME[reply.source]}</dd>
      </dl>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        {/* The quote's slot holds its place through every state, and can hold the keys while it reads again. */}
        <div ref={slot} data-quote-slot tabIndex={-1} role="group" aria-label="The message it answers" className="focus-ring rounded-sm empty:hidden">
          {answered === "loading" ? (
            <div data-answers="loading" aria-hidden className="flex h-5 items-center gap-1.5">
              <Skeleton className="size-3 rounded-sm" />
              <Skeleton className="h-2.5 w-[60%]" />
            </div>
          ) : answered === "gone" || answered === "unreadable" ? (
            <p data-answers={answered} className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <CornerDownRight aria-hidden className="size-3 shrink-0" />
              {answered === "gone" ? "The message it answers is no longer here" : "The message it answers could not be read"}
              {answered === "unreadable" && onRetry ? (
                <Button variant="ghost" size="xs" className="ms-1" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </p>
          ) : answered ? (
            <p data-answers className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <CornerDownRight aria-hidden className="size-3 shrink-0" />
              {/* "Dana Lee: words", cut where the line ends. */}
              <span className="min-w-0 truncate">
                {named ? null : <span className="font-medium">{answered.who}: </span>}
                {answered.text.replace(/\s+/g, " ").trim()}
              </span>
            </p>
          ) : null}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-[22px] text-foreground">{reply.text}</div>
      </div>
    </div>
  );
}

const ready = <T,>(query: LifeosQuery<T>): T | undefined => (query.status === "ready" ? query.value : undefined);
