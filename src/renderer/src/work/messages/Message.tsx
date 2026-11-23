import { memo, useEffect, useState, type MouseEvent } from "react";
import { formatSize } from "work-kit/mail/lib/files";
import { loadBytes } from "work-kit/mail/lib/bytes";
import type { CanvasKind } from "@shared/work";
import { fileMarkers, firstWords, SOURCE_APP, type ChatFile, type ChatMessage, type ChatReplyState, type ChatRow } from "@shared/work/messages";
import { CornerDownRight, MoreHorizontal, type IconComponent } from "../../chrome/icons";
import { Tip } from "../../components/tip";
import { Skeleton } from "../../components/ui/skeleton";
import { Doc, File as FileGlyph, Media, Pdf, Slides, Table } from "../icons";
import { reveal } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import { clockTime } from "../../lib/duration";
import { openUrl } from "../../lib/native";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { Face } from "../mail/face";
import { useMessagesData, type FileVerb } from "./data";
import { isPicture, pictureBox, viewKind } from "./files";
import { linkParts, opensOutside, type Block } from "./model";
import { keepTyped } from "./page";

/**
 * One message in the conversation's column (docs/agents/work-messages.md):
 * rows, not bubbles, his own drawn as anyone's. A run's first message carries
 * the 28px face, the name and the time; the rest of the run is words alone.
 * A day opens with its date on a hairline, and the first unread message sits
 * under the one that says "New".
 */
export const MessageBlock = memo(function MessageBlock({
  block,
  arrives,
  found,
  workspaceId,
  chatId,
  chat,
  onMore,
}: {
  block: Block;
  arrives?: boolean;
  /** A message he was sent to: marked ("on"), then fading ("off"). */
  found?: "on" | "off";
  workspaceId: string;
  chatId: string;
  /** The conversation's source and link, for a file that could not come. */
  chat: Pick<ChatRow, "source" | "link">;
  /** Opens the message's menu under its ⋯. */
  onMore?: (id: string, button: HTMLElement) => void;
}) {
  const { message, head, day, isNew } = block;
  return (
    <div data-block={block.id} data-menu-id={block.id} data-head={head || undefined} className={cn(head ? (day || isNew ? "pt-3" : "pt-4") : "pt-1", arrives && "tc-message-arrives")}>
      {day || isNew ? <Divider day={day} isNew={isNew} /> : null}
      <div
        data-found={found}
        className={cn(
          "group/message relative -mx-2 rounded-md px-2",
          // Marked at once, then the fill fades; reduced motion takes it away at once.
          found === "on" ? "bg-muted" : found === "off" ? "transition-[background-color] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none" : null,
        )}
      >
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
            {/* Once its files are listed beside it, the names LifeOS's readers folded into its words go. */}
            <Words text={message.files.length ? fileMarkers(message.text, message.files) : message.text} />
            {message.files.length ? <Files message={message} chatId={chatId} chat={chat} /> : null}
            {message.reply && message.reply.status !== "sent" ? <ReplyState reply={message.reply} workspaceId={workspaceId} chatId={chatId} /> : null}
          </div>
        </div>
        {onMore ? (
          <span className={cn("absolute end-0 top-0 rounded-md bg-background", reveal("message"))}>
            <Button variant="ghost" size="icon-xs" aria-label="Message actions" className="text-muted-foreground" onClick={(event) => onMore(block.id, event.currentTarget)}>
              <MoreHorizontal />
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
});

// ── Pictures and files ──

/** Messages whose listed files were asked for this window's life: each is asked once. */
const asked = new Set<string>();

/**
 * A message's files: a picture drawn in place at most 360 by 270, in its own
 * shape, from LifeOS's bytes as a blob (the page loads no picture from the
 * web), its shape held by a skeleton while it comes; any other file Mail's
 * 40px chip, whose press shows it beside the conversation or saves it; a file
 * that could not come says why, with the way to it in its app. Files LifeOS
 * only listed are asked for once, as the message comes into view.
 */
function Files({ message, chatId, chat }: { message: ChatMessage; chatId: string; chat: Pick<ChatRow, "source" | "link"> }) {
  const data = useMessagesData();
  const wants = message.files.some((file) => file.status === "listed");
  useEffect(() => {
    if (!wants || asked.has(message._id)) return;
    asked.add(message._id);
    data.requestFiles(message._id);
  }, [wants, message._id, data]);
  const link = message.permalink ?? chat.link;
  return (
    <div data-files className="mt-1.5 mb-0.5 flex flex-col gap-1.5">
      {message.files.map((file) =>
        file.status === "failed" ? (
          <FileFailed key={file._id} file={file} source={chat.source} link={link} />
        ) : isPicture(file) ? (
          <Picture key={file._id} file={file} onOpen={() => data.openFile(chatId, message, file)} />
        ) : (
          <FileChip key={file._id} file={file} verb={data.fileVerb(file)} onOpen={() => data.openFile(chatId, message, file)} />
        ),
      )}
    </div>
  );
}

/** Pictures read this window's life, by their address in LifeOS's store: a blob to draw, or null for one that did not load. */
const pictures = new Map<string, string | null>();
const drawable = (url: string): boolean => url.startsWith("data:") || url.startsWith("blob:");

/** A stored picture's bytes as a blob address: undefined while it comes, null when it cannot. */
function usePictureBytes(url: string | undefined): string | null | undefined {
  const [, bump] = useState(0);
  const held = !url ? undefined : drawable(url) ? url : pictures.get(url);
  useEffect(() => {
    if (!url || drawable(url) || pictures.has(url)) return;
    let live = true;
    loadBytes(url).then(
      (blob) => pictures.set(url, URL.createObjectURL(blob)),
      () => pictures.set(url, null),
    ).finally(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [url]);
  return held;
}

function Picture({ file, onOpen }: { file: ChatFile; onOpen: () => void }) {
  const box = pictureBox(file);
  const src = usePictureBytes(file.status === "stored" ? file.url : undefined);
  if (src === null) return <FileChip file={file} verb="view" onOpen={onOpen} />;
  return (
    <Button variant="ghost" aria-label={`View ${file.name}`} onClick={onOpen} style={box} className="h-auto self-start overflow-hidden rounded-lg p-0 hover:bg-transparent active:bg-transparent">
      {src ? (
        <img src={src} alt={file.name} width={box.width} height={box.height} draggable={false} className="block size-full rounded-lg object-cover outline-1 -outline-offset-1 outline-(--image-outline)" />
      ) : (
        <Skeleton aria-label={`Loading ${file.name}`} className="size-full rounded-lg" />
      )}
    </Button>
  );
}

/** A file's glyph, by the canvas kind that shows it. */
const GLYPH: Partial<Record<CanvasKind, IconComponent>> = { pdf: Pdf, sheet: Table, slides: Slides, media: Media, document: Doc };

/** Mail's 40px chip: a 28px tile with the file's glyph, its name, its size; the press views or downloads it. */
function FileChip({ file, verb, onOpen }: { file: ChatFile; verb: FileVerb; onOpen: () => void }) {
  const kind = viewKind(file);
  const Glyph = (kind && GLYPH[kind]) || FileGlyph;
  const said = `${verb === "view" ? "View" : "Download"} ${file.name}`;
  return (
    <Tip label={said}>
      <Button variant="ghost" aria-label={said} onClick={onOpen} className="h-10 max-w-72 min-w-0 shrink justify-start gap-2 self-start rounded-lg border border-border ps-1.5 pe-3 font-normal">
        <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
          <Glyph className="size-3.5" />
        </span>
        <span className="min-w-0 truncate font-medium text-foreground">{file.name}</span>
        {file.size !== undefined ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(file.size)}</span> : null}
      </Button>
    </Tip>
  );
}

/** A file that could not come: its name, why in LifeOS's words, and the way to it in its app. */
function FileFailed({ file, source, link }: { file: ChatFile; source: ChatRow["source"]; link: string | undefined }) {
  const opens = link && /^https?:\/\//i.test(link) ? link : undefined;
  return (
    <p data-file-failed className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
      <span className="font-medium">{file.name}</span>
      <span>{file.error ?? "Couldn't load this file"}</span>
      {opens ? (
        <Button variant="ghost" size="xs" className="ms-1 text-muted-foreground" onClick={() => void openUrl(opens)}>
          Open in {SOURCE_APP[source]}
        </Button>
      ) : null}
    </p>
  );
}

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
