import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { RowsContextMenu } from "../../chrome/menuRows";
import { useSortable } from "../../hooks/useSortable";
import { bareKey } from "../../lib/keys";
import type { PdfDoc } from "../pdf/engine";
import type { DeckStore } from "./deck";
import type { HandSession } from "./edit/session";
import { moveOp, removeSlide, slideAct, slideRows, slidesOpen, type NameAsk } from "./edit/slides";
import { Picture } from "./Picture";

/**
 * The strip (docs/agents/work-slides.md "The canvas"): every slide of the
 * deck in the proposed order, a 96px picture in a 3px frame that carries a
 * suggestion's tint, its number, and a section's name over the slide that
 * starts it; a hidden slide at 45%. Where his hand may change the deck's
 * slides, a slide opens its menu on a right-click (or the menu key), moves
 * by a drag, and goes with Delete.
 */

export const THUMB = 96;
const FRAME_TINT = { add: "bg-(--add-bg)", del: "bg-(--del-bg)" } as const;

/** A slide's picture as it can be drawn now: the render it is in, and its page there. */
export type PictureOf = (slide: DeckSlide) => { doc: PdfDoc | null; page: number };

/** His hand on the deck's slides, for the strip and the Sorter: absent where the deck cannot change by hand. */
export interface SlideHand {
  session: HandSession;
  store: DeckStore;
  askName(ask: NameAsk): void;
}

/** The order a drag left the slides in, kept until the deck comes back in it. */
export function useDropped(view: DeckView): [string[], (order: string[]) => void] {
  const [dropped, setDropped] = useState<{ view: DeckView; order: string[] } | null>(null);
  const keys = view.slides.map((s) => s.key);
  return [dropped?.view === view ? dropped.order : keys, (order) => setDropped({ view, order })];
}

/** After a slide is taken out from the keyboard, the slide on the stage (the one in its place) takes the keyboard when the deck comes back. */
export function useRefocus(root: { current: HTMLElement | null }, view: DeckView): () => void {
  const asked = useRef(false);
  useEffect(() => {
    if (!asked.current) return;
    asked.current = false;
    root.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, [root, view]);
  return () => {
    asked.current = true;
  };
}

/** A slide's menu, on the strip or the Sorter: the rows for the slide under a right-click, written at once. */
export function SlideMenu({ view, hand, children }: { view: DeckView; hand: SlideHand | null; children: ReactElement }) {
  const open = !!hand && slidesOpen(view);
  return (
    <RowsContextMenu
      lazyMount
      label="Slide"
      disabled={!open}
      rowsFor={(key) => {
        const slide = view.slides.find((s) => s.key === key);
        return slide ? slideRows(view, slide) : null;
      }}
      onPick={(pick, key) => {
        const slide = view.slides.find((s) => s.key === key);
        if (slide && hand) slideAct(pick, slide, view, hand.session, hand.store, hand.askName);
      }}
    >
      {children}
    </RowsContextMenu>
  );
}

/** The strip draws again only when the deck, the slide on the stage or a render does: not on each word he types. */
export const Strip = memo(function Strip({
  view,
  current,
  narrow,
  pictureOf,
  pictures,
  hand,
  onPick,
}: {
  view: DeckView;
  current: string | null;
  narrow: boolean;
  pictureOf: PictureOf;
  pictures: boolean;
  hand: SlideHand | null;
  onPick(key: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const open = !!hand && slidesOpen(view);
  const [order, drop] = useDropped(view);
  const byKey = new Map(view.slides.map((s) => [s.key, s]));
  const slides = order.map((key) => byKey.get(key)).filter((s): s is DeckSlide => !!s);
  const sortable = useSortable(
    order,
    (next, moved) => {
      const op = moved ? moveOp(next, moved, view) : null;
      if (!op || !hand) return;
      drop(next);
      // Refused, the slides go back to the deck's own order.
      void hand.session.edit([op], "Couldn't move the slide").then((written) => written || drop(view.slides.map((s) => s.key)));
    },
    narrow ? "x" : "y",
  );
  // A slide taken out with Delete hands the keyboard to the one in its place once the deck comes back.
  const refocus = useRefocus(list, view);
  // The current slide stays in view when the stepper moves the stage.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  // One Tab stop, as a listbox is: the slide on the stage takes it (the first while none is), and the arrows along the
  // strip, Home and End move the focus and the stage together.
  const stop = slides.some((slide) => slide.key === current) ? current : (slides[0]?.key ?? null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = slides.map((slide) => slide.key);
    const at = keys.indexOf((event.target as HTMLElement).dataset.slide ?? stop ?? "");
    if ((event.key === "Delete" || event.key === "Backspace") && bareKey(event) && open && hand) {
      const slide = slides[at];
      if (!slide) return;
      event.preventDefault();
      refocus();
      return removeSlide(slide, view, hand.session);
    }
    const back = narrow ? "ArrowLeft" : "ArrowUp";
    const on = narrow ? "ArrowRight" : "ArrowDown";
    const to = event.key === back ? at - 1 : event.key === on ? at + 1 : event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const key = keys[Math.max(0, Math.min(keys.length - 1, to))];
    if (!key) return;
    if (key !== current) onPick(key);
    list.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(key)}"]`)?.focus();
  };
  return (
    <SlideMenu view={view} hand={hand}>
      <div
        ref={list}
        data-slides-strip
        role="listbox"
        aria-label="Slides"
        aria-orientation={narrow ? "horizontal" : "vertical"}
        onKeyDown={onKeyDown}
        className={
          narrow
            ? "flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden overscroll-contain border-t border-border bg-sidebar p-2"
            : "flex w-[140px] shrink-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain border-e border-border bg-sidebar pt-2 pr-2 pb-4 pl-1"
        }
      >
        {slides.map((slide, index) => {
          const on = slide.key === current;
          const picture = pictureOf(slide);
          const dropping = sortable.toIndex === index && sortable.fromIndex !== null && sortable.toIndex !== sortable.fromIndex;
          const before = dropping && sortable.toIndex! < sortable.fromIndex!;
          return (
            <div key={slide.key} className={narrow ? "flex shrink-0 flex-col" : "contents"}>
              {slide.section ? <div className={`text-xs font-medium text-muted-foreground ${narrow ? "px-2 pb-1 whitespace-nowrap" : `${index === 0 ? "pt-1" : "pt-3"} pr-1 pb-1 pl-6`}`}>{slide.section}</div> : null}
              <button
                ref={(el) => sortable.setItemRef(slide.key, el)}
                type="button"
                role="option"
                aria-selected={on}
                aria-current={on ? "true" : undefined}
                aria-label={`${slide.number === null ? "Removed" : `Slide ${slide.number}`}${slide.hidden ? ", hidden" : ""}: ${slide.title || "Untitled"}`}
                data-slide={slide.key}
                data-menu-id={slide.key}
                data-tint={slide.tint ?? undefined}
                data-hidden={slide.hidden || undefined}
                tabIndex={slide.key === stop ? 0 : -1}
                onPointerDown={open ? (event) => sortable.onItemPointerDown(slide.key, event) : undefined}
                onClick={() => {
                  if (!sortable.consumeClick()) onPick(slide.key);
                }}
                className={`group/th relative flex shrink-0 items-start gap-1 rounded-md text-start ${sortable.draggingId === slide.key ? "z-10" : ""}`}
              >
                {dropping ? (
                  <span
                    aria-hidden="true"
                    data-slide-drop
                    className={`pointer-events-none absolute z-20 rounded-full bg-accent ${narrow ? `inset-y-0 w-0.5 ${before ? "-left-[3px]" : "-right-[3px]"}` : `right-0 left-6 h-0.5 ${before ? "-top-px" : "-bottom-px"}`}`}
                  />
                ) : null}
                <span className={`w-5 shrink-0 pt-1 text-end text-xs leading-4 tabular-nums ${on ? "text-foreground" : "text-muted-foreground"}`}>{slide.number ?? ""}</span>
                <span
                  className={`block rounded-md p-[3px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${
                    slide.tint === "add"
                      ? on
                        ? "bg-[color-mix(in_srgb,var(--success)_30%,transparent)]"
                        : FRAME_TINT.add
                      : slide.tint === "del"
                        ? FRAME_TINT.del
                        : on || sortable.draggingId === slide.key
                          ? "bg-muted"
                          : "group-hover/th:bg-foreground/5 group-active/th:bg-foreground/12 group-active/th:transition-none"
                  }`}
                >
                  <Picture doc={pictures ? picture.doc : null} page={picture.page} width={THUMB} ghost={slide.tint === "del" || slide.hidden} title={slide.title} thumb />
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </SlideMenu>
  );
});
