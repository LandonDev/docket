import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { BrowserDriver, BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The browser kind's reads and presses (docs/agents/work-browser.md): who
 * drives a thread's browser (`work.browser.state` once, then the
 * `work.browser` push) and the thread's held computer acts
 * (`work.outbox.list`, then the `work.outbox` push), asked again when the
 * socket comes back. A read that fails leaves what was there; a first read
 * that fails says so (`error`), with a way to ask again.
 */

/** Who asks for a thread's browser state, by host and thread: Retry asks again for every reader of it (the bar and the body alike). */
const readers = new Map<string, Set<() => void>>();

export interface BrowserRead {
  state: BrowserState | null;
  /** why the first read failed, while nothing has been read */
  error: string | null;
  retry(): void;
}

export function useBrowserState(env: string, sessionId: string): BrowserRead {
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${env}\n${sessionId}`;
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    const load = (): void =>
      void link.request<BrowserState>("work.browser.state", { sessionId }).then(
        (s) => {
          if (!live) return;
          setState(s);
          setError(null);
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
      );
    const set = readers.get(key) ?? new Set();
    readers.set(key, set.add(load));
    load();
    const offPush = link.onPush((push) => {
      if (push.push !== "work.browser" || push.state.sessionId !== sessionId) return;
      setState(push.state);
      setError(null);
    });
    const offOpen = link.onOpen(load);
    return () => {
      live = false;
      set.delete(load);
      if (!set.size) readers.delete(key);
      offPush();
      offOpen();
    };
  }, [env, sessionId, key]);
  // One function per thread, so a state line that holds it is not set again on every render.
  const retry = useCallback(() => {
    setError(null);
    readers.get(key)?.forEach((load) => load());
  }, [key]);
  return { state, error: state ? null : error, retry };
}

/**
 * The thread host's held computer acts: every waiting one (few), and the
 * pane's last decided ones for the line after a press. Kept current by the
 * outbox's push.
 */
export function useHeldActs(env: string, pane: string): OutboxItem[] {
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    const list = (params: Record<string, unknown>): Promise<OutboxItem[]> =>
      link.request<{ items: OutboxItem[] }>("work.outbox.list", params).then(
        (a) => a.items.filter((i) => i.kind === "computer.act"),
        () => [],
      );
    const load = (): void =>
      void Promise.all([list({ show: "waiting" }), list({ show: "decided", sessionId: pane, limit: 10 })]).then(([waiting, decided]) => live && setItems([...waiting, ...decided]));
    load();
    const offPush = link.onPush((push) => {
      if (push.push !== "work.outbox" || !push.item || push.item.kind !== "computer.act") return;
      const item = push.item;
      setItems((was) => [item, ...was.filter((i) => !(i.ref.at === "host" && item.ref.at === "host" && i.ref.id === item.ref.id))]);
    });
    const offOpen = link.onOpen(load);
    return () => {
      live = false;
      offPush();
      offOpen();
    };
  }, [env, pane]);
  return items;
}

export function setDriver(env: string, sessionId: string, driver: BrowserDriver): Promise<BrowserState> {
  return registry.linkOf(env).request<BrowserState>("work.browser.drive", { sessionId, driver });
}

/** His press on the held submit: it runs once, as it was held, if the page still shows what he saw. */
export function submitHeld(env: string, ref: HeldRef): Promise<OutboxItem> {
  return registry.linkOf(env).request<OutboxItem>("work.outbox.send", { ref });
}

export function discardHeld(env: string, ref: HeldRef): Promise<OutboxItem> {
  return registry.linkOf(env).request<OutboxItem>("work.outbox.discard", { ref });
}

/** The held page's picture, for a desktop that cannot draw the live window (the box, the browser /ui): null when none was kept. */
export async function heldPicture(env: string, ref: HeldRef): Promise<string | null> {
  const item = await registry.linkOf(env).request<OutboxItem>("work.outbox.get", { ref });
  const picture = (item.payload as { picture?: { mimeType: string; data?: string } | null } | null)?.picture;
  if (!picture) return null;
  // A picture the act kept whose bytes did not come is a failure, never "none kept" (the Outbox's rule).
  if (!picture.data) throw new Error("The picture's bytes did not come");
  return `data:${picture.mimeType};base64,${picture.data}`;
}

/** The held page's picture as the body draws it: undefined while it comes, "failed" when the read or the drawing failed, null when none was kept. */
export interface HeldPictureRead {
  src: string | null | undefined | "failed";
  /** the image has drawn */
  loaded: boolean;
}

export interface HeldPicture extends HeldPictureRead {
  retry(): void;
  onLoad(): void;
  onError(): void;
}

/**
 * One read of a held page's picture, by host and act, shared by the body that
 * draws it and the bar whose primary waits on it: his press approves what he
 * has seen, so the verb stays off while the picture comes or failed.
 */
const pictures = new Map<string, { read: HeldPictureRead; subs: Set<() => void>; reading: boolean }>();
const NONE: HeldPictureRead = { src: null, loaded: false };

function pictureEntry(key: string) {
  let entry = pictures.get(key);
  if (!entry) pictures.set(key, (entry = { read: { src: undefined, loaded: false }, subs: new Set(), reading: false }));
  return entry;
}

function setPicture(key: string, read: HeldPictureRead): void {
  const entry = pictures.get(key);
  if (!entry) return;
  entry.read = read;
  entry.subs.forEach((fn) => fn());
}

function readPicture(key: string): void {
  const entry = pictures.get(key);
  if (!entry || entry.reading || entry.read.src !== undefined) return;
  entry.reading = true;
  const [env, ref] = key.split("\n") as [string, string];
  heldPicture(env, JSON.parse(ref) as HeldRef).then(
    (src) => {
      entry.reading = false;
      setPicture(key, { src, loaded: false });
    },
    () => {
      entry.reading = false;
      setPicture(key, { src: "failed", loaded: false });
    },
  );
}

export function useHeldPicture(env: string, ref: HeldRef | null): HeldPicture {
  // Read by the ref's key: a push that rewrites the same item fetches nothing again.
  const key = ref ? `${env}\n${JSON.stringify(ref)}` : null;
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!key) return () => undefined;
      const entry = pictureEntry(key);
      entry.subs.add(fn);
      readPicture(key);
      return () => {
        entry.subs.delete(fn);
        // The last reader gone, the next one reads it afresh.
        if (!entry.subs.size && pictures.get(key) === entry) pictures.delete(key);
      };
    },
    [key],
  );
  const read = useSyncExternalStore(subscribe, () => (key ? (pictures.get(key)?.read ?? PENDING) : NONE));
  const retry = useCallback(() => {
    if (!key) return;
    setPicture(key, { src: undefined, loaded: false });
    readPicture(key);
  }, [key]);
  const onLoad = useCallback(() => {
    const was = key ? pictures.get(key)?.read : undefined;
    if (key && was && typeof was.src === "string" && was.src !== "failed" && !was.loaded) setPicture(key, { src: was.src, loaded: true });
  }, [key]);
  const onError = useCallback(() => key && setPicture(key, { src: "failed", loaded: false }), [key]);
  return { ...read, retry, onLoad, onError };
}

const PENDING: HeldPictureRead = { src: undefined, loaded: false };

/** Whether what his press approves is on screen: the kept picture has drawn, or none was kept. */
export const pictureShown = (p: HeldPictureRead): boolean => p.src === null || (typeof p.src === "string" && p.src !== "failed" && p.loaded);
