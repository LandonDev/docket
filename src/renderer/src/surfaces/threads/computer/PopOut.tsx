import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BusyLabel, Button } from "@renderer/components/ui/button";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { loadToast } from "@renderer/components/ui/toaster";
import { TooltipContainerProvider } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/cn";
import { Desktop, Square, X } from "../../../chrome/icons";
import { canTakeOver, handBack, takeOver, useComputer, type ComputerTile } from "../../../lib/computers";
import { stopComputer } from "../../../lib/computerSessions";
import { setPopOutShape } from "../../../lib/native";
import { POP_OUT_FRAME, closePopOut, usePopOut } from "../../../lib/popOut";
import { ViewButton } from "./ComputerCaption";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type LiveStream } from "./Viewport";
import { drivenScreen } from "../../../lib/video/videoInput";

/**
 * The pop-out (docs/DESIGN.md "Computers", "Pop out"): a small frameless
 * window over every app, every Space and every workspace, with one computer
 * in it and a 36px bar under it. The main window draws it: a child window
 * opened under the frame name main lets through (src/main/popOut.ts), filled
 * through a portal, its canvas handed to this window's own video worker, so
 * it plays the stream the page already plays. It wears the main window's
 * styles and theme and follows a change, keeps the picture's shape as he
 * drags it to a size, and closes when its computer leaves or the main window
 * closes. Input, the pixel ratio and the tips are the child window's own.
 */

/** A computer whose row is gone for this long has left: the pop-out closes. A Take over moves a row from one thread to another in between. */
export const LEFT_AFTER_MS = 3000;

export interface PopOutViewProps {
  tile: ComputerTile | null;
  stream: LiveStream;
  name: string;
  boxRef?: Ref<HTMLDivElement>;
  measureRef?: Ref<HTMLDivElement>;
  onBack: () => void;
  onClose: () => void;
  /** a still in the canvas's place, for a fixture */
  picture?: ReactNode;
}

/** The window's body, pure: the picture filling the room above, and the bar. */
export function PopOutView({ tile, stream, name, boxRef, measureRef, onBack, onClose, picture }: PopOutViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  return (
    <div data-slot="pop-out" className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div ref={measureRef} className="relative min-h-0 flex-1">
        {tile && !over ? (
          <div
            ref={boxRef}
            {...(face.driving ? DRIVEN : { role: "img" })}
            aria-label={name}
            data-face="live"
            className={cn("absolute inset-0 overflow-hidden bg-card", face.driving && DRIVEN_CLASS)}
          >
            {face.drawn ? null : <Skeleton className="absolute inset-0 rounded-none" />}
            {picture ?? face.picture}
            <div className="pointer-events-none absolute inset-0">{face.mark}</div>
          </div>
        ) : (
          <div data-face="none" className="absolute inset-0 flex items-center justify-center bg-card px-3 text-center">
            <ViewportLine words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error} />
          </div>
        )}
      </div>
      {/* the bar is the window's handle: it drags the window, and its buttons do not */}
      <div data-slot="pop-out-bar" data-tauri-drag-region className="flex h-9 shrink-0 items-center gap-1 ps-3 pe-1.5">
        <span className="min-w-0 flex-1 truncate text-xs leading-4 font-medium">{tile?.title ?? name}</span>
        {tile ? <PopOutControls tile={tile} /> : null}
        <ViewButton label="Back to the page" onClick={onBack}>
          <Desktop className="size-4" />
        </ViewButton>
        <ViewButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </ViewButton>
      </div>
    </div>
  );
}

/** Take over (where the computer takes input) and Stop; while he drives, Hand back. The bar's own sizes. */
function PopOutControls({ tile }: { tile: ComputerTile }) {
  const [busy, setBusy] = useState<"take" | "back" | "stop" | null>(null);
  const press = (which: "take" | "back" | "stop", run: () => Promise<unknown>, failed: string): void => {
    if (busy) return;
    setBusy(which);
    void run()
      .catch(() => loadToast().then((toast) => toast.error(failed, { description: tile.title })))
      .finally(() => setBusy(null));
  };
  if (tile.driving)
    return (
      <Button size="xs" data-hand-back disabled={!!busy} onClick={() => press("back", () => handBack(tile), "Couldn't hand it back")}>
        <BusyLabel busy={busy === "back"} label="Hand back" />
      </Button>
    );
  return (
    <>
      {canTakeOver(tile) ? (
        <Button variant="secondary" size="xs" disabled={!!busy} onClick={() => press("take", () => takeOver(tile), "Couldn't take over")}>
          <BusyLabel busy={busy === "take"} label="Take over" />
        </Button>
      ) : null}
      {tile.idle ? null : (
        <ViewButton label={`Stop ${tile.title}`} onClick={() => press("stop", () => stopComputer(tile.entry), "Couldn't stop it")}>
          <Square className="size-2.5 fill-current" />
        </ViewButton>
      )}
    </>
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

function PopOutBody({ host, threadId, name, title, onBack }: { host: string; threadId: string; name: string; title: Document; onBack: (computer: { host: string; threadId: string }) => void }) {
  const tile = useComputer(host, threadId);
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // it is what he watches: it takes the box's display, and he may drive from it
  const stream = useLiveStream(tile?.entry ?? null, true, box as RefObject<HTMLElement | null>, measure);
  useDrivingInput(stream, box as RefObject<HTMLElement | null>, drivenScreen(tile?.computer ?? ""));
  const frame = streamSize(stream.state);
  useEffect(() => {
    title.title = tile?.title ?? name;
  }, [name, tile?.title, title]);
  // the window keeps the picture's shape as he drags it to a size
  useEffect(() => {
    if (frame) setPopOutShape(frame.width / frame.height);
  }, [frame?.width, frame?.height]); // eslint-disable-line react-hooks/exhaustive-deps
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
      onBack={() => {
        onBack({ host, threadId });
        closePopOut();
      }}
      onClose={closePopOut}
    />
  );
}
