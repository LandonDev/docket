import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ShowMedia } from "@shared/contract-work-slides";
import { Button } from "../../../components/ui/button";
import { Progress } from "../../../components/ui/progress";
import { Pause, Play, RotateCcw } from "../../../chrome/icons";
import type { PdfDoc, PdfEngine } from "../../pdf/engine";
import type { ShowMotion, Slide } from "./state";
import { clockOf } from "./timer";

/**
 * What a running show hands both its windows beyond the state (docs/agents/work-slides.md "The show"): where each
 * step's picture is, how a picture comes in, and the slide's video and sound. One provider in the show's root
 * reaches both windows through their portals; a surface drawn without one (a test, a preview) shows each slide's
 * page and no media.
 */

/** A picture of a slide at a step: a page of a render, or nothing yet while a step's own picture is read (`waiting`). */
export interface Picture {
  doc: PdfDoc | null;
  page: number;
  waiting: boolean;
}

export interface ShowStage {
  pictureOf(slide: Slide, step: number): Picture;
  /** how the picture now shown came in, and the arrival it belongs to */
  motion: ShowMotion;
  motionKey: string;
  media: MediaRun | null;
}

export const StageContext = createContext<ShowStage | null>(null);

/** A slide's picture at a step, by the stage when there is one, else its page of the render. */
export function usePicture(doc: PdfDoc | null): (slide: Slide | undefined, step: number) => Picture {
  const stage = useContext(StageContext);
  return (slide, step) => (slide ? (stage?.pictureOf(slide, step) ?? { doc, page: slide.page, waiting: false }) : { doc, page: 1, waiting: false });
}
export const useStage = (): ShowStage | null => useContext(StageContext);

// ── the steps' pictures ──────────────────────────────────────────────

type Opened = PdfDoc | "opening" | "failed";

/**
 * Each step picture a show is near (the slide shown and the next press's), opened from the host by its `rev` and
 * let go once the show has moved two slides on. A picture that fails to read is the slide's own page from then on.
 */
export function useStepDocs(engine: PdfEngine, read: ((rev: string, offset: number, length: number) => Promise<Uint8Array>) | undefined, near: ReadonlyArray<{ rev: string; size: number }>): ReadonlyMap<string, Opened> {
  const [docs, setDocs] = useState<ReadonlyMap<string, Opened>>(new Map());
  const live = useRef(docs);
  live.current = docs;
  const wanted = near.map((p) => p.rev).join(",");
  useEffect(() => {
    if (!read) return;
    for (const pic of near) {
      if (live.current.has(pic.rev)) continue;
      setDocs((was) => new Map(was).set(pic.rev, "opening"));
      engine.open({ size: pic.size, read: (offset, length) => read(pic.rev, offset, length) }).then(
        (doc) => setDocs((was) => (was.get(pic.rev) === "opening" ? new Map(was).set(pic.rev, doc) : (doc.destroy(), was))),
        () => setDocs((was) => new Map(was).set(pic.rev, "failed")),
      );
    }
    // Pictures the show is no longer near go; one still opening is dropped when it lands.
    const keep = new Set(wanted.split(","));
    const gone = [...live.current.keys()].filter((rev) => !keep.has(rev));
    if (gone.length) {
      setDocs((was) => {
        const next = new Map(was);
        for (const rev of gone) {
          const d = next.get(rev);
          if (d && typeof d === "object") d.destroy();
          next.delete(rev);
        }
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `near` is read by its revisions
  }, [engine, read, wanted]);
  useEffect(
    () => () => {
      for (const d of live.current.values()) if (typeof d === "object") d.destroy();
    },
    [],
  );
  return docs;
}

// ── video and sound ──────────────────────────────────────────────────

/** The read size of a clip's chunks: the most a call carries. */
const CHUNK = 4 * 1024 * 1024;

/**
 * Each clip the show is near, read whole from the host into one object URL of the main window's, which both
 * windows play (they are of its origin). Let go when the show ends.
 */
export function useMediaUrls(read: ((rev: string, offset: number, length: number) => Promise<Uint8Array>) | undefined, near: ReadonlyArray<NonNullable<ShowMedia["file"]>>): ReadonlyMap<string, string | "loading" | "failed"> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string | "loading" | "failed">>(new Map());
  const live = useRef(urls);
  live.current = urls;
  const wanted = near.map((f) => f.rev).join(",");
  useEffect(() => {
    if (!read) return;
    for (const file of near) {
      if (live.current.has(file.rev)) continue;
      setUrls((was) => new Map(was).set(file.rev, "loading"));
      void (async () => {
        const parts: Uint8Array[] = [];
        for (let at = 0; at < file.size; at += CHUNK) parts.push(await read(file.rev, at, Math.min(CHUNK, file.size - at)));
        return URL.createObjectURL(new Blob(parts as BlobPart[], { type: file.type }));
      })().then(
        (url) => setUrls((was) => new Map(was).set(file.rev, url)),
        () => setUrls((was) => new Map(was).set(file.rev, "failed")),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `near` is read by its revisions
  }, [read, wanted]);
  useEffect(
    () => () => {
      for (const url of live.current.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    [],
  );
  return urls;
}

/** One clip's place in its playing, kept once for both windows. */
export interface Playing {
  playing: boolean;
  /** it has been started on this visit to its slide: the video lies over the slide's picture from then on */
  started: boolean;
  /** seconds in, as last read */
  time: number;
  duration: number | null;
  /** a seek asked for: the windows go there, then it is cleared */
  seek: number | null;
}
export type MediaAct = { t: "play" } | { t: "pause" } | { t: "restart" } | { t: "time"; time: number; duration?: number } | { t: "ended" } | { t: "seeked" };

const IDLE: Playing = { playing: false, started: false, time: 0, duration: null, seek: null };
export function playReducer(was: Playing = IDLE, act: MediaAct): Playing {
  switch (act.t) {
    case "play":
      return { ...was, playing: true, started: true, seek: was.duration !== null && was.time >= was.duration ? 0 : was.seek };
    case "pause":
      return { ...was, playing: false };
    case "restart":
      return { ...was, playing: true, started: true, time: 0, seek: 0 };
    case "time":
      return { ...was, time: act.time, duration: act.duration ?? was.duration };
    case "ended":
      return { ...was, playing: false, time: was.duration ?? was.time };
    case "seeked":
      return { ...was, seek: null };
  }
}

export interface MediaRun {
  url(file: ShowMedia["file"]): string | "loading" | "failed" | null;
  playing(slide: number, shape: number): Playing;
  act(slide: number, shape: number, act: MediaAct): void;
  /** the window whose copy is heard (the slideshow's, else the presenter's); the other plays muted, in step */
  heard: "audience" | "presenter";
}

/** The clips of a slide over its picture, in one window: each video in its shape's box once started, each sound unseen. */
export function SlideMedia({ slide, step, surface, width, height, presses = false }: { slide: Slide; step: number; surface: "audience" | "presenter"; width: number; height: number; presses?: boolean }) {
  const media = useStage()?.media;
  if (!media || !slide.media?.length) return null;
  const hidden = new Set(slide.steps?.[step]?.hides ?? []);
  return (
    <>
      {slide.media
        .filter((m) => !hidden.has(m.shape))
        .map((m) => (
          <Clip key={m.shape} slide={slide.id} clip={m} run={media} surface={surface} width={width} height={height} presses={presses} />
        ))}
    </>
  );
}

/** A box in the picture's pixels from a shape's corners: its centre, its own width and height, and its turn. */
function boxOf(quad: ShowMedia["quad"], width: number, height: number) {
  const [a, b, , d] = quad.map(([x, y]) => [x * width, y * height] as const);
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const h = Math.hypot(d[0] - a[0], d[1] - a[1]);
  const cx = quad.reduce((n, p) => n + p[0], 0) * (width / 4);
  const cy = quad.reduce((n, p) => n + p[1], 0) * (height / 4);
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, rotate: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
}

function Clip({ slide, clip, run, surface, width, height, presses }: { slide: number; clip: ShowMedia; run: MediaRun; surface: "audience" | "presenter"; width: number; height: number; presses: boolean }) {
  const el = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const play = run.playing(slide, clip.shape);
  const url = run.url(clip.file);
  const heard = run.heard === surface;
  const act = useCallback((a: MediaAct) => run.act(slide, clip.shape, a), [run, slide, clip.shape]);

  // Each copy follows the one state: started or stopped, and sent where a seek asks; the heard copy reports its time.
  useEffect(() => {
    const media = el.current;
    if (!media || typeof url !== "string" || url === "loading" || url === "failed") return;
    if (play.seek !== null) {
      media.currentTime = play.seek;
      if (heard) act({ t: "seeked" });
    } else if (!heard && Math.abs(media.currentTime - play.time) > 0.3) media.currentTime = play.time;
    if (play.playing && media.paused) void media.play()?.catch(() => heard && act({ t: "pause" }));
    if (!play.playing && !media.paused) media.pause();
  }, [play, url, heard, act]);

  if (typeof url !== "string" || url === "loading" || url === "failed") return null;
  const report = heard
    ? {
        onTimeUpdate: () => el.current && act({ t: "time", time: el.current.currentTime, ...(Number.isFinite(el.current.duration) ? { duration: el.current.duration } : {}) }),
        onLoadedMetadata: () => el.current && Number.isFinite(el.current.duration) && act({ t: "time", time: el.current.currentTime, duration: el.current.duration }),
        onEnded: () => act({ t: "ended" }),
      }
    : {};
  const box = boxOf(clip.quad, width, height);
  const placed = { left: box.left, top: box.top, width: box.width, height: box.height, transform: box.rotate ? `rotate(${box.rotate}deg)` : undefined };
  return (
    <>
      {clip.kind === "audio" ? (
        <audio ref={el} src={url} preload="auto" muted={!heard} data-show-media={clip.shape} {...report} />
      ) : (
        <video
          ref={el}
          src={url}
          preload="auto"
          playsInline
          muted={!heard}
          data-show-media={clip.shape}
          aria-hidden="true"
          // The slide's own picture (the poster PowerPoint shows) stays until the clip is started.
          className={`pointer-events-none absolute bg-(--matte) object-contain ${play.started ? "" : "invisible"}`}
          style={placed}
          {...report}
        />
      )}
      {presses ? (
        // With no presenter's view a press on the clip starts and stops it; anywhere else it is still the next press.
        <button
          type="button"
          aria-label={`${play.playing ? "Pause" : "Play"} the ${clip.kind === "audio" ? "sound" : "video"}`}
          className="focus-ring absolute cursor-pointer rounded-sm"
          style={placed}
          onClick={(event) => {
            event.stopPropagation();
            act({ t: play.playing ? "pause" : "play" });
          }}
        />
      ) : null}
    </>
  );
}

/** The presenter's transport: one row a clip on the slide shown, under the picture the room sees. */
export function MediaTransport({ slide, step }: { slide: Slide; step: number }) {
  const media = useStage()?.media;
  if (!media || !slide.media?.length) return null;
  const hidden = new Set(slide.steps?.[step]?.hides ?? []);
  const clips = slide.media.filter((m) => !hidden.has(m.shape));
  if (!clips.length) return null;
  return (
    <div data-show-transport className="flex flex-col gap-1">
      {clips.map((clip) => {
        const play = media.playing(slide.id, clip.shape);
        const url = media.url(clip.file);
        const what = clip.kind === "audio" ? "sound" : "video";
        const ready = typeof url === "string" && url !== "loading" && url !== "failed";
        return (
          <div key={clip.shape} data-show-clip={clip.shape} className="-ml-1 flex h-7 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`${play.playing ? "Pause" : "Play"} the ${what}`}
              disabled={!ready}
              onClick={() => media.act(slide.id, clip.shape, { t: play.playing ? "pause" : "play" })}
            >
              {play.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label={`Play the ${what} from the start`} disabled={!ready || !play.started} onClick={() => media.act(slide.id, clip.shape, { t: "restart" })}>
              <RotateCcw className="size-3.5" />
            </Button>
            {ready ? (
              <>
                <Progress aria-label={`The ${what}'s place`} value={play.duration ? play.time : 0} max={play.duration || 1} className="mx-1.5 min-w-0 flex-1" />
                <span className="text-xs leading-4 text-muted-foreground tabular-nums">
                  {clockOf(play.time * 1000)}
                  {play.duration !== null ? ` / ${clockOf(play.duration * 1000)}` : ""}
                </span>
              </>
            ) : (
              <span className="ml-1.5 text-xs leading-4 text-muted-foreground">{url === "failed" ? `The ${what} could not be read` : `Getting the ${what} ready…`}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
