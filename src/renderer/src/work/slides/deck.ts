import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeckMode, DeckVersion, DeckView, ShowDeck, SlideOp } from "@shared/contract-work-slides";
import { registry } from "../../lib/connection";
import { toBase64 } from "../formats/model";
import { fromBase64, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";
import type { ShowHost } from "./show/Show";
import { linkShowRemote, type ShowRemote } from "./show/remote";

/** The host's side of a deck, as its canvas uses it (src/shared/contract-work-slides.ts). */
export interface DeckHost {
  open(): Promise<DeckView>;
  /** The file's slides and render, for a show: never the suggestions that wait. */
  show(): Promise<ShowDeck>;
  /**
   * With `rev`, bytes of a render at another revision (the deck moved on mid-read) are refused (`RENDER_CHANGED`).
   * `layouts` is the picture of the deck's layouts, one page each (`DeckView.layoutsPic`).
   */
  read(which: "file" | "proposed" | "layouts", offset: number, length: number, rev?: string): Promise<Uint8Array>;
  /** With `rev`, the proposed render the press was made on: the host refuses it once the changes moved on since. */
  review(changes: string[] | "all", verdict: "accept" | "reject", rev?: string): Promise<DeckView>;
  mode(mode: DeckMode): Promise<DeckView>;
  undo(writeId: string): Promise<DeckView>;
  /** His own edits, written into the file at once, whole or not at all (refused with a sentence). */
  edit(ops: SlideOp[]): Promise<DeckView>;
  /** Takes his last edit back, or puts back the one he took back. */
  step(dir: "undo" | "redo"): Promise<DeckView>;
  /** The kept copies of the deck, newest first. */
  versions(): Promise<DeckVersion[]>;
  /** Puts a kept copy in the file's place; the deck as it is now is kept first. */
  restore(version: string): Promise<DeckView>;
  /** A picture or a video he adds, brought to the host in pieces: the token an `insert` edit names it by. */
  attach(name: string, data: Uint8Array): Promise<string>;
  onView(listener: (view: DeckView) => void): () => void;
  /** A show's step pictures and clips, by their `rev` (`work.slides.build`, `work.slides.media`), and the word that more of them is ready. */
  build?(rev: string, offset: number, length: number): Promise<Uint8Array>;
  media?(rev: string, offset: number, length: number): Promise<Uint8Array>;
  onReady?(listener: (rev: string) => void): () => void;
  /** The clicker's wire for this deck (show/remote.ts). */
  remote?: ShowRemote;
}

/**
 * The picture of the deck's layouts, one page an entry of `DeckView.layouts` in its order, read with
 * `work.slides.read {which: 'layouts'}`: the lead's `DeckView.layoutsPic`, read here by name until the contract has it.
 */
export const layoutsPicOf = (view: DeckView): { rev: string; size: number } | undefined => view.layoutsPic;

/** The most of a file one `work.slides.attach` carries: 4 MB, which base64 keeps under the method's limit. */
export const ATTACH_PIECE = 4 * 1024 * 1024;

/** A render read whose bytes came from another revision than the view advertised: the preview is being replaced, never a failure to show. */
export const RENDER_CHANGED = "The slides changed while they were read";

export function linkDeckHost(environmentId: string, itemId: string): DeckHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId, ...params });
  return {
    open: () => call("work.slides.open"),
    show: () => call("work.slides.show"),
    read: async (which, offset, length, rev) => {
      const got = await call<{ data: string; rev?: string }>("work.slides.read", { which, offset, length });
      // Every frame of one picture comes from the revision the view advertised, as the phone's reads do.
      if (rev !== undefined && got.rev !== undefined && got.rev !== rev) throw new Error(RENDER_CHANGED);
      return fromBase64(got.data);
    },
    review: (changes, verdict, rev) => call("work.slides.review", { changes, verdict, ...(rev !== undefined ? { rev } : {}) }),
    mode: (mode) => call("work.slides.mode", { mode }),
    undo: (writeId) => call("work.slides.undo", { writeId }),
    edit: (ops) => call("work.slides.edit", { ops }),
    step: (dir) => call("work.slides.step", { dir }),
    versions: () => call("work.slides.versions"),
    restore: (version) => call("work.slides.restore", { version }),
    attach: async (name, data) => {
      let token: string | undefined;
      for (let at = 0; at < data.length || at === 0; at += ATTACH_PIECE) {
        const got = await call<{ token: string }>("work.slides.attach", { name, data: toBase64(data.subarray(at, at + ATTACH_PIECE)), ...(token ? { token } : {}) });
        token = got.token;
        if (data.length === 0) break;
      }
      return token!;
    },
    onView: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.slides" && push.view.itemId === itemId) listener(push.view);
      }),
    build: async (rev, offset, length) => fromBase64((await call<{ data: string }>("work.slides.build", { rev, offset, length })).data),
    media: async (rev, offset, length) => fromBase64((await call<{ data: string }>("work.slides.media", { rev, offset, length })).data),
    onReady: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.slides.ready" && push.itemId === itemId) listener(push.rev);
      }),
    remote: linkShowRemote(environmentId, itemId),
  };
}

/** The deck's host as a show reads it: the file's own slides and render, and the file's revision whenever the deck is told again. */
export const showHostOf = (host: DeckHost): ShowHost => ({
  show: () => host.show(),
  read: (offset, length, rev) => host.read("file", offset, length, rev),
  onRev: (listener) => host.onView((view) => listener(view.rev)),
  // A step's own picture: the show calls it `step`; on the deck's host `step` is his undo and redo.
  ...(host.build ? { step: host.build } : {}),
  ...(host.media ? { media: host.media } : {}),
  ...(host.onReady ? { onReady: host.onReady } : {}),
  ...(host.remote ? { remote: host.remote } : {}),
});

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
  /** One slide on the stage, or every slide in a grid (the row's view switch). */
  look: "slide" | "sorter";
  /** The Format sheet is open beside the stage (or under it in a narrow canvas). */
  sheet: boolean;
  /** The sheet's tab: the picked shape's format, or the slide's animation. Kept while the window lives, so the sheet opens where he left it. */
  sheetTab: SheetTab;
}

export type SheetTab = "format" | "animate";

export class DeckStore {
  private state: DeckState = { view: null, error: null, current: null, side: "tempcode", look: "slide", sheet: false, sheetTab: "format" };
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
 * One of the deck's renders opened in the engine, at its revision: null until the first is; `error` when it could not be
 * read; `rev`, the revision the open doc was read at. A new revision is opened beside the one shown, which stays (and
 * every picture painted from it) until the new one is open, so the stage never blanks between two revisions of the
 * deck. Bytes from another revision (the deck moved on mid-read) are no failure: what is shown stays and `onChanged`
 * asks for the view again, whose new revision reads afresh.
 */
export function useRender(
  host: DeckHost,
  which: "file" | "proposed" | "layouts",
  render: { rev: string; size: number } | null,
  engine: PdfEngine = pdfjsEngine,
  onChanged?: () => void,
): { doc: PdfDoc | null; error: string | null; rev: string | null; retry(): void } {
  const [state, setState] = useState<{ doc: PdfDoc | null; error: string | null; rev: string | null }>({ doc: null, error: null, rev: null });
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // The doc on screen is let go only once another has taken its place on screen (after the pictures painted from it
  // have stopped their paints), or the render is gone.
  const shown = useRef<PdfDoc | null>(null);
  const show = setState;
  useEffect(() => {
    const was = shown.current;
    shown.current = state.doc;
    if (was && was !== state.doc) was.destroy();
  }, [state.doc]);
  useEffect(() => () => shown.current?.destroy(), []);
  // Each Retry reads the picture again from its first byte.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const rev = render?.rev;
  const size = render?.size;
  useEffect(() => {
    if (rev === undefined || size === undefined) return show({ doc: null, error: null, rev: null });
    let live = true;
    let opened: PdfDoc | null = null;
    const failed = (error: unknown): void => {
      if (!live) return;
      const message = error instanceof Error && error.message ? error.message : String(error);
      if (message === RENDER_CHANGED) {
        if (opened && opened !== shown.current) opened.destroy();
        opened = null;
        changed.current?.();
        return;
      }
      show({ doc: null, error: message, rev: null });
    };
    engine.open({ size, read: (offset, length) => host.read(which, offset, length, rev), onFail: (message) => failed(new Error(message)) }).then((got) => {
      if (!live) return got.destroy();
      opened = got;
      show({ doc: got, error: null, rev });
    }, failed);
    return () => {
      live = false;
      // A doc opened for a revision already left behind goes; the one on screen stays until the next replaces it.
      if (opened && opened !== shown.current) opened.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, which, rev, size, engine, attempt]);
  return { ...state, retry };
}
