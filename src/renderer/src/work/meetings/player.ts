import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRange } from "@server/shared/contract-attachments";
import { registry } from "../../lib/connection";

/**
 * The meeting's player (docs/agents/work-meetings.md "The canvas"). The host
 * keeps a small mono AAC copy of the recording in the thread's attachment
 * folder; on the first play it is read in 2 MB ranges (`attachment.readRange`,
 * which the path fence admits there) into one Blob and played from that. The
 * position is this hook's own, so a seek before the copy has come (a click on
 * a turn, a decision's minute) lands where the play starts.
 */

const RANGE = 2 * 1024 * 1024;
export const SPEEDS = [1, 1.25, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export interface Player {
  /** seconds */
  position: number;
  playing: boolean;
  /** reading the copy from the host */
  loading: boolean;
  /** the copy could not be read or played: why */
  error: string | null;
  /** the person has played or moved the position: the turn playing is marked from then on */
  touched: boolean;
  rate: Speed;
  /** there is a copy to play */
  playable: boolean;
  toggle(): void;
  /** moves to `t`; `play` starts it from there */
  seek(t: number, play?: boolean): void;
  setRate(rate: Speed): void;
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The whole copy as a Blob, read range by range. */
export async function readCopy(environmentId: string, path: string, bytes: number, signal: AbortSignal): Promise<Blob> {
  const link = registry.linkOf(environmentId);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes; offset += RANGE) {
    if (signal.aborted) throw new Error("cancelled");
    const { dataBase64 } = await link.request<AttachmentRange>("attachment.readRange", { path, offset, length: Math.min(RANGE, bytes - offset) });
    parts.push(bytesOf(dataBase64));
  }
  return new Blob(parts as BlobPart[], { type: "audio/mp4" });
}

export function usePlayer(environmentId: string, audio: { path: string; bytes: number } | undefined, durationSec: number): Player {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [rate, setRateState] = useState<Speed>(1);
  const element = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const loadingRef = useRef<AbortController | null>(null);
  const want = useRef({ position: 0, rate: 1 as Speed });
  const path = audio?.path;
  const bytes = audio?.bytes ?? 0;

  // A new copy (or none): what was loaded goes.
  useEffect(() => {
    return () => {
      loadingRef.current?.abort();
      loadingRef.current = null;
      element.current?.pause();
      element.current = null;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      setPlaying(false);
      setLoading(false);
      setError(null);
    };
  }, [environmentId, path, bytes]);

  const ensure = useCallback(async (): Promise<HTMLAudioElement | null> => {
    if (element.current) return element.current;
    if (!path || loadingRef.current) return null;
    const abort = new AbortController();
    loadingRef.current = abort;
    setLoading(true);
    setError(null);
    try {
      const blob = await readCopy(environmentId, path, bytes, abort.signal);
      if (abort.signal.aborted) return null;
      url.current = URL.createObjectURL(blob);
      const a = new Audio(url.current);
      a.preload = "auto";
      a.playbackRate = want.current.rate;
      a.currentTime = want.current.position;
      a.addEventListener("timeupdate", () => setPosition(a.currentTime));
      a.addEventListener("play", () => setPlaying(true));
      a.addEventListener("pause", () => setPlaying(false));
      a.addEventListener("ended", () => setPlaying(false));
      a.addEventListener("error", () => {
        // A copy that would not play is dropped, so the next Play reads it again.
        setError("The recording would not play.");
        setPlaying(false);
        if (element.current === a) element.current = null;
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = null;
      });
      element.current = a;
      return a;
    } catch (err) {
      if (!abort.signal.aborted) setError(`The recording could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (loadingRef.current === abort) loadingRef.current = null;
      setLoading(false);
    }
  }, [environmentId, path, bytes]);

  const start = useCallback(() => {
    void ensure().then((a) => {
      if (!a) return;
      a.play().catch((err: unknown) => {
        // A pause before the play settled is not a failure.
        if (!(err instanceof DOMException && err.name === "AbortError")) setError("The recording would not play.");
      });
    });
  }, [ensure]);

  const seek = useCallback(
    (t: number, play = false) => {
      const to = Math.max(0, Math.min(durationSec > 0 ? durationSec : t, t));
      want.current.position = to;
      setPosition(to);
      setTouched(true);
      if (element.current) element.current.currentTime = to;
      if (play) start();
    },
    [durationSec, start],
  );

  const toggle = useCallback(() => {
    setTouched(true);
    const a = element.current;
    if (a && !a.paused) a.pause();
    else start();
  }, [start]);

  const setRate = useCallback((next: Speed) => {
    want.current.rate = next;
    setRateState(next);
    if (element.current) element.current.playbackRate = next;
  }, []);

  return { position, playing, loading, error, touched, rate, playable: !!path, toggle, seek, setRate };
}
