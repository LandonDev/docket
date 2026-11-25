import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { clock, frameCentre, frameCount, frameStart, tableDuration, tableFps } from "@shared/mediaFrames";
import type { FrameTable, MediaNote, MediaRegion, MediaVersion } from "@shared/contract-work-media";
import { RowsMenu } from "../../chrome/menuRows";
import { Minimize2, Pause, Play } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { STALL_SHOWN_MS } from "../../lib/ease";
import { Tip } from "../../components/tip";
import { TooltipProvider } from "../../components/ui/tooltip";
import { chordKey } from "../../lib/keys";
import { Comment, FullScreen, Volume, VolumeOff } from "../icons";
import { RegionLayer } from "./parts";
import { seekToFrame, stepFrame, watchFrames } from "./seek";
import { attachSegments, type SegmentFeed } from "./segments";
import { shownPlay } from "./plays";
import type { MediaActions } from "./store";

/**
 * The player (docs/DESIGN.md "Images and video"): the frame at radius 8,
 * the scrubber (a 24px hit row, a 4px track, a 12px head, a 2 by 6 tick at
 * each note), the 32px transport. Everything is keyed by frame index: a
 * seek goes to the frame's centre (seek.ts), the clock reads the frame from
 * the frame callbacks, and a step adds frames, never seconds. Two versions
 * (a compare) play on one transport, in step by frame.
 */

/** Why a Play was refused, in his words (never the browser's own message): a format this computer cannot play, else a file that did not load (an address that lapsed, bytes cut short). */
export const playWords = (name: unknown): string => (name === "NotSupportedError" ? "Its format does not play here" : "Its file did not load");

export interface PlayerHandle {
  seek(frame: number): Promise<void>;
  /** Plays again after a refused Play: the elements load their source afresh first. */
  play(): void;
  /** Where a moment sits on screen: the scrubber's x at that frame, for a popover to point at. */
  rectAt(frame: number): DOMRect | null;
}

export interface Stretch {
  from: number;
  to: number;
}

const SPEEDS = [0.5, 1, 1.5, 2];

const tableOf = (v: MediaVersion): FrameTable | null => {
  const play = shownPlay(v);
  return play && "table" in play ? play.table : null;
};

/** What the state line says of a proxy segment that did not come: the host's words for it are transport, not his. */
export const FEED_FAILED = "Part of the video did not load";

const playsHls = (v: MediaVersion): boolean => shownPlay(v)?.via === "hls";

/**
 * What the state line says of the element's own error, by its `MediaError` code; null for one it should not hear of: an
 * abort (a source we swapped) or any error once we took the source away (a teardown's `load()` on no source).
 */
export function nativeErrorWords(video: Pick<HTMLVideoElement, "error" | "getAttribute">): string | null {
  const code = video.error?.code;
  if (!code || code === 1 || !video.getAttribute("src")) return null;
  if (code === 2) return "The video stopped loading";
  if (code === 3) return "Part of the video could not be read";
  if (code === 4) return "This video cannot be played here";
  return "The video stopped";
}

/**
 * Points a `<video>` at a version: the file's URL, or the HLS proxy through Media Source. A segment that fails stops the
 * feed, and `onFeedError` hears of it; a new `round` builds the feed again from nothing (a MediaSource attaches once).
 */
function useSource(video: HTMLVideoElement | null, version: MediaVersion, actions: MediaActions, round: number, onFeedError: (err: unknown) => void): void {
  const failed = useRef(onFeedError);
  failed.current = onFeedError;
  const play = shownPlay(version);
  const feed = useRef<SegmentFeed | null>(null);
  const hls = play?.via === "hls" ? play : null;
  const url = play && (play.via === "original" || play.via === "proxy") ? play.url : null;
  useEffect(() => {
    if (!video || !url) return;
    video.src = url;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [video, url]);
  const init = hls?.init ?? null;
  useEffect(() => {
    if (!video || !init || !hls) return;
    feed.current = attachSegments(
      video,
      { init, segments: hls.segments, ended: hls.ended, mime: hls.mime },
      async (i) => Uint8Array.from(atob(await actions.segment(version.id, i)), (c) => c.charCodeAt(0)).buffer,
      (err) => failed.current(err),
    );
    return () => {
      feed.current?.destroy();
      feed.current = null;
    };
    // The feed is made once per version and round; later lists reach it through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, init, version.id, round]);
  useEffect(() => {
    if (hls) feed.current?.update(hls.segments, hls.ended);
  }, [hls]);
}

/** The picture's shape as the probe read it, turned where the file says to turn it; 16:9 until it is known. */
export function frameRatio(probe: MediaVersion["probe"] | undefined): number {
  const turned = probe?.rotation === 90 || probe?.rotation === 270;
  return probe && probe.width && probe.height ? (turned ? probe.height / probe.width : probe.width / probe.height) : 16 / 9;
}

/**
 * The frame's box at a shape: as wide as the player, and never taller than 58% of the window. The bones take the same box.
 * Full screen lifts the cap (`--frame-cap` on the player) to the screen less the track and the transport.
 */
const frameStyle = (ratio: number): CSSProperties => ({ aspectRatio: String(ratio), maxWidth: `calc(var(--frame-cap, 58vh) * ${ratio})` });
/** The whole player full screen: the frame as large as the screen leaves room for, the track and transport under it. */
const FULL = "[&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:justify-center [&:fullscreen]:bg-background [&:fullscreen]:px-6 [&:fullscreen]:pb-3 [&:fullscreen]:[--frame-cap:calc(100vh_-_96px)]";

function Screen({ version, label, videoRef, region, selecting, stalled = false, onRegion, onClick }: { version: MediaVersion; label?: string; videoRef(el: HTMLVideoElement | null): void; region: MediaRegion | null; selecting: boolean; stalled?: boolean; onRegion?(r: MediaRegion, rect: DOMRect): void; onClick(): void }) {
  return (
    <div className="min-w-0">
      {label ? <div className="mb-1 text-xs text-muted-foreground">{label}</div> : null}
      <div
        data-media-frame
        className="relative mx-auto w-full overflow-hidden rounded-lg bg-matte outline-1 -outline-offset-1 outline-(--image-outline)"
        style={frameStyle(frameRatio(version.probe))}
      >
        <video ref={videoRef} playsInline preload="auto" className="absolute inset-0 size-full object-contain" />
        <RegionLayer shown={region} selecting={selecting} onRegion={onRegion} onClick={onClick} />
        {/* A stall past STALL_SHOWN_MS: the spinner at the frame's centre on a round of the matte, whatever the picture under it. */}
        {stalled ? (
          <span data-media-stalled role="status" aria-label="Loading the video" className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid size-8 place-items-center rounded-full bg-matte/50 text-(--paper)">
              <Spinner className="size-4" />
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function Player({
  ref,
  versions,
  labels,
  actions,
  notes,
  chapters,
  current,
  region,
  selecting,
  stretch,
  onFrame,
  onStretch,
  onRegion,
  onComment,
  onPlayFailed,
}: {
  ref?: Ref<PlayerHandle>;
  /** One version, or two for a compare: the first drives the clock. */
  versions: MediaVersion[];
  labels?: string[];
  actions: MediaActions;
  /** The notes on the first version, ticked on the track. */
  notes: MediaNote[];
  chapters: MediaNote[];
  current: string | null;
  /** The region to draw over the frame: the current note's, or the one being asked about. */
  region: MediaRegion | null;
  selecting: boolean;
  stretch: Stretch | null;
  onFrame(frame: number): void;
  onStretch(stretch: Stretch | null, rect: DOMRect | null): void;
  onRegion(region: MediaRegion, rect: DOMRect, frame: number): void;
  onComment(frame: number, rect: DOMRect | null): void;
  /** A Play the element refused, in words, and null once one plays: the kind's state line says it, with Retry. */
  onPlayFailed?(reason: string | null): void;
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [primary, setPrimary] = useState<HTMLVideoElement | null>(null);
  const [second, setSecond] = useState<HTMLVideoElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  // The first screen waiting for its bytes past STALL_SHOWN_MS (`waiting`), until it plays, a seek lands or it pauses.
  const [stalled, setStalled] = useState(false);
  const stall = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(stall.current), []);
  // While he drags the head: the frame under the pointer, drawn before the seek lands; the last seek asked.
  const [scrub, setScrub] = useState<number | null>(null);
  const seeking = useRef<Promise<void> | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Full screen holds the whole player, so the track and the transport come with the picture.
  const [full, setFull] = useState(false);
  useEffect(() => {
    const changed = (): void => setFull(!!root.current && document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const fullScreen = (): void => {
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen?.();
      return;
    }
    // The focus moves into the player, so Space plays there instead of pressing Full screen again.
    void el.requestFullscreen?.()?.then(
      () => el.focus({ preventScroll: true }),
      () => undefined,
    );
  };
  const table = tableOf(versions[0]);
  const total = table ? frameCount(table) : 0;
  const start = table ? frameStart(table, 0) : 0;

  // A proxy segment that failed after Play stalls the picture with no refusal: it is said on the same state line, and
  // Retry (`play`) builds the feed again, where the video stood.
  const [feedRound, setFeedRound] = useState(0);
  const resumeAt = useRef<number | null>(null);
  const failedRef = useRef(onPlayFailed);
  failedRef.current = onPlayFailed;
  const feedFailed = useCallback(() => failedRef.current?.(FEED_FAILED), []);
  useSource(primary, versions[0], actions, feedRound, feedFailed);
  useSource(second, versions[1] ?? versions[0], actions, feedRound, feedFailed);

  const all = (): HTMLVideoElement[] => videos.current.filter((v): v is HTMLVideoElement => !!v);
  // One ref per screen for the element's life: a new callback each render would detach and attach it every time.
  const live = useRef({ muted, rate });
  live.current = { muted, rate };
  const attach = (i: number, el: HTMLVideoElement | null): void => {
    videos.current[i] = el;
    if (!el) return;
    el.muted = live.current.muted;
    el.playbackRate = live.current.rate;
    if (i === 0) {
      const going = (): void => {
        clearTimeout(stall.current);
        setStalled(false);
      };
      el.onplay = () => setPaused(false);
      el.onpause = () => (setPaused(true), going());
      el.onwaiting = () => {
        clearTimeout(stall.current);
        stall.current = setTimeout(() => setStalled(true), STALL_SHOWN_MS);
      };
      el.onplaying = going;
      el.onseeked = going;
      el.onemptied = going;
    }
    // The element's own failure (a dropped connection, a frame it cannot decode) stalls the picture with no refusal, after
    // Play as before it: said on the same state line, and Retry loads it again where it stood.
    el.onerror = () => {
      const words = nativeErrorWords(el);
      if (words) failedRef.current?.(words);
    };
  };
  const refFirst = useCallback((el: HTMLVideoElement | null) => (attach(0, el), setPrimary(el)), []);
  const refSecond = useCallback((el: HTMLVideoElement | null) => (attach(1, el), setSecond(el)), []);

  const seek = useCallback(
    async (n: number): Promise<void> => {
      const shown = await Promise.all(
        all().map((v, i) => {
          const t = tableOf(versions[i] ?? versions[0]);
          return t ? seekToFrame(v, t, n) : Promise.resolve(n);
        }),
      );
      setFrame(shown[0] ?? n);
    },
    // versions' tables are what a seek reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versions],
  );

  const xOf = (n: number): number => (total > 1 ? n / (total - 1) : 0);
  useImperativeHandle(ref, () => ({
    seek,
    play: () => {
      const vs = all();
      if (versions.some(playsHls)) {
        // The feeds are built again first; the effect below plays once they are in place.
        resumeAt.current = vs[0]?.currentTime ?? 0;
        setFeedRound((n) => n + 1);
        return;
      }
      // Loaded again from where each stood: a load goes back to the start, and the default start position puts it back.
      for (const v of vs) {
        const t = v.currentTime;
        v.load();
        if (t > 0) v.currentTime = t;
      }
      playAll(vs);
    },
    rectAt: (n) => {
      const r = track.current?.getBoundingClientRect();
      return r ? new DOMRect(r.left + xOf(n) * r.width, r.top, 0, r.height) : null;
    },
  }));

  // After Retry's new feeds are attached (the source effects above run first): back to where the video stood, and play.
  useEffect(() => {
    const t = resumeAt.current;
    if (t === null) return;
    resumeAt.current = null;
    const vs = all();
    vs.forEach((v, i) => {
      if (!playsHls(versions[i] ?? versions[0])) v.load();
      v.currentTime = t;
    });
    playAll(vs);
    // only a new round resumes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRound]);

  // The clock: the frame on screen, from the first version's frame callbacks.
  useEffect(() => {
    if (!primary || !table) return;
    return watchFrames(primary, table, setFrame);
  }, [primary, table]);
  useEffect(() => onFrame(frame), [frame, onFrame]);

  // A compare keeps the second cut on the first's frame while playing; a drift past two frames is put right.
  useEffect(() => {
    const t2 = versions[1] ? tableOf(versions[1]) : null;
    if (!second || !t2 || paused) return;
    const want = frameCentre(t2, frame);
    if (Math.abs(second.currentTime - want) > 2 / (tableFps(t2) || 24)) second.currentTime = want;
  }, [frame, second, versions, paused]);

  /** Frames from the one shown, or from where a running seek heads, so quick presses add up; a compare's second cut follows. */
  const stepBy = (delta: number): void => {
    if (!primary || !table) return;
    void stepFrame(primary, table, delta).then((n) => {
      setFrame(n);
      const t2 = versions[1] ? tableOf(versions[1]) : null;
      if (second && t2) void seekToFrame(second, t2, n);
    });
  };

  /** Plays every screen; a refusal is said once (a Pause that cut a starting Play is no refusal). */
  const playAll = (vs: HTMLVideoElement[]): void => {
    void Promise.all(vs.map((v) => v.play())).then(
      () => onPlayFailed?.(null),
      (error: unknown) => {
        // A DOMException, which is not always an Error where it is made: read its name as it is.
        const { name } = (error ?? {}) as { name?: unknown };
        if (name === "AbortError") return;
        onPlayFailed?.(playWords(name));
      },
    );
  };

  const toggle = (): void => {
    const vs = all();
    if (!vs.length) return;
    if (vs[0].paused) playAll(vs);
    else for (const v of vs) v.pause();
  };

  const frameFromX = (clientX: number): number => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * Math.max(0, total - 1));
  };
  const drag = useRef<{ anchor: number; shift: boolean } | null>(null);
  const stretchRect = (s: Stretch): DOMRect | null => {
    const r = track.current?.getBoundingClientRect();
    return r ? new DOMRect(r.left + xOf(s.from) * r.width, r.top - 6, (xOf(s.to) - xOf(s.from)) * r.width, r.height + 12) : null;
  };

  const ticks = notes.filter((n) => n.kind === "comment" && n.anchor.frame !== undefined && !n.parentId);
  const chapterStarts = chapters.map((c) => c.anchor.frame ?? 0).sort((a, b) => a - b);
  // The head, the fill and the clock follow the pointer while he drags; the frame on screen otherwise.
  const shown = scrub ?? frame;
  const p = xOf(shown) * 100;
  /** A seek while he drags: the head is at `n` at once, and the last seek asked is the one his release waits on. */
  const scrubTo = (n: number): void => {
    setScrub(n);
    seeking.current = seek(n);
  };
  /** His release: the head stays at the pointer until the last seek lands, so it never steps back to an older frame. */
  const scrubDone = (): void => {
    const last = seeking.current;
    seeking.current = null;
    if (!last) return setScrub(null);
    void last.then(() => {
      if (!drag.current) setScrub(null);
    });
  };

  return (
    <div
      ref={root}
      data-media-player
      tabIndex={0}
      className={`focus-ring @container min-w-0 px-3 pt-3 ${FULL}`}
      onKeyDown={(e) => {
        if (!table || chordKey(e)) return;
        // A focused control keeps its own keys: Space presses the button, the arrows move in a menu.
        if (e.target !== e.currentTarget && (e.target as HTMLElement).closest("button, input, textarea, [role=menu], [role=menuitem]")) return;
        const step = e.shiftKey ? Math.max(1, Math.round(tableFps(table))) : 1;
        if (e.key === " " || e.key === "k") toggle();
        else if (e.key === "ArrowLeft" || e.key === ",") stepBy(-step);
        else if (e.key === "ArrowRight" || e.key === ".") stepBy(step);
        else if (e.key === "Home") void seek(0);
        else if (e.key === "End") void seek(total - 1);
        else if (e.key === "Escape" && stretch) onStretch(null, null);
        else return;
        e.preventDefault();
      }}
    >
      {/* Two cuts sit side by side from a 600px player; narrower, one over the other, so neither shrinks to a sliver. */}
      <div data-media-cuts={versions.length > 1 || undefined} className={versions.length > 1 ? "grid gap-2 @[600px]:grid-cols-2" : ""}>
        {versions.map((v, i) => (
          <Screen
            key={v.id}
            version={v}
            label={labels?.[i]}
            videoRef={i === 0 ? refFirst : refSecond}
            region={i === 0 ? region : null}
            selecting={selecting}
            stalled={i === 0 && stalled}
            // A compare takes no region: which cut it was drawn on would be lost on the chip.
            onRegion={
              versions.length > 1
                ? undefined
                : (r, rect) => {
                    for (const v of all()) v.pause();
                    onRegion(r, rect, frame);
                  }
            }
            onClick={toggle}
          />
        ))}
      </div>

      {/* The scrubber: drag to scrub, Shift and drag to take a stretch. */}
      <div
        ref={track}
        role="slider"
        aria-label="Frame"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, total - 1)}
        aria-valuenow={shown}
        aria-valuetext={clock(table ? frameStart(table, shown) - start : 0)}
        className="relative mt-1.5 flex h-6 cursor-default touch-none items-center"
        onPointerDown={(e) => {
          if (e.button !== 0 || !total) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const n = frameFromX(e.clientX);
          drag.current = { anchor: n, shift: e.shiftKey };
          if (e.shiftKey) onStretch({ from: n, to: n }, null);
          else {
            onStretch(null, null);
            scrubTo(n);
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const n = frameFromX(e.clientX);
          if (d.shift) onStretch({ from: Math.min(d.anchor, n), to: Math.max(d.anchor, n) }, null);
          else scrubTo(n);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d?.shift) return scrubDone();
          const n = frameFromX(e.clientX);
          const s = { from: Math.min(d.anchor, n), to: Math.max(d.anchor, n) };
          onStretch(s.to > s.from ? s : null, s.to > s.from ? stretchRect(s) : null);
        }}
        onPointerCancel={() => ((drag.current = null), scrubDone())}
        onLostPointerCapture={() => {
          if (!drag.current) return;
          drag.current = null;
          scrubDone();
        }}
      >
        <div className="relative h-1 flex-1">
          {chapterStarts.length ? (
            <div className="absolute inset-0 flex gap-0.5">
              {chapterStarts.map((from, i) => {
                const to = chapterStarts[i + 1] ?? total;
                const fill = shown >= to ? 100 : shown > from ? ((shown - from) / Math.max(1, to - from)) * 100 : 0;
                return (
                  <span key={from} className="relative h-full min-w-0 overflow-hidden rounded-[2px] bg-(--track)" style={{ flex: `0 1 ${((to - from) / Math.max(1, total)) * 100}%` }}>
                    <span className="absolute inset-y-0 start-0 bg-foreground" style={{ width: `${fill}%` }} />
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="absolute inset-0 rounded-[2px] bg-(--track)">
              <span className="absolute inset-y-0 start-0 rounded-[2px] bg-foreground" style={{ width: `${p}%` }} />
            </div>
          )}
          {ticks.map((n) => (
            <i
              key={n.id}
              aria-hidden
              className={`absolute bottom-[9px] h-1.5 w-0.5 -translate-x-1/2 rounded-[1px] ${n.state === "suggested" ? "bg-success" : n.id === current || n.anchor.frame === frame ? "bg-foreground" : "bg-muted-foreground"}`}
              style={{ left: `${xOf(n.anchor.frame!) * 100}%` }}
            />
          ))}
          {stretch ? (
            <span
              data-media-stretch
              aria-hidden
              className="absolute -inset-y-1.5 rounded-[3px] bg-(--sel-bg) before:absolute before:inset-y-0.5 before:start-0 before:w-0.5 before:rounded-[1px] before:bg-foreground after:absolute after:inset-y-0.5 after:end-0 after:w-0.5 after:rounded-[1px] after:bg-foreground"
              style={{ left: `${xOf(stretch.from) * 100}%`, width: `${(xOf(stretch.to) - xOf(stretch.from)) * 100}%` }}
            />
          ) : null}
          <span aria-hidden data-media-head className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--background)]" style={{ left: `${p}%` }} />
        </div>
      </div>

      {/* The transport: its buttons' labels share one hover delay. */}
      <TooltipProvider>
        <div className="-mx-1 flex h-8 items-center gap-0.5">
          <Tip label={paused ? "Play" : "Pause"}>
            <Button variant="ghost" size="icon-sm" aria-label={paused ? "Play" : "Pause"} disabled={!table} onClick={toggle}>
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            </Button>
          </Tip>
          <span className="mx-1 text-[13px] leading-5 whitespace-nowrap tabular-nums">
            {clock(table ? frameStart(table, shown) - start : 0)} <span className="text-muted-foreground">/ {clock(table ? tableDuration(table) : 0)}</span>
          </span>
          <Tip label="Comment at this frame">
            <Button variant="ghost" size="icon-xs" aria-label="Comment at this frame" disabled={!table} onClick={() => onComment(frame, track.current ? new DOMRect(track.current.getBoundingClientRect().left + xOf(frame) * track.current.getBoundingClientRect().width, track.current.getBoundingClientRect().top, 0, 24) : null)}>
              <Comment className="size-3.5" />
            </Button>
          </Tip>
          <span className="ms-auto flex items-center gap-0.5">
            <RowsMenu
              label="Speed"
              align="end"
              rows={SPEEDS.map((s) => ({ kind: "item" as const, id: String(s), label: `${s}×`, checked: s === rate }))}
              onPick={(id) => {
                const s = Number(id);
                setRate(s);
                for (const v of all()) v.playbackRate = s;
              }}
              trigger={
                <Button variant="ghost" size="xs" className="w-10 font-normal text-muted-foreground tabular-nums">
                  {rate}×
                </Button>
              }
            />
            <Tip label={muted ? "Sound on" : "Sound off"}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={muted ? "Sound on" : "Sound off"}
                className="text-muted-foreground"
                onClick={() => {
                  setMuted(!muted);
                  for (const v of all()) v.muted = !muted;
                }}
              >
                {muted ? <VolumeOff className="size-3.5" /> : <Volume className="size-3.5" />}
              </Button>
            </Tip>
            <Tip label={full ? "Leave full screen" : "Full screen"}>
              <Button variant="ghost" size="icon-xs" aria-label={full ? "Leave full screen" : "Full screen"} className="text-muted-foreground" onClick={fullScreen}>
                {full ? <Minimize2 className="size-3.5" /> : <FullScreen className="size-3.5" />}
              </Button>
            </Tip>
          </span>
        </div>
      </TooltipProvider>
    </div>
  );
}

/**
 * The player's place while the host reads the file: the frame at the file's own shape once the probe has read it (a
 * vertical short stands tall, never 16:9 then narrow), the track and the transport as bones, each in the box and at the
 * height the player gives it, so nothing under the player moves when it lands.
 */
export function PlayerSkeleton({ line, probe }: { line?: ReactNode; probe?: MediaVersion["probe"] }) {
  return (
    <div className="px-3 pt-3">
      {/* A wait with words in it (a copy being made to play) is the frame on the stage, so its bar's track shows; else the bone. */}
      <Skeleton
        data-media-frame-bone
        className={`relative mx-auto grid w-full place-items-center rounded-lg ${line && typeof line !== "string" ? "bg-(--stage) outline-1 -outline-offset-1 outline-(--image-outline)" : ""}`}
        style={frameStyle(frameRatio(probe))}
      >
        {line ? typeof line === "string" ? <span className="text-xs text-muted-foreground">{line}</span> : line : null}
      </Skeleton>
      <div data-media-track-bone className="mt-1.5 flex h-6 items-center">
        <Skeleton className="h-1 flex-1 rounded-[2px]" />
      </div>
      <div data-media-transport-bone className="-mx-1 flex h-8 items-center gap-0.5">
        <span className="grid size-7 place-items-center">
          <Skeleton className="size-4 rounded" />
        </span>
        <Skeleton className="mx-1 h-3 w-[76px] rounded" />
      </div>
    </div>
  );
}
