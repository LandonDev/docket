import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeckMode, DeckView } from "@shared/contract-work-slides";
import { registry } from "../../lib/connection";
import { fromBase64, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";

/** The host's side of a deck, as its canvas uses it (src/shared/contract-work-slides.ts). */
export interface DeckHost {
  open(): Promise<DeckView>;
  /** With `rev`, bytes of a render at another revision (the deck moved on mid-read) are refused (`RENDER_CHANGED`). */
  read(which: "file" | "proposed", offset: number, length: number, rev?: string): Promise<Uint8Array>;
  /** With `rev`, the proposed render the press was made on: the host refuses it once the changes moved on since. */
  review(changes: string[] | "all", verdict: "accept" | "reject", rev?: string): Promise<DeckView>;
  mode(mode: DeckMode): Promise<DeckView>;
  undo(writeId: string): Promise<DeckView>;
  onView(listener: (view: DeckView) => void): () => void;
}

/** A render read whose bytes came from another revision than the view advertised: the preview is being replaced, never a failure to show. */
export const RENDER_CHANGED = "The slides changed while they were read";

export function linkDeckHost(environmentId: string, itemId: string): DeckHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId, ...params });
  return {
    open: () => call("work.slides.open"),
    read: async (which, offset, length, rev) => {
      const got = await call<{ data: string; rev?: string }>("work.slides.read", { which, offset, length });
      // Every frame of one picture comes from the revision the view advertised, as the phone's reads do.
      if (rev !== undefined && got.rev !== undefined && got.rev !== rev) throw new Error(RENDER_CHANGED);
      return fromBase64(got.data);
    },
    review: (changes, verdict, rev) => call("work.slides.review", { changes, verdict, ...(rev !== undefined ? { rev } : {}) }),
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

/** Asks the host for the deck: its view, else the word for why not. Retry asks again. */
export function openDeck(host: DeckHost, store: DeckStore, live: () => boolean = () => true): Promise<void> {
  return host.open().then(
    (view) => void (live() && store.view(view)),
    (error: unknown) => void (live() && store.set({ error: error instanceof Error && error.message ? error.message : "The host did not answer" })),
  );
}

/** Loads the view once and follows the push. */
export function useDeckView(host: DeckHost, store: DeckStore): void {
  useEffect(() => {
    let live = true;
    const off = host.onView((view) => live && store.view(view));
    void openDeck(host, store, () => live);
    return () => {
      live = false;
      off();
    };
  }, [host, store]);
}

/**
 * One of the deck's renders opened in the engine, at its revision: null until it is; `error` when it could not be read;
 * `rev`, the revision the open doc was read at. Bytes from another revision (the deck moved on mid-read) are no failure:
 * the doc stays null and `onChanged` asks for the view again, whose new revision reads afresh.
 */
export function useRender(
  host: DeckHost,
  which: "file" | "proposed",
  render: { rev: string; size: number } | null,
  engine: PdfEngine = pdfjsEngine,
  onChanged?: () => void,
): { doc: PdfDoc | null; error: string | null; rev: string | null; retry(): void } {
  const [state, setState] = useState<{ doc: PdfDoc | null; error: string | null; rev: string | null }>({ doc: null, error: null, rev: null });
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // Each Retry reads the picture again from its first byte.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const rev = render?.rev;
  const size = render?.size;
  useEffect(() => {
    setState({ doc: null, error: null, rev: null });
    if (rev === undefined || size === undefined) return;
    let live = true;
    let opened: PdfDoc | null = null;
    const failed = (error: unknown): void => {
      if (!live) return;
      const message = error instanceof Error && error.message ? error.message : String(error);
      if (message === RENDER_CHANGED) {
        opened?.destroy();
        opened = null;
        setState({ doc: null, error: null, rev: null });
        changed.current?.();
        return;
      }
      setState({ doc: null, error: message, rev: null });
    };
    engine.open({ size, read: (offset, length) => host.read(which, offset, length, rev), onFail: (message) => failed(new Error(message)) }).then((got) => {
      if (!live) return got.destroy();
      opened = got;
      setState({ doc: got, error: null, rev });
    }, failed);
    return () => {
      live = false;
      opened?.destroy();
    };
  }, [host, which, rev, size, engine, attempt]);
  return { ...state, retry };
}
