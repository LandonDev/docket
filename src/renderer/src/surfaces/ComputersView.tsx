import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button } from "@renderer/components/ui/button";
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
import { offerFullScreen, openFullWindow, screenRectOf, useFullWindow, type ScreenRect } from "../lib/fullWindow";
import { openPopOut, takeStageRequest, useStageRequest } from "../lib/popOut";
import { drawnPixelated, fitStage, pictureKind, roomKnown, stageLayout, stageOf, type PictureKind, type Size } from "../lib/stageLayout";
import { pixelRatioOf } from "../lib/video/support";
import { usePageEscape } from "../lib/pageEscape";
import { IS_MAC } from "../lib/platform";
import { restingVm, restingVmTiles, useVmStates, vmPlate, wakeVm, type VmState } from "../lib/winvmWake";
import { useVmStill } from "../work/winvm/vmPresses";
import { hostName } from "../lib/threadResources";
import { EmptyState } from "./SurfaceSkeleton";
import { ComputerBar, OpenSettingsButton, ViewButton, WakeButton, tileLine, vmScreenSeam, type BarReading } from "./threads/computer/ComputerBar";
import { ENDED_WORDS, PIXELATED, Plate, RETRY_ENDS, Viewport, ViewportLine, liveFace, streamSize, useDrivingInput, useLiveStream, type PlateProps } from "./threads/computer/Viewport";
import { drivenScreen } from "../lib/video/videoInput";
import type { PreviewState } from "../lib/computerPreview";

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

export { tileLine } from "./threads/computer/ComputerBar";

const tileLabel = (tile: ComputerTile): string => {
  const app = tile.entry.row.apps[0];
  return app ? `Live view of ${app.window ? `${app.window} in ${app.name}` : app.name}` : "Live view";
};

/**
 * An element's size, live, read from the element the callback ref is given: the page's body comes and goes with its
 * tiles (the Windows VM's arrives after the first paint, from its state), and a ref object read once at mount never
 * measured the body that came later, so its stage had no room and its picture was a sliver (1.0.382).
 */
function useSize(): [Size, (el: HTMLElement | null) => void, HTMLElement | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const read = (): void => setSize((was) => (was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [size, setEl, el];
}

/** Where a tile is: on the stage with the room its picture may fill, or in the strip. */
export type Place = { stage: true; room: Size } | { stage: false };

/** The host's link drops: tried again this many times before the plate says the picture stopped, with Retry. */
export const LOST_TRIES = 5;

/** The plate while the host's link is down: "Reconnecting to The box", "Try 2 of 5"; past the last try, Retry. */
export function lostPlate(host: string, attempts: number): PlateProps & { retry: boolean } {
  if (attempts >= LOST_TRIES) return { title: "The picture stopped", retry: true };
  return { title: `Reconnecting to ${host}`, detail: `Try ${attempts + 1} of ${LOST_TRIES}`, spin: true, retry: false };
}

/** A clock that ticks each second while `on`: a wake's count. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * A tile's picture, live, in the box its place gives it: the stage fits the stream's shape to its room (`fitStage`: a
 * whole computer's screen fills it, a window's picture stops at twice its own pixels); the strip's is the strip's width. The stream is asked for at that size. On the stage
 * it takes the box's one display and is his to drive; a press on Take over gives the picture the keyboard at once.
 * The Windows VM's opens on the picture it last slept on, under a lighter wash, until its first frame is drawn.
 */
function LivePicture({ tile, place, focusOnDrive, readStage, onReading }: { tile: ComputerTile; place: Place; focusOnDrive: RefObject<boolean>; readStage: string; onReading: (key: string, reading: BarReading | null) => void }) {
  const seen = useDocumentVisible();
  const link = useHostLink(tile.entry.host);
  const linked = link.linked;
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const vm = tile.computer.startsWith("vm:");
  // no stream is asked for while the host's link is down: it is asked for again, as a place shown again, when the link is back
  const full = useFullWindow();
  const stream = useLiveStream(tile.entry, seen && linked, box, measure, { take: place.stage, drive: place.stage, room: place.stage && !full ? place.room : undefined, read: place.stage });
  // the stage's Hand back wears the leave chord: no toast says it again
  useDrivingInput(stream, box, drivenScreen(tile.computer), { chordShown: place.stage });
  useEffect(() => {
    if (!stream.drive || !focusOnDrive.current) return;
    focusOnDrive.current = false;
    box.current?.focus();
  }, [focusOnDrive, stream.drive]);
  const reading = stream.reading ?? null;
  useEffect(() => {
    if (place.stage) onReading(readStage, reading);
  }, [onReading, place.stage, readStage, reading]);
  const { state } = stream;
  const still = useVmStill(tile.entry.host, vm, null);
  const over = state.status === "ended" || state.status === "failed";
  const label = tileLabel(tile);
  const frame = pictureFrame(frameKey(tile), streamSize(state), vm);
  const kind = pictureKind(tile.computer);
  if (!linked) {
    const lost = lostPlate(hostName(tile.entry.host), link.attempts);
    return <PlatePicture place={place} frame={frame} kind={kind} label={label} plate={{ ...lost, still: still?.src, action: lost.retry ? <RetryButton onRetry={() => registry.retry(tile.entry.host)} /> : undefined }} />;
  }
  const dpr = pixelRatioOf(measure.current);
  const fit = place.stage && roomKnown(place.room) ? fitStage(place.room, frame, dpr, kind) : null;
  const face = over ? null : liveFace(stream, place.stage ? (from) => openFullWindow({ host: tile.entry.host, threadId: viewKey(tile), name: label, from: screenRectOf(from) }) : undefined);
  const drawn = state.status === "live" && state.drawn;
  // the last picture, washed back, until the first frame: then it fades out over it
  const cover = vm && still ? <Plate title="Connecting" spin still={still.src} light gone={drawn} /> : undefined;
  return (
    <div ref={measure} data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? (drawnPixelated(fit.width, frame, dpr) ? PIXELATED : undefined) : "w-full"}>
      <Viewport
        ref={box}
        fill
        face={face ? { ...face, ...(cover ? { cover } : {}) } : over ? { kind: "plate", plate: stoppedPlate(state, still?.src, place.stage ? stream.retry : undefined) } : { kind: "none" }}
        label={label}
        size={frame}
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

/** The host's link: up (a host the registry does not list, none to wait for, counts as up), and its failed tries since. */
function useHostLink(host: string): { linked: boolean; attempts: number } {
  const linked = useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => !registry.statuses().has(host) || registry.statusOf(host).transport === "open",
  );
  const attempts = useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => (registry.statuses().has(host) ? (registry.statusOf(host).attempts ?? 0) : 0),
  );
  return { linked, attempts };
}

/** Retry on a plate: secondary, small. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={onRetry}>
      Retry
    </Button>
  );
}

/**
 * A stream that ended with the host linked, as every face of the stage is (docs/DESIGN.md "Computers", "The faces"): one
 * plate of words over the last picture washed back, Retry its press where retrying can help. A strip tile is one press
 * that puts it on the stage, so its plate has none.
 */
export function stoppedPlate(state: Extract<PreviewState, { status: "ended" | "failed" }>, still: string | null | undefined, retry: (() => void) | undefined): PlateProps {
  const again = state.status === "failed" || RETRY_ENDS.has(state.reason);
  return { title: state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error, still, action: again && retry ? <RetryButton onRetry={retry} /> : undefined };
}

/** A picture's box with nothing live in it: its plate, at the picture's size, so nothing moves when the picture comes. */
function PlatePicture({ place, frame, kind, label, plate }: { place: Place; frame: Size | null; kind: PictureKind; label: string; plate: PlateProps }) {
  const fit = place.stage && roomKnown(place.room) ? fitStage(place.room, frame, pixelRatioOf(null), kind) : null;
  return (
    <div data-slot="computer-picture-room" style={fit ? { width: fit.width } : undefined} className={fit ? undefined : "w-full"}>
      <Viewport fill face={{ kind: "plate", plate }} label={label} size={frame} />
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
 * The Windows VM while it has no live picture: the desk it last slept on, washed back, with one plate of words
 * (`vmPlate`). On the stage a VM asleep or going to sleep wakes by itself, unless his own Sleep put it there (then it
 * waits for Wake, in the bar), and its plate counts the wake against the usual one; in the strip it waits for his
 * press. Not set up, the plate stands on the bare box and the bar's one press goes to Settings.
 */
export function RestingVmPicture({ host, vm, place, wake = wakeVm }: { host: string; vm: VmState; place: Place; wake?: (host: string) => Promise<void> }) {
  const rest = restingVm(vm);
  const stage = place.stage;
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [since, setSince] = useState<number | undefined>(undefined);
  const wakes = stage && rest.wakes && !vm.heldAsleep;
  useEffect(() => {
    if (!wakes) return;
    let live = true;
    setFailed(null);
    setSince(Date.now());
    wake(host).catch((err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [attempt, host, wake, wakes]);
  const counting = !failed && (vm.state === "waking" || wakes);
  const now = useNow(counting);
  const words = vmPlate(vm, { wakes, now, failed, since });
  // read again each time it goes to sleep: the host keeps the newest
  const still = useVmStill(host, vm.state !== "none" && vm.state !== "setting-up", vm.state === "asleep" ? vm.since : null);
  const frame = pictureFrame(`${host}\nvm:windows`, null, true) ?? (still ? { width: still.width, height: still.height } : VM_SIZE);
  return (
    <PlatePicture
      place={place}
      frame={frame}
      kind="screen"
      label="Windows VM"
      plate={{ title: words.title, detail: words.detail, spin: words.spin, still: words.bare ? null : still?.src, action: words.retry ? <RetryButton onRetry={() => setAttempt((n) => n + 1)} /> : undefined }}
    />
  );
}

export interface TileProps {
  tile: ComputerTile;
  /** the picture; left out where no desktop draws one (the browser /ui): its name alone */
  picture?: ReactNode;
  /** on the stage, its bar the page's header; else a strip tile, a press on which puts it there */
  stage?: boolean;
  onStage?: () => void;
}

/** One computer, on the stage or in the strip: the same element either way, so its picture's canvas stays. */
export function Tile({ tile, picture, stage = true, onStage }: TileProps) {
  // a tile of the computer he drives holds his drive: leaving the page with nothing else of his showing it hands it back
  useDriveHold(`${tile.entry.host}\n${driveName(tile)}`, tile.driving, () => handBack(tile));
  const line = tileLine(tile);
  // where it runs is said once: a picture this desktop may not draw already names the machine
  const where = picture && tile.shownOn ? null : tile.where;
  return (
    <article data-slot="computer-tile" data-stage={stage || undefined} aria-label={tile.title} className={cn("relative flex min-w-0 flex-col", !stage && "gap-1.5 transition-transform duration-(--dur-fast) ease-(--ease-out) active:scale-[0.98]", FADE_IN)}>
      {picture}
      {stage ? null : (
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

/** The page's frame around its header: the way back and the window's own buttons; none in a fixture. */
export interface PageFrame {
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar: () => void;
}

export interface ComputersPageProps {
  tiles: readonly ComputerTile[];
  onOpenSession: (threadId: string, host: string) => void;
  /** a tile's picture; the live one by default */
  pictureOf?: (tile: ComputerTile, place: Place) => ReactNode;
  /** the body's size before it is measured: a fixture's, drawn with no layout pass */
  size?: Size;
  frame?: PageFrame;
  /** each host's Windows VM, for its bar's menu */
  vms?: Readonly<Record<string, VmState>>;
  /** the delay's numbers of the stage's stream, as far as they are known (lib/video: the ping, the worker's draw) */
  reading?: BarReading | null;
}

/** The bar of the computer on the stage, as the page's header has it. */
function StageBar({ tile, vm, picture, onOpenSession, onTookOver, pictureRect, reading }: { tile: ComputerTile; vm: VmState | null; picture: boolean; onOpenSession: (threadId: string, host: string) => void; onTookOver: () => void; pictureRect: () => ScreenRect | undefined; reading?: BarReading | null }) {
  const isVm = tile.computer.startsWith("vm:");
  const { linked } = useHostLink(tile.entry.host);
  const views =
    picture && !tile.shownOn && !tile.vm ? (
      <>
        <ViewButton label="Pop out" fold onClick={() => openPopOut({ host: tile.entry.host, threadId: viewKey(tile), name: tileLabel(tile) })}>
          <PictureInPicture className="size-4" />
        </ViewButton>
        <ViewButton label="Full screen" fold="last" onClick={() => openFullWindow({ host: tile.entry.host, threadId: viewKey(tile), name: tileLabel(tile), from: pictureRect() })}>
          <Maximize2 className="size-4" />
        </ViewButton>
      </>
    ) : null;
  const screen = isVm ? vmScreenSeam(tile.entry.host, vm ?? undefined) : null;
  // a poor link's way out: the lighter picture, where Windows takes it now
  const faster = screen?.canResize && screen.detail !== "faster" ? () => screen.onPick({ detail: "faster" }) : undefined;
  const action = !isVm || !vm ? undefined : vm.state === "none" ? <OpenSettingsButton /> : linked && vm.state === "asleep" && vm.heldAsleep && !vm.blocked ? <WakeButton host={tile.entry.host} /> : undefined;
  return (
    <ComputerBar
      tile={tile}
      linkLost={!linked}
      onOpenSession={onOpenSession}
      onTookOver={onTookOver}
      // where it runs is said once: a picture this desktop may not draw already names the machine
      where={picture && tile.shownOn ? null : tile.where}
      reading={reading}
      vm={isVm ? vm : null}
      screen={screen}
      onFaster={faster}
      action={action}
      views={views}
    />
  );
}

/** The page: its header (the stage's bar, or its name when nothing is driven), the stage and the strip, or the one empty state. */
export function ComputersPage({ tiles, onOpenSession, pictureOf, size: given, frame, vms, reading }: ComputersPageProps) {
  const [measured, pageRef, page] = useSize();
  const size = measured.width > 0 || !given ? measured : given;
  const [pick, setPick] = useState<string | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const focusOnDrive = useRef(false);
  const [measuredReading, setMeasuredReading] = useState<{ key: string; reading: BarReading } | null>(null);
  const onReading = useCallback((key: string, reading: BarReading | null) => {
    setMeasuredReading((was) => reading ? { key, reading } : was?.key === key ? null : was);
  }, []);
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
  const staged = tiles.find((tile) => tileKey(tile, tiles) === front);
  // ⌃⌘F takes the stage's computer full screen while it has a live picture here
  const offer = !pictureOf && staged && !staged.vm && !staged.shownOn ? { host: staged.entry.host, threadId: viewKey(staged), name: tileLabel(staged) } : null;
  useEffect(() => (offer ? offerFullScreen(offer) : undefined), [offer?.host, offer?.threadId, offer?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const layout = stageLayout(size, tiles.length);
  const picture =
    pictureOf ??
    ((tile: ComputerTile, place: Place) =>
      tile.vm ? (
        <RestingVmPicture host={tile.entry.host} vm={tile.vm} place={place} />
      ) : tile.shownOn ? (
        <ElsewherePicture machine={tile.shownOn} />
      ) : (
        <LivePicture tile={tile} place={place} focusOnDrive={focusOnDrive} readStage={tileKey(tile, tiles)} onReading={onReading} />
      ));
  const pictures = new Map(keyed.map(({ tile, key }) => [key, picture(tile, key === front ? { stage: true, room: layout.room } : { stage: false })]));
  // where the stage's picture is on his screen: full screen grows it from there
  const pictureRect = (): ScreenRect | undefined => {
    const room = page?.querySelector("[data-stage] [data-slot=computer-picture-room]");
    return room ? screenRectOf(room.getBoundingClientRect()) : undefined;
  };
  const bar = staged ? (
    <StageBar
      tile={staged}
      vm={staged.vm ?? vms?.[staged.entry.host] ?? null}
      picture={!!pictures.get(front ?? "")}
      onOpenSession={onOpenSession}
      onTookOver={() => void (focusOnDrive.current = true)}
      pictureRect={pictureRect}
      reading={reading ?? (!pictureOf && !staged.vm && !staged.shownOn && measuredReading?.key === front ? measuredReading?.reading : null)}
    />
  ) : null;
  const header = <ComputersHeader {...frame} bar={bar} />;
  if (tiles.length === 0)
    return (
      <>
        {header}
        <EmptyState title="Nothing is being driven" line="A browser or an app an agent is using shows here, live." />
      </>
    );
  // the strip in the order they acted, the latest first; the elements stay in one order, so none is ever remade
  const rank = new Map([...keyed].sort((a, b) => b.lastCallAt - a.lastCallAt || a.key.localeCompare(b.key)).map((k, i) => [k.key, i]));
  const others = tiles.length - 1;
  const grid: CSSProperties =
    layout.strip === "side"
      ? { gridTemplateColumns: `minmax(0, 1fr) ${layout.stripWidth}px`, gridTemplateRows: `repeat(${others}, auto) 1fr` }
      : layout.strip === "below"
        ? { gridTemplateColumns: `repeat(${Math.min(others, 2)}, minmax(0, 1fr))` }
        : { gridTemplateColumns: "minmax(0, 1fr)" };
  // the stage's picture sits in the middle of its room, both ways; under it on a narrow page the strip follows at once
  const stagePlace: CSSProperties =
    layout.strip === "side"
      ? { gridColumn: 1, gridRow: `1 / span ${others + 1}`, minHeight: layout.room.height }
      : layout.strip === "below"
        ? { gridColumn: "1 / -1", gridRow: 1 }
        : { minHeight: layout.room.height };
  return (
    <>
      {header}
      <div ref={pageRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
        <div data-slot="computer-tiles" data-strip={layout.strip} className="grid items-start gap-4 p-4" style={grid}>
          {[...keyed]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map(({ tile, key }) => {
              const on = key === front;
              return (
                <div key={key} className={cn("min-w-0", on && "flex items-center justify-center")} style={on ? stagePlace : { gridColumn: layout.strip === "side" ? 2 : undefined, order: rank.get(key) }}>
                  <Tile tile={tile} stage={on} onStage={() => setPick(key)} picture={pictures.get(key)} />
                </div>
              );
            })}
        </div>
      </div>
    </>
  );
}

/**
 * The page's 40px header. It IS the bar of the computer on the stage; the page's own name stays as its heading for a
 * screen reader, and shows when nothing is driven.
 */
export function ComputersHeader({ besideRail = false, onClose, onToggleSidebar, bar }: Partial<PageFrame> & { bar?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
      {IS_MAC && !besideRail && onClose ? <div className="w-[78px] shrink-0" /> : null}
      {besideRail || !onClose || !onToggleSidebar ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
      <h1 className={bar ? "sr-only" : "m-0 flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px] font-medium"}>
        {bar ? null : <Desktop aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate">Computers</span>
      </h1>
      {bar}
      {IS_MAC || !onClose ? null : <WindowControls />}
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
      <ComputersPage
        tiles={tiles}
        vms={vms}
        frame={{ besideRail, onClose, onToggleSidebar }}
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
