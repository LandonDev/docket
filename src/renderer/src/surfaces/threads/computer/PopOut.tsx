import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bone } from "@renderer/components/bones";
import { TooltipContainerProvider } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { Desktop, Maximize2, Minimize2, X } from "../../../chrome/icons";
import { driveName, handBack, useComputer, type ComputerTile } from "../../../lib/computers";
import { useDriveHold } from "../../../lib/driveHold";
import { onWindowFullScreen, setWindowFullScreen } from "../../../lib/native";
import { POP_OUT_FRAME, closePopOut, usePopOut } from "../../../lib/popOut";
import { drawnPixelated, fitStage, pictureKind, type Size } from "../../../lib/stageLayout";
import { pixelRatioOf } from "../../../lib/video/support";
import { ComputerBar, ViewButton } from "./ComputerBar";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, PIXELATED, RETRY_ENDS, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type LiveStream } from "./Viewport";
import { drivenScreen } from "../../../lib/video/videoInput";

/**
 * The pop-out (docs/DESIGN.md "Computers", "Pop out"): a small frameless
 * window over every app, every Space and every workspace, with one computer
 * in it under its bar: the window's 36px handle, the computer's bar with
 * Keys, Take over or Hand back, Stop, then Back to the page, Full screen and
 * Close. The main window draws it: a child window
 * opened under the frame name main lets through (src/main/popOut.ts), filled
 * through a portal, its canvas handed to this window's own video worker, so
 * it plays the stream the page already plays. It wears the main window's
 * styles and theme and follows a change, takes any size he drags it to (the
 * picture keeps its shape inside, fitted as the stage's is, `fitStage`), and
 * closes when its computer leaves or the main window closes. Input, the pixel
 * ratio and the tips are the child window's own. Full screen (its button or
 * ⌃⌘F) takes it over its own display (main's fullScreen.ts), the picture on
 * `matte`.
 */

/** The bar over the picture (main's POP_OUT_BAR). */
const BAR = 36;

/** A computer whose row is gone for this long has left: the pop-out closes. A Take over moves a row from one thread to another in between. */
export const LEFT_AFTER_MS = 3000;

export interface PopOutViewProps {
  tile: ComputerTile | null;
  stream: LiveStream;
  name: string;
  boxRef?: Ref<HTMLDivElement>;
  measureRef?: Ref<HTMLDivElement>;
  /** the room above the bar, in CSS pixels; the picture fills it when left out (a fixture) */
  room?: Size;
  dpr?: number;
  /** the window is full screen: the picture sits on `matte` */
  full?: boolean;
  onBack: () => void;
  onClose: () => void;
  /** its own display, or back */
  onFullScreen?: () => void;
  /** a still in the canvas's place, for a fixture */
  picture?: ReactNode;
}

/** The window's body, pure: the bar, and the picture filling the room under it. */
export function PopOutView({ tile, stream, name, boxRef, measureRef, room, dpr = 1, full = false, onBack, onClose, onFullScreen, picture }: PopOutViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  const frame = streamSize(state);
  const fit = room ? fitStage(room, frame, dpr, pictureKind(tile?.computer ?? "")) : null;
  return (
    <div data-slot="pop-out" data-full={full || undefined} className={cn("flex h-screen w-screen flex-col overflow-hidden text-foreground", full ? "bg-matte" : "bg-background")}>
      {/* the bar is the window's handle: it drags the window, and its buttons do not */}
      <div data-slot="pop-out-bar" data-tauri-drag-region className="flex h-9 shrink-0 bg-background">
        <ComputerBar
          tile={tile}
          name={name}
          small
          reading={stream.reading}
          className="h-9 ps-2.5 pe-1.5"
          views={
            <>
              <ViewButton label="Back to the page" onClick={onBack}>
                <Desktop className="size-4" />
              </ViewButton>
              {onFullScreen ? (
                <ViewButton label={full ? "Leave full screen" : "Full screen"} onClick={onFullScreen}>
                  {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </ViewButton>
              ) : null}
              <ViewButton label="Close" onClick={onClose}>
                <X className="size-4" />
              </ViewButton>
            </>
          }
        />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          ref={measureRef}
          data-slot="pop-out-picture"
          className={cn("relative", fit ? (drawnPixelated(fit.width, frame, dpr) && PIXELATED) : "size-full")}
          style={fit ? { width: fit.width, height: fit.height } : undefined}
        >
          {tile && !over ? (
            <div
              ref={boxRef}
              {...(face.driving ? DRIVEN : { role: "img" })}
              aria-label={name}
              data-face="live"
              className={cn("absolute inset-0 overflow-hidden bg-card", face.driving && DRIVEN_CLASS)}
            >
              {face.drawn ? null : <Bone data-bones-on="matte" className="absolute inset-0 rounded-none" />}
              {picture ?? face.picture}
              <div className="pointer-events-none absolute inset-0">{face.mark}</div>
            </div>
          ) : (
            <div data-face="none" className="absolute inset-0 flex items-center justify-center bg-card px-3 text-center">
              {/* Retry where retrying can help, as on the page and in full screen: he need not go Back to the page for it. */}
              <ViewportLine
                words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
                onRetry={tile && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? stream.retry : undefined}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The main window's look, put on the child's document and kept in step: its stylesheets, and the theme on its root. */
export function mirrorDocument(from: Document, to: Document): () => void {
  const copied = new Map<Node, Node>();
  const copyStyles = (): void => {
    for (const node of from.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      if (copied.has(node)) continue;
      const clone = node.cloneNode(true);
      copied.set(node, clone);
      to.head.appendChild(clone);
    }
  };
  const copyRoot = (): void => {
    to.documentElement.className = from.documentElement.className;
    const style = from.documentElement.getAttribute("style");
    if (style === null) to.documentElement.removeAttribute("style");
    else to.documentElement.setAttribute("style", style);
    to.body.className = from.body.className;
  };
  copyStyles();
  copyRoot();
  to.body.style.margin = "0";
  const view = from.defaultView;
  if (!view || typeof view.MutationObserver === "undefined") return () => undefined;
  // a lazy chunk adds its styles later, and a change of theme rewrites the root's class
  const heads = new view.MutationObserver(copyStyles);
  heads.observe(from.head, { childList: true });
  const roots = new view.MutationObserver(copyRoot);
  roots.observe(from.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  roots.observe(from.body, { attributes: true, attributeFilter: ["class"] });
  return () => {
    heads.disconnect();
    roots.disconnect();
  };
}

/** The pop-out, live, while one is open (lib/popOut.ts): the child window and what is drawn in it. */
export function PopOut({ onBack }: { onBack: (computer: { host: string; threadId: string }) => void }) {
  const target = usePopOut();
  const [child, setChild] = useState<Window | null>(null);
  const host = target?.host;
  const threadId = target?.threadId;
  useEffect(() => {
    if (!host || !threadId) return;
    const w = window.open("about:blank", POP_OUT_FRAME);
    if (!w) {
      closePopOut();
      return;
    }
    const unmirror = mirrorDocument(document, w.document);
    // the window closed under us (the main window went, or the system closed it)
    const gone = (): void => closePopOut();
    w.addEventListener("pagehide", gone);
    setChild(w);
    return () => {
      w.removeEventListener("pagehide", gone);
      unmirror();
      setChild(null);
      w.close();
    };
  }, [host, threadId]);
  if (!target || !child) return null;
  return createPortal(
    <TooltipContainerProvider value={child.document.body}>
      <PopOutBody host={target.host} threadId={target.threadId} name={target.name} title={child.document} onBack={onBack} />
    </TooltipContainerProvider>,
    child.document.body,
  );
}

/** The room above the bar in the pop-out's own window, live. */
function useRoom(view: Window | null): Size | undefined {
  const read = (): Size | undefined => (view ? { width: view.innerWidth, height: Math.max(0, view.innerHeight - BAR) } : undefined);
  const [room, setRoom] = useState(read);
  useEffect(() => {
    if (!view) return;
    const on = (): void => setRoom(read());
    on();
    view.addEventListener("resize", on);
    return () => view.removeEventListener("resize", on);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  return room;
}

function PopOutBody({ host, threadId, name, title, onBack }: { host: string; threadId: string; name: string; title: Document; onBack: (computer: { host: string; threadId: string }) => void }) {
  const tile = useComputer(host, threadId);
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // it is what he watches: it takes the box's display, and he may drive from it
  const room = useRoom(title.defaultView);
  const stream = useLiveStream(tile?.entry ?? null, true, box as RefObject<HTMLElement | null>, measure, { room, read: true });
  useDrivingInput(stream, box as RefObject<HTMLElement | null>, drivenScreen(tile?.computer ?? ""));
  useDriveHold(tile ? `${tile.entry.host}\n${driveName(tile)}` : null, !!tile?.driving, () => (tile ? handBack(tile) : Promise.resolve()));
  const [full, setFull] = useState(false);
  useEffect(() => onWindowFullScreen(({ on, popOut }) => popOut && setFull(on)), []);
  useEffect(() => {
    title.title = tile?.title ?? name;
  }, [name, tile?.title, title]);
  // its computer left: the window closes (a Take over moves the row between threads within the grace)
  useEffect(() => {
    if (tile) return;
    const timer = setTimeout(closePopOut, LEFT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tile]);
  return (
    <PopOutView
      tile={tile}
      stream={stream}
      name={name}
      boxRef={box}
      measureRef={measure}
      room={room}
      dpr={pixelRatioOf(measure.current)}
      full={full}
      onBack={() => {
        onBack({ host, threadId });
        closePopOut();
      }}
      onClose={closePopOut}
      onFullScreen={() => void setWindowFullScreen({ on: !full, popOut: true })}
    />
  );
}
