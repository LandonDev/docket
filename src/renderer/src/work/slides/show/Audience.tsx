import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { ChevronLeft, ChevronRight } from "../../../chrome/icons";
import type { PdfDoc } from "../../pdf/engine";
import { aspectOf, fit, SlidePicture, Thumb } from "./pictures";
import { nextPress, placeLabel, placeText, type ShowAct, type ShowState } from "./state";

/**
 * The slideshow as the room sees it (docs/DESIGN.md "The show"): the slide
 * on the matte and nothing else. A real move of the pointer calls a small
 * bar at the foot, which goes with the pointer two seconds after the last
 * move; a key never calls it. The window wears the dark theme whatever the
 * app wears, so the bar keeps one look on every deck.
 */

/** How long after the pointer's last move the bar and the pointer go. */
export const PRESENT_IDLE_MS = 2000;

export interface Room {
  width: number;
  height: number;
}

/** An element's size, read by its own window's observer; a test or a preview hands in a fixed one. */
export function useRoom(ref: RefObject<HTMLElement | null>, fixed?: Room): Room {
  const [room, setRoom] = useState<Room>(fixed ?? { width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fixed) return;
    const read = (): void => setRoom((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    read();
    const Observer = el.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, fixed]);
  return fixed ?? room;
}

export interface AudienceProps {
  state: ShowState;
  dispatch(act: ShowAct): void;
  doc: PdfDoc | null;
  /** why there is no picture, in the slide's place */
  error?: string | null;
  /** the window's pixels a CSS pixel over the main window's */
  ratio?: number;
  /** the picker opens here: there is no presenter's view to hold it */
  picks?: boolean;
  /** a fixed room, and the bar held on: a test's and a preview's */
  room?: Room;
  barOn?: boolean;
}

export function Audience({ state, dispatch, doc, error = null, ratio = 1, picks = true, room: fixedRoom, barOn }: AudienceProps) {
  const root = useRef<HTMLDivElement>(null);
  const room = useRoom(root, fixedRoom);
  const slide = state.slides[state.at];
  const next = nextPress(state);
  const ahead = next.kind === "slide" ? (state.slides[next.at]?.page ?? null) : null;
  const size = fit(room, aspectOf(doc, slide?.page ?? 1));

  // The bar comes for a real move of the pointer alone: the first reading only says where the pointer is (a window
  // that opens under a still pointer is told a move), and a slide changing under it is no move.
  const [moved, setMoved] = useState(false);
  const [over, setOver] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onPointerMove = (event: PointerEvent): void => {
    const was = last.current;
    last.current = { x: event.clientX, y: event.clientY };
    if (!was || (was.x === event.clientX && was.y === event.clientY)) return;
    setMoved(true);
    clearTimeout(idle.current);
    idle.current = setTimeout(() => setMoved(false), PRESENT_IDLE_MS);
  };
  useEffect(() => () => clearTimeout(idle.current), []);
  const picking = picks && state.picker;
  const on = barOn ?? (moved || over || picking);

  return (
    <div
      ref={root}
      data-show="audience"
      tabIndex={-1}
      onPointerMove={onPointerMove}
      // A press anywhere on the screen is a next press: on the slide, on the black of a blank, on "End of show".
      onClick={() => dispatch({ t: "next" })}
      className={`relative flex h-full w-full items-center justify-center overflow-hidden bg-(--matte) text-foreground outline-none select-none ${on ? "" : "cursor-none"}`}
    >
      {state.blank ? null : state.ended ? (
        <p data-show-end className="text-[15px] leading-6 text-muted-foreground">
          End of show
        </p>
      ) : error ? (
        <p data-show-error className="max-w-[60ch] px-6 text-center text-[15px] leading-6 text-pretty text-muted-foreground">
          {error}
        </p>
      ) : slide ? (
        <div data-show-slide>
          <SlidePicture doc={doc} page={slide.page} ahead={ahead} width={size.width} ratio={ratio} title={slide.title} />
        </div>
      ) : null}
      <div
        data-show-bar
        data-on={on || undefined}
        inert={!on}
        onPointerEnter={() => setOver(true)}
        onPointerLeave={() => setOver(false)}
        // The bar's own presses are its own; after one made with the pointer the keyboard is the show's again, so
        // Space is the next slide and never a second press of the button he last used.
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail > 0) root.current?.focus();
        }}
        className={`absolute bottom-3 left-1/2 flex h-10 -translate-x-1/2 items-center gap-0.5 rounded-[10px] bg-(--present-bar) px-1 shadow-overlay ring-1 ring-border transition-[opacity,translate] duration-(--dur-base) motion-reduce:translate-y-0 motion-reduce:transition-opacity ${
          on ? "translate-y-0 opacity-100 ease-(--ease-out)" : "pointer-events-none translate-y-1 opacity-0 ease-(--ease-exit)"
        }`}
      >
        <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => dispatch({ t: "prev" })}>
          <ChevronLeft />
        </Button>
        <span data-show-place aria-live="polite" aria-label={placeLabel(state)} className="min-w-11 px-1 text-center text-xs leading-4 tabular-nums">
          {placeText(state)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => dispatch({ t: "next" })}>
          <ChevronRight />
        </Button>
        <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-border" />
        {picks ? (
          <Button variant="ghost" size="sm" aria-haspopup="listbox" aria-expanded={picking} onClick={() => dispatch({ t: "picker" })}>
            Slides
          </Button>
        ) : null}
        <Toggle size="sm" className="px-2.5 text-foreground" pressed={state.blank} onPressedChange={() => dispatch({ t: "blank" })}>
          Blank
        </Toggle>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ t: "end" })}>
          End
        </Button>
        {picking ? <Picker state={state} doc={doc} ratio={ratio} dispatch={dispatch} /> : null}
      </div>
    </div>
  );
}

const PICKER_ACROSS = 4;

/** Every slide as a 64px picture, four across, over the bar: a press or Return jumps, the arrows move, Escape leaves. */
function Picker({ state, doc, ratio, dispatch }: { state: ShowState; doc: PdfDoc | null; ratio: number; dispatch(act: ShowAct): void }) {
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const all = [...(grid.current?.querySelectorAll<HTMLElement>("[data-pick]") ?? [])];
    const at = all.indexOf(event.target as HTMLElement);
    const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? PICKER_ACROSS : event.key === "ArrowUp" ? -PICKER_ACROSS : 0;
    const to = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : by ? at + by : -1;
    if (to < 0 || to >= all.length || at < 0) return;
    event.preventDefault();
    all[to].focus();
  };
  return (
    <div
      ref={grid}
      data-show-picker
      role="listbox"
      aria-label="Slides"
      onKeyDown={onKeyDown}
      className="absolute bottom-full left-1/2 mb-2 grid max-h-[50vh] w-[296px] origin-bottom -translate-x-1/2 grid-cols-4 gap-2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl bg-popover p-2 shadow-overlay ring-1 ring-border transition-[opacity,scale] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-opacity starting:scale-95 starting:opacity-0"
    >
      {state.slides.map((slide, index) => {
        const current = index === state.at && !state.ended;
        return (
          <button
            key={slide.id}
            type="button"
            role="option"
            data-pick={slide.number}
            aria-selected={current}
            aria-label={`Slide ${slide.number}: ${slide.title || "Untitled"}`}
            tabIndex={current ? 0 : -1}
            onClick={() => dispatch({ t: "goto", number: slide.number })}
            className={`rounded-md p-[3px] text-start transition-[background-color] duration-(--dur-hover) ease-(--ease-out) active:bg-foreground/12 active:transition-none motion-reduce:transition-none ${current ? "bg-muted" : "hover:bg-foreground/7"}`}
          >
            <Thumb doc={doc} page={slide.page} width={58} ratio={ratio} title={slide.title} />
          </button>
        );
      })}
    </div>
  );
}
