import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PreviewOptions, PreviewState } from "./computerPreview";
import type { ComputerEntry } from "./computerSessions";
import type { InputEvent } from "@server/shared/video/nsl1";
import type { StreamHandle, StreamView } from "./video/streams";
import { REGROW_QUIET_MS, nextEdge, pixelRatioOf, videoEdge, videoSupported } from "./video/support";
import { registry } from "./connection/registry";

/**
 * A computer session as live video (docs/agents/live-video.md "The viewer"):
 * `video.open` on the session's host, the stream on its own socket, decoded
 * and drawn by the window's worker. It speaks the preview's own states, so
 * a place that shows the 4 fps picture shows video with nothing changed
 * around it. When there is no video to be had (the host refuses, this
 * machine cannot decode it, the stream kept dropping, the box's display went
 * to another page) it says it gave way, and the picture takes its place.
 *
 * The viewer's code is a chunk of its own, loaded when the first stream is
 * wanted.
 */

export interface VideoOptions extends PreviewOptions {
  /** this place is the thread on screen: it takes the box's one display from another page */
  take: boolean;
  /** he drives this page from this place: the stream is asked for as one his pointer and keys go down */
  drive?: boolean;
}

/** His input into the page he drives, while a stream that takes it is live. */
export interface VideoDrive {
  send(event: InputEvent): void;
  paste(text: string): Promise<void>;
  /** the far clipboard's text after his copy there; null when it holds none */
  copy(): Promise<string | null>;
}

let loading: Promise<typeof import("./video/streams")> | null = null;
const loadStreams = (): Promise<typeof import("./video/streams")> => (loading ??= import("./video/streams"));

/** A chord pressed on the drive stream of a host's computer (`VideoStreams.press`); false when none is live here. */
export async function pressKeys(host: string, key: string, keys: readonly number[]): Promise<boolean> {
  const { videoStreams } = await loadStreams();
  return videoStreams.press(host, key, keys);
}

const starting = (prev: PreviewState): PreviewState =>
  (prev.status === "live" || prev.status === "starting") && prev.width && prev.height ? { status: "starting", width: prev.width, height: prev.height } : { status: "starting" };

/** A stream's view in the preview's words; null when the picture stands in for it. */
export function videoState(view: StreamView, app: string, window: string | null): PreviewState | null {
  if (view.status === "opening") return view.width && view.height ? { status: "starting", width: view.width, height: view.height } : { status: "starting" };
  if (view.status === "live") return { status: "live", app, window, width: view.width, height: view.height, drawn: true };
  // the display went elsewhere, or an act is held: the picture shows what there is
  if (view.face === "picture" || view.face === "kept") return null;
  if (view.face === "permission") return { status: "ended", reason: "permission" };
  return { status: "ended", reason: view.retry ? "error" : "closed" };
}

export function useComputerVideo(entry: ComputerEntry, opts: VideoOptions): { state: PreviewState; gaveWay: boolean; retry: () => void; drive: VideoDrive | null } {
  const [state, setState] = useState<PreviewState>({ status: "starting" });
  const [gaveWay, setGaveWay] = useState(() => !videoSupported());
  const [attempt, setAttempt] = useState(0);
  const [edge, setEdge] = useState<number | null>(null);
  const onClick = useRef(opts.onClick);
  const handle = useRef<StreamHandle | null>(null);
  /** the canvas the stream is on now, and the undo */
  const shown = useRef<{ canvas: HTMLCanvasElement; off: () => void } | null>(null);
  const { canvas, box, take } = opts;
  const drive = !!opts.drive;
  const host = entry.previewHost;
  const key = entry.previewKey;
  const app = entry.row.apps[0]?.name ?? "";
  const window_ = entry.row.apps[0]?.window ?? null;
  const names = useRef({ app, window: window_ });
  // The state is its session's, as the preview's is: another session starts from nothing, and video is tried for it anew.
  const owner = `${host ?? ""}\n${key ?? ""}`;
  const [owned, setOwned] = useState(owner);
  if (owned !== owner) {
    setOwned(owner);
    setState({ status: "starting" });
    setGaveWay(!videoSupported());
  }
  const wanted = opts.run && entry.previewable && !!host && !!key && app !== "";
  // A place that was hidden and is shown again asks for video again: the display may be free now.
  const [was, setWas] = useState(wanted);
  if (was !== wanted) {
    setWas(wanted);
    if (wanted && gaveWay && videoSupported()) setGaveWay(false);
  }
  const run = wanted && !gaveWay && edge !== null;

  useLayoutEffect(() => {
    onClick.current = opts.onClick;
    names.current = { app, window: window_ };
  });

  // The edge follows the size shown, in the pixels of the window that shows it: larger past REGROW, smaller below SHRINK
  // (the stream itself waits until every place has shrunk, streams.ts), each once the resize has been quiet.
  useEffect(() => {
    if (opts.boxWidth <= 0) return;
    const next = nextEdge(edge, videoEdge(opts.boxWidth, pixelRatioOf(box?.current ?? canvas.current)));
    if (edge === null) return setEdge(next);
    if (next === edge) return;
    const timer = setTimeout(() => setEdge(next), REGROW_QUIET_MS);
    return () => clearTimeout(timer);
  }, [box, canvas, edge, opts.boxWidth]);

  /** The stream is drawn on the canvas that is there now: it may mount after the stream opened, or be another one. */
  const sync = useCallback(() => {
    const el = canvas.current;
    const stream = handle.current;
    if (shown.current && (shown.current.canvas !== el || !stream)) {
      shown.current.off();
      shown.current = null;
    }
    if (el && stream && !shown.current) shown.current = { canvas: el, off: stream.show(el) };
  }, [canvas]);
  useEffect(sync);

  useEffect(() => {
    if (!run || !host || !key || edge === null) return;
    let alive = true;
    let offs: (() => void)[] = [];
    setState(starting);
    void loadStreams().then(
      ({ videoStreams }) => {
        if (!alive) return;
        const stream = videoStreams.acquire(host, key, { edge, take, drive });
        handle.current = stream;
        const read = (): void => {
          const next = videoState(stream.view(), names.current.app, names.current.window);
          if (next) setState(next);
          else setGaveWay(true);
        };
        offs = [
          stream.subscribe(read),
          stream.onCount((frames, fps) => {
            if (!box?.current) return;
            box.current.dataset.frames = String(frames);
            box.current.dataset.fps = String(fps);
          }),
          stream.onClick((x, y) => onClick.current(x, y)),
        ];
        read();
        sync();
      },
      // the chunk would not load: the picture it is
      () => alive && setGaveWay(true),
    );
    return () => {
      alive = false;
      for (const off of offs) off();
      shown.current?.off();
      shown.current = null;
      handle.current?.release();
      handle.current = null;
      setState((prev) => (prev.status === "live" ? starting(prev) : prev));
    };
  }, [attempt, box, drive, edge, host, key, run, sync, take]);

  const driving = useMemo<VideoDrive>(
    () => ({ send: (event) => handle.current?.input(event), paste: async (text) => handle.current?.paste(text), copy: async () => (await handle.current?.copy()) ?? null }),
    [],
  );

  const retry = useCallback(() => {
    handle.current?.retry();
    setAttempt((n) => n + 1);
  }, []);

  // The host's link came back (a box restart, his link to it cut and mended): a stream that gave way to the picture
  // or ended while it was gone is asked for again, as if the place were shown again.
  const settled = useRef({ gaveWay, ended: false });
  useLayoutEffect(() => {
    settled.current = { gaveWay, ended: state.status === "ended" };
  });
  useEffect(() => {
    if (!host) return;
    return registry.link(host)?.onOpen(() => {
      if (!settled.current.gaveWay && !settled.current.ended) return;
      if (videoSupported()) setGaveWay(false);
      retry();
    });
  }, [host, retry]);
  return { state, gaveWay, retry, drive: drive && run && state.status === "live" ? driving : null };
}
