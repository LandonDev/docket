import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import { Lock } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { Tip, TruncateTip, useTruncated } from "../../components/tip";
import { FADE_IN } from "../../components/ui/reveal";
import { cn } from "../../lib/cn";
import { treeIds } from "../../lib/activity";
import { drawable, useComputerSection } from "../../lib/computerSection";
import { useComputerEntries, type ComputerEntry } from "../../lib/computerSessions";
import { thisDesktopInLine } from "../../lib/native";
import { hostName } from "../../lib/threadResources";
import { useSessionMetas } from "../../lib/tcserver/store";
import { DRIVEN, DRIVEN_CLASS, ENDED_WORDS, OPEN_OVER, liveFace, pictureClass, RETRY_ENDS, sharpOf, streamSize, useDrivingInput, useLiveStream, VIEWPORT_INSETS, ViewportLine } from "../../surfaces/threads/computer/Viewport";
import { openFullWindow } from "../../lib/fullWindow";
import { useDriveHold } from "../../lib/driveHold";
import { sharpWidth } from "../../lib/video/support";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps } from "../canvas/kind";
import { barFaceOf, heldSubmitOf, portalValues, siteHost, type BarFace, type HeldSubmitPayload, type PortalValue } from "./portal";
import { discardHeld, pictureShown, setDriver, setLiveDrawn, submitHeld, useBrowserState, useHeldActs, useHeldPicture, useLiveDrawn } from "./store";

/**
 * The live browser (docs/agents/work-browser.md "The canvas"; the approved
 * prototype's "Watch, and take over"): computer use on the Mac, shown full
 * size by the Computer section's viewport rules. The bar holds the site's
 * host, who drives and one verb. A submit the computer hold kept waits on
 * its final screen: the bar ends in the one primary named for the act, and
 * the page's values sit under the picture beside where each came from.
 */

/** The thread whose pane the item is in: the browser's state is kept by it. */
const paneOf = ({ item, source }: Pick<CanvasBodyProps, "item" | "source">): string => (source.at === "browser" ? source.sessionId : item.sessionId);

export interface Browser {
  state: BrowserState | null;
  held: OutboxItem | null;
  /** the session whose window the canvas follows; null when none is live or this desktop cannot draw it */
  entry: ComputerEntry | null;
  /** every live session of the pane's tree on its host, drawable here or not: Take over stops them all */
  live: ComputerEntry[];
  /** why the first read of who drives failed, while nothing has been read */
  error?: string | null;
  retry?(): void;
}

function useBrowser(env: string, pane: string): Browser {
  const { state, error, retry } = useBrowserState(env, pane);
  const acts = useHeldActs(env, pane);
  const metas = useSessionMetas();
  const treeKey = [...treeIds(pane, metas)].sort().join("\n");
  const tree = useMemo(() => new Set(treeKey.split("\n")), [treeKey]);
  const section = useComputerSection(pane);
  const held = useMemo(() => heldSubmitOf(acts, tree, state?.site ? state.since : 0), [acts, tree, state?.site, state?.since]);
  const live = useComputerEntries(tree, env);
  const entries = useMemo(() => drawable(section.entries), [section.entries]);
  return { state, held, entry: entries[0] ?? null, live, error, retry };
}

/** A press: one at a time (a second click before the re-render too), its failure said once in the thread's toast stack. */
function usePress(): [string | null, (which: string, run: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  const pressing = useRef(false);
  const press = (which: string, run: () => Promise<unknown>): void => {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(which);
    void run()
      .catch((err: unknown) => sayError(err, "That did not go through"))
      .finally(() => {
        pressing.current = false;
        setBusy(null);
      });
  };
  return [busy, press];
}

/** A preview's stand-ins: what the host would answer, and the page in place of the live window. */
export interface BrowserSeam {
  data?: Browser;
  picture?: ReactNode;
}

export function Bar(props: CanvasBodyProps & BrowserSeam) {
  const { env } = props;
  const pane = paneOf(props);
  const fetched = useBrowser(env, pane);
  const { state, held, entry, error } = props.data ?? fetched;
  const face = barFaceOf(state, held);
  // While a submit waits and the agent drives, the body draws the held page's kept picture, a live window or not: his press
  // approves what he has seen, so the primary waits until that picture has drawn (or none was kept), and stays off while it
  // comes or failed. Once he has taken over a window this desktop draws, he sees it live, and the still and its wait give way
  // to the live view's: the primary waits until that view has drawn a frame (a skeleton or an ended stream keeps it off).
  const takenOver = face.face === "held" && face.owner && !!entry && !props.picture;
  const still = face.face === "held" && !takenOver && !props.picture ? face.item.ref : null;
  const picture = useHeldPicture(env, still);
  const drawn = useLiveDrawn(`${env}\n${pane}`);
  const seen = takenOver ? drawn : !still || pictureShown(picture);
  const [busy, press] = usePress();
  // one call: the host hands him the wheel, then stops every session of the tree for its turn
  const takeOver = (): void => press("take", () => setDriver(env, pane, "owner"));
  const handBack = (): void => press("back", () => setDriver(env, pane, "agent"));
  // this canvas is one of his places that show the page he drives: the last of them to go hands it back (driveHold.ts)
  useDriveHold(`${env}\nbrowser:${pane}`, face.face === "owner" || (face.face === "held" && face.owner), () => setDriver(env, pane, "agent"));
  const host = siteHost(state);
  // A first read that failed is the state line's alone: the bar holds no bone that would never fill.
  if (error) return null;
  // Its own container, the free room in the bar: a verb the pane cannot hold gives way by the pane's width, not the window's,
  // and who drives goes whole before its verb would be cut (the verb already says it).
  return (
    <span data-slot="browser-bar" className="@container/browser flex min-w-0 flex-1 items-center gap-2">
      {face.face === "loading" ? (
        <Skeleton className="h-3 w-32" />
      ) : host ? (
        <Host host={host} />
      ) : null}
      <FaceEnd face={face} env={env} busy={busy} seen={seen} press={press} takeOver={takeOver} handBack={handBack} />
    </span>
  );
}

/**
 * The site's host, the destination he approves a submit for: cut to its room, and while cut it takes the focus too, so the
 * keyboard brings up the whole of it in the same tip the pointer does. One tip stays mounted, off while the host fits.
 */
function Host({ host }: { host: string }) {
  const { ref, cut } = useTruncated(host);
  return (
    <span data-slot="browser-host" className="flex min-w-0 items-center gap-1.5 text-foreground">
      <Lock className="size-3 shrink-0 text-muted-foreground" />
      <Tip label={host} disabled={!cut}>
        <span ref={ref} tabIndex={cut ? 0 : undefined} className="focus-ring truncate rounded-sm">
          {host}
        </span>
      </Tip>
    </span>
  );
}

function FaceEnd({
  face,
  env,
  busy,
  seen,
  press,
  takeOver,
  handBack,
}: {
  face: BarFace;
  env: string;
  busy: string | null;
  /** the page his press approves is on screen */
  seen: boolean;
  press: (which: string, run: () => Promise<unknown>) => void;
  takeOver(): void;
  handBack(): void;
}) {
  switch (face.face) {
    case "loading":
      return null;
    case "agent":
      return (
        <span className="ms-auto flex shrink-0 items-center gap-2">
          <span data-narrow-hide className="whitespace-nowrap @max-[320px]/browser:hidden">The agent is driving</span>
          <Button variant="secondary" size="xs" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </span>
      );
    case "needs":
      return (
        <span className="ms-auto flex min-w-0 items-center gap-2">
          <StatusMark state="waiting" word={face.words} className="min-w-0 truncate" />
          <Button size="xs" className="shrink-0" disabled={!!busy} onClick={takeOver}>
            <BusyLabel busy={busy === "take"} label="Take over" />
          </Button>
        </span>
      );
    case "owner":
      return (
        <span className="ms-auto flex shrink-0 items-center gap-2">
          <span data-narrow-hide className="whitespace-nowrap text-foreground @max-[320px]/browser:hidden">You are driving</span>
          <Button variant="secondary" size="xs" data-hand-back disabled={!!busy} onClick={handBack}>
            <BusyLabel busy={busy === "back"} label="Hand back" />
          </Button>
        </span>
      );
    case "done":
      return <span className="ms-auto min-w-0 truncate">{face.words}</span>;
    case "held": {
      const ref = face.item.ref;
      return (
        // The verbs stay whole; the primary takes the room left beside Discard and cuts its words there, never its box or its ring.
        <span className="ms-auto flex min-w-0 items-center gap-1">
          {face.owner ? (
            <Button variant="ghost" size="xs" data-hand-back className="shrink-0" disabled={!!busy} onClick={handBack}>
              <BusyLabel busy={busy === "back"} label="Hand back" />
            </Button>
          ) : (
            <Button variant="ghost" size="xs" data-slot="browser-take-over" className="shrink-0 @max-[540px]/browser:hidden" disabled={!!busy} onClick={takeOver}>
              <BusyLabel busy={busy === "take"} label="Take over" />
            </Button>
          )}
          <Button variant="ghost" size="xs" className="shrink-0" disabled={!!busy} onClick={() => press("discard", () => discardHeld(env, ref))}>
            <BusyLabel busy={busy === "discard"} label="Discard" />
          </Button>
          <Primary label={face.act} busy={busy === "submit"} disabled={!!busy || !seen} onClick={() => press("submit", () => submitHeld(env, ref))} />
        </span>
      );
    }
  }
}

/**
 * The held submit's one primary: its words cut to the room it has (a site's name runs to 80 characters), whole in its
 * name and, while cut, in its tooltip. One tooltip trigger stays mounted around it, the tip off while the words fit, so a
 * pane that narrows or widens never swaps the button (its focus stays) and the measure keeps watching the words shown.
 */
function Primary({ label, busy, disabled, onClick }: { label: string; busy: boolean; disabled: boolean; onClick(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = button.current;
    if (!el) return;
    // Read the words afresh on each measure: a busy press redraws them inside the same button.
    const measure = (): void => {
      const words = el.querySelector<HTMLElement>("[data-slot=busy-label] > span");
      setCut(!!words && words.scrollWidth > words.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [label, busy]);
  return (
    <Tip label={label} disabled={!cut}>
      <Button
        ref={button}
        size="xs"
        data-browser-submit
        aria-label={label}
        // `shrink` lifts the recipe's shrink-0, so the primary gives way to the room beside Discard and cuts its words there.
        className="max-w-full min-w-0 shrink [&_[data-slot=busy-label]]:min-w-0 [&_[data-slot=busy-label]:not([data-busy])>span]:block [&_[data-slot=busy-label]:not([data-busy])>span]:truncate"
        disabled={disabled}
        onClick={onClick}
      >
        <BusyLabel busy={busy} label={label} />
      </Button>
    </Tip>
  );
}

export function Body(props: CanvasBodyProps & BrowserSeam) {
  const { env, shell } = props;
  const pane = paneOf(props);
  const fetched = useBrowser(env, pane);
  const { state, held, entry, live, error, retry } = props.data ?? fetched;
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const waiting = held && (held.state === "held" || held.state === "live") ? held : null;
  // A waiting submit shows the page it kept, never the live window's placeholder, so the stream rests until it is decided;
  // once he takes over he drives the live window, so the body draws it (browser.html "You took over").
  const still = waiting && !(state?.driver === "owner" && entry) ? waiting : null;
  // the view's p-3 is around the picture: 12px a side
  const stream = useLiveStream(entry, !still, box, measure, { inset: VIEWPORT_INSETS });
  // The bar's primary, after he takes over, waits on this view's first frame: say when one is on screen.
  const framed = !props.picture && !still && !!entry && stream.state.status === "live" && stream.state.drawn;
  const liveKey = `${env}\n${pane}`;
  useEffect(() => {
    setLiveDrawn(liveKey, framed);
    return () => setLiveDrawn(liveKey, false);
  }, [liveKey, framed]);

  // Where it runs, said once after the page's title: the Mac a box thread drives, else the thread's own host (none for this one).
  const where = entry?.row.macName ?? live.find((e) => e.row.macName)?.row.macName ?? hostName(env);
  useEffect(() => {
    shell.detail(where === thisDesktopInLine() ? null : where);
    return () => shell.detail(null);
  }, [shell, where]);

  // A first read that failed says so on the one state line, with Retry; the body under it draws nothing that pretends to load.
  useEffect(() => {
    shell.statusLine(error ? { tone: "failed", word: "Couldn't open this browser", detail: error, action: retry ? { label: "Retry", run: retry } : undefined } : null);
    return () => shell.statusLine(null);
  }, [shell, error, retry]);

  const values = useMemo<PortalValue[]>(() => (waiting ? portalValues((waiting.payload as HeldSubmitPayload).mark ?? "", state?.sources ?? []) : []), [waiting, state?.sources]);

  return (
    <div ref={measure} data-slot="browser-view" className="flex h-full min-h-0 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
      {/* The page fills the body inside its inset (browser.html), at any width of canvas. */}
      <div className="flex w-full flex-col gap-3">
        {error && !props.picture ? null : props.picture ??
          (still ? (
            <StillView env={env} held={still} />
          ) : entry ? (
            <LiveView stream={stream} box={box} label={liveLabel(entry)} onOpen={() => openFullWindow({ host: entry.host, threadId: entry.row.threadId, name: liveLabel(entry) })} />
          ) : state ? (
            <StillView env={env} held={waiting} />
          ) : (
            <Skeleton className="aspect-[16/10] w-full rounded-lg" />
          ))}
        {values.length ? <Values values={values} /> : null}
      </div>
    </div>
  );
}

const liveLabel = (entry: ComputerEntry): string => {
  const app = entry.row.apps[0];
  return app ? `Live view of ${app.window ? `${app.window} in ${app.name}` : app.name}` : "Live view";
};

/**
 * The window live, in its own shape, a skeleton in that shape until its first frame. It is as wide as the column and no
 * wider than its own pixels, so the picture is never stretched; a click on it opens the full view.
 */
export function LiveView({ stream, box, label, onOpen }: { stream: ReturnType<typeof useLiveStream>; box: RefObject<HTMLDivElement | null>; label: string; onOpen?: (from: DOMRect) => void }) {
  const face = liveFace(stream, onOpen);
  // while he drives, the picture is his way into the page: his pointer and keys go down the stream
  useDrivingInput(stream, box);
  const size = streamSize(stream.state) ?? { width: 16, height: 10 };
  const ended = stream.state.status === "ended" ? stream.state : null;
  // Bones only while a first frame is on its way: a stream that ended or failed leaves the empty well over its line and Retry.
  const coming = stream.state.status === "starting" || (stream.state.status === "live" && !face.drawn);
  const shape = { aspectRatio: `${size.width} / ${size.height}`, maxWidth: sharpOf(stream) ?? undefined };
  const inside = (
    <>
      {coming ? <Skeleton className="absolute inset-0 rounded-lg" /> : null}
      {face.picture}
      <div className="pointer-events-none absolute inset-0">{face.mark}</div>
    </>
  );
  // One element for the box in every mode (watched, opening, driven): a mode only changes its attributes, so the canvas
  // that took a frame stays through the first frame, Take over and Hand back (a still page sends one frame, then waits
  // for a change). The full view opens from a clear button laid over the picture, there only while he does not drive,
  // off until a frame is there to open, and carrying the box's name while it is there.
  const open = face.driving ? undefined : face.onOpen;
  const role = face.driving ? DRIVEN : open ? {} : { role: "img" as const };
  return (
    <div className={FADE_IN}>
      <div
        ref={box}
        {...role}
        aria-label={open ? undefined : label}
        data-face="live"
        className={cn("relative w-full overflow-hidden rounded-lg bg-card", face.driving && DRIVEN_CLASS)}
        style={shape}
      >
        {inside}
        {open ? (
          <Button
            variant="link"
            aria-label={label}
            data-viewport-open
            disabled={!face.drawn}
            onClick={(e) => open(e.currentTarget.getBoundingClientRect())}
            className={OPEN_OVER}
          />
        ) : null}
      </div>
      {ended ? (
        <div className="pt-1">
          <ViewportLine words={ENDED_WORDS[ended.reason]} onRetry={RETRY_ENDS.has(ended.reason) ? stream.retry : undefined} />
        </div>
      ) : null}
    </div>
  );
}

/** A waiting submit's page, live window or not, and where none can be drawn (the box, the browser /ui): the held page's picture, or one line. The bar's primary waits on the same read. */
function StillView({ env, held }: { env: string; held: OutboxItem | null }) {
  const picture = useHeldPicture(env, held?.ref ?? null);
  const { src } = picture;
  if (!held) return <ViewportLine words="The agent is not driving the browser now" />;
  const payload = held.payload as HeldSubmitPayload | null;
  const shape = payload?.picture ? `${payload.picture.width} / ${payload.picture.height}` : "16 / 10";
  if (src === undefined) return <Skeleton className="w-full rounded-lg" style={{ aspectRatio: shape }} />;
  if (src === "failed") return <ViewportLine words="The page's picture did not load" onRetry={picture.retry} />;
  if (!src) return <ViewportLine words="No picture of this page was kept" />;
  return (
    <img
      src={src}
      alt={held.summary}
      draggable={false}
      onLoad={picture.onLoad}
      onError={picture.onError}
      // in the live picture's own frame: no wider than its pixels, so the two swap without a jump
      className={cn(pictureClass(true), "h-auto")}
      style={{ aspectRatio: shape, maxWidth: payload?.picture ? sharpWidth(payload.picture.width, window.devicePixelRatio || 1) : undefined }}
    />
  );
}

/** The page's values at its final screen, each beside where it came from. */
function Values({ values }: { values: PortalValue[] }) {
  return (
    // Under 480px of its own width the source goes under its label and value, whole, rather than a sliver beside them.
    <div data-slot="browser-values" role="table" aria-label="What the page holds" className="@container/values flex flex-col">
      {values.map((v, i) => (
        <div
          key={`${v.label}-${i}`}
          role="row"
          className="grid min-h-7 grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3 @[480px]/values:grid-cols-[112px_minmax(80px,max-content)_minmax(0,1fr)] border-t border-border py-1 text-[13px] leading-5 first:border-t-0"
        >
          {/* A field's name wraps in its column, whole, so two that open with the same words stay told apart. */}
          <span role="cell" data-value-label className="min-w-0 font-medium break-words">
            {v.label}
          </span>
          <span role="cell" className="min-w-0 break-words tabular-nums">
            {v.value}
          </span>
          <TruncateTip text={v.source ?? ""}>
            <span role="cell" data-value-source className="col-span-2 truncate text-xs text-muted-foreground @[480px]/values:col-span-1">
              {v.source ?? ""}
            </span>
          </TruncateTip>
        </div>
      ))}
    </div>
  );
}
