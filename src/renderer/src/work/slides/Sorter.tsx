import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { bareKey } from "../../lib/keys";
import { moveOp, removeSlide, slidesOpen } from "./edit/slides";
import { Picture } from "./Picture";
import { SlideMenu, useDropped, useRefocus, type PictureOf, type SlideHand } from "./Strip";

/**
 * The Sorter (docs/DESIGN.md "The slide editor"): every slide of the deck
 * in a grid, four across (two under 640px), each in the strip's 3px frame
 * with its number and title under it; the deck's sections as headings with
 * their counts; a hidden slide at 45%. A press goes back to that slide on the
 * stage. Where his hand may change the deck's slides, a slide opens the
 * strip's menu, is dragged to a new place (a 2px bar where it will land, the
 * slide carried at 80%, a dashed frame where it was), and goes with Delete.
 */

const GAP_X = 12;
const INSET = 16;
const DRAG_START = 5;

/** Where a slide dropped at a point lands: its place among the others once it has left its own, from the nearest slide's side. */
export function dropIndex(rects: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }>, from: number, x: number, y: number): number {
  let best = 0;
  let gap = Infinity;
  rects.forEach((r, i) => {
    const d = Math.hypot(x - (r.left + r.right) / 2, y - (r.top + r.bottom) / 2);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  const r = rects[best];
  const at = r && x > (r.left + r.right) / 2 ? best + 1 : best;
  return at > from ? at - 1 : at;
}

interface Drag {
  key: string;
  from: number;
  to: number;
  /** the carried slide's top-left, in the grid's own pixels */
  x: number;
  y: number;
}

export function Sorter({
  view,
  current,
  width,
  pictureOf,
  pictures,
  hand,
  onOpen,
}: {
  view: DeckView;
  current: string | null;
  /** the body's width: how many go across and how wide each is */
  width: number;
  pictureOf: PictureOf;
  pictures: boolean;
  hand: SlideHand | null;
  /** a press on a slide: back to it on the stage */
  onOpen(key: string): void;
}) {
  const open = !!hand && slidesOpen(view);
  const cols = width > 0 && width < 640 ? 2 : 4;
  const thumb = Math.max(80, Math.floor((Math.max(0, width - INSET * 2) - (cols - 1) * GAP_X) / cols) - 6);
  const [order, drop] = useDropped(view);
  const byKey = new Map(view.slides.map((s) => [s.key, s]));
  const slides = order.map((key) => byKey.get(key)).filter((s): s is DeckSlide => !!s);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragged = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const refocus = useRefocus(box, view);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const items = (): HTMLElement[] => [...(box.current?.querySelectorAll<HTMLElement>("[data-sorter-slide]") ?? [])];
  const local = (x: number, y: number): { x: number; y: number } => {
    const r = box.current!.getBoundingClientRect();
    return { x: x - r.left + box.current!.scrollLeft, y: y - r.top + box.current!.scrollTop };
  };
  const down = (key: string, event: ReactPointerEvent<HTMLElement>): void => {
    if (!open || event.button !== 0 || slides.length < 2) return;
    dragged.current = false;
    const from = slides.findIndex((s) => s.key === key);
    const el = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY };
    const rect = el.getBoundingClientRect();
    const grab = { x: start.x - rect.left, y: start.y - rect.top };
    const pointer = event.pointerId;
    let live: Drag | null = null;
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return;
      if (!live && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START) return;
      const at = local(e.clientX - grab.x, e.clientY - grab.y);
      const to = dropIndex(items().map((n) => n.getBoundingClientRect()), from, e.clientX, e.clientY);
      live = { key, from, to, x: at.x, y: at.y };
      dragged.current = true;
      setDrag(live);
    };
    const end = (commit: boolean): void => {
      stop.current?.();
      stop.current = null;
      const done = live;
      live = null;
      setDrag(null);
      if (!commit || !done || done.to === done.from || !hand) return;
      const next = slides.map((s) => s.key);
      next.splice(done.to, 0, ...next.splice(done.from, 1));
      const op = moveOp(next, done.key, view);
      if (!op) return;
      drop(next);
      void hand.session.edit([op], "Couldn't move the slide").then((written) => written || drop(view.slides.map((s) => s.key)));
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId === pointer) end(e.type === "pointerup");
    };
    const key_ = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape" || !live) return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key_, true);
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key_, true);
    };
  };

  // One Tab stop: the slide he stood on. The arrows move four ways over the grid, Return opens one, Delete takes it out.
  const stopKey = slides.some((s) => s.key === current) ? current : (slides[0]?.key ?? null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = slides.findIndex((s) => s.key === (event.target as HTMLElement).dataset.slide);
    if (at < 0) return;
    if ((event.key === "Delete" || event.key === "Backspace") && bareKey(event) && open && hand) {
      event.preventDefault();
      refocus();
      return removeSlide(slides[at], view, hand.session);
    }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -at, End: slides.length - 1 - at }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const to = slides[Math.max(0, Math.min(slides.length - 1, at + step))];
    box.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(to.key)}"]`)?.focus();
  };

  const counts = new Map<string, number>();
  let section: string | null = null;
  for (const s of slides) {
    if (s.section !== undefined) section = s.key;
    if (section) counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  const bar = drag ? barAt(items(), drag, box.current) : null;
  const carried = drag ? slides[drag.from] : undefined;
  return (
    <SlideMenu view={view} hand={hand}>
      <div ref={box} data-slides-sorter className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4">
        <div role="listbox" aria-label="Slides" onKeyDown={onKeyDown} className="grid gap-x-3 gap-y-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {slides.map((slide, index) => {
            const on = slide.key === current;
            const picture = pictureOf(slide);
            const hole = drag?.key === slide.key;
            return (
              <Fragment key={slide.key}>
                {slide.section !== undefined ? (
                  <div data-sorter-section className={`col-span-full flex items-baseline gap-2 text-[13px] leading-5 font-medium ${index === 0 ? "" : "mt-2"}`}>
                    <span className="min-w-0 truncate">{slide.section}</span>
                    <span className="font-normal text-muted-foreground tabular-nums">{counts.get(slide.key) ?? 0}</span>
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-current={on ? "true" : undefined}
                  aria-label={`${slide.number === null ? "Removed" : `Slide ${slide.number}`}${slide.hidden ? ", hidden" : ""}: ${slide.title || "Untitled"}`}
                  data-slide={slide.key}
                  data-sorter-slide
                  data-menu-id={slide.key}
                  data-hidden={slide.hidden || undefined}
                  tabIndex={slide.key === stopKey ? 0 : -1}
                  onPointerDown={(event) => down(slide.key, event)}
                  onClick={() => {
                    if (dragged.current) dragged.current = false;
                    else onOpen(slide.key);
                  }}
                  className="group/gi relative flex min-w-0 flex-col gap-1.5 rounded-md text-start"
                >
                  <span
                    className={`block rounded-md p-[3px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${
                      hole
                        ? "outline-1 -outline-offset-1 outline-(--border-strong) outline-dashed"
                        : slide.tint === "add"
                          ? "bg-(--add-bg)"
                          : slide.tint === "del"
                            ? "bg-(--del-bg)"
                            : on
                              ? "bg-muted"
                              : "group-hover/gi:bg-foreground/5 group-active/gi:bg-foreground/12 group-active/gi:transition-none"
                    }`}
                  >
                    <span className={hole ? "block opacity-0" : "block"}>
                      <Picture doc={pictures ? picture.doc : null} page={picture.page} width={thumb} ghost={slide.tint === "del" || slide.hidden} title={slide.title} thumb first />
                    </span>
                  </span>
                  <span className="flex min-w-0 gap-1.5 px-[3px] text-xs leading-4 text-muted-foreground">
                    <span className="shrink-0 tabular-nums">{slide.number ?? ""}</span>
                    <span className="min-w-0 truncate text-foreground">{slide.title || "Untitled"}</span>
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
        {bar ? <span aria-hidden="true" data-sorter-drop className="pointer-events-none absolute w-0.5 rounded-full bg-accent" style={bar} /> : null}
        {drag && carried ? (
          <span aria-hidden="true" data-sorter-carry className="pointer-events-none absolute z-10 block rounded-[3px] opacity-80 shadow-overlay outline-[1.5px] outline-accent" style={{ left: drag.x + 3, top: drag.y + 3 }}>
            <Picture doc={pictures ? pictureOf(carried).doc : null} page={pictureOf(carried).page} width={thumb} title={carried.title} />
          </span>
        ) : null}
      </div>
    </SlideMenu>
  );
}

/** The 2px bar where a dragged slide will land: in the 12px gap before the slide it goes in front of, or after the last. */
function barAt(nodes: HTMLElement[], drag: Drag, box: HTMLElement | null): { left: number; top: number; height: number } | null {
  if (!box || drag.to === drag.from) return null;
  const others = nodes.filter((_, i) => i !== drag.from);
  const r = box.getBoundingClientRect();
  const at = (n: HTMLElement): DOMRect => n.getBoundingClientRect();
  const next = others[drag.to];
  const frame = (n: HTMLElement): number => (n.firstElementChild as HTMLElement | null)?.getBoundingClientRect().height ?? at(n).height;
  if (next) return { left: at(next).left - r.left + box.scrollLeft - GAP_X / 2 - 1, top: at(next).top - r.top + box.scrollTop, height: frame(next) };
  const last = others[others.length - 1];
  return last ? { left: at(last).right - r.left + box.scrollLeft + GAP_X / 2 - 1, top: at(last).top - r.top + box.scrollTop, height: frame(last) } : null;
}
