import { useLayoutEffect, useRef, useState } from "react";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { TruncateTip } from "@renderer/components/tip";
import { useComputer, useComputers, type ComputerTile } from "../../../lib/computers";
import { sharpSize } from "../../../lib/video/support";
import { ComputerControls } from "./ComputerControls";
import { ENDED_WORDS, RETRY_ENDS, ViewportLine, liveFace, streamSize, useLiveStream, type LiveStream } from "./Viewport";

/**
 * The full view of a computer being driven (docs/DESIGN.md "Computers"):
 * the lightbox's body when a live picture is clicked. One surface holds the
 * picture, at its own pixels or exactly twice them where the window has the
 * room, and one row under it: the thread's title, who drives, Take over or
 * Hand back where the session has them, and Stop. It is another canvas on
 * the stream the place it was opened from already plays, never a second
 * stream.
 */

/** The surface's padding, the row's height and the gap between it and the picture. */
const PAD = 12;
const ROW = 36;
const GAP = 8;
/** The shape until the stream says its own. */
const DEFAULT_FRAME = { width: 1280, height: 800 };

/** Who drives, in the canvas bar's own words; nothing for a session with no driver to speak of. */
export const drivesWords = (tile: ComputerTile): string | null => (!tile.browser ? null : tile.driving ? "You are driving" : "The agent is driving");

export interface FullViewProps {
  tile: ComputerTile | null;
  all: readonly ComputerTile[];
  stream: LiveStream;
  /** the room the surface may take, in CSS pixels */
  room: { width: number; height: number };
  name: string;
  boxRef?: React.Ref<HTMLDivElement>;
  dpr?: number;
  /** a still in the canvas's place, for a fixture */
  picture?: React.ReactNode;
}

/** The surface, pure: what it draws for a tile, a stream and a room. */
export function FullView({ tile, all, stream, room, name, boxRef, picture, dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1 }: FullViewProps) {
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const face = liveFace(stream);
  const frame = streamSize(state) ?? DEFAULT_FRAME;
  const size = sharpSize(frame, dpr, { width: Math.max(0, room.width - PAD * 2), height: Math.max(0, room.height - PAD * 2 - ROW - GAP) }, 2);
  const words = tile ? drivesWords(tile) : null;
  return (
    <div data-slot="live-full-view" className="flex flex-col gap-2 rounded-2xl bg-popover p-3 text-popover-foreground shadow-overlay ring-1 ring-border" style={{ width: size.width + PAD * 2 }}>
      {tile && !over ? (
        <div ref={boxRef} role="img" aria-label={name} data-face="live" className="relative overflow-hidden rounded-lg bg-card" style={{ width: size.width, height: size.height }}>
          {face.drawn ? null : <Skeleton className="absolute inset-0 rounded-lg" />}
          {picture ?? face.picture}
          <div className="pointer-events-none absolute inset-0">{face.mark}</div>
        </div>
      ) : (
        <div data-face="none" className="flex items-center justify-center rounded-lg bg-card px-3 text-center" style={{ width: size.width, height: size.height }}>
          <ViewportLine
            words={!tile ? "Nothing is driving this now" : state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error}
            onRetry={tile && (state.status === "failed" || (state.status === "ended" && RETRY_ENDS.has(state.reason))) ? stream.retry : undefined}
          />
        </div>
      )}
      <div data-slot="live-full-row" className="flex h-9 min-w-0 items-center gap-3">
        <TruncateTip text={tile?.title ?? name}>
          <span className="min-w-0 truncate text-[13px] leading-5 font-medium">{tile?.title ?? name}</span>
        </TruncateTip>
        {/* on the title's own line height, so the two sizes share a baseline */}
        {words ? <span className={tile?.driving ? "shrink-0 text-xs leading-5 whitespace-nowrap text-foreground" : "shrink-0 text-xs leading-5 whitespace-nowrap text-muted-foreground"}>{words}</span> : null}
        <span className="flex-1" />
        {tile ? <ComputerControls tile={tile} all={all} /> : null}
      </div>
    </div>
  );
}

/** The full view of one thread's computer on one host, live. */
export function LiveFullView({ host, threadId, name }: { host: string; threadId: string; name: string }) {
  const tile = useComputer(host, threadId);
  const all = useComputers();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const read = (): void => setRoom({ width: el.clientWidth, height: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the thread on screen is the one he opened this from: it takes the display as its own place does
  const stream = useLiveStream(tile?.entry ?? null, true, box, measure);
  return (
    // the lightbox's own room: the window less its inset and the arrows' gutters
    <div ref={measure} className="flex h-[calc(100vh-112px)] w-[calc(100vw-160px)] items-center justify-center">
      {room.width > 0 ? <FullView tile={tile} all={all} stream={stream} room={room} name={name} boxRef={box} /> : null}
    </div>
  );
}
