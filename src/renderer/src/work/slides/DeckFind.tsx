import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { DeckView } from "@shared/contract-work-slides";
import { CaseSensitive, ChevronDown, ChevronUp, Search, WholeWord, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { GroupInput } from "../../components/ui/input";
import { TooltipProvider } from "../../components/ui/tooltip";
import { Tip } from "../../components/tip";
import { cn } from "../../lib/cn";
import { modOrCtrl } from "../../lib/keys";
import type { DeckFind as Find, DeckStore } from "./deck";
import { deckMatches, findCount, firstFrom, type DeckMatch, type FindOptions } from "./find";

/**
 * Find on a deck's words (docs/DESIGN.md "The slide editor", Find): the
 * document's bar, with its measures and words, floating at the stage's top
 * end. It finds as he types, across every slide's shapes and its notes;
 * each step puts the slide on the stage and outlines the shape, and Escape
 * gives the keyboard back to what he found. It reads the deck and changes
 * nothing, so it is there on a deck he can only read too.
 *
 * A key opens it many times a day: it lands at once, with no motion.
 */

/** The matches of the bar as it stands, and the one in hand. */
export function useDeckMatches(view: DeckView | null, find: Find): { matches: DeckMatch[]; capped: boolean; current: DeckMatch | null } {
  const { query, options } = find;
  const { matches, capped } = useMemo(() => deckMatches(view, query, options), [view, query, options]);
  const current = find.open ? (matches[Math.min(find.current, matches.length - 1)] ?? null) : null;
  return { matches, capped, current };
}

export function DeckFind({ store, view, find, end, onClose }: { store: DeckStore; view: DeckView; find: Find; /** the room at the stage's end it keeps clear (the Format sheet beside it) */ end: number; onClose(match: DeckMatch | null): void }) {
  const field = useRef<HTMLInputElement>(null);
  const { matches, capped, current } = useDeckMatches(view, find);
  const none = matches.length === 0;

  // Each open (⌘F again included): the field has the focus with its words chosen, ready to type over.
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, [find.ask]);

  /** The match in hand at `at`: its slide goes on the stage. */
  const hold = (next: Find, all: DeckMatch[]): void => {
    const match = all[next.current];
    store.set({ find: next, ...(match ? { current: match.slideKey, look: "slide" as const } : {}) });
  };
  /** What he typed or how: the first match from the slide on the stage. */
  const search = (query: string, options: FindOptions): void => {
    const all = deckMatches(view, query, options).matches;
    hold({ ...find, query, options, current: firstFrom(view, all, store.get().current) }, all);
  };
  const step = (by: 1 | -1): void => {
    if (none) return;
    const at = find.current < 0 ? (by > 0 ? 0 : matches.length - 1) : (find.current + by + matches.length) % matches.length;
    hold({ ...find, current: at }, matches);
  };
  const close = (): void => {
    store.set({ find: { ...find, open: false } });
    onClose(current);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // His Escape closes find, and nothing under it (the picked shape, a pane).
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !modOrCtrl(event) && !event.altKey) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };
  const option = (name: keyof FindOptions) => () => search(find.query, { ...find.options, [name]: !find.options[name] });

  return (
    // A line of no height over the stage: it takes no room, so nothing under it moves when it opens.
    <div data-deck-find className="pointer-events-none absolute inset-x-0 top-2 z-10 flex h-0 justify-end" style={{ paddingInlineEnd: end + 8 }}>
      <TooltipProvider>
        <div
          role="search"
          aria-label="Find in deck"
          // The buttons' 6px and the bar's 4px: the corners nest, as the document's bar does.
          className="pointer-events-auto flex h-8 w-[min(360px,calc(100%-8px))] items-center gap-0.5 rounded-[10px] bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border has-[input:focus-visible]:ring-ring"
        >
          <span aria-hidden className="grid size-6 shrink-0 place-items-center text-muted-foreground">
            <Search className="size-3.5" />
          </span>
          <GroupInput
            ref={field}
            aria-label="Find"
            placeholder="Find"
            autoComplete="off"
            spellCheck={false}
            value={find.query}
            onChange={(event) => search(event.target.value, find.options)}
            onKeyDown={keys}
            className="h-6 min-w-16 flex-1 ps-0.5 pe-1 text-sm"
          />
          <span data-deck-find-count aria-live="polite" className={cn("shrink-0 ps-1 pe-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums", find.query === "" && "hidden")}>
            {findCount(find.query, matches.length, find.current, capped)}
          </span>
          <Tip label="Match case">
            <Button variant="ghost" size="icon-xs" aria-label="Match case" aria-pressed={find.options.matchCase} className={cn("text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground")} onClick={option("matchCase")}>
              <CaseSensitive className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Whole word">
            <Button variant="ghost" size="icon-xs" aria-label="Whole word" aria-pressed={find.options.wholeWord} className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground" onClick={option("wholeWord")}>
              <WholeWord className="size-3.5" />
            </Button>
          </Tip>
          <span aria-hidden className="mx-[3px] h-3.5 w-px shrink-0 bg-border" />
          <Tip label="Previous match">
            <Button variant="ghost" size="icon-xs" aria-label="Previous match" disabled={none} className="text-muted-foreground" onClick={() => step(-1)}>
              <ChevronUp className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Next match">
            <Button variant="ghost" size="icon-xs" aria-label="Next match" disabled={none} className="text-muted-foreground" onClick={() => step(1)}>
              <ChevronDown className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Close find">
            <Button variant="ghost" size="icon-xs" aria-label="Close find" className="text-muted-foreground" onClick={close}>
              <X className="size-3.5" />
            </Button>
          </Tip>
        </div>
      </TooltipProvider>
    </div>
  );
}
