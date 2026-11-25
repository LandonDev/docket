import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { cn } from "@renderer/lib/cn";
import { Minimize2 } from "../../../chrome/icons";
import { driveName, handBack, useComputer, type ComputerTile } from "../../../lib/computers";
import { useDriveHold } from "../../../lib/driveHold";
import { DUR } from "../../../lib/ease";
import { closeFullWindow, useFullWindow, type ScreenRect } from "../../../lib/fullWindow";
import { reducedMotion } from "../../../lib/motion";
import { onWindowFullScreen, setWindowFullScreen } from "../../../lib/native";
import { drawnPixelated, fitStage, pictureKind, type PictureKind, type Size } from "../../../lib/stageLayout";
import { pixelRatioOf } from "../../../lib/video/support";
import { ComputerCaption, ViewButton } from "./ComputerCaption";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, PIXELATED, RETRY_ENDS, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type LiveStream } from "./Viewport";
import { drivenScreen } from "../../../lib/video/videoInput";

/**
 * Full screen (docs/DESIGN.md "Computers", "Full screen"): one computer over
 * his whole display. The window itself goes full screen (main's
 * fullScreen.ts) and the picture fills it on `matte`, in its own shape, with
 * no inset: a whole computer's screen as large as the display allows, a
 * window's picture to twice its own pixels (`fitStage`). The caption floats
 * over the top edge; it fades after two seconds with no pointer movement and
 * comes back with it, or with keyboard focus in it. ⌃⌘F leaves; Escape leaves
 * when the picture does not hold the keyboard; a double click on the picture
 * leaves when he does not drive. A press grows the picture from where it was;
 * a key's entry has no motion. It is another canvas on the stream the page
 * already plays.
 */

/** The caption stays this long after the pointer last moved. */
export const CAPTION_REST_MS = 2000;

/** The longest a pressed picture waits for the window to fill the display before it grows anyway. */
export const FILL_WAIT_MS = 400;

export interface FullWindowViewProps {
  tile: ComputerTile | null;
  stream: LiveStream;
  /** the window, in CSS pixels: in full screen, the display */
  room: Size;
  name: string;
  /** what the picture shows; a `vm:` screen by the tile's name when left out */
  kind?: PictureKind;
  boxRef?: Ref<HTMLDivElement>;
  measureRef?: Ref<HTMLDivElement>;
  dpr?: number;
  /** the caption is shown; it fades otherwise */
  captionShown?: boolean;
  onExit: () => void;
  onOpenSession: (threadId: string, host: string) => void;
  onTookOver?: () => void;
  /** a still in the canvas's place, for a fixture */
  picture?: ReactNode;
}

/** The screen's body, pure: what it draws for a tile, a stream and a room. */
export function FullWindowView({ tile, stream, room, name, kind, boxRef, measureRef, dpr = 1, captionShown = true, onExit, onOpenSession, onTookOver, picture }: FullWindowViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  const frame = streamSize(state);
  const fit = fitStage(room, frame, dpr, kind ?? pictureKind(tile?.computer ?? ""));
  const aspect = frame ? `${frame.width} / ${frame.height}` : "16 / 10";
  const pixelated = drawnPixelated(fit.width, frame, dpr);
  const leave = (
    <ViewButton label="Leave full screen" onClick={onExit}>
      <Minimize2 className="size-4" />
    </ViewButton>
  );
  return (
    <div className="relative flex size-full items-center justify-center">
      <div ref={measureRef} data-slot="full-window-picture" className="origin-top-left" style={{ width: fit.width }}>
        {tile && !over ? (
          <div
            ref={boxRef}
            {...(face.driving ? DRIVEN : { role: "img" })}
            aria-label={name}
            data-face="live"
            data-pixelated={pixelated || undefined}
            className={cn("relative overflow-hidden [&_canvas]:rounded-none [&_canvas]:outline-0 [&_img]:rounded-none [&_img]:outline-0", pixelated && PIXELATED, face.driving && DRIVEN_CLASS)}
            style={{ aspectRatio: aspect }}
          >
            {face.drawn ? null : <Skeleton className="absolute inset-0 rounded-none" />}
            {picture ?? face.picture}
            <div className="pointer-events-none absolute inset-0">{face.mark}</div>
          </div>
        ) : (
          <div data-face="none" className="flex items-center justify-center bg-card px-3 text-center" style={{ aspectRatio: aspect }}>
            <ViewportLine
              words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
              onRetry={tile && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? stream.retry : undefined}
            />
          </div>
        )}
      </div>
      {/* over the top edge, on its own ground: no words read on matte */}
      <div
        data-slot="full-window-caption"
        data-shown={captionShown || undefined}
        className={cn("absolute inset-x-0 top-0 bg-background px-4 py-2 transition-opacity duration-(--dur-base) ease-(--ease-out) has-focus-visible:opacity-100", !captionShown && "opacity-0")}
      >
        {tile ? (
          <ComputerCaption tile={tile} onOpenSession={onOpenSession} where={tile.where} onTookOver={onTookOver} views={leave} />
        ) : (
          <div className="flex min-h-9 items-center justify-end">{leave}</div>
        )}
      </div>
    </div>
  );
}

/** A motion token as the page has it: a curve, or a time in ms. */
function token(el: HTMLElement, name: string): string {
  return el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue(name).trim() ?? "";
}
const ms = (value: string, fallback: number): number => (/^\d+(\.\d+)?ms$/.test(value) ? parseFloat(value) : fallback);

/**
 * The pressed picture's entry: grown by `transform` from where it was on his screen to where full screen puts it, over
 * `--dur-slow` on `--ease-out`; with reduced motion a fade over `--dur-fast`. Shown at once where there are no Web
 * Animations (a test's document).
 */
export function growFrom(el: HTMLElement, from: ScreenRect): void {
  el.style.opacity = "";
  if (typeof el.animate !== "function") return;
  const easing = token(el, "--ease-out") || undefined;
  if (reducedMotion()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(token(el, "--dur-fast"), DUR.fast * 1000), easing });
    return;
  }
  const to = el.getBoundingClientRect();
  if (to.width <= 0 || to.height <= 0) return;
  const view = el.ownerDocument.defaultView;
  const x = from.x - (view?.screenX ?? 0) - to.left;
  const y = from.y - (view?.screenY ?? 0) - to.top;
  const start = `translate(${x}px, ${y}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  el.animate([{ transform: start }, { transform: "none" }], { duration: ms(token(el, "--dur-slow"), DUR.slow * 1000), easing });
}

/** Runs `then` once the window covers the display (main makes it so a beat after it answers), else after FILL_WAIT_MS. */
function whenFilled(then: () => void): () => void {
  const filled = (): boolean => window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height;
  let frame = 0;
  // two frames: the page lays out at its new size in the first
  const run = (): void => void (frame = requestAnimationFrame(() => (frame = requestAnimationFrame(then))));
  const timer = setTimeout(done, filled() ? 0 : FILL_WAIT_MS);
  function onResize(): void {
    if (filled()) done();
  }
  function done(): void {
    clearTimeout(timer);
    window.removeEventListener("resize", onResize);
    run();
  }
  window.addEventListener("resize", onResize);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("resize", onResize);
    cancelAnimationFrame(frame);
  };
}

/**
 * The window full screen while full screen is open, and back as it closes, unless it was full before (his own full
 * screen stays his). A window that leaves full screen some other way closes it. A pressed picture is held unseen until
 * the window fills the display, then grows from `from`.
 */
function useWindowFullScreen(open: boolean, from: ScreenRect | undefined, picture: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    let live = true;
    let entered = false;
    let stopWait = (): void => undefined;
    const el = picture.current;
    if (from && el) el.style.opacity = "0";
    const unlisten = onWindowFullScreen(({ on, popOut }) => {
      if (popOut) return;
      if (on) entered = true;
      else if (entered) closeFullWindow();
    });
    const was = setWindowFullScreen({ on: true });
    void was.then(() => {
      if (!live) return;
      entered = true;
      if (!from || !el) return;
      stopWait = whenFilled(() => growFrom(el, from));
    });
    return () => {
      live = false;
      stopWait();
      unlisten();
      if (el) el.style.opacity = "";
      void was.then((full) => {
        if (!full) void setWindowFullScreen({ on: false });
      });
    };
    // the entry's place is read once, as it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** The window's size, live. */
function useWindowSize(): Size {
  const read = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = (): void => setSize(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/** The caption shows while the pointer moves, and for CAPTION_REST_MS after. */
function useCaptionShown(): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    let timer = setTimeout(() => setShown(false), CAPTION_REST_MS);
    const moved = (): void => {
      setShown(true);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), CAPTION_REST_MS);
    };
    window.addEventListener("pointermove", moved);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", moved);
    };
  }, []);
  return shown;
}

/** Escape leaves, unless the picture he drives holds the keyboard (there Escape is the page's) or a popup took it. */
function useLeaveOnEscape(leave: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("[data-driving], [role=menu], [data-slot=popover-content]")) return;
      event.preventDefault();
      event.stopPropagation();
      leave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leave]);
}

/** Full screen, live, over the whole app while one is open (lib/fullWindow.ts). */
export function FullWindow({ onOpenSession }: { onOpenSession: (threadId: string, host: string) => void }) {
  const target = useFullWindow();
  const tile = useComputer(target?.host ?? "", target?.threadId ?? "");
  const room = useWindowSize();
  const captionShown = useCaptionShown();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusOnDrive = useRef(false);
  const stream = useLiveStream(target ? (tile?.entry ?? null) : null, !!target, box as RefObject<HTMLElement | null>, measure, { room });
  // its Hand back wears the leave chord: no toast says it again
  useDrivingInput(stream, box as RefObject<HTMLElement | null>, drivenScreen(tile?.computer ?? ""), { chordShown: true });
  useDriveHold(tile ? `${tile.entry.host}\n${driveName(tile)}` : null, !!tile?.driving, () => (tile ? handBack(tile) : Promise.resolve()));
  useLeaveOnEscape(closeFullWindow);
  useWindowFullScreen(!!target, target?.from, measure);
  useEffect(() => {
    if (!stream.drive || !focusOnDrive.current) return;
    focusOnDrive.current = false;
    box.current?.focus();
  }, [stream.drive]);
  // a double click on a picture he does not drive leaves, as the stage's single click came in
  useEffect(() => {
    const el = box.current;
    if (!el || stream.drive) return;
    el.addEventListener("dblclick", closeFullWindow);
    return () => el.removeEventListener("dblclick", closeFullWindow);
  });
  if (!target) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={target.name} data-full-window className="fixed inset-0 z-(--layer-dialog) bg-matte text-foreground">
      <FullWindowView
        tile={tile}
        stream={stream}
        room={room}
        name={target.name}
        kind={pictureKind(tile?.computer ?? target.threadId)}
        boxRef={box}
        measureRef={measure}
        dpr={pixelRatioOf(measure.current)}
        captionShown={captionShown}
        onExit={closeFullWindow}
        onOpenSession={(threadId, host) => {
          closeFullWindow();
          onOpenSession(threadId, host);
        }}
        onTookOver={() => void (focusOnDrive.current = true)}
      />
    </div>
  );
}
