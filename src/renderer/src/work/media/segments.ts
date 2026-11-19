/**
 * Feeds the host's HLS proxy to a `<video>` through Media Source
 * (docs/agents/work-media.md): Electron has no HLS of its own.
 * The proxy is fMP4, one init segment and then segments of about four
 * seconds; the host lists their times and mints a segment's URL only when
 * it is asked for one. The feeder keeps the 30 seconds after the playhead
 * buffered, drops what is 30 seconds behind it, and on a seek starts again
 * from the segment that holds the target.
 */

export interface Segment {
  start: number;
  duration: number;
}

export interface SegmentSource {
  init: string;
  segments: Segment[];
  ended: boolean;
  /** the SourceBuffer's type, e.g. `video/mp4; codecs="avc1.640028,mp4a.40.2"` */
  mime: string;
}

export interface SegmentFeed {
  /** The host listed more segments, or finished writing. */
  update(segments: Segment[], ended: boolean): void;
  destroy(): void;
}

const AHEAD_S = 30;
const BEHIND_S = 30;

/** The index of the segment holding `t`: the first when `t` is before it, the last when after. */
function holding(segments: Segment[], t: number): number {
  for (let i = 0; i < segments.length; i++) if (t < segments[i].start + segments[i].duration) return i;
  return segments.length - 1;
}

/** The segments covering `t` to `t + ahead` that are not held yet, the one holding `t` first. */
export function segmentsToLoad(segments: Segment[], t: number, ahead: number, have: Set<number>): number[] {
  if (segments.length === 0) return [];
  const out: number[] = [];
  for (let i = holding(segments, t); i < segments.length && segments[i].start < t + ahead; i++) if (!have.has(i)) out.push(i);
  return out;
}

/** The held segments wholly more than `behind` before `t`, or starting more than `ahead` after it (left by a seek back). */
export function segmentsToEvict(segments: Segment[], t: number, ahead: number, behind: number, have: Set<number>): number[] {
  return [...have].filter((i) => segments[i] && (segments[i].start + segments[i].duration < t - behind || segments[i].start > t + ahead)).sort((a, b) => a - b);
}

/** What the queue does to a SourceBuffer; one call at a time. */
export interface Sink {
  append(data: ArrayBuffer): Promise<void>;
  remove(from: number, to: number): Promise<void>;
  setDuration(seconds: number): void;
  end(): void;
}

export interface Queue {
  /** Look again: the playhead moved or a segment finished. */
  pump(): void;
  /** A seek began: drop what is fetched but not appended and start from the target. */
  seek(): void;
  update(segments: Segment[], ended: boolean): void;
  destroy(): void;
  readonly have: ReadonlySet<number>;
}

/**
 * The feeder without the DOM: one loop, never two at once, that appends the
 * init segment, then whatever `segmentsToLoad` names first, evicting as it
 * goes, and ends the stream once the host has finished and all is appended.
 */
export function segmentQueue(o: {
  init: string;
  segments: Segment[];
  ended: boolean;
  sink: Sink;
  now: () => number;
  segmentUrl: (i: number) => Promise<string>;
  fetch: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  onError?: (err: unknown) => void;
}): Queue {
  let segments = o.segments;
  let ended = o.ended;
  const have = new Set<number>();
  let initDone = false;
  let finished = false;
  let running = false;
  let again = false;
  let dead = false;
  let duration = 0;
  let epoch = 0;
  let abort = new AbortController();

  const span = (): number => segments.reduce((m, s) => Math.max(m, s.start + s.duration), 0);

  /** One move; true while there is more to do now. A fetch cut short by a seek counts as more. */
  async function step(): Promise<boolean> {
    const mine = epoch;
    const signal = abort.signal;
    try {
      if (!initDone) {
        await o.sink.append(await o.fetch(o.init, signal));
        initDone = true;
      }
      const end = span();
      if (end > duration) o.sink.setDuration((duration = end));
      const t = o.now();
      for (const i of segmentsToEvict(segments, t, AHEAD_S, BEHIND_S, have)) {
        await o.sink.remove(segments[i].start, segments[i].start + segments[i].duration);
        have.delete(i);
      }
      const next = segmentsToLoad(segments, t, AHEAD_S, have)[0];
      if (next === undefined) {
        // The last segment is in: the stream can end. An append after a seek back reopens it.
        if (ended && !finished && have.has(segments.length - 1)) {
          finished = true;
          o.sink.end();
        }
        return false;
      }
      const data = await o.fetch(await o.segmentUrl(next), signal);
      if (mine !== epoch || dead) return true;
      await o.sink.append(data);
      have.add(next);
      finished = false;
      return true;
    } catch (err) {
      if (signal.aborted) return !dead;
      o.onError?.(err);
      return false;
    }
  }

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        while (!dead && (await step())) {
          /* the next segment */
        }
      } while (again && !dead);
    } finally {
      running = false;
    }
  }

  return {
    have,
    pump: () => void run(),
    seek() {
      epoch++;
      abort.abort();
      abort = new AbortController();
      void run();
    },
    update(next, nextEnded) {
      segments = next;
      ended = nextEnded;
      void run();
    },
    destroy() {
      dead = true;
      abort.abort();
    }
  };
}

/** A SourceBuffer as a Sink: each call waits for `updateend`. */
function bufferSink(source: MediaSource, buffer: SourceBuffer): Sink {
  const done = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const ok = (): void => (off(), resolve());
      const bad = (): void => (off(), reject(new Error("the media buffer refused a segment")));
      const off = (): void => {
        buffer.removeEventListener("updateend", ok);
        buffer.removeEventListener("error", bad);
      };
      buffer.addEventListener("updateend", ok);
      buffer.addEventListener("error", bad);
    });
  return {
    append(data) {
      const p = done();
      buffer.appendBuffer(data);
      return p;
    },
    remove(from, to) {
      const p = done();
      buffer.remove(from, to);
      return p;
    },
    setDuration(seconds) {
      if (source.readyState === "open" && !buffer.updating && !(source.duration >= seconds)) source.duration = seconds;
    },
    end() {
      if (source.readyState === "open" && !buffer.updating) source.endOfStream();
    }
  };
}

/**
 * Plays `source` in `video` through a MediaSource. `bytes(i)` asks the host
 * for segment `i` (or the init segment) as bytes (`work.media.segment`): the
 * app's content policy lets the renderer fetch no file URL, so nothing here
 * fetches one. A segment that fails stops the feed where it is; `onError`
 * hears of it, so the player can say why the picture stalled and build the
 * feed again.
 */
export function attachSegments(
  video: HTMLVideoElement,
  source: SegmentSource,
  bytes: (i: number | "init", signal: AbortSignal) => Promise<ArrayBuffer>,
  onError?: (err: unknown) => void,
): SegmentFeed {
  const media = new MediaSource();
  const objectUrl = URL.createObjectURL(media);
  let queue: Queue | null = null;
  let pending: { segments: Segment[]; ended: boolean } = { segments: source.segments, ended: source.ended };
  const onSeeking = (): void => queue?.seek();
  const onTime = (): void => queue?.pump();
  media.addEventListener(
    "sourceopen",
    () => {
      const buffer = media.addSourceBuffer(source.mime);
      queue = segmentQueue({
        init: "init",
        ...pending,
        sink: bufferSink(media, buffer),
        now: () => video.currentTime,
        // The queue speaks in keys; the host is asked for bytes by them.
        segmentUrl: async (i) => String(i),
        fetch: (key, signal) => bytes(key === "init" ? "init" : Number(key), signal),
        onError: (err) => {
          console.error("[media] segments:", err);
          onError?.(err);
        }
      });
      queue.pump();
    },
    { once: true }
  );
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("timeupdate", onTime);
  video.src = objectUrl;
  return {
    update(segments, ended) {
      pending = { segments, ended };
      queue?.update(segments, ended);
    },
    destroy() {
      queue?.destroy();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("timeupdate", onTime);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  };
}
