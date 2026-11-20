import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button } from "@renderer/components/ui/button";
import { FADE_IN } from "@renderer/components/ui/reveal";
import { StatusMark } from "@renderer/components/ui/status";
import { Desktop, Maximize2 } from "../chrome/icons";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useDocumentVisible } from "../hooks/paneVisibility";
import { cn } from "../lib/cn";
import { tileKey, useComputers, type ComputerTile } from "../lib/computers";
import { previewContext } from "../lib/computerSessions";
import { openFullWindow } from "../lib/fullWindow";
import { fitStage, stageLayout, stageOf, type Size } from "../lib/stageLayout";
import { pixelRatioOf } from "../lib/video/support";
import { usePageEscape } from "../lib/pageEscape";
import { IS_MAC } from "../lib/platform";
import { EmptyState } from "./SurfaceSkeleton";
import { ComputerCaption, ViewButton, tileLine } from "./threads/computer/ComputerCaption";
import { ENDED_WORDS, RETRY_ENDS, Viewport, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream } from "./threads/computer/Viewport";

/**
 * Computers (docs/DESIGN.md "Computers"): every computer being driven now,
 * on every connected host, in one page over the thread area, like the Inbox
 * and the Outbox. One computer has the stage: its picture fits the page and
 * its caption sits under it with its controls, never behind a hover. The
 * others sit in a strip beside it, live, and a press puts one on the stage.
 * No card, no badge, no count, and nothing moves to the stage by itself.
 *
 * Every tile is one element in one grid whatever its place: a swap changes
 * only where it sits, so its canvas stays and no stream is opened again.
 * The stage takes the box's one display and is where he drives; a strip
 * tile plays video where a stream is free and the 4 fps picture where not.
 */

export { tileLine } from "./threads/computer/ComputerCaption";

const tileLabel = (tile: ComputerTile): string => {
  const app = tile.entry.row.apps[0];
  return app ? `Live view of ${app.window ? `${app.window} in ${app.name}` : app.name}` : "Live view";
};

/** An element's size, live. */
function useSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => setSize((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Where a tile is: on the stage with the room its picture may fill, or in the strip. */
export type Place = { stage: true; room: Size } | { stage: false };

/**
 * A tile's picture, live, in the box its place gives it: the stage fits the stream's shape to its room, never past
 * twice the stream's own pixels; the strip's is the strip's width. The stream is asked for at that size. On the stage
 * it takes the box's one display and is his to drive; a press on Take over gives the picture the keyboard at once.
 */
function LivePicture({ tile, place, focusOnDrive }: { tile: ComputerTile; place: Place; focusOnDrive: RefObject<boolean> }) {
  const seen = useDocumentVisible();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const stream = useLiveStream(tile.entry, seen, box, measure, { take: place.stage, drive: place.stage });
  useDrivingInput(stream, box);
  useEffect(() => {
    if (!stream.drive || !focusOnDrive.current) return;
    focusOnDrive.current = false;
    box.current?.focus();
  }, [focusOnDrive, stream.drive]);
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const label = tileLabel(tile);
  const frame = streamSize(state);
  const fit = place.stage ? fitStage(place.room, frame, pixelRatioOf(measure.current)) : null;
  return (
    <div ref={measure} data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport
        ref={box}
        fill
        face={over ? { kind: "none" } : liveFace(stream, place.stage ? () => openFullWindow({ host: tile.entry.host, threadId: tile.entry.row.threadId, name: label }) : undefined)}
        label={label}
        size={frame}
        line={over ? <ViewportLine words={state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error} onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined} /> : null}
      />
    </div>
  );
}

/** In place of a picture this desktop may not draw: one muted line, naming the machine that does. */
function ElsewherePicture({ machine }: { machine: string }) {
  return <Viewport fill face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />;
}

export interface TileProps {
  tile: ComputerTile;
  onOpenSession: (threadId: string, host: string) => void;
  /** the picture; left out where no desktop draws one (the browser /ui): the caption alone */
  picture?: ReactNode;
  /** on the stage, with the controls; else a strip tile, a press on which puts it there */
  stage?: boolean;
  onStage?: () => void;
  onTookOver?: () => void;
}

/** One computer, on the stage or in the strip: the same element either way, so its picture's canvas stays. */
export function Tile({ tile, onOpenSession, picture, stage = true, onStage, onTookOver }: TileProps) {
  const line = tileLine(tile);
  // where it runs is said once: a picture this desktop may not draw already names the machine
  const where = picture && tile.shownOn ? null : tile.where;
  return (
    <article data-slot="computer-tile" data-stage={stage || undefined} aria-label={tile.title} className={cn("relative flex min-w-0 flex-col", stage ? "gap-2" : "gap-1.5 transition-transform duration-(--dur-fast) ease-(--ease-out) active:scale-[0.98]", FADE_IN)}>
      {picture}
      {stage ? (
        <ComputerCaption
          tile={tile}
          onOpenSession={onOpenSession}
          where={where}
          onTookOver={onTookOver}
          views={
            picture && !tile.shownOn ? (
              <ViewButton label="Full window" onClick={() => openFullWindow({ host: tile.entry.host, threadId: tile.entry.row.threadId, name: tileLabel(tile) })}>
                <Maximize2 className="size-4" />
              </ViewButton>
            ) : null
          }
        />
      ) : (
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 font-medium">
            {tile.entry.row.asking ? <StatusMark state="waiting" word={false} /> : null}
            <span className="min-w-0 truncate">{tile.title}</span>
          </span>
          <span className="truncate text-xs leading-4 text-muted-foreground">{line ?? where}</span>
          {/* the whole tile is the press that puts it on the stage */}
          <Button variant="link" aria-label={`Show ${tile.title}`} onClick={onStage} className="absolute inset-0 h-auto rounded-lg p-0" />
        </div>
      )}
    </article>
  );
}

export interface ComputersPageProps {
  tiles: readonly ComputerTile[];
  onOpenSession: (threadId: string, host: string) => void;
  /** a tile's picture; the live one by default */
  pictureOf?: (tile: ComputerTile, place: Place) => ReactNode;
  /** the body's size before it is measured: a fixture's, drawn with no layout pass */
  size?: Size;
}

/** The page's body: the stage and the strip, or the one empty state. */
export function ComputersPage({ tiles, onOpenSession, pictureOf, size: given }: ComputersPageProps) {
  const page = useRef<HTMLDivElement>(null);
  const measured = useSize(page);
  const size = measured.width > 0 || !given ? measured : given;
  const [pick, setPick] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const focusOnDrive = useRef(false);
  const keyed = tiles.map((tile) => ({ tile, key: tileKey(tile, tiles), asking: !!tile.entry.row.asking, lastCallAt: tile.entry.row.lastCallAt }));
  const front = stageOf(keyed, pick, kept);
  if (front !== kept) setKept(front);
  if (tiles.length === 0) return <EmptyState title="Nothing is being driven" line="A browser or an app an agent is using shows here, live." />;
  const layout = stageLayout(size, tiles.length);
  const picture =
    pictureOf ??
    ((tile: ComputerTile, place: Place) => (tile.shownOn ? <ElsewherePicture machine={tile.shownOn} /> : <LivePicture tile={tile} place={place} focusOnDrive={focusOnDrive} />));
  // the strip in the order they acted, the latest first; the elements stay in one order, so none is ever remade
  const rank = new Map([...keyed].sort((a, b) => b.lastCallAt - a.lastCallAt || a.key.localeCompare(b.key)).map((k, i) => [k.key, i]));
  const others = tiles.length - 1;
  const grid: CSSProperties =
    layout.strip === "side"
      ? { gridTemplateColumns: `minmax(0, 1fr) ${layout.stripWidth}px`, gridTemplateRows: `repeat(${others}, auto) 1fr` }
      : layout.strip === "below"
        ? { gridTemplateColumns: `repeat(${Math.min(others, 2)}, minmax(0, 1fr))` }
        : { gridTemplateColumns: "minmax(0, 1fr)" };
  const stagePlace: CSSProperties =
    layout.strip === "side" ? { gridColumn: 1, gridRow: `1 / span ${others + 1}` } : layout.strip === "below" ? { gridColumn: "1 / -1", gridRow: 1 } : {};
  return (
    <div ref={page} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
      <div data-slot="computer-tiles" data-strip={layout.strip} className="grid items-start gap-4 p-4" style={grid}>
        {[...keyed]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map(({ tile, key }) => {
            const on = key === front;
            const place: Place = on ? { stage: true, room: layout.room } : { stage: false };
            return (
              <div key={key} className={cn("min-w-0", on && "flex justify-center")} style={on ? stagePlace : { gridColumn: layout.strip === "side" ? 2 : undefined, order: rank.get(key) }}>
                <Tile
                  tile={tile}
                  stage={on}
                  onStage={() => setPick(key)}
                  onTookOver={() => void (focusOnDrive.current = true)}
                  onOpenSession={onOpenSession}
                  picture={picture(tile, place)}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

interface Props {
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar: () => void;
  onOpenSession: (threadId: string, host: string) => void;
}

export function ComputersView({ besideRail = false, onClose, onToggleSidebar, onOpenSession }: Props) {
  const tiles = useComputers();
  const close = useRef(onClose);
  close.current = onClose;
  usePageEscape(() => close.current(), { fields: "blur" });
  return (
    <div role="region" aria-label="Computers" data-computers className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Desktop className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">Computers</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <ComputersPage
        tiles={tiles}
        // the browser /ui draws no picture of any machine: the same tiles, their captions alone
        {...(previewContext().desktop ? {} : { pictureOf: () => null })}
        onOpenSession={(threadId, host) => {
          onClose();
          onOpenSession(threadId, host);
        }}
      />
    </div>
  );
}
