import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { MENU_ROW } from "../../../components/ui/menu-row";
import { Skeleton } from "../../../components/ui/skeleton";
import { Toggle } from "../../../components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { Check, ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, RefreshCw } from "../../../chrome/icons";
import { clockTime } from "../../../lib/duration";
import type { PdfDoc } from "../../pdf/engine";
import { useRoom, type Room } from "./Audience";
import { aspectOf, fit, SlidePicture, Thumb } from "./pictures";
import { MediaTransport, SlideMedia, usePicture, useStage } from "./stage";
import { nextPress, NOTES_SIZES, placeLabel, placeText, type ShowAct, type ShowState } from "./state";
import { clockOf, elapsedOf, overTarget, TARGETS, type ShowTimer, type Target } from "./timer";

/**
 * The presenter's view (docs/DESIGN.md "The show"; the approved page is
 * .temp-code/prototypes/work-editors/present.html, "Slide and column"): the
 * slide the room sees, large at the left; at the right the next press and
 * the notes at a size he sets; the timer and the clock on a 40px bar at the
 * top; every slide in a strip at the foot. It wears the app's theme.
 */

/** The column at the right: the next press, then the notes. */
export const COLUMN = 288;
/** Under this the column stacks under the slide and the clock and the timer's buttons go. */
export const PRESENTER_NARROW = 640;
const STRIP_THUMB = 64;
const NEXT_NARROW = 176;

export interface PresenterProps {
  state: ShowState;
  dispatch(act: ShowAct): void;
  doc: PdfDoc | null;
  /** the deck is being read */
  loading?: boolean;
  error?: string | null;
  /** a line under the bar: the display the slideshow was on left */
  notice?: string | null;
  ratio?: number;
  timer: ShowTimer;
  target: Target;
  onTimer(act: "pause" | "resume" | "restart"): void;
  onTarget(target: Target): void;
  /** the notes' size, by its place in `NOTES_SIZES` */
  notesSize: number;
  onNotesSize(by: 1 | -1): void;
  /** the time now; a test and a preview hand in a still one */
  now?: () => number;
  room?: Room;
}

/** The time, read again each second while the view is up. */
function useNow(now: () => number): number {
  const [at, setAt] = useState(now);
  useEffect(() => {
    const tick = setInterval(() => setAt(now()), 1000);
    return () => clearInterval(tick);
  }, [now]);
  return at;
}

const LABEL = "text-xs leading-4 font-medium text-muted-foreground";
/** A slide in the view: radius 4, on the image outline, which sits on the picture itself (a button's outline is the focus ring's). */
const PICTURE = "rounded-sm bg-muted outline-1 -outline-offset-1 outline-(--image-outline)";
const RULE = <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-border" />;

function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Presenter({ state, dispatch, doc, loading = false, error = null, notice = null, ratio = 1, timer, target, onTimer, onTarget, notesSize, onNotesSize, now = Date.now, room: fixedRoom }: PresenterProps) {
  const root = useRef<HTMLDivElement>(null);
  const room = useRoom(root, fixedRoom);
  const at = useNow(now);
  const narrow = room.width > 0 && room.width < PRESENTER_NARROW;
  const slide = state.slides[state.at];
  const next = nextPress(state);
  const elapsed = elapsedOf(timer, at);
  const paused = timer.pausedAt !== null;

  // The slide takes the room the bar, the strip, the column and the insets leave; beside a column it is as tall as the body allows.
  const aspect = aspectOf(doc, slide?.page ?? 1);
  // The transport's rows (28px each, 4px apart, 8px under the slide) come out of the slide's room.
  const hidden = slide?.steps?.[state.step]?.hides ?? [];
  const clips = slide && !state.ended ? (slide.media?.filter((m) => !hidden.includes(m.shape)).length ?? 0) : 0;
  const bodyHeight = Math.max(0, room.height - 40 - 60 - (notice ? 28 : 0) - 32 - (clips ? clips * 32 + 4 : 0));
  const now_ = narrow ? fit({ width: room.width - 32, height: Math.max(120, bodyHeight * 0.5) }, aspect) : fit({ width: room.width - COLUMN - 48, height: bodyHeight - 24 }, aspect);
  const columnWidth = narrow ? Math.max(0, room.width - 32) : COLUMN;
  // Stacked, the next press is a small picture, so the notes keep the room.
  const nextWidth = narrow ? Math.min(columnWidth, NEXT_NARROW) : COLUMN;
  const [size, line] = NOTES_SIZES[notesSize] ?? NOTES_SIZES[0];

  const nextSlide = next.kind === "slide" ? state.slides[next.at] : next.kind === "build" ? slide : undefined;
  const pictureOf = usePicture(doc);
  const stage = useStage();
  const here = pictureOf(slide, state.step);
  const coming = nextSlide ? pictureOf(nextSlide, next.kind === "build" ? next.step : 0) : null;
  return (
    <div
      ref={root}
      data-show="presenter"
      tabIndex={-1}
      // After a press made with the pointer the keyboard is the show's again: Space is the next slide, never a second
      // press of the button he last used. A press made with the keyboard keeps its place, and a menu keeps its own.
      onClick={(event) => {
        if (event.detail > 0 && !(event.target as Element).closest('[role="menu"], [aria-haspopup]')) root.current?.focus();
      }}
      className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground outline-none select-none"
    >
      <div data-show-top className="flex h-10 shrink-0 items-center border-b border-border pr-2 pl-4">
        <span data-show-elapsed data-over={overTarget(elapsed, target) || undefined} className={`text-base leading-6 font-semibold tracking-[-0.01em] tabular-nums ${overTarget(elapsed, target) ? "text-warning" : ""}`}>
          {clockOf(elapsed)}
        </span>
        <TargetMenu target={target} onTarget={onTarget} />
        {narrow ? null : (
          <>
            <IconButton label={paused ? "Resume the timer" : "Pause the timer"} onClick={() => onTimer(paused ? "resume" : "pause")}>
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </IconButton>
            <IconButton label="Restart the timer" onClick={() => onTimer("restart")}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            {RULE}
            <span data-show-clock className="px-0.5 text-[13px] leading-5 text-muted-foreground tabular-nums">
              {clockTime(at)}
            </span>
          </>
        )}
        <span className="min-w-2 flex-1" />
        <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => dispatch({ t: "prev" })}>
          <ChevronLeft />
        </Button>
        <span data-show-place aria-live="polite" aria-label={placeLabel(state)} className="min-w-11 px-1 text-center text-xs leading-4 tabular-nums">
          {placeText(state)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => dispatch({ t: "next" })}>
          <ChevronRight />
        </Button>
        {RULE}
        <Toggle size="sm" className="px-2.5" pressed={state.blank} onPressedChange={() => dispatch({ t: "blank" })}>
          Blank
        </Toggle>
        <Button variant="secondary" size="sm" className="ml-1.5" onClick={() => dispatch({ t: "end" })}>
          End show
        </Button>
      </div>
      {notice ? (
        <div data-show-notice role="status" className="flex h-7 shrink-0 items-center border-b border-border px-4 text-xs leading-4 text-muted-foreground">
          {notice}
        </div>
      ) : null}
      <div data-show-body className={`flex min-h-0 flex-1 gap-4 p-4 ${narrow ? "flex-col overflow-x-hidden overflow-y-auto overscroll-contain" : ""}`}>
        <div className="flex min-w-0 shrink-0 flex-col gap-2" style={narrow ? undefined : { width: Math.max(0, room.width - COLUMN - 48) }}>
          <div className={LABEL}>Now</div>
          {error ? (
            <p data-show-error className="max-w-[60ch] text-[13px] leading-5 text-pretty text-muted-foreground">
              {error}
            </p>
          ) : loading && !doc ? (
            <Skeleton className="rounded-sm" style={now_} />
          ) : state.ended ? (
            <Ended size={now_} words="End of show" />
          ) : slide ? (
            <button type="button" data-show-now aria-label={`Current slide ${slide.number}${slide.title ? `, ${slide.title}` : ""}`} onClick={() => dispatch({ t: "next" })} className="block w-fit rounded-sm text-start">
              <SlidePicture
                doc={here.doc}
                page={here.page}
                waiting={here.waiting}
                width={now_.width}
                ratio={ratio}
                title={slide.title}
                className={`${PICTURE} ${state.blank ? "opacity-45" : ""}`}
                motion={stage?.motion ?? null}
                motionKey={stage?.motionKey}
              >
                <SlideMedia slide={slide} step={state.step} surface="presenter" width={now_.width} height={now_.height} />
              </SlidePicture>
            </button>
          ) : null}
          {slide && !state.ended && !error ? <MediaTransport slide={slide} step={state.step} /> : null}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-4" style={{ width: columnWidth }}>
          <div className="flex shrink-0 flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className={LABEL}>Next</span>
              {next.kind === "build" ? (
                <span data-show-build className="text-xs leading-4 text-muted-foreground tabular-nums">
                  Build {next.step} of {next.of}
                </span>
              ) : null}
            </div>
            {loading && !doc ? (
              <Skeleton className="aspect-video rounded-sm" style={{ width: nextWidth }} />
            ) : next.kind === "close" ? (
              <Ended size={{ width: nextWidth, height: Math.round(nextWidth / aspect) }} words="A press closes the show" quiet />
            ) : next.kind === "end" ? (
              <Ended size={{ width: nextWidth, height: Math.round(nextWidth / aspect) }} words="End of show" />
            ) : nextSlide ? (
              <button type="button" data-show-next aria-label={next.kind === "build" ? `Next: build ${next.step} of ${next.of}` : `Next slide ${nextSlide.number}${nextSlide.title ? `, ${nextSlide.title}` : ""}`} onClick={() => dispatch({ t: "next" })} className="block w-fit rounded-sm text-start">
                <SlidePicture doc={coming?.doc ?? doc} page={coming?.page ?? nextSlide.page} waiting={coming?.waiting} width={nextWidth} ratio={ratio} title={nextSlide.title} className={PICTURE} />
              </button>
            ) : null}
          </div>
          <div className={`flex min-h-0 flex-col ${narrow ? "max-h-[220px]" : "flex-1"}`}>
            <div className="flex h-6 shrink-0 items-center">
              <span className={`flex-1 ${LABEL}`}>Notes</span>
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="Smaller notes" disabled={notesSize <= 0} onClick={() => onNotesSize(-1)}>
                <Minus />
              </Button>
              <span data-show-notes-size className="min-w-6 text-center text-xs leading-4 text-muted-foreground tabular-nums">
                {size}
              </span>
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="Larger notes" disabled={notesSize >= NOTES_SIZES.length - 1} onClick={() => onNotesSize(1)}>
                <Plus />
              </Button>
            </div>
            {slide && !state.ended && slide.notes.trim() ? (
              <p data-show-notes tabIndex={0} className="focus-ring mt-2 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain text-pretty whitespace-pre-wrap select-text" style={{ fontSize: size, lineHeight: `${line}px` }}>
                {slide.notes}
              </p>
            ) : (
              <p data-show-notes className="mt-2 text-[13px] leading-5 text-muted-foreground">
                None
              </p>
            )}
          </div>
        </div>
      </div>
      <Strip state={state} doc={doc} ratio={ratio} dispatch={dispatch} surface={root} />
    </div>
  );
}

/** The end, in a slide's place: the matte with its words, or (once the show has ended) a quiet box saying what a press does. */
function Ended({ size, words, quiet = false }: { size: { width: number; height: number }; words: string; quiet?: boolean }) {
  return (
    <div data-show-ended style={size} className={`grid place-items-center rounded-sm text-[13px] leading-5 text-muted-foreground ${quiet ? "bg-muted" : "bg-(--matte)"}`}>
      {words}
    </div>
  );
}

/**
 * "of 20:00": the target he talks against, and its choices. A panel of the
 * view's own, never a portal: the app's menus mount in the main window's
 * page, and this view is a window of its own.
 */
function TargetMenu({ target, onTarget }: { target: Target; onTarget(target: Target): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const doc = box.current?.ownerDocument;
    const away = (event: Event): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    doc?.addEventListener("pointerdown", away, true);
    box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => doc?.removeEventListener("pointerdown", away, true);
  }, [open]);
  // Every key pressed in the open menu is the menu's: an arrow moves its rows and never the show.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    event.stopPropagation();
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = rows.indexOf(event.target as HTMLElement);
    if (event.key === "Escape") {
      setOpen(false);
      box.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    }
  };
  const choices: Target[] = [...TARGETS, null];
  return (
    <div ref={box} className="relative ml-1" onKeyDown={onKeyDown}>
      <Button variant="ghost" size="xs" className="font-normal text-muted-foreground tabular-nums hover:text-foreground" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {target === null ? "Set a target" : `of ${target}:00`}
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Target"
          className="absolute top-full left-0 z-(--layer-popover) mt-1.5 min-w-36 origin-top-left rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border transition-[opacity,scale] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-opacity starting:scale-95 starting:opacity-0"
        >
          {choices.map((choice) => (
            <button
              key={choice ?? "none"}
              type="button"
              role="menuitemradio"
              aria-checked={choice === target}
              onClick={() => {
                onTarget(choice);
                setOpen(false);
              }}
              className={`flex w-full items-center rounded-lg text-start tabular-nums outline-none hover:bg-foreground/7 focus-visible:bg-foreground/7 ${MENU_ROW}`}
            >
              <span className="flex-1">{choice === null ? "No target" : `${choice}:00`}</span>
              {choice === target ? <Check className="size-3.5" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every slide, at the foot: a press jumps there. G hands it the keyboard
 * (the arrows then move along it and Return jumps); at every other time the
 * arrows are the show's, so a thumbnail is never a Tab stop.
 */
function Strip({ state, doc, ratio, dispatch, surface }: { state: ShowState; doc: PdfDoc | null; ratio: number; dispatch(act: ShowAct): void; surface: { current: HTMLElement | null } }) {
  const list = useRef<HTMLDivElement>(null);
  const current = state.slides[state.at]?.id;
  // The current slide stays in the middle of the strip.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [current]);
  useEffect(() => {
    if (state.picker) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    else if (list.current?.contains(list.current.ownerDocument.activeElement)) surface.current?.focus();
  }, [state.picker, surface]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!state.picker) return;
    const all = [...(list.current?.querySelectorAll<HTMLElement>("[data-pick]") ?? [])];
    const at = all.indexOf(event.target as HTMLElement);
    const to = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : -1;
    if (at < 0 || to < 0 || to >= all.length) return;
    event.preventDefault();
    all[to].focus();
  };
  return (
    <div
      ref={list}
      data-show-strip
      role="listbox"
      aria-label="Slides"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex h-[60px] shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-contain border-t border-border bg-sidebar px-3"
    >
      {state.slides.map((slide, index) => {
        const on = index === state.at && !state.ended;
        return (
          <button
            key={slide.id}
            type="button"
            role="option"
            data-pick={slide.number}
            aria-selected={on}
            aria-label={`Slide ${slide.number}: ${slide.title || "Untitled"}${slide.hidden ? ", hidden" : ""}`}
            tabIndex={-1}
            onClick={() => dispatch({ t: "goto", number: slide.number })}
            className="group/th flex shrink-0 items-start gap-1 rounded-md text-start"
          >
            <span className={`min-w-4 shrink-0 pt-1 text-end text-xs leading-4 tabular-nums ${on ? "text-foreground" : "text-muted-foreground"}`}>{slide.number}</span>
            <span
              className={`block rounded-md p-[3px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${
                on ? "bg-muted" : "group-hover/th:bg-foreground/5 group-active/th:bg-foreground/12 group-active/th:transition-none"
              } ${slide.hidden ? "opacity-45" : ""}`}
            >
              <Thumb doc={doc} page={slide.page} width={STRIP_THUMB - 6} ratio={ratio} title="" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
