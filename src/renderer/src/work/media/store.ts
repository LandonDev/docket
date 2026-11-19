import { useEffect, useSyncExternalStore } from "react";
import type { MediaAnchor, MediaNote, MediaView } from "@shared/contract-work-media";
import { registry } from "../../lib/connection";
import { viewerPlays } from "./plays";

/**
 * The renderer's copy of each media item's view (the host's work/media):
 * asked for once per item with what this viewer decodes, then kept current
 * by the `work.media` push, which carries the whole view.
 */

export interface MediaEntry {
  view: MediaView | null;
  error: string | null;
}

const EMPTY: MediaEntry = { view: null, error: null };
const entries = new Map<string, MediaEntry>();
const listeners = new Map<string, Set<() => void>>();
const asked = new Set<string>();

function put(itemId: string, patch: Partial<MediaEntry>): void {
  const prev = entries.get(itemId) ?? EMPTY;
  // A push can overtake an answer: the higher rev wins.
  if (patch.view && prev.view && patch.view.rev < prev.view.rev && patch.view.versions.every((v, i) => v.state === prev.view!.versions[i]?.state)) return;
  entries.set(itemId, { ...prev, ...patch });
  for (const l of listeners.get(itemId) ?? []) l();
}

export function applyMediaView(view: MediaView): void {
  // A view that arrived (an answer, a push) counts as asked: the item is not asked again until its socket comes back.
  asked.add(view.itemId);
  put(view.itemId, { view, error: null });
}

export async function loadMedia(env: string, itemId: string): Promise<void> {
  asked.add(itemId);
  try {
    applyMediaView(await registry.linkOf(env).request<MediaView>("work.media.view", { itemId, plays: viewerPlays() }));
  } catch (err) {
    put(itemId, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The item's view, asked for on first use. */
export function useMedia(env: string, itemId: string): MediaEntry {
  const entry = useSyncExternalStore(
    (l) => {
      let set = listeners.get(itemId);
      if (!set) listeners.set(itemId, (set = new Set()));
      set.add(l);
      return () => set!.delete(l);
    },
    () => entries.get(itemId) ?? EMPTY,
  );
  useEffect(() => {
    if (!asked.has(itemId)) void loadMedia(env, itemId);
  }, [env, itemId]);
  return entry;
}

const call = <T,>(env: string, method: string, params: Record<string, unknown>): Promise<T> => registry.linkOf(env).request<T>(method, params);
const andApply = async (p: Promise<MediaView>): Promise<void> => applyMediaView(await p);

/** What the canvas asks of the host. Each answer that is a view is applied at once; the push follows. */
export const mediaActions = (env: string, itemId: string) => ({
  // A note's answer is the note; the view is asked again at once rather than waiting for the push.
  note: (anchor: MediaAnchor, body: string, kind: MediaNote["kind"] = "comment") => call<MediaNote>(env, "work.media.note", { itemId, anchor, body, kind }).then((n) => (void loadMedia(env, itemId), n)),
  edit: (noteId: string, patch: { body?: string; resolved?: boolean }) => call<MediaNote>(env, "work.media.edit", { noteId, ...patch }).then((n) => (void loadMedia(env, itemId), n)),
  remove: (noteId: string) => call<null>(env, "work.media.remove", { noteId }).then(() => void loadMedia(env, itemId)),
  decide: (which: string, accept: boolean) => andApply(call<MediaView>(env, "work.media.decide", { itemId, which, accept })),
  mode: (mode: MediaView["mode"]) => andApply(call<MediaView>(env, "work.media.mode", { itemId, mode })),
  undo: (writeId: string) => andApply(call<MediaView>(env, "work.media.undo", { itemId, writeId })),
  segment: async (versionId: string, index: number) => (await call<{ url: string }>(env, "work.media.segment", { itemId, versionId, index })).url,
  tile: async (versionId: string, level: number, x: number, y: number) => (await call<{ data: string }>(env, "work.media.tile", { itemId, versionId, level, x, y })).data,
});
export type MediaActions = ReturnType<typeof mediaActions>;

/** The item is being asked for elsewhere (a preview, a test): this window does not ask itself. */
export function markMediaAsked(itemId: string): void {
  asked.add(itemId);
}

/** Test seam: forget everything (a module-level store). */
export function resetMediaStore(): void {
  entries.clear();
  asked.clear();
}

registry.onLink((link, event) => {
  if (event === "removed") return;
  link.onPush((push) => {
    if (push.push === "work.media") applyMediaView(push.view);
  });
  // A socket that came back may have missed a push: the items on screen ask again.
  link.onOpen(() => {
    for (const itemId of listeners.keys()) if (listeners.get(itemId)?.size) void loadMedia(link.environmentId, itemId);
  });
});
