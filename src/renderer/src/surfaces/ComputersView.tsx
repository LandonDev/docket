import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { FADE_IN } from "@renderer/components/ui/reveal";
import { StatusMark } from "@renderer/components/ui/status";
import { Desktop, Maximize2, PictureInPicture } from "../chrome/icons";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useDocumentVisible } from "../hooks/paneVisibility";
import { cn } from "../lib/cn";
import { driveName, handBack, tileKey, useComputers, viewKey, type ComputerTile } from "../lib/computers";
import { registry } from "../lib/connection/registry";
import { useDriveHold } from "../lib/driveHold";
import { previewContext } from "../lib/computerSessions";
import { openFullWindow } from "../lib/fullWindow";
import { openPopOut, takeStageRequest, useStageRequest } from "../lib/popOut";
import { fitStage, stageLayout, stageOf, type Size } from "../lib/stageLayout";
import { pixelRatioOf } from "../lib/video/support";
import { usePageEscape } from "../lib/pageEscape";
import { IS_MAC } from "../lib/platform";
import { restingVm, restingVmTiles, useVmStates, wakeVm, WAKING_LINE, type VmState } from "../lib/winvmWake";
import { hostName } from "../lib/threadResources";
import { EmptyState } from "./SurfaceSkeleton";
import { ComputerCaption, ViewButton, tileLine } from "./threads/computer/ComputerCaption";
import { ENDED_WORDS, RETRY_ENDS, Viewport, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream } from "./threads/computer/Viewport";
import { drivenScreen } from "../lib/video/videoInput";

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
  const linked = useHostLinked(tile.entry.host);
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  // no stream is asked for while the host's link is down: it is asked for again, as a place shown again, when the link is back
  const stream = useLiveStream(tile.entry, seen && linked, box, measure, { take: place.stage, drive: place.stage });
  // the stage's Hand back wears the leave chord: no toast says it again
  useDrivingInput(stream, box, drivenScreen(tile.computer), { chordShown: place.stage });
  useEffect(() => {
    if (!stream.drive || !focusOnDrive.current) return;
    focusOnDrive.current = false;
    box.current?.focus();
  }, [focusOnDrive, stream.drive]);
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const label = tileLabel(tile);
  const frame = pictureFrame(frameKey(tile), streamSize(state), tile.computer.startsWith("vm:"));
  if (!linked) return <WaitingPicture place={place} frame={frame} label={label} words={`Reconnecting to ${hostName(tile.entry.host)}`} />;
  const fit = place.stage ? fitStage(place.room, frame, pixelRatioOf(measure.current)) : null;
  return (
    <div ref={measure} data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport
        ref={box}
        fill
        face={over ? { kind: "none" } : liveFace(stream, place.stage ? () => openFullWindow({ host: tile.entry.host, threadId: viewKey(tile), name: label }) : undefined)}
        label={label}
        size={frame}
        line={over ? <ViewportLine words={state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error} onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined} /> : null}
      />
    </div>
  );
}

/**
 * The size a computer's picture box takes, one rule for every face it has (the live picture, the waiting box, the
 * stopped line): the stream's own once it is known, else the last one this window saw for that computer, else the
 * Windows VM's 1280 by 800; so nothing moves when one face gives way to another (the Mac's proof saw the live picture
 * laid out at 788 by 493 for 60 ms before its frame said 640 by 400, after a wake and after a dropped link).
 */
const lastFrames = new Map<string, Size>();
const frameKey = (tile: Pick<ComputerTile, "entry" | "computer">): string => `${tile.entry.host}\n${tile.computer}`;
export function pictureFrame(key: string, frame: Size | null, vm: boolean): Size | null {
  if (frame) {
    lastFrames.set(key, frame);
    return frame;
  }
  return lastFrames.get(key) ?? (vm ? VM_SIZE : null);
}

/** Whether the host's link is up; a host the registry does not list (none to wait for) counts as up. */
function useHostLinked(host: string): boolean {
  return useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => !registry.statuses().has(host) || registry.statusOf(host).transport === "open",
  );
}

/** A picture's box while it waits (the VM waking, the host's link coming back): its words beside a spinner, at the picture's size. */
function WaitingPicture({ place, frame, label, words, line }: { place: Place; frame: Size | null; label: string; words: string; line?: ReactNode }) {
  const fit = place.stage ? fitStage(place.room, frame, pixelRatioOf(null)) : null;
  return (
    <div data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport
        fill
        face={{ kind: "none" }}
        label={label}
        size={frame}
        line={
          line ?? (
            <span role="status" className="flex items-center gap-2 text-xs leading-4 text-muted-foreground">
              <Spinner aria-hidden className="size-3.5" />
              <span>{words}</span>
            </span>
          )
        }
      />
    </div>
  );
}

/** In place of a picture this desktop may not draw: one muted line, naming the machine that does. */
function ElsewherePicture({ machine }: { machine: string }) {
  return <Viewport fill face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />;
}

/** The Windows VM's picture box while it is not awake, in the stream's own 16:10 so nothing moves when the picture comes. */
const VM_SIZE = { width: 1280, height: 800 };

/**
 * The Windows VM while it is not awake: its box keeps the picture's place, with one line in it. On the stage a VM
 * asleep or going to sleep is woken by itself, so the page shows "Waking the Windows VM" until the picture arrives
 * (the live tile then takes this one's place, the same element); in the strip it waits for his press. Not set up, it
 * says where to set it up.
 */
export function RestingVmPicture({ host, vm, place, wake = wakeVm }: { host: string; vm: VmState; place: Place; wake?: (host: string) => Promise<void> }) {
  const rest = restingVm(vm);
  const stage = place.stage;
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wakes = stage && rest.wakes;
  useEffect(() => {
    if (!wakes) return;
    let live = true;
    setFailed(null);
    wake(host).catch((err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [attempt, host, wake, wakes]);
  // asleep on the stage reads as waking from the first frame: the wake is already asked
  const busy = rest.busy || wakes;
  const line =
    failed !== null ? (
      <ViewportLine words={`Couldn't wake the Windows VM: ${failed}`} onRetry={() => setAttempt((n) => n + 1)} />
    ) : busy ? undefined : (
      <ViewportLine words={rest.line} />
    );
  // the size its live picture will have (the last frame seen, else 1280 by 800), so it comes with nothing moving
  return <WaitingPicture place={place} frame={pictureFrame(`${host}\nvm:windows`, null, true)} label="Windows VM" words={wakes ? WAKING_LINE : rest.line} line={line} />;
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
  // a tile of the computer he drives holds his drive: leaving the page with nothing else of his showing it hands it back
  useDriveHold(`${tile.entry.host}\n${driveName(tile)}`, tile.driving, () => handBack(tile));
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
            picture && !tile.shownOn && !tile.vm ? (
              <>
                <ViewButton label="Pop out" onClick={() => openPopOut({ host: tile.entry.host, threadId: viewKey(tile), name: tileLabel(tile) })}>
                  <PictureInPicture className="size-4" />
                </ViewButton>
                <ViewButton label="Full window" onClick={() => openFullWindow({ host: tile.entry.host, threadId: viewKey(tile), name: tileLabel(tile) })}>
                  <Maximize2 className="size-4" />
                </ViewButton>
              </>
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
  // back from the pop-out: that computer has the stage, as his pick
  const asked = useStageRequest();
  useEffect(() => {
    if (!asked) return;
    const found = tiles.find((tile) => tile.entry.host === asked.host && (tile.entry.row.threadId === asked.threadId || tile.pane === asked.threadId || tile.computer === asked.threadId));
    takeStageRequest();
    if (found) setPick(tileKey(found, tiles));
  }, [asked, tiles]);
  const front = stageOf(keyed, pick, kept);
  if (front !== kept) setKept(front);
  if (tiles.length === 0) return <EmptyState title="Nothing is being driven" line="A browser or an app an agent is using shows here, live." />;
  const layout = stageLayout(size, tiles.length);
  const picture =
    pictureOf ??
    ((tile: ComputerTile, place: Place) =>
      tile.vm ? (
        <RestingVmPicture host={tile.entry.host} vm={tile.vm} place={place} />
      ) : tile.shownOn ? (
        <ElsewherePicture machine={tile.shownOn} />
      ) : (
        <LivePicture tile={tile} place={place} focusOnDrive={focusOnDrive} />
      ));
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

/** The page's 40px header: the glyph and its name. */
export function ComputersHeader({ besideRail = false, onClose, onToggleSidebar }: { besideRail?: boolean; onClose: () => void; onToggleSidebar: () => void }) {
  return (
    <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
      {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
      {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
        <Desktop className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">Computers</span>
      </div>
      {IS_MAC ? null : <WindowControls />}
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
  const live = useComputers();
  const vms = useVmStates();
  // the Windows VM is a tile in every state: drawn from its state while it has no row of its own
  const tiles = useMemo(() => [...live, ...restingVmTiles(vms, live, hostName)], [live, vms]);
  const close = useRef(onClose);
  close.current = onClose;
  // while he drives a computer here Escape is that computer's key: a stray one never closes the page and its drive
  usePageEscape(() => close.current(), { fields: "blur", enabled: !tiles.some((t) => t.driving) });
  return (
    <div role="region" aria-label="Computers" data-computers className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <ComputersHeader besideRail={besideRail} onClose={onClose} onToggleSidebar={onToggleSidebar} />
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
