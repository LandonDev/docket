import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Bone } from "@renderer/components/bones";
import { cn } from "@renderer/lib/cn";
import { Minimize2, PictureInPicture } from "../../../chrome/icons";
import { driveName, handBack, useComputer, type ComputerTile } from "../../../lib/computers";
import { useDriveHold } from "../../../lib/driveHold";
import { DUR } from "../../../lib/ease";
import { closeFullWindow, useFullWindow, type ScreenRect } from "../../../lib/fullWindow";
import { reducedMotion } from "../../../lib/motion";
import { onWindowFullScreen, setWindowFullScreen } from "../../../lib/native";
import { drawnPixelated, fitStage, pictureKind, type PictureKind, type Size } from "../../../lib/stageLayout";
import { pixelRatioOf } from "../../../lib/video/support";
import { ComputerBar, ViewButton, type BarReading } from "./ComputerBar";
import { FullScreenHint } from "./FullScreenHint";
import { openPopOut } from "../../../lib/popOut";
import { useVmStates, vmPlate, type VmState } from "../../../lib/winvmWake";
import { useVmStill } from "../../../work/winvm/vmPresses";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, PIXELATED, Plate, RETRY_ENDS, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type LiveStream } from "./Viewport";
import { drivenScreen } from "../../../lib/video/videoInput";

/**
 * Full screen (docs/DESIGN.md "Computers", "Full screen"): one computer over
 * his whole display. The window itself goes full screen (main's
 * fullScreen.ts) and the picture fills it on `matte`, in its own shape, with
 * no inset: a whole computer's screen as large as the display allows, a
 * window's picture to twice its own pixels (`fitStage`). The computer's bar
 * floats over the top edge's middle, hidden until called: the pointer resting
 * 250 ms on the edge's middle 240px, or ⌃⌥; it goes 600 ms after the pointer
 * leaves it, never while one of its menus is open, and comes by itself once
 * when the link turns poor. ⌃⌘F leaves; Escape leaves when the picture does
 * not hold the keyboard; a double click on the picture leaves when he does
 * not drive. While he drives the picture holds the keyboard with main
 * (lib/video/keyboardHold.ts), and the two ways out are said on entry
 * (FullScreenHint). A press grows the picture from where it was; a key's
 * entry has no motion. It is another canvas on the stream the page already
 * plays.
 */

/** The pointer rests this long on the top edge's middle before the bar comes. */
export const BAR_REST_MS = 250;
/** The bar goes this long after the pointer leaves it. */
export const BAR_LEAVE_MS = 600;
/** Called by a poor link, the bar stays this long for him to see it. */
export const BAR_POOR_MS = 3000;
/** The top edge's middle that calls the bar: 240px wide, 8px tall. */
export const EDGE = { width: 240, height: 8 };
export const inEdge = (x: number, y: number, width: number): boolean => y <= EDGE.height && Math.abs(x - width / 2) <= EDGE.width / 2;

/** The bar afloat: the popover's ground, 8px under the edge, as wide as 560px allows. In by opacity and 8px down; out faster. */
const FLOAT =
  "absolute top-2 left-1/2 z-10 w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-xl bg-popover text-popover-foreground shadow-overlay ring-1 ring-border transition-[opacity,translate] duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-opacity";
const AWAY = "pointer-events-none -translate-y-2 opacity-0 duration-(--dur-fast) ease-(--ease-exit)";

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
  /** the bar is called; it is away otherwise */
  barShown?: boolean;
  barRef?: Ref<HTMLDivElement>;
  /** a menu of the bar opened or closed: it stays while one is open */
  onMenuOpen?: (open: boolean) => void;
  /** the delay's numbers, as far as they are known */
  reading?: BarReading | null;
  /** in the picture's place where there is no computer: the Windows VM asleep under him */
  rest?: ReactNode;
  onPopOut?: () => void;
  onExit: () => void;
  onOpenSession: (threadId: string, host: string) => void;
  onTookOver?: () => void;
  /** a still in the canvas's place, for a fixture */
  picture?: ReactNode;
}

/** The screen's body, pure: what it draws for a tile, a stream and a room. */
export function FullWindowView({ tile, stream, room, name, kind, boxRef, measureRef, dpr = 1, barShown = true, barRef, onMenuOpen, reading, rest, onPopOut, onExit, onOpenSession, onTookOver, picture }: FullWindowViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  const frame = streamSize(state);
  const fit = fitStage(room, frame, dpr, kind ?? pictureKind(tile?.computer ?? ""));
  const aspect = frame ? `${frame.width} / ${frame.height}` : "16 / 10";
  const pixelated = drawnPixelated(fit.width, frame, dpr);
  const views = (
    <>
      {onPopOut && tile && !over ? (
        <ViewButton label="Pop out" fold onClick={onPopOut}>
          <PictureInPicture className="size-4" />
        </ViewButton>
      ) : null}
      <ViewButton label="Leave full screen" onClick={onExit}>
        <Minimize2 className="size-4" />
      </ViewButton>
    </>
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
            {face.drawn ? null : <Bone data-bones-on="matte" className="absolute inset-0 rounded-none" />}
            {picture ?? face.picture}
            <div className="pointer-events-none absolute inset-0">{face.mark}</div>
          </div>
        ) : !tile && rest ? (
          rest
        ) : (
          <div data-face="none" className="flex items-center justify-center bg-card px-3 text-center" style={{ aspectRatio: aspect }}>
            <ViewportLine
              words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
              onRetry={tile && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? stream.retry : undefined}
            />
          </div>
        )}
      </div>
      {/* the computer's bar afloat over the top edge's middle, on the popover's ground: no words read on matte */}
      <div ref={barRef} data-slot="full-window-bar" data-shown={barShown || undefined} aria-hidden={barShown ? undefined : true} className={cn(FLOAT, !barShown && AWAY)}>
        <ComputerBar tile={tile} name={name} onOpenSession={onOpenSession} where={tile?.where} onTookOver={onTookOver} reading={reading} views={views} onMenuOpen={onMenuOpen} fold={false} className="pe-1.5" />
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

/**
 * Whether the floating bar is called: the pointer resting BAR_REST_MS on the top edge's middle, ⌃⌥, or keyboard focus
 * in it; it goes BAR_LEAVE_MS after the pointer leaves it (and the edge), never while a menu of it is open or focus
 * is in it. A poor link calls it once, for BAR_POOR_MS.
 */
export function useFloatingBar(bar: RefObject<HTMLElement | null>, poor: boolean): { shown: boolean; onMenuOpen: (open: boolean) => void } {
  const [shown, setShown] = useState(false);
  const menus = useRef(0);
  const over = useRef(false);
  const live = useRef(false);
  live.current = shown;
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const away = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stay = (): boolean => menus.current > 0 || over.current || !!bar.current?.contains(document.activeElement);
  const clear = (t: typeof rest): void => {
    if (t.current) clearTimeout(t.current);
    t.current = null;
  };
  const goSoon = (ms = BAR_LEAVE_MS): void => {
    clear(away);
    away.current = setTimeout(() => {
      away.current = null;
      if (!stay()) setShown(false);
    }, ms);
  };
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      const r = bar.current?.getBoundingClientRect();
      const onBar = !!r && r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const edge = inEdge(e.clientX, e.clientY, window.innerWidth);
      over.current = onBar || (live.current && edge);
      if (over.current) clear(away);
      if (edge && !live.current) {
        clear(rest);
        rest.current = setTimeout(() => setShown(true), BAR_REST_MS);
      } else if (!edge) clear(rest);
      if (!over.current && live.current && !away.current) goSoon();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.altKey && (e.key === "Control" || e.key === "Alt")) {
        setShown(true);
        goSoon(BAR_POOR_MS);
      }
    };
    const focusIn = (): void => setShown(true);
    const focusOut = (): void => goSoon();
    window.addEventListener("pointermove", move);
    window.addEventListener("keydown", key, true);
    const el = bar.current;
    el?.addEventListener("focusin", focusIn);
    el?.addEventListener("focusout", focusOut);
    return () => {
      clear(rest);
      clear(away);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("keydown", key, true);
      el?.removeEventListener("focusin", focusIn);
      el?.removeEventListener("focusout", focusOut);
    };
    // the handlers read refs: bound once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar]);
  // a poor link calls it by itself, once each time it turns poor
  useEffect(() => {
    if (!poor) return;
    setShown(true);
    goSoon(BAR_POOR_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poor]);
  const onMenuOpen = (open: boolean): void => {
    menus.current = Math.max(0, menus.current + (open ? 1 : -1));
    if (!open) goSoon();
  };
  return { shown, onMenuOpen };
}

/**
 * The Windows VM gone to sleep under him in full screen: its stream ended, so the keyboard is his Mac's again, and the
 * picture's place shows the desk it slept on with its plate, as the page does. It wakes only by his press.
 */
function AsleepUnder({ host, vm, room }: { host: string; vm: VmState; room: Size }) {
  const words = vmPlate(vm, { wakes: false, now: Date.now() });
  const still = useVmStill(host, vm.state !== "none", vm.state === "asleep" ? vm.since : null);
  const frame = still ? { width: still.width, height: still.height } : { width: 16, height: 10 };
  const fit = fitStage(room, frame, 1, "screen");
  return (
    <div data-face="plate" className="relative overflow-hidden bg-card" style={{ width: fit.width, aspectRatio: `${frame.width} / ${frame.height}` }}>
      <Plate title={words.title} detail={words.detail} spin={words.spin} still={words.bare ? null : still?.src} />
    </div>
  );
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

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Full screen covers the app, so the keyboard stays in it: focus enters it as it opens (unless something in it holds
 * focus already), Tab and Shift+Tab go round its own controls, never to the app behind, and focus goes back to what
 * opened it as it closes. A driven picture keeps Tab for the computer (its input marks the key handled); a menu of the
 * bar is a popup of its own and keeps its keys.
 */
export function useFocusScope(root: RefObject<HTMLElement | null>, open: boolean): (event: KeyboardEvent) => void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [root, open]);
  return (event) => {
    const el = root.current;
    if (event.key !== "Tab" || event.defaultPrevented || !el) return;
    if (event.target instanceof Element && event.target.closest("[data-driving]")) return;
    const stops = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => !node.closest("[inert]"));
    const first = stops[0];
    const last = stops[stops.length - 1];
    const at = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey ? at === first || at === el : at === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
}

/** Full screen, live, over the whole app while one is open (lib/fullWindow.ts). */
export function FullWindow({ onOpenSession, reading = null }: { onOpenSession: (threadId: string, host: string) => void; reading?: BarReading | null }) {
  const target = useFullWindow();
  const tile = useComputer(target?.host ?? "", target?.threadId ?? "");
  const room = useWindowSize();
  const bar = useRef<HTMLDivElement>(null);
  const vm = (target?.threadId ?? "").startsWith("vm:") ? target!.host : null;
  const vms = useVmStates();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusOnDrive = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const onScopeKey = useFocusScope(dialog, !!target);
  const stream = useLiveStream(target ? (tile?.entry ?? null) : null, !!target, box as RefObject<HTMLElement | null>, measure, { room, read: true });
  const shownReading = reading ?? stream.reading;
  const floating = useFloatingBar(bar, shownReading?.link === "poor");
  // its Hand back wears the leave chord: no toast says it again
  useDrivingInput(stream, box as RefObject<HTMLElement | null>, drivenScreen(tile?.computer ?? ""), { chordShown: true, fullScreen: true });
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
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={target.name} data-full-window tabIndex={-1} onKeyDown={(e) => onScopeKey(e.nativeEvent)} className="fixed inset-0 z-(--layer-dialog) bg-matte text-foreground outline-none">
      <FullWindowView
        tile={tile}
        stream={stream}
        room={room}
        name={target.name}
        kind={pictureKind(tile?.computer ?? target.threadId)}
        boxRef={box}
        measureRef={measure}
        dpr={pixelRatioOf(measure.current)}
        barShown={floating.shown}
        barRef={bar}
        onMenuOpen={floating.onMenuOpen}
        reading={shownReading}
        rest={vm && vms[vm] ? <AsleepUnder host={vm} vm={vms[vm]!} room={room} /> : undefined}
        onPopOut={
          tile
            ? () => {
                closeFullWindow();
                openPopOut({ host: target.host, threadId: target.threadId, name: target.name });
              }
            : undefined
        }
        onExit={closeFullWindow}
        onOpenSession={(threadId, host) => {
          closeFullWindow();
          onOpenSession(threadId, host);
        }}
        onTookOver={() => void (focusOnDrive.current = true)}
      />
      <FullScreenHint driving={!!stream.drive} />
    </div>
  );
}
