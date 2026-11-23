import { memo, type MouseEvent } from "react";
import type { ChatMessage } from "@shared/work/messages";
import { firstWords } from "@shared/work/messages";
import { CornerDownRight } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { clockTime } from "../../lib/duration";
import { openUrl } from "../../lib/native";
import { Face } from "../mail/face";
import { linkParts, opensOutside, type Block } from "./model";

/**
 * One message in the conversation's column (docs/agents/work-messages.md):
 * rows, not bubbles, his own drawn as anyone's. A run's first message carries
 * the 28px face, the name and the time; the rest of the run is words alone.
 * A day opens with its date on a hairline, and the first unread message sits
 * under the one that says "New".
 */
export const MessageBlock = memo(function MessageBlock({ block, arrives }: { block: Block; arrives?: boolean }) {
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
          {/* A message's pictures and files are drawn here once LifeOS keeps them (the plan's MSG4): in place, at
              most 360 by 270, or Mail's 40px chip. Until then its words say what it held, as LifeOS stored them. */}
        </div>
      </div>
    </div>
  );
});

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
        <span className="font-medium">{to.who}</span> {firstWords(to.text, 80)}
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
