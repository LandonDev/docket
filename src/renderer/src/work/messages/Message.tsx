import { memo, useState, type MouseEvent } from "react";
import { firstWords, type ChatMessage, type ChatReplyState } from "@shared/work/messages";
import { CornerDownRight } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { clockTime } from "../../lib/duration";
import { openUrl } from "../../lib/native";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { Face } from "../mail/face";
import { useMessagesData } from "./data";
import { linkParts, opensOutside, type Block } from "./model";
import { keepTyped } from "./page";

/**
 * One message in the conversation's column (docs/agents/work-messages.md):
 * rows, not bubbles, his own drawn as anyone's. A run's first message carries
 * the 28px face, the name and the time; the rest of the run is words alone.
 * A day opens with its date on a hairline, and the first unread message sits
 * under the one that says "New".
 */
export const MessageBlock = memo(function MessageBlock({ block, arrives, workspaceId, chatId }: { block: Block; arrives?: boolean; workspaceId: string; chatId: string }) {
  const { message, head, day, isNew } = block;
  return (
    <div data-block={block.id} data-head={head || undefined} className={cn(head ? (day || isNew ? "pt-3" : "pt-4") : "pt-1", arrives && "tc-message-arrives")}>
      {day || isNew ? <Divider day={day} isNew={isNew} /> : null}
      {message.replyTo ? <ReplyLine to={message.replyTo} /> : null}
      <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
        {head ? (
          <>
            <Face name={message.who.name} picture={message.who.picture} size="head" className="row-span-2 self-start" />
            <div className="flex h-5 min-w-0 items-baseline gap-2">
              <span className="truncate text-[13px] leading-5 font-semibold text-foreground">{message.who.name}</span>
              <time className="shrink-0 text-xs text-muted-foreground tabular-nums">{clockTime(message.sentAt)}</time>
            </div>
          </>
        ) : null}
        <div className="col-start-2 min-w-0">
          <Words text={message.text} />
          {message.reply && message.reply.status !== "sent" ? <ReplyState reply={message.reply} workspaceId={workspaceId} chatId={chatId} /> : null}
          {/* A message's pictures and files are drawn here once LifeOS keeps them (the plan's MSG4): in place, at
              most 360 by 270, or Mail's 40px chip. Until then its words say what it held, as LifeOS stored them. */}
        </div>
      </div>
    </div>
  );
});

/**
 * His reply on its way: "Sending" and Undo inside its undo time, which puts
 * the words back in the composer; failed, the red mark, "Not sent." and
 * LifeOS's reason, with Retry.
 */
function ReplyState({ reply, workspaceId, chatId }: { reply: ChatReplyState; workspaceId: string; chatId: string }) {
  const data = useMessagesData();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const act = (run: () => Promise<void>): void => {
    setBusy(true);
    setRefused(null);
    run()
      .catch((err: unknown) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  if (reply.status === "failed") {
    return (
      <div data-reply="failed" className="flex min-h-6 flex-wrap items-center gap-x-2 text-xs">
        <StatusMark state="failed" word="Not sent." detail={refused ?? reply.error} className="min-w-0" />
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => act(() => data.retry(chatId, reply.outboxId))}>
          <BusyLabel busy={busy} label="Retry" />
        </Button>
      </div>
    );
  }
  return (
    <div data-reply="sending" className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
      <span>Sending</span>
      {reply.status === "queued" ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          className="text-muted-foreground"
          onClick={() =>
            act(async () => {
              keepTyped(workspaceId, chatId, await data.undo(chatId, reply.outboxId));
            })
          }
        >
          <BusyLabel busy={busy} label="Undo" />
        </Button>
      ) : null}
      {refused ? <span className="text-destructive">{refused}</span> : null}
    </div>
  );
}

/** A day's date on a hairline, centred; "New" at the line's end over the first unread message. */
function Divider({ day, isNew }: { day: string | null; isNew: boolean }) {
  return (
    <div role="separator" aria-label={[day, isNew ? "New" : null].filter(Boolean).join(", ")} className="mb-3 flex h-5 items-center gap-3 text-xs">
      <span aria-hidden className="h-px flex-1 bg-border" />
      {day ? (
        <>
          <span aria-hidden className="text-muted-foreground">
            {day}
          </span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </>
      ) : null}
      {isNew ? (
        <span aria-hidden className="font-medium text-foreground">
          New
        </span>
      ) : null}
    </div>
  );
}

/** What a Slack thread reply answers: its writer and first words, one muted line over the reply. */
function ReplyLine({ to }: { to: NonNullable<ChatMessage["replyTo"]> }) {
  return (
    <div className="grid h-5 grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 text-xs text-muted-foreground">
      <CornerDownRight aria-hidden className="size-3 justify-self-end" />
      <span className="truncate">
        <span className="font-medium">{to.who}</span> <span className="text-faint-foreground">{firstWords(to.text, 80)}</span>
      </span>
    </div>
  );
}

/** Opens a link outside, where it may open at all; never in this window. */
function openOutside(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const href = event.currentTarget.getAttribute("href") ?? "";
  if (opensOutside(href)) void openUrl(href);
}

/** Plain text with its line breaks, its http, https and mailto links pressable. */
function Words({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="text-message whitespace-pre-wrap text-foreground select-text [overflow-wrap:anywhere]">
      {linkParts(text).map((part, i) =>
        part.href ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order
          <a key={i} href={part.href} onClick={openOutside} className="text-link underline-offset-2 hover:underline">
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </p>
  );
}
