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

/** Reads the host's copy of a fetched item and saves it into this computer's Downloads under its own name. */
export async function downloadItem(env: string, item: Pick<CanvasItem, "id" | "title" | "source">): Promise<void> {
  const link = registry.linkOf(env);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = Number.POSITIVE_INFINITY;
  while (offset < size) {
    const got = await link.request<{ data: string; size: number }>("work.canvas.read", { itemId: item.id, offset, length: CHUNK });
    size = got.size;
    const bytes = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  const whole = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
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
