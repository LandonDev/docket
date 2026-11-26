import { LoadEarlierButton } from "./transcript/LoadEarlier";
import { keyHint } from "../lib/keys";
import { memo, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { ChevronLeft, ChevronRight } from "../chrome/icons";
import { SwapIcon } from "../motion/IconSwap";
import type { JumpHow } from "../chrome/JumpList";
import { cn } from "../lib/cn";
import { messageListFold } from "../lib/messageListFold";
import type { Block } from "../lib/session";
import { messageListChunk } from "./chunks";
import type { ReaderStore } from "./transcriptOutlineModel";

const List = messageListChunk.surface("TranscriptOutlineList");

/**
 * The transcript's left side: the person's own messages, one line each with
 * its clock time, the one being read marked, a click or Enter landing on it
 * (transcriptOutlineModel.ts has the rules; AgentTranscript places it).
 * The chevron above it folds the list sideways to the chevron alone and
 * back (lib/messageListFold.ts keeps the window's choice): it points left
 * while the list is open and right while folded, the rows slide out past
 * the pane's left edge and in again, and where the list sat beside the
 * column the column takes the width back (AgentTranscript, columnGlide.ts).
 * The rows ride `messageListChunk` (TranscriptOutlineList.tsx), mounted once
 * the list is first open and kept through a fold so they can slide out.
 */
export const TranscriptOutline = memo(function TranscriptOutline({
  turns,
  reader,
  readerTurn = 0,
  onJump,
  hasOlder = false,
  onLoadEarlier,
  now,
  locale,
  folded: foldedProp,
  className,
}: {
  turns: Block[][];
  /** The reader's turn, written by the scroll engine; a scroll renders the
   *  list alone. */
  reader?: ReaderStore;
  /** The reader's turn when there is no store (a static render). */
  readerTurn?: number;
  onJump: (blockId: string, how: JumpHow) => void;
  /** Older history the host has not sent yet. */
  hasOlder?: boolean;
  onLoadEarlier?: () => void | Promise<unknown>;
  /** Today, for the day labels; defaults to now. */
  now?: number;
  locale?: string;
  /** Folded or open, for a static render; the window's choice otherwise. */
  folded?: boolean;
  /** Placement and size of the list with its chevron. */
  className?: string;
}) {
  const listId = useId();
  const storedFold = useSyncExternalStore(messageListFold.subscribe, messageListFold.get, messageListFold.get);
  const folded = foldedProp ?? storedFold;
  // The rows mount the first time the list is open and stay; mounted by an
  // unfold rather than with the transcript, they come in on the fold's motion.
  const [mounted, setMounted] = useState<"no" | "at-mount" | "by-unfold">(folded ? "no" : "at-mount");
  if (!folded && mounted === "no") setMounted("by-unfold");
  const chevron = useRef<HTMLButtonElement>(null);
  // Folded by ⌘⇧M from inside the list: the focus goes to the chevron, never
  // to a row about to be hidden.
  useEffect(() => {
    const list = document.getElementById(listId);
    if (folded && list?.contains(document.activeElement)) chevron.current?.focus();
  }, [folded, listId]);
  const verb = folded ? "Show message list" : "Hide message list";
  return (
    // The box catches no pointer itself: folded, the room under the chevron
    // is the transcript's again.
    <div className={cn("pointer-events-none flex flex-col *:pointer-events-auto", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={chevron}
              variant="ghost"
              size="icon-xs"
              aria-label={verb}
              aria-expanded={!folded}
              aria-controls={listId}
              // An open list is the default state, not a pressed one: no
              // expanded fill, only the hover's.
              className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-foreground/7"
              onClick={() => messageListFold.set(!folded)}
              {...messageListChunk.intent}
            />
          }
        >
          <SwapIcon swapped={folded} from={<ChevronLeft data-glyph="left" className="size-3.5" />} to={<ChevronRight data-glyph="right" className="size-3.5" />} />
        </TooltipTrigger>
        <TooltipContent side="right">{verb} {keyHint("mod+shift+M")}</TooltipContent>
      </Tooltip>
      {mounted !== "no" ? (
        <List
          id={listId}
          turns={turns}
          reader={reader}
          readerTurn={readerTurn}
          onJump={onJump}
          now={now}
          locale={locale}
          folded={folded}
          enter={mounted === "by-unfold"}
          head={
            hasOlder && onLoadEarlier ? (
              <LoadEarlierButton
                variant="ghost"
                size="sm"
                // Its words on the rows' text edge: the busy label keeps the spinner's slot in its width, so its
                // words sit at the start and the spinner, while it loads, follows them (never pushes them).
                className="w-full justify-start font-normal text-muted-foreground [&_[data-slot=busy-label]>span]:flex-row-reverse [&_[data-slot=busy-label]>span]:justify-end"
                onLoad={onLoadEarlier}
                label="Earlier messages"
              />
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
});
