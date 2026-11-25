import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import type { ComputerPreviewEndReason, HistoryPictureNone } from "@server/shared/contract-computer";
import { Button } from "@renderer/components/ui/button";
import { CONSOLE } from "@renderer/components/ui/console";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Spinner } from "@renderer/components/ui/spinner";
import { FADE_IN } from "@renderer/components/ui/reveal";
import { cn } from "@renderer/lib/cn";
import { CLICK_MARK } from "../../../lib/ease";
import { useComputerPreview, type PreviewState } from "../../../lib/computerPreview";
import { loadToast } from "@renderer/components/ui/toaster";
import type { Room } from "@server/shared/video/guestSize";
import type { CursorShape } from "@server/shared/video/nsl1";
import type { StreamReading } from "../../../lib/video/messages";
import type { BarReading } from "./ComputerBar";
import { CursorImages } from "../../../lib/video/cursor";
import { useComputerVideo, type GuestSizeSetting, type VideoDrive } from "../../../lib/computerVideo";
import { IS_MAC } from "../../../lib/platform";
import { keyHint } from "../../../lib/keys";
import { LEAVE_CHORD, VideoInput, attachInput, type DrivenScreen } from "../../../lib/video/videoInput";
import { attachKeyboardHold } from "../../../lib/video/keyboardHold";
import { pixelRatioOf, sharpWidth } from "../../../lib/video/support";
import type { ComputerEntry } from "../../../lib/computerSessions";
import { reducedMotion } from "../../../lib/motion";

/**
 * The Computer section's viewport (docs/DESIGN.md "Panels"): the window as
 * it is or as it was, in one box at the pane's width less its insets, in the
 * picture's shape and at most `min(400px, 45cqh)` of the section's height. It
 * has four faces and never two at once: the live stream on a canvas (video
 * where the host has it, else the 4 fps picture) with the agent's click
 * ringed for a moment; a kept picture, which opens the
 * lightbox; the text the model read, where there is no picture; a skeleton
 * in the picture's shape while the first one is on its way. One 12px line
 * sits under it only when it has something to say. Nothing in it moves but
 * the click's ring: a frame, or a kept picture, replaces the last with no
 * transition.
 */

/** The box's tallest, in pixels; the section's height caps it sooner (`VIEWPORT_MAX`). */
export const VIEWPORT_MAX_HEIGHT = 400;
/** The cap as CSS: the section's body is a size container, so a short panel keeps its list. */
export const VIEWPORT_MAX = `min(${VIEWPORT_MAX_HEIGHT}px, 45cqh)`;
/** The section's 12px insets either side of the box. */
export const VIEWPORT_INSETS = 24;
/** The shape until a picture says its own. */
const DEFAULT_SIZE = { width: 16, height: 10 };

/** Why the live preview ended, as the line under the box says it. */
export const ENDED_WORDS: Record<ComputerPreviewEndReason, string> = {
  closed: "The preview stopped",
  "window-closed": "The window closed",
  minimized: "The window is minimized",
  permission: "Turn on Screen Recording for TempCode in System Settings",
  restarted: "The preview stopped",
  error: "The preview stopped",
};
/**
 * The ends the person can retry; the rest name what to do instead. A minimized window is one: the host starts the
 * stream again when the service says the window was restored, and Retry is there for a restore it did not hear.
 */
export const RETRY_ENDS: ReadonlySet<ComputerPreviewEndReason> = new Set(["restarted", "error", "minimized"]);

/** Why a step kept no picture, where that is worth a line: nothing for a switch that was off, a call with no read, or a capture that failed. */
export const NO_PICTURE_WORDS: Partial<Record<HistoryPictureNone, string>> = {
  permission: "Screen Recording was off",
  minimized: "The window was minimized",
  "not-drawn": "The window was not drawn",
  gone: "This picture is no longer kept",
};

const prefersReducedMotion = reducedMotion;

/** The ring the agent's click draws: a background halo under a foreground ring, so it reads on any window. */
export const ClickMark = forwardRef(function ClickMark({ at, frozen }: { at?: [number, number]; frozen?: boolean }, ref: Ref<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-slot="click-mark-at"
      className="pointer-events-none absolute size-0"
      style={at ? { left: `${at[0] * 100}%`, top: `${at[1] * 100}%` } : undefined}
    >
      <div ref={ref} className={cn("absolute -top-2.5 -left-2.5 size-5", frozen ? "scale-90" : "opacity-0")} data-slot="click-mark">
        <svg viewBox="0 0 20 20" className="size-5" fill="none">
          <circle cx="10" cy="10" r="8.5" className="stroke-background stroke-[3]" />
          <circle cx="10" cy="10" r="8.5" className="stroke-foreground stroke-[1.5]" />
        </svg>
      </div>
    </div>
  );
});

/** The line under the box: muted, wrapping rather than losing its end, with Retry where retrying can help. */
export function ViewportLine({ words, onRetry }: { words: string; onRetry?: () => void }) {
  return (
    <span data-slot="computer-line" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-4 text-muted-foreground">
      <span className="min-w-0">{words}</span>
      {onRetry ? (
        <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/** What a picture's plate says: its words, a spinner while it waits, its one press, over the last picture or the bare box. */
export interface PlateProps {
  title: string;
  /** one muted line under it: "Since 1:14 PM", "6 s of about 13", "Try 2 of 5" */
  detail?: string | null;
  spin?: boolean;
  action?: ReactNode;
  /** the last picture, washed back under the words; none: the bare box */
  still?: string | null;
  /** the lighter wash, for a picture about to come (connecting) */
  light?: boolean;
  /** the live picture is on the canvas: the plate fades out over it */
  gone?: boolean;
}

/**
 * What a picture says of itself while it has nothing live to show (docs/DESIGN.md "Computers", "The faces"): one
 * plate of words, centred, over the last picture washed back, or over the bare box where there is none. Only its
 * words are a status for a screen reader: a counting detail is not read out each second.
 */
export function Plate({ title, detail, spin = false, action, still, light = false, gone = false }: PlateProps) {
  return (
    <div data-slot="computer-plate" data-gone={gone || undefined} className={cn("absolute inset-0 transition-opacity duration-(--dur-base) ease-(--ease-out)", gone && "pointer-events-none opacity-0")}>
      {still ? (
        <>
          <img src={still} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
          <div data-slot="computer-wash" className={cn("absolute inset-0", light ? "bg-background/55" : "bg-background/80")} />
        </>
      ) : null}
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className="flex max-w-80 flex-col items-center gap-3 text-center">
          {spin ? <Spinner aria-hidden className="size-4 text-muted-foreground" /> : null}
          <div className="flex flex-col items-center gap-1">
            <span role="status" className="text-[13px] leading-5 font-medium">
              {title}
            </span>
            {detail ? <span className="text-xs leading-4 text-muted-foreground tabular-nums">{detail}</span> : null}
          </div>
          {action}
        </div>
      </div>
    </div>
  );
}

/** The class a picture's surface takes: the box's size, the image outline, hidden until it has something to show. */
export const pictureClass = (drawn: boolean): string =>
  cn("block size-full rounded-lg outline outline-1 -outline-offset-1 outline-image-outline", !drawn && "invisible");

/** A picture drawn at a whole number of screen pixels to each of the stream's, two or more: each pixel crisp, as a plain display shows it (lib/stageLayout.ts `drawnPixelated`). */
export const PIXELATED = "[&_canvas]:[image-rendering:pixelated] [&_img]:[image-rendering:pixelated]";

export type ViewportFace =
  /**
   * the live stream: `picture` is the canvas (a still in a fixture); a click opens the full view from the box.
   * `driving`: he drives the page from this picture, so the box takes the keyboard and his pointer, and opens nothing.
   */
  | { kind: "live"; picture: ReactNode; drawn: boolean; mark?: ReactNode; onOpen?: (from: DOMRect) => void; driving?: boolean; cover?: ReactNode }
  /** a kept picture; `dim` while the next one is on its way; a click opens the lightbox from the box */
  | { kind: "picture"; src: string; dim?: boolean; onOpen?: (from: DOMRect) => void }
  /** what the model read, where there is no picture */
  | { kind: "text"; text: string }
  /** the first picture is on its way */
  | { kind: "skeleton" }
  /** a pinned step that kept nothing: the box keeps its place, with the line inside it */
  | { kind: "none" }
  /** nothing live to show (asleep, waking, lost, not set up): one plate of words over the last picture */
  | { kind: "plate"; plate: PlateProps };

export interface ViewportProps {
  /** null: the line alone (nothing will come into a box) */
  face: ViewportFace | null;
  /** what the box shows, as its accessible name: "Live view of Untitled in TextEdit", "Untitled in TextEdit at 2:04 PM" */
  label: string;
  /** the picture's shape; 16:10 until one says its own */
  size?: { width: number; height: number } | null;
  /** the widest the box is drawn, in CSS pixels: a live picture's own pixels, so it is never stretched (`sharpOf`) */
  sharp?: number | null;
  /** one line, only when it has something to say */
  line?: ReactNode;
  /** while a row is pinned: the height the box had when the pin began, so a picture of another shape sits inside it */
  height?: number | null;
  /** the live face's counts as rendered; the stream then writes them by hand */
  frames?: number;
  marks?: number;
  /** the place sizes the box (the Computers page's stage and strip): no cap on its height or width, its shape alone */
  fill?: boolean;
}

/**
 * The box, pure. Its height is the picture's by CSS alone (the shape as an
 * aspect ratio under the cap), so a static render has the right size; pinned,
 * it keeps the height it is given and centres a picture of another shape.
 */
export const Viewport = forwardRef(function Viewport({ face, label, size, sharp, line, height, frames = 0, marks = 0, fill }: ViewportProps, ref: Ref<HTMLElement>) {
  const { width, height: tall } = size && size.width > 0 && size.height > 0 ? size : DEFAULT_SIZE;
  const aspect = `${width} / ${tall}`;
  const cap = sharp && sharp > 0 && !height ? { maxWidth: sharp } : null;
  const boxStyle = fill ? { aspectRatio: aspect } : height ? { height, maxHeight: VIEWPORT_MAX } : { aspectRatio: aspect, maxHeight: VIEWPORT_MAX, ...cap };
  // In its own shape the picture fills the box's height. In a kept height it is as wide as that height allows and no
  // wider than the box, so a picture of any shape sits whole inside it, centred both ways.
  const fit = height ? { aspectRatio: aspect, width: `min(100%, ${Math.round((height * width) / tall)}px)` } : { aspectRatio: aspect };
  const boxClass = cn("relative flex w-full justify-center overflow-hidden rounded-lg bg-card", height && "items-center");
  // The fade is the section's first picture arriving: it rides the wrapper, which stays through every change of face,
  // so a pin, Go live and a step by key swap one face for another with nothing moving.
  const wrap = { "data-slot": "computer-viewport", className: FADE_IN } as const;
  const below = line ? <div className={face ? "pt-1" : undefined}>{line}</div> : null;
  if (!face) return below ? <div {...wrap}>{below}</div> : null;
  if (face.kind === "none") {
    return (
      <div {...wrap}>
        <div ref={ref as Ref<HTMLDivElement>} data-face="none" className={cn(boxClass, "items-center px-3 text-center")} style={boxStyle}>
          {line}
        </div>
      </div>
    );
  }
  if (face.kind === "plate") {
    return (
      <div {...wrap}>
        <div ref={ref as Ref<HTMLDivElement>} role="group" aria-label={label} data-face="plate" className={boxClass} style={boxStyle}>
          <Plate {...face.plate} />
        </div>
      </div>
    );
  }
  if (face.kind === "text") {
    return (
      <div {...wrap}>
        <pre
          ref={ref as Ref<HTMLPreElement>}
          tabIndex={0}
          aria-label={label}
          data-face="text"
          className={cn(CONSOLE, "m-0 w-full overflow-x-auto overflow-y-auto whitespace-pre")}
          style={boxStyle}
        >
          {face.text}
        </pre>
        {below}
      </div>
    );
  }
  // Until a picture is there the skeleton is the whole box, never a box inside the box; a cover (the last picture under
  // its plate) stands in its place.
  const cover = face.kind === "live" ? face.cover : undefined;
  const waiting = face.kind === "skeleton" || (face.kind === "live" && !face.drawn && !cover);
  const picture = (
    <div data-slot="computer-picture" className={cn(height ? "max-h-full" : "h-full max-w-full", !waiting && "relative")} style={fit}>
      {waiting ? <Skeleton className="absolute inset-0 rounded-lg" /> : null}
      {face.kind === "live" ? face.picture : null}
      {face.kind === "picture" ? (
        <img
          src={face.src}
          alt=""
          draggable={false}
          data-dim={face.dim || undefined}
          // The old picture dims while the next is on its way; nothing else about a picture moves.
          className={cn(pictureClass(true), "object-contain transition-opacity duration-(--dur-fast) ease-(--ease-out) motion-reduce:transition-opacity", face.dim && "opacity-40")}
        />
      ) : null}
      {face.kind === "live" ? <div className="pointer-events-none absolute inset-0">{face.mark}</div> : null}
      {cover}
    </div>
  );
  // One element for the box in every mode (watched, opening, driven): a mode only changes its attributes, so the canvas
  // that took a frame stays through the first frame, Take over and Hand back (a still page sends one frame, then waits).
  const driving = face.kind === "live" && !!face.driving;
  const open = !driving && (face.kind === "picture" || face.kind === "live") ? face.onOpen : undefined;
  // The full view opens from a clear button laid over the picture, off until a frame is there to open; while it is
  // there it carries the box's name, since an image's own children are hidden from assistive tech.
  const closed = face.kind === "live" && !face.drawn;
  const role = driving ? DRIVEN : open ? {} : { role: "img" as const };
  return (
    <div {...wrap}>
      <div
        ref={ref as Ref<HTMLDivElement>}
        {...role}
        aria-label={open ? undefined : label}
        data-face={face.kind}
        {...(face.kind === "live" ? { "data-frames": frames, "data-marks": marks } : {})}
        className={cn(boxClass, driving && DRIVEN_CLASS)}
        style={boxStyle}
      >
        {picture}
        {open ? (
          <Button
            variant="link"
            aria-label={label}
            data-viewport-open
            disabled={closed}
            onClick={(e) => open(e.currentTarget.getBoundingClientRect())}
            className={OPEN_OVER}
          />
        ) : null}
      </div>
      {below}
    </div>
  );
});

/** The clear button laid over a picture that opens the full view: the picture's whole face, with nothing of its own to draw but the focus ring. */
export const OPEN_OVER = "absolute inset-0 h-auto cursor-zoom-in rounded-lg p-0";

/**
 * What the box of a picture he drives carries: it takes the keyboard, and a focus ring marks it for as long as it
 * holds it, however it took it (a click too). A click outside lets go, and so does Ctrl+Alt: Tab and Escape are the
 * page's here, so the chord is the keyboard's way out, said to a screen reader on the box itself.
 */
export const DRIVEN = { role: "application", tabIndex: 0, "data-driving": "", "aria-description": `Press ${IS_MAC ? "Control and Option" : "Control and Alt"} together to leave the page` } as const;
export const DRIVEN_CLASS = "focus-ring-held cursor-default touch-none select-none";

/** Where the keyboard goes when he leaves the picture by the chord: the Hand back nearest it, else nowhere in particular. */
function leavePicture(el: HTMLElement): void {
  for (let up = el.parentElement; up; up = up.parentElement) {
    const back = up.querySelector<HTMLElement>("[data-hand-back]:not(:disabled)");
    if (back) return back.focus();
  }
  el.blur();
}

/** The leave chord's toast takes no pointer: a press goes through it, and a resting pointer does not hold it open. */
export const LEAVE_TOAST_CLASS = "pointer-events-none";

/** The chord is said once a launch, in a toast, the first time a picture becomes his to drive. */
let leaveSaid = false;
export function forgetLeaveSaid(): void {
  leaveSaid = false;
}

/** The live stream for the viewport: its state, the canvas and the ring to draw into the live face, and Retry for one that stopped. */
export interface LiveStream {
  state: PreviewState;
  retry: () => void;
  canvas: RefObject<HTMLCanvasElement | null>;
  ring: RefObject<HTMLDivElement | null>;
  /** what draws on the canvas: the video's worker, or the 4 fps picture. Each has a canvas of its own, since one handed to the worker takes no other drawing. */
  mode: "video" | "picture";
  /** his way into the page, while he drives it from this place and its video is live; null otherwise */
  drive: VideoDrive | null;
  reading?: BarReading | null;
}

/** How long after a copy chord the far clipboard is read: the app there takes the chord, then fills it. */
export const COPY_SETTLE_MS = 300;

/**
 * While he drives from this place, the box is his keyboard and pointer in
 * the page (docs/agents/live-video.md "Driving"): its events go down the
 * stream as input records, a paste goes to the host as text, and everything
 * he holds is let go when the box loses the keyboard. Ctrl+Alt alone takes
 * the keyboard out of it, to Hand back. `chordShown`: the place's Hand back
 * wears that chord as a key cap (the Computers stage, the full window), so no
 * toast says it again; elsewhere one toast says it once a launch, taking no
 * pointer, so it never sits over a control nor waits for the pointer to go.
 */
export function useDrivingInput(
  stream: LiveStream,
  box: RefObject<HTMLElement | null>,
  screen: DrivenScreen = "browser",
  { chordShown = false, fullScreen = false }: { chordShown?: boolean; /** the picture is full screen: main holds the keyboard while it does (lib/video/keyboardHold.ts) */ fullScreen?: boolean } = {},
): boolean {
  const drive = stream.drive;
  useEffect(() => {
    const el = box.current;
    if (!drive || !el) return;
    const paste = (): void =>
      void navigator.clipboard
        .readText()
        .then((text) => (text ? drive.paste(text) : undefined))
        .catch(() => loadToast().then((toast) => toast.error("Couldn't paste into the page")));
    // a copy in the Windows VM lands on its clipboard, not his: once the app there has taken the chord, its text is his
    let copies = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const copied = (): void => {
      const mine = ++copies;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void drive
          .copy()
          .then((text) => (text && mine === copies ? navigator.clipboard.writeText(text) : undefined))
          .catch(() => loadToast().then((toast) => toast.error("Couldn't copy from the page")));
      }, COPY_SETTLE_MS);
    };
    if (!leaveSaid && !chordShown) {
      leaveSaid = true;
      void loadToast().then((toast) => toast(`Press ${keyHint(LEAVE_CHORD)} to leave the page`, { className: LEAVE_TOAST_CLASS }));
    }
    const input = new VideoInput(drive.send, { mac: IS_MAC, paste, leave: () => leavePicture(el), screen, copied });
    const detach = attachInput(el, input);
    const unhold = fullScreen ? attachKeyboardHold(el, input, () => leavePicture(el)) : undefined;
    return () => {
      if (timer) clearTimeout(timer);
      unhold?.();
      detach();
    };
  }, [box, chordShown, drive, fullScreen, screen]);
  return drive !== null;
}

/** The native cursor follows the actual canvas size, including pop-outs on a different display. */
function usePictureCursor(canvas: RefObject<HTMLCanvasElement | null>, shape: CursorShape | null, frameWidth: number | undefined): void {
  const images = useRef<CursorImages | null>(null);
  useLayoutEffect(() => () => {
    images.current?.close();
    images.current = null;
  }, []);
  useLayoutEffect(() => {
    const el = canvas.current;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    if (!shape || !frameWidth) {
      el.style.cursor = "";
      return;
    }
    const cache = (images.current ??= new CursorImages(el.ownerDocument));
    let request = 0;
    let resolution: MediaQueryList | undefined;
    const update = () => {
      const current = ++request;
      const dpr = pixelRatioOf(el);
      resolution?.removeEventListener?.("change", update);
      resolution = view.matchMedia?.(`(resolution: ${dpr}dppx)`);
      resolution?.addEventListener?.("change", update);
      const width = Number.parseFloat(view.getComputedStyle(el).width) || el.clientWidth;
      void cache.css(shape, width / frameWidth, dpr).then(
        (cursor) => { if (request === current) el.style.cursor = cursor; },
        () => { if (request === current) el.style.cursor = ""; },
      );
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(el);
    update();
    return () => {
      request++;
      resize?.disconnect();
      resolution?.removeEventListener?.("change", update);
    };
  }, [canvas, frameWidth, shape]);
}

/** Estimate the relay-to-viewer leg as half the stream socket's round trip. */
export function barReading(timing: StreamReading, picture: { width: number; height: number } | null): BarReading {
  const { roundTripMs, captureMs, drawMs, fps, link } = timing;
  const delayMs = roundTripMs === undefined || drawMs === undefined ? undefined : (captureMs ?? 0) + roundTripMs / 2 + drawMs;
  return { delayMs, fps, link, picture: picture ?? undefined };
}

/**
 * The stream of `entry`'s window while `run` holds (the section shown, the
 * document visible, the section following). It is video first
 * (docs/agents/live-video.md), and the 4 fps picture when video gives way.
 * The box's width decides the edge it asks for. A click moves the ring to
 * its share of the picture and plays it; the frame and click counts go to
 * the box's `data-frames`, `data-fps` and `data-marks` by hand, so none
 * re-renders anything. `take` is false for a place that is not the thread
 * on screen: it does not take the box's one display from another page.
 */
export function useLiveStream(
  entry: ComputerEntry | null,
  run: boolean,
  box: RefObject<HTMLElement | null>,
  measure: RefObject<HTMLElement | null>,
  {
    take = true,
    drive = true,
    inset = 0,
    room,
    guestSize,
    read = false,
  }: {
    take?: boolean;
    /** false for a place that only shows it: a tile */
    drive?: boolean;
    /** what the measured element holds around the picture, in CSS pixels (the right panel's section, VIEWPORT_INSETS) */
    inset?: number;
    room?: Room;
    guestSize?: GuestSizeSetting;
    read?: boolean;
  } = {},
): LiveStream {
  const pictureCanvas = useRef<HTMLCanvasElement>(null);
  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const [timing, setTiming] = useState<StreamReading | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const marks = useRef(0);

  // The measured element is the section's own, which never unmounts while it is shown, so Retry finds the width it had.
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const inner = (w: number): number => Math.max(0, Math.round(w) - inset);
    setBoxWidth(inner(el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setBoxWidth(inner(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [inset, measure]);

  const onClick = useCallback(
    (x: number, y: number) => {
      const el = ring.current;
      const at = el?.parentElement;
      if (!at || !el) return;
      at.style.left = `${Math.min(1, Math.max(0, x)) * 100}%`;
      at.style.top = `${Math.min(1, Math.max(0, y)) * 100}%`;
      el.getAnimations?.().forEach((a) => a.cancel());
      el.animate?.(prefersReducedMotion() ? CLICK_MARK.reduced : CLICK_MARK.keyframes, CLICK_MARK.timing);
      marks.current += 1;
      if (box.current) box.current.dataset.marks = String(marks.current);
    },
    [box],
  );

  const on = run && !!entry && boxWidth > 0;
  // he drives the page of a row kept for him: its stream is the one his input goes down
  const video = useComputerVideo(entry ?? NO_ENTRY, { run: on, boxWidth, canvas: videoCanvas, box, onClick, take, drive: drive && entry?.row.driver === "owner", room, guestSize, onReading: read ? setTiming : undefined });
  const picture = useComputerPreview(entry ?? NO_ENTRY, { run: on && video.gaveWay, boxWidth, canvas: pictureCanvas, box, onClick });
  const frame = streamSize(video.state);
  usePictureCursor(videoCanvas, video.drive && !video.gaveWay ? video.cursor : null, frame?.width);
  const width = frame?.width;
  const height = frame?.height;
  const reading = useMemo(
    () => read && on && !video.gaveWay && timing && video.state.status === "live" ? barReading(timing, width && height ? { width, height } : null) : null,
    [read, on, timing, video.state.status, video.gaveWay, width, height],
  );
  if (video.gaveWay) return { state: picture.state, retry: picture.retry, canvas: pictureCanvas, ring, mode: "picture", drive: null };
  return { state: video.state, retry: video.retry, canvas: videoCanvas, ring, mode: "video", drive: video.drive, reading };
}

/** The live face from a stream: its canvas, hidden until the first frame, and the ring a click plays. */
export function liveFace(stream: LiveStream, onOpen?: (from: DOMRect) => void): Extract<ViewportFace, { kind: "live" }> {
  const drawn = stream.state.status === "live" && stream.state.drawn;
  // keyed by what draws on it: when video gives way to the picture, the picture gets a canvas nothing was handed off
  const picture = <canvas key={stream.mode} ref={stream.canvas} aria-hidden="true" className={pictureClass(drawn)} />;
  // while he drives from here the picture is his way into the page, and a click on it is the page's; otherwise the box
  // that opens the full view is the same element before and after the first frame (Viewport turns it on once `drawn`),
  // so the canvas that took the frame stays
  if (stream.drive) return { kind: "live", drawn, picture, mark: <ClickMark ref={stream.ring} />, driving: true };
  return { kind: "live", drawn, picture, mark: <ClickMark ref={stream.ring} />, ...(onOpen ? { onOpen } : {}) };
}

/**
 * The widest a stream's box is drawn. Video is the window's own pixels, so it is drawn at them on this screen and
 * never stretched. The 4 fps picture is a copy the host scaled down to at most 960 on its long edge: its pixels say
 * nothing of the window's size, and held to them on a 2× screen it was half the width video has. It is drawn up to
 * its width in CSS pixels, which is what a 1× screen shows. Null before a frame's size is known.
 */
export function sharpOf(stream: Pick<LiveStream, "state" | "mode">): number | null {
  const size = streamSize(stream.state);
  if (!size || typeof window === "undefined") return null;
  return stream.mode === "picture" ? size.width : sharpWidth(size.width, window.devicePixelRatio || 1);
}

/** The stream's shape while it starts or runs; null before it is known. */
export function streamSize(state: PreviewState): { width: number; height: number } | null {
  if (state.status !== "live" && state.status !== "starting") return null;
  return state.width && state.height ? { width: state.width, height: state.height } : null;
}

/** A stand-in while no session is live: nothing to preview, so the stream never starts. */
const NO_ENTRY: ComputerEntry = { host: "", row: { threadId: "", since: 0, lastCallAt: 0, apps: [], running: null, tier: null }, previewable: false };
