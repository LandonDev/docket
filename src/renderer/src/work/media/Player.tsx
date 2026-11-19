import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { clock, frameCentre, frameCount, frameStart, tableDuration, tableFps } from "@shared/mediaFrames";
import type { FrameTable, MediaNote, MediaRegion, MediaVersion } from "@shared/contract-work-media";
import { RowsMenu } from "../../chrome/menuRows";
import { Pause, Play } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
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

export interface PlayerHandle {
  seek(frame: number): Promise<void>;
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

/** Points a `<video>` at a version: the file's URL, or the HLS proxy through Media Source. */
function useSource(video: HTMLVideoElement | null, version: MediaVersion, actions: MediaActions): void {
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
    feed.current = attachSegments(video, { init, segments: hls.segments, ended: hls.ended, mime: hls.mime }, async (i) => Uint8Array.from(atob(await actions.segment(version.id, i)), (c) => c.charCodeAt(0)).buffer);
    return () => {
      feed.current?.destroy();
      feed.current = null;
    };
    // The feed is made once per version; later lists reach it through update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, init, version.id]);
  useEffect(() => {
    if (hls) feed.current?.update(hls.segments, hls.ended);
  }, [hls]);
}

function Screen({ version, label, videoRef, region, selecting, onRegion, onClick }: { version: MediaVersion; label?: string; videoRef(el: HTMLVideoElement | null): void; region: MediaRegion | null; selecting: boolean; onRegion?(r: MediaRegion, rect: DOMRect): void; onClick(): void }) {
  const p = version.probe;
  const turned = p?.rotation === 90 || p?.rotation === 270;
  const ratio = p && p.width && p.height ? (turned ? p.height / p.width : p.width / p.height) : 16 / 9;
  return (
    <div className="min-w-0">
      {label ? <div className="mb-1 text-xs text-muted-foreground">{label}</div> : null}
      <div
        data-media-frame
        className="relative mx-auto w-full overflow-hidden rounded-lg bg-black outline-1 -outline-offset-1 outline-(--image-outline)"
        style={{ aspectRatio: String(ratio), maxWidth: `calc(58vh * ${ratio})` }}
      >
        <video ref={videoRef} playsInline preload="auto" className="absolute inset-0 size-full object-contain" />
        <RegionLayer shown={region} selecting={selecting} onRegion={onRegion} onClick={onClick} />
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
}) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [primary, setPrimary] = useState<HTMLVideoElement | null>(null);
  const [second, setSecond] = useState<HTMLVideoElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const track = useRef<HTMLDivElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const table = tableOf(versions[0]);
  const total = table ? frameCount(table) : 0;
  const start = table ? frameStart(table, 0) : 0;

  useSource(primary, versions[0], actions);
  useSource(second, versions[1] ?? versions[0], actions);

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
      el.onplay = () => setPaused(false);
      el.onpause = () => setPaused(true);
    }
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
    rectAt: (n) => {
      const r = track.current?.getBoundingClientRect();
      return r ? new DOMRect(r.left + xOf(n) * r.width, r.top, 0, r.height) : null;
    },
  }));

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

  const toggle = (): void => {
    const vs = all();
    if (!vs.length) return;
    if (vs[0].paused) for (const v of vs) void v.play().catch(() => undefined);
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
  const p = xOf(frame) * 100;

  return (
    <div
      data-media-player
      tabIndex={0}
      className="focus-ring min-w-0 px-3 pt-3"
      onKeyDown={(e) => {
        if (!table || e.metaKey || e.ctrlKey || e.altKey) return;
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
      <div ref={frameBox} className={versions.length > 1 ? "grid grid-cols-2 gap-2" : ""}>
        {versions.map((v, i) => (
          <Screen
            key={v.id}
            version={v}
            label={labels?.[i]}
            videoRef={i === 0 ? refFirst : refSecond}
            region={i === 0 ? region : null}
            selecting={selecting}
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
        aria-valuenow={frame}
        aria-valuetext={clock(table ? frameStart(table, frame) - start : 0)}
        className="relative mt-1.5 flex h-6 cursor-default touch-none items-center"
        onPointerDown={(e) => {
          if (e.button !== 0 || !total) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const n = frameFromX(e.clientX);
          drag.current = { anchor: n, shift: e.shiftKey };
          if (e.shiftKey) onStretch({ from: n, to: n }, null);
          else {
            onStretch(null, null);
            void seek(n);
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const n = frameFromX(e.clientX);
          if (d.shift) onStretch({ from: Math.min(d.anchor, n), to: Math.max(d.anchor, n) }, null);
          else void seek(n);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d?.shift) return;
          const n = frameFromX(e.clientX);
          const s = { from: Math.min(d.anchor, n), to: Math.max(d.anchor, n) };
          onStretch(s.to > s.from ? s : null, s.to > s.from ? stretchRect(s) : null);
        }}
        onPointerCancel={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
      >
        <div className="relative h-1 flex-1">
          {chapterStarts.length ? (
            <div className="absolute inset-0 flex gap-0.5">
              {chapterStarts.map((from, i) => {
                const to = chapterStarts[i + 1] ?? total;
                const fill = frame >= to ? 100 : frame > from ? ((frame - from) / Math.max(1, to - from)) * 100 : 0;
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
          <span aria-hidden className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--background)]" style={{ left: `${p}%` }} />
        </div>
      </div>

      {/* The transport. */}
      <div className="-mx-1 flex h-8 items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label={paused ? "Play" : "Pause"} disabled={!table} onClick={toggle}>
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </Button>
        <span className="mx-1 text-[13px] leading-5 whitespace-nowrap tabular-nums">
          {clock(table ? frameStart(table, frame) - start : 0)} <span className="text-muted-foreground">/ {clock(table ? tableDuration(table) : 0)}</span>
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Comment at this frame" disabled={!table} onClick={() => onComment(frame, track.current ? new DOMRect(track.current.getBoundingClientRect().left + xOf(frame) * track.current.getBoundingClientRect().width, track.current.getBoundingClientRect().top, 0, 24) : null)}>
          <Comment className="size-3.5" />
        </Button>
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
          <Button variant="ghost" size="icon-xs" aria-label="Full screen" className="text-muted-foreground" onClick={() => void frameBox.current?.requestFullscreen?.()}>
            <FullScreen className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  );
}

/** The player's place while the host reads the file: the frame, the track and the transport as bones. */
export function PlayerSkeleton({ line }: { line?: string }) {
  return (
    <div className="px-3 pt-3">
      <div className="relative grid aspect-video w-full place-items-center rounded-lg bg-muted">
        {line ? <span className="text-xs text-muted-foreground">{line}</span> : null}
      </div>
      <div className="mt-4 mb-3 h-1 rounded-[2px] bg-muted" />
      <div className="flex h-6 items-center gap-2">
        <div className="size-4 rounded bg-muted" />
        <div className="h-3 w-[76px] rounded bg-muted" />
      </div>
    </div>
  );
}
