import { useEffect, useSyncExternalStore } from "react";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { registry } from "../../lib/connection";
import { saveDownload } from "../../lib/native";

/**
 * An item whose bytes come to the host before its kind opens them
 * (docs/agents/work-canvas.md "Fetched sources": a mail's attachment). The
 * pane asks the host once (`work.canvas.fetch`), follows its progress
 * pushes, and mounts the kind only once the file is there. Download reads
 * the host's copy by range and saves it on this computer.
 */

export type Fetch = { phase: "fetching"; received: number; total: number | null } | { phase: "ready"; size: number } | { phase: "failed"; message: string };

/**
 * The kinds whose host side opens a fetched file (pdf/file.ts `sourcePath` for a PDF and a deck, sheets/held.ts
 * `heldOf`, media/prepare.ts): an attachment of any other kind is only saved until its kind reads one.
 */
export const FETCHED_KINDS: readonly CanvasKind[] = ["pdf", "sheet", "media", "slides", "document", "meeting"];

/** Whether an item's bytes are fetched before its kind opens them. */
export const fetchedSource = (item: Pick<CanvasItem, "source">): boolean => item.source.at === "mail";

const states = new Map<string, Fetch>();
const listeners = new Map<string, Set<() => void>>();
const FETCHING: Fetch = { phase: "fetching", received: 0, total: null };

function put(itemId: string, next: Fetch): void {
  states.set(itemId, next);
  for (const fn of listeners.get(itemId) ?? []) fn();
}

const errorWords = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");

/** Asks the host for the item's bytes once; `again` asks after a failure (Retry). */
export function startFetch(env: string, itemId: string, again = false): void {
  const now = states.get(itemId);
  if (now && !(again && now.phase === "failed")) return;
  put(itemId, FETCHING);
  // A host this window does not know is a failure like any other, said in the pane.
  Promise.resolve()
    .then(() => registry.linkOf(env).request<{ size: number }>("work.canvas.fetch", { itemId }))
    .then(
      ({ size }) => put(itemId, { phase: "ready", size }),
      (error: unknown) => put(itemId, { phase: "failed", message: errorWords(error) }),
    );
}

/** The host's progress: kept only while the fetch runs, so a late push never takes a landed file back. */
export function applyFetchPush(push: { itemId: string; received: number; total: number | null }): void {
  if (states.get(push.itemId)?.phase !== "fetching") return;
  put(push.itemId, { phase: "fetching", received: push.received, total: push.total });
}

/** The item's fetch, started on first use; null for an item read where it is. */
export function useItemFetch(env: string, item: Pick<CanvasItem, "id" | "source">): { fetch: Fetch; retry(): void } | null {
  const fetched = fetchedSource(item);
  const itemId = item.id;
  const fetch = useSyncExternalStore(
    (fn) => {
      const set = listeners.get(itemId) ?? new Set();
      set.add(fn);
      listeners.set(itemId, set);
      return () => void set.delete(fn);
    },
    () => states.get(itemId) ?? FETCHING,
  );
  useEffect(() => {
    if (fetched) startFetch(env, itemId);
  }, [env, itemId, fetched]);
  return fetched ? { fetch, retry: () => startFetch(env, itemId, true) } : null;
}

/** Bytes per read: the host's ranged read takes at most 8 MB. */
const CHUNK = 4 * 1024 * 1024;
/** Reads after the first on their way at once (perf M9): the link's round trip is paid once for a few pieces. */
export const DOWNLOAD_AT_ONCE = 3;

/**
 * Reads the host's copy of a fetched item and saves it into this computer's Downloads under its own name: the first
 * piece says the size, and the rest come `DOWNLOAD_AT_ONCE` at a time, each into its place.
 */
export async function downloadItem(env: string, item: Pick<CanvasItem, "id" | "title" | "source">): Promise<void> {
  const link = registry.linkOf(env);
  const read = async (offset: number, length = CHUNK): Promise<{ bytes: Uint8Array; size: number }> => {
    const got = await link.request<{ data: string; size: number }>("work.canvas.read", { itemId: item.id, offset, length });
    return { bytes: Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0)), size: got.size };
  };
  const first = await read(0);
  const size = first.bytes.length ? first.size : 0;
  const whole = new Uint8Array(size);
  whole.set(first.bytes.subarray(0, size), 0);
  const offsets: number[] = [];
  for (let at = first.bytes.length; at < size; at += CHUNK) offsets.push(at);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < offsets.length) {
      const start = offsets[next++]!;
      const end = Math.min(start + CHUNK, size);
      // (a host that answers less than was asked is read on from where it stopped)
      for (let at = start; at < end; ) {
        const { bytes } = await read(at, end - at);
        if (!bytes.length) throw new Error(`${item.title} did not come whole. Try again.`);
        whole.set(bytes.subarray(0, end - at), at);
        at += bytes.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_AT_ONCE, offsets.length) }, lane));
  await saveDownload(item.source.at === "mail" ? item.source.name : item.title, whole);
}

/** Save to workspace: the host copies its file into the item's workspace folder and answers the name it took. */
export const keepItem = (env: string, itemId: string): Promise<{ path: string; name: string }> => registry.linkOf(env).request("work.canvas.keep", { itemId });

/** A preview's seam: the item's fetch as it is drawn, with no host asked. */
export const seedFetch = (itemId: string, fetch: Fetch): void => put(itemId, fetch);

/** Test seam. */
export function resetFetches(): void {
  states.clear();
}

registry.onLink((link, event) => {
  if (event === "removed") return;
  link.onPush((push) => {
    if (push.push === "work.canvas.fetch") applyFetchPush(push);
  });
});
