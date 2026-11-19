import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeckMode, DeckView } from "@shared/contract-work-slides";
import { registry } from "../../lib/connection";
import { fromBase64, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";

/** The host's side of a deck, as its canvas uses it (src/shared/contract-work-slides.ts). */
export interface DeckHost {
  open(): Promise<DeckView>;
  read(which: "file" | "proposed", offset: number, length: number): Promise<Uint8Array>;
  review(changes: string[] | "all", verdict: "accept" | "reject"): Promise<DeckView>;
  mode(mode: DeckMode): Promise<DeckView>;
  undo(writeId: string): Promise<DeckView>;
  onView(listener: (view: DeckView) => void): () => void;
}

export function linkDeckHost(environmentId: string, itemId: string): DeckHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId, ...params });
  return {
    open: () => call("work.slides.open"),
    read: async (which, offset, length) => fromBase64((await call<{ data: string }>("work.slides.read", { which, offset, length })).data),
    review: (changes, verdict) => call("work.slides.review", { changes, verdict }),
    mode: (mode) => call("work.slides.mode", { mode }),
    undo: (writeId) => call("work.slides.undo", { writeId }),
    onView: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.slides" && push.view.itemId === itemId) listener(push.view);
      }),
  };
}

/**
 * What the deck's body, its bar and its tab-row switch share for one item:
 * the view, the slide on the stage, and which app shows the deck. One per
 * item while the window lives, so a tab switch keeps the place.
 */
export interface DeckState {
  view: DeckView | null;
  error: string | null;
  /** The key of the slide on the stage. */
  current: string | null;
  /** A hosted deck shows in TempCode or in the real PowerPoint. */
  side: "tempcode" | "powerpoint";
}

export class DeckStore {
  private state: DeckState = { view: null, error: null, current: null, side: "tempcode" };
  private listeners = new Set<() => void>();
  get = (): DeckState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(patch: Partial<DeckState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** A new view keeps the slide on the stage when it is still there, else the slide in its place. */
  view(view: DeckView): void {
    const was = this.state.view?.slides ?? [];
    const keys = new Set(view.slides.map((s) => s.key));
    let current = this.state.current;
    if (!current || !keys.has(current)) {
      const at = Math.max(0, was.findIndex((s) => s.key === current));
      current = view.slides[Math.min(at, view.slides.length - 1)]?.key ?? null;
    }
    this.set({ view, error: null, current });
  }
}

const stores = new Map<string, DeckStore>();
export function deckStoreOf(itemId: string): DeckStore {
  let store = stores.get(itemId);
  if (!store) {
    store = new DeckStore();
    stores.set(itemId, store);
  }
  return store;
}
export const useDeck = (store: DeckStore): DeckState => useSyncExternalStore(store.subscribe, store.get, store.get);

/** Loads the view once and follows the push. */
export function useDeckView(host: DeckHost, store: DeckStore): void {
  useEffect(() => {
    let live = true;
    const off = host.onView((view) => live && store.view(view));
    host.open().then(
      (view) => live && store.view(view),
      (error: unknown) => live && store.set({ error: error instanceof Error && error.message ? error.message : "The host did not answer" }),
    );
    return () => {
      live = false;
      off();
    };
  }, [host, store]);
}

/** One of the deck's renders opened in the engine, at its revision: null until it is; `error` when it could not be read. */
export function useRender(host: DeckHost, which: "file" | "proposed", render: { rev: string; size: number } | null, engine: PdfEngine = pdfjsEngine): { doc: PdfDoc | null; error: string | null } {
  const [state, setState] = useState<{ doc: PdfDoc | null; error: string | null }>({ doc: null, error: null });
  const rev = render?.rev;
  const size = render?.size;
  useEffect(() => {
    setState({ doc: null, error: null });
    if (rev === undefined || size === undefined) return;
    let live = true;
    let opened: PdfDoc | null = null;
    const failed = (error: unknown): void => {
      if (live) setState({ doc: null, error: error instanceof Error && error.message ? error.message : String(error) });
    };
    engine.open({ size, read: (offset, length) => host.read(which, offset, length), onFail: (message) => failed(new Error(message)) }).then((got) => {
      if (!live) return got.destroy();
      opened = got;
      setState({ doc: got, error: null });
    }, failed);
    return () => {
      live = false;
      opened?.destroy();
    };
  }, [host, which, rev, size, engine]);
  return state;
}
