import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MediaPlay, MediaRegion, MediaShape } from "@shared/contract-work-media";
import { RegionLayer } from "./parts";
import type { MediaActions } from "./store";

/**
 * A picture on the stage (docs/DESIGN.md "Images and video"): fitted inside
 * a 24px inset, or at a zoom the bar sets, scrolling when it is larger than
 * the stage. A drag on it takes a region. A picture too large to decode
 * whole is drawn from the host's Deep Zoom tiles at the level the zoom
 * needs, over its preview.
 */

export type Zoom = "fit" | number;
type ImagePlay = Extract<MediaPlay, { via: "image" | "tiles" }>;

/** The scale a zoom means for a picture on a stage of this size: fit never enlarges past 1. */
export function scaleOf(zoom: Zoom, picture: { width: number; height: number }, stage: { width: number; height: number }): number {
  if (zoom !== "fit") return zoom;
  if (!picture.width || !picture.height || stage.width <= 48 || stage.height <= 48) return 1;
  return Math.min(1, (stage.width - 48) / picture.width, (stage.height - 48) / picture.height);
}

/** The Deep Zoom level a scale draws from; below `minLevel` the preview alone does. */
export function levelFor(scale: number, levels: number, minLevel: number): number | null {
  const max = levels - 1;
  const level = scale >= 1 ? max : max - Math.floor(Math.log2(1 / scale));
  return level < minLevel ? null : Math.min(max, level);
}

export function Picture({
  versionId,
  play,
  zoom,
  actions,
  region,
  shapes,
  selecting,
  onRegion,
  onScale,
  attempt = 0,
  onDrawn,
}: {
  versionId: string;
  play: ImagePlay;
  zoom: Zoom;
  actions: MediaActions;
  region: MediaRegion | null;
  shapes?: MediaShape[];
  selecting: boolean;
  onRegion(region: MediaRegion, rect: DOMRect): void;
  /** The scale shown, for the bar's zoom word. */
  onScale(scale: number): void;
  /** Each Retry moves it on, so the picture loads afresh. */
  attempt?: number;
  /** Whether the picture (or the tiles' preview) drew: false when its bytes did not load or could not be read. */
  onDrawn?(drawn: boolean): void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ left: 0, top: 0 });
  // A picture that did not draw leaves its frame, at its own size, empty: never the browser's broken-image mark.
  const [broken, setBroken] = useState(false);
  const drawn = (ok: boolean): void => {
    setBroken(!ok);
    onDrawn?.(ok);
  };
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const scale = scaleOf(zoom, play, size);
  useEffect(() => onScale(scale), [scale, onScale]);
  const w = Math.round(play.width * scale);
  const h = Math.round(play.height * scale);
  // Fit is the stage's own sizing, as the prototype's: the picture inside the 24px inset, never past its own pixels.
  const ratio = play.width / Math.max(1, play.height);
  const box =
    zoom === "fit"
      ? { aspectRatio: String(ratio), width: `min(100cqw - 48px, (100cqh - 48px) * ${ratio.toFixed(5)}, ${play.width}px)` }
      : { width: w, height: h };
  return (
    <div
      ref={stage}
      data-media-stage
      className="grid size-full min-h-0 overflow-auto bg-(--stage) [container-type:size]"
      onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })}
    >
      <div className="m-auto p-6">
        <div className="relative overflow-hidden rounded-[4px] outline-1 -outline-offset-1 outline-(--image-outline)" style={box}>
          {play.via === "image" ? (
            <img
              key={`${play.url}#${attempt}`}
              src={play.url}
              alt=""
              draggable={false}
              data-media-picture
              onLoad={() => drawn(true)}
              onError={() => drawn(false)}
              className={`absolute inset-0 size-full select-none ${broken ? "invisible" : ""}`}
            />
          ) : (
            <Tiles versionId={versionId} play={play} scale={scale} shown={{ ...view, width: size.width, height: size.height }} actions={actions} attempt={attempt} broken={broken} onPreview={drawn} />
          )}
          <RegionLayer shown={region} shapes={shapes} selecting={selecting} onRegion={onRegion} />
        </div>
      </div>
    </div>
  );
}

const tileUrls = new Map<string, string>();
const TILE_CACHE = 400;

function Tiles({
  versionId,
  play,
  scale,
  shown,
  actions,
  attempt,
  broken,
  onPreview,
}: {
  versionId: string;
  play: Extract<MediaPlay, { via: "tiles" }>;
  scale: number;
  shown: { left: number; top: number; width: number; height: number };
  actions: MediaActions;
  attempt: number;
  broken: boolean;
  /** Whether the preview under the tiles drew. */
  onPreview(drawn: boolean): void;
}) {
  const [, redraw] = useState(0);
  const level = levelFor(scale, play.levels, play.minLevel);
  const max = play.levels - 1;
  const factor = level === null ? 0 : 2 ** (max - level);
  const lw = level === null ? 0 : Math.ceil(play.width / factor);
  const lh = level === null ? 0 : Math.ceil(play.height / factor);
  // A level's pixel on screen; the stage's 24px inset is outside the picture.
  const px = level === null ? 0 : (play.width * scale) / lw;
  const cols = Math.ceil(lw / play.tile);
  const rows = Math.ceil(lh / play.tile);
  const t = play.tile * px;
  const x0 = Math.max(0, Math.floor((shown.left - 24) / t));
  const y0 = Math.max(0, Math.floor((shown.top - 24) / t));
  const x1 = Math.min(cols - 1, Math.floor((shown.left - 24 + shown.width) / t));
  const y1 = Math.min(rows - 1, Math.floor((shown.top - 24 + shown.height) / t));
  const wanted: Array<[number, number]> = [];
  if (level !== null) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.push([x, y]);
  // The preview's URL carries the file's time: a picture written again never shows its old tiles.
  const key = (x: number, y: number): string => `${versionId}/${play.preview}/${level}/${x}_${y}`;
  const missing = wanted.filter(([x, y]) => !tileUrls.has(key(x, y))).length;
  useEffect(() => {
    let live = true;
    for (const [x, y] of wanted) {
      const k = key(x, y);
      if (tileUrls.has(k)) continue;
      tileUrls.set(k, "");
      void actions
        .tile(versionId, level!, x, y)
        .then((data) => {
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          tileUrls.set(k, URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
          while (tileUrls.size > TILE_CACHE) {
            const [old, url] = tileUrls.entries().next().value!;
            if (url) URL.revokeObjectURL(url);
            tileUrls.delete(old);
          }
          if (live) redraw((n) => n + 1);
        })
        .catch(() => tileUrls.delete(k));
    }
    return () => {
      live = false;
    };
    // The tiles in view are the dependency; their list is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, play.preview, level, x0, y0, x1, y1, missing]);
  return (
    <>
      <img
        key={`${play.preview}#${attempt}`}
        src={play.preview}
        alt=""
        draggable={false}
        data-media-picture
        onLoad={() => onPreview(true)}
        onError={() => onPreview(false)}
        className={`absolute inset-0 size-full select-none ${broken ? "invisible" : ""}`}
      />
      {wanted.map(([x, y]) => {
        const url = tileUrls.get(key(x, y));
        return url ? <img key={key(x, y)} src={url} alt="" draggable={false} className="absolute select-none" style={{ left: x * t, top: y * t, width: t, height: t }} /> : null;
      })}
    </>
  );
}
