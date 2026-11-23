import { useEffect, useState, useSyncExternalStore } from "react";
import { THUMB_SIZES, type FileArchive, type FilePreview } from "@shared/contract-work-files";
import type { FileEntry } from "@shared/work/files";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import type { PlaceCopy, TileSize } from "./model";

/**
 * Pictures of files, for the window (docs/agents/work-files.md "Previews"): a tile's thumbnail and a page of
 * Quick Look. Both are made on the file's own host and asked of it; this file only decides when to ask, asks
 * for many tiles at once, and keeps what came back while the window is open. Nothing here is written to disk.
 * A folder, a file kept in the cloud and a file in the Windows VM are never asked for: a list, a tile and a walk
 * with the arrow keys download nothing.
 */

/** Where a picture is asked: the workspace, and the copy of the place the file was listed from. */
export interface PictureFrom {
  workspaceId: string;
  copy: { link: string; wire: PlaceCopy["wire"]; place: Pick<PlaceCopy["place"], "vm"> };
}

/** A host asked by its link alone, for a file whose place is not at hand (a file open in its tab). */
export const hostFrom = (link: string, workspaceId: string): PictureFrom => ({ workspaceId, copy: { link, wire: "files", place: {} } });

/** A seam for a preview page and tests, which have no host: set, each answers in the host's place. */
export const previewSeams: {
  thumbs?: (from: PictureFrom, entries: readonly FileEntry[], size: number) => Promise<(string | null)[]>;
  preview?: (from: PictureFrom, entry: FileEntry, page: number, width: number) => Promise<FilePreview>;
  archive?: (from: PictureFrom, entry: FileEntry) => Promise<FileArchive>;
} = {};

/** The kinds a host can draw a picture of; a sound and an archive have none. */
const DRAWN: ReadonlySet<FileEntry["kind"]> = new Set(["document", "sheet", "deck", "pdf", "picture", "video", "text"]);

/** Whether a picture of this file may be asked for at all: never a folder's, a cloud-only file's or the Windows VM's. */
export function mayPicture(entry: Pick<FileEntry, "ref" | "kind" | "local" | "state">, from: PictureFrom | null): boolean {
  if (!from || !entry.ref || from.copy.wire !== "files" || from.copy.place.vm) return false;
  if (entry.local === false || entry.state?.is === "cloud") return false;
  return DRAWN.has(entry.kind);
}

/** The host's size for a tile: twice its width in CSS pixels, so it is sharp on a dense screen. */
export const thumbPx = (tile: TileSize | 64): (typeof THUMB_SIZES)[number] => (tile <= 96 ? THUMB_SIZES[0] : tile <= 144 ? THUMB_SIZES[1] : THUMB_SIZES[2]);

/** A host answers a PNG's bytes in base64; a stand-in (a preview page) may answer an address of its own. */
const dataUrl = (png: string): string => (png.startsWith("data:") ? png : `data:image/png;base64,${png}`);

// ── thumbnails ────────────────────────────────────────────────────────

/** A picture kept: its data URL, or null where the host has none to show. */
const thumbs = new Map<string, string | null>();
const thumbListeners = new Map<string, Set<() => void>>();
/** The most thumbnails kept while the window is open; the oldest go first. */
export const THUMBS_KEPT = 600;
/** How many files one ask names (the wire's bound), and how long a tile waits for its neighbours to join it. */
const BATCH_MOST = 40;
const BATCH_AFTER_MS = 40;

/** One file's picture at one size: a changed file (its time, its size) is another picture. */
const thumbKey = (from: PictureFrom, entry: FileEntry, size: number): string => `${from.copy.link}\u0000${from.workspaceId}\u0000${entry.key}\u0000${entry.changed ?? 0}:${entry.size ?? 0}\u0000${size}`;

interface Waiting {
  from: PictureFrom;
  size: number;
  entries: Map<string, FileEntry>;
  timer: ReturnType<typeof setTimeout> | null;
}
const waiting = new Map<string, Waiting>();

function keep(key: string, value: string | null): void {
  thumbs.delete(key);
  thumbs.set(key, value);
  if (thumbs.size > THUMBS_KEPT) for (const old of thumbs.keys()) {
    if (thumbs.size <= THUMBS_KEPT) break;
    if (!thumbListeners.has(old)) thumbs.delete(old);
  }
  for (const listener of thumbListeners.get(key) ?? []) listener();
}

async function flush(queueKey: string): Promise<void> {
  const queue = waiting.get(queueKey);
  if (!queue) return;
  waiting.delete(queueKey);
  const all = [...queue.entries];
  for (let i = 0; i < all.length; i += BATCH_MOST) {
    const part = all.slice(i, i + BATCH_MOST);
    const entries = part.map(([, entry]) => entry);
    const got = await (previewSeams.thumbs
      ? previewSeams.thumbs(queue.from, entries, queue.size)
      : registry
          .linkOf(queue.from.copy.link)
          .request<{ thumbs: (string | null)[] }>("work.files.thumbs", { workspaceId: queue.from.workspaceId, refs: entries.map((e) => e.ref), size: queue.size })
          .then((answer) => answer.thumbs)
    ).catch(() => null);
    // A host that did not answer is asked again the next time the tile is drawn: nothing is kept for it.
    part.forEach(([key], index) => {
      pending.delete(key);
      if (got) keep(key, got[index] ? dataUrl(got[index]!) : null);
    });
  }
}

/** The keys asked for and not yet answered. */
const pending = new Set<string>();

function want(from: PictureFrom, entry: FileEntry, size: number, key: string): void {
  if (thumbs.has(key) || pending.has(key)) return;
  pending.add(key);
  const queueKey = `${from.copy.link}\u0000${from.workspaceId}\u0000${size}`;
  const queue = waiting.get(queueKey) ?? { from, size, entries: new Map(), timer: null };
  queue.entries.set(key, entry);
  waiting.set(queueKey, queue);
  queue.timer ??= setTimeout(() => void flush(queueKey), BATCH_AFTER_MS);
}

/**
 * A tile's picture: undefined while it is asked for (and for a file no picture is asked of), null where the host
 * has none, else a data URL. A tile asks when it is drawn, so a long folder asks only for what is on screen.
 */
export function useThumb(from: PictureFrom | null, entry: FileEntry, tile: TileSize | 64): string | null | undefined {
  const may = mayPicture(entry, from);
  const size = thumbPx(tile);
  const key = may ? thumbKey(from!, entry, size) : null;
  useEffect(() => {
    if (key) want(from!, entry, size, key);
    // The key holds everything the ask depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useSyncExternalStore(
    (listener) => {
      if (!key) return () => undefined;
      const set = thumbListeners.get(key) ?? new Set();
      set.add(listener);
      thumbListeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) thumbListeners.delete(key);
      };
    },
    () => (key ? thumbs.get(key) : null),
  );
}

/** Forgets every picture kept (a test's clean start). */
export function forgetPictures(): void {
  thumbs.clear();
  pending.clear();
  for (const queue of waiting.values()) if (queue.timer) clearTimeout(queue.timer);
  waiting.clear();
  pages.clear();
}

// ── a page of Quick Look ──────────────────────────────────────────────

/** What a page of a preview is, on screen: asked for, drawn, or the one sentence that says why there is none. */
export type PageView = { is: "loading" } | { is: "page"; url: string; pages: number; width: number; height: number } | { is: "none"; why: string };

const pages = new Map<string, PageView>();
/** The most pages kept: a walk through a folder keeps the last few files' pages, no more. */
const PAGES_KEPT = 24;

const LOADING: PageView = { is: "loading" };

/** The widths a page is asked at: a step up from what the pane needs, so a pane resized a little asks nothing new. */
export const pageWidth = (css: number, density = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1): number => {
  const need = Math.max(64, Math.round(css * Math.min(2, density)));
  return need <= 640 ? 640 : need <= 1024 ? 1024 : need <= 1600 ? 1600 : 2048;
};

/**
 * One page of a file's preview, read only. `enabled` false asks nothing (a file kept in the cloud before his
 * press). An older answer never replaces a newer one: a walk with the arrow keys shows only the file it rests on.
 */
export function usePreviewPage(from: PictureFrom | null, entry: FileEntry | null, page: number, width: number, enabled = true): PageView {
  const key = from && entry?.ref && enabled ? `${from.copy.link}\u0000${from.workspaceId}\u0000${entry.key}\u0000${entry.changed ?? 0}:${entry.size ?? 0}\u0000${page}\u0000${width}` : null;
  const [, bump] = useState(0);
  const [failed, setFailed] = useState<{ key: string; why: string } | null>(null);
  useEffect(() => {
    if (!key || pages.has(key)) return;
    let live = true;
    const ask = previewSeams.preview
      ? previewSeams.preview(from!, entry!, page, width)
      : registry.linkOf(from!.copy.link).request<FilePreview>("work.files.preview", { workspaceId: from!.workspaceId, ref: entry!.ref, page, width }, { timeoutMs: 60_000 });
    void ask.then(
      (got) => {
        pages.set(key, "png" in got ? { is: "page", url: dataUrl(got.png), pages: got.pages, width: got.width, height: got.height } : { is: "none", why: got.none });
        if (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value!);
        if (live) bump((n) => n + 1);
      },
      (err: unknown) => {
        // Not kept: the next look asks again.
        if (live) setFailed({ key, why: refusalWords(err) || "The host did not answer." });
      },
    );
    return () => {
      live = false;
    };
    // The key holds everything the ask depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return entry && !entry.ref ? { is: "none", why: "A folder has no preview." } : LOADING;
  return pages.get(key) ?? (failed?.key === key ? { is: "none", why: failed.why } : LOADING);
}

// ── an archive's listing ──────────────────────────────────────────────

export type ArchiveView = { is: "loading" } | { is: "list"; entries: FileArchive["entries"]; more: boolean } | { is: "failed"; why: string };

/** What a zip holds, as its own directory names it: asked once for a file while it is shown. Nothing is extracted. */
export function useArchive(from: PictureFrom | null, entry: FileEntry | null, enabled = true): ArchiveView {
  const [view, setView] = useState<{ key: string; view: ArchiveView } | null>(null);
  const key = from && entry?.ref && enabled ? `${from.copy.link}\u0000${entry.key}\u0000${entry.changed ?? 0}` : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    const ask = previewSeams.archive ? previewSeams.archive(from!, entry!) : registry.linkOf(from!.copy.link).request<FileArchive>("work.files.archive", { workspaceId: from!.workspaceId, ref: entry!.ref });
    void ask.then(
      (got) => live && setView({ key, view: { is: "list", entries: got.entries, more: got.more } }),
      (err: unknown) => live && setView({ key, view: { is: "failed", why: refusalWords(err) || "The host did not answer." } }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return view && view.key === key ? view.view : { is: "loading" };
}
