import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { cn } from "@renderer/lib/cn";
import { Minimize2 } from "../../../chrome/icons";
import { useComputer, type ComputerTile } from "../../../lib/computers";
import { closeFullWindow, useFullWindow } from "../../../lib/fullWindow";
import { CAPTION_GAP, CAPTION_HEIGHT, STAGE_INSET, fitStage, type Size } from "../../../lib/stageLayout";
import { pixelRatioOf } from "../../../lib/video/support";
import { ComputerCaption, ViewButton } from "./ComputerCaption";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, RETRY_ENDS, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type LiveStream } from "./Viewport";

/**
 * The full window (docs/DESIGN.md "Computers", "Full window"): the stage with
 * the rail and the header gone, on the ground under a picture (`stage`). One
 * computer, its picture as large as the window allows in its own shape and
 * never past twice the stream's own pixels, its caption under it. The
 * caption fades after two seconds with no pointer movement and comes back
 * with it, or with keyboard focus in it. Escape leaves when the picture does
 * not hold the keyboard; a double click on the picture leaves when he does
 * not drive. It is another canvas on the stream the page already plays.
 */

/** The caption stays this long after the pointer last moved. */
export const CAPTION_REST_MS = 2000;

export interface FullWindowViewProps {
  tile: ComputerTile | null;
  stream: LiveStream;
  /** the window, in CSS pixels */
  room: Size;
  name: string;
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

/** The window's body, pure: what it draws for a tile, a stream and a room. */
export function FullWindowView({ tile, stream, room, name, boxRef, measureRef, dpr = 1, captionShown = true, onExit, onOpenSession, onTookOver, picture }: FullWindowViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  const frame = streamSize(state);
  const fit = fitStage({ width: room.width - STAGE_INSET * 2, height: room.height - STAGE_INSET * 2 - CAPTION_GAP - CAPTION_HEIGHT }, frame, dpr);
  const aspect = frame ? `${frame.width} / ${frame.height}` : "16 / 10";
  return (
    <div className="flex size-full flex-col items-center justify-center p-4">
      <div ref={measureRef} className="flex flex-col gap-2" style={{ width: fit.width }}>
        {tile && !over ? (
          <div
            ref={boxRef}
            {...(face.driving ? DRIVEN : { role: "img" })}
            aria-label={name}
            data-face="live"
            className={cn("relative overflow-hidden rounded-lg bg-card", face.driving && DRIVEN_CLASS)}
            style={{ aspectRatio: aspect }}
          >
            {face.drawn ? null : <Skeleton className="absolute inset-0 rounded-lg" />}
            {picture ?? face.picture}
            <div className="pointer-events-none absolute inset-0">{face.mark}</div>
          </div>
        ) : (
          <div data-face="none" className="flex items-center justify-center rounded-lg bg-card px-3 text-center" style={{ aspectRatio: aspect }}>
            <ViewportLine
              words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
              onRetry={tile && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? stream.retry : undefined}
            />
          </div>
        )}
        <div
          data-slot="full-window-caption"
          data-shown={captionShown || undefined}
          className={cn("transition-opacity duration-(--dur-base) ease-(--ease-out) has-focus-visible:opacity-100", !captionShown && "opacity-0")}
        >
          {tile ? (
            <ComputerCaption
              tile={tile}
              onOpenSession={onOpenSession}
              where={tile.where}
              onTookOver={onTookOver}
              views={
                <ViewButton label="Leave full window" onClick={onExit}>
                  <Minimize2 className="size-4" />
                </ViewButton>
              }
            />
          ) : (
            <div className="flex min-h-9 items-center justify-end">
              <ViewButton label="Leave full window" onClick={onExit}>
                <Minimize2 className="size-4" />
              </ViewButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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

/** The full window, live, over the whole app while one is open (lib/fullWindow.ts). */
export function FullWindow({ onOpenSession }: { onOpenSession: (threadId: string, host: string) => void }) {
  const target = useFullWindow();
  const tile = useComputer(target?.host ?? "", target?.threadId ?? "");
  const room = useWindowSize();
  const captionShown = useCaptionShown();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusOnDrive = useRef(false);
  const stream = useLiveStream(target ? (tile?.entry ?? null) : null, !!target, box as RefObject<HTMLElement | null>, measure);
  useDrivingInput(stream, box as RefObject<HTMLElement | null>);
  useLeaveOnEscape(closeFullWindow);
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
    <div role="dialog" aria-modal="true" aria-label={target.name} data-full-window className="fixed inset-0 z-(--layer-dialog) bg-stage text-foreground">
      <FullWindowView
        tile={tile}
        stream={stream}
        room={room}
        name={target.name}
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
