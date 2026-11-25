import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeckSlide, DeckView } from "@shared/contract-work-slides";
import { onItemsGone } from "../canvas/gone";
import type { PdfDoc, PdfEngine } from "../pdf/engine";
import { RENDER_CHANGED, type DeckHost } from "./deck";

/**
 * The pictures of the deck's own slides (`from: 'file'`), slide by slide. The first view reads the deck's whole render,
 * one page a slide, as before. A later view keeps each slide whose picture is the same (`DeckSlide.pic.rev`) and reads
 * only the ones that changed, each its own one-page PDF (`work.slides.slide`), so an edit, and every save of his typing,
 * reads the slide it changed and nothing else. The whole render is read again only where per-slide reads cannot do it:
 * a slide the host has no picture of, a host with no `slide`, or more changed slides than `SLIDE_READS_MOST`.
 *
 * A new set of pictures takes the place of the one shown only once all of it is open, so the stage and the strip never
 * blank between two revisions. A doc goes once no slide shows it.
 */

/** Past this many changed slides in one view, the deck's whole render is read instead: one read, not many. */
export const SLIDE_READS_MOST = 4;

type Picture = { doc: PdfDoc; page: number; pic: string | null };

export interface FilePicturesState {
  /** the file render's revision every picture shown stands at; null before the first */
  rev: string | null;
  error: string | null;
  /** each file slide's picture by its key, as shown now: a new map with every new set */
  shown: ReadonlyMap<string, { doc: PdfDoc; page: number }>;
}

/** A file slide's picture in a set as shown, and its page; a doc of null while none is open for it. */
export const pictureIn = (shown: FilePicturesState["shown"], slide: Pick<DeckSlide, "key" | "page">): { doc: PdfDoc | null; page: number } => shown.get(slide.key) ?? { doc: null, page: slide.page };

export class FilePictures {
  private pictures = new Map<string, Picture>();
  private state: FilePicturesState = { rev: null, error: null, shown: new Map() };
  private listeners = new Set<() => void>();
  /** the latest view asked for: an older one still being read is dropped when it lands */
  private wanted = 0;
  /** the revision the pictures were last asked for, so the same view pushed again reads nothing */
  private asked: string | null = null;
  private gone = false;

  constructor(
    readonly host: DeckHost,
    private readonly engine: PdfEngine,
    private readonly onChanged: () => void = () => undefined,
    readonly itemId = "",
  ) {}

  /** Destroyed: a body that comes back makes a new one. */
  isGone = (): boolean => this.gone;

  get = (): FilePicturesState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<FilePicturesState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }


  /** Whether a doc is one of these pictures. */
  holds(doc: PdfDoc): boolean {
    for (const picture of this.pictures.values()) if (picture.doc === doc) return true;
    return false;
  }

  /** Reads what this view's file slides need. `again`: Retry, which reads afresh even the same revision. */
  update(view: DeckView | null, again = false): void {
    const render = view?.renders.file ?? null;
    if (!view || !render || view.renderError) return;
    if (!again && this.asked === render.rev) return;
    this.asked = render.rev;
    const mine = ++this.wanted;
    const slides = view.slides.filter((s) => s.from === "file");
    const changed = slides.filter((s) => {
      const had = this.pictures.get(s.key);
      return !had || !s.pic || had.pic !== s.pic.rev;
    });
    const whole = this.pictures.size === 0 || again || changed.length > SLIDE_READS_MOST || !this.host.slide || changed.some((s) => !s.pic);
    void this.read(view, slides, whole ? slides : changed, whole, mine);
  }

  private async read(view: DeckView, slides: DeckSlide[], reading: DeckSlide[], whole: boolean, mine: number): Promise<void> {
    const render = view.renders.file!;
    const opened: PdfDoc[] = [];
    try {
      const next = new Map<string, Picture>();
      if (whole) {
        const doc = await this.engine.open({ size: render.size, read: (offset, length) => this.host.read("file", offset, length, render.rev) });
        opened.push(doc);
        for (const s of slides) next.set(s.key, { doc, page: s.page, pic: s.pic?.rev ?? null });
      } else {
        const got = await Promise.allSettled(reading.map((s) => this.engine.open({ size: s.pic!.size, read: (offset, length) => this.host.slide!("file", s.id, offset, length, s.pic!.rev) })));
        for (const one of got) if (one.status === "fulfilled") opened.push(one.value);
        const failed = got.find((one): one is PromiseRejectedResult => one.status === "rejected");
        if (failed) throw failed.reason;
        const docs = reading.map((s, i) => [s, (got[i] as PromiseFulfilledResult<PdfDoc>).value] as const);
        for (const s of slides) {
          const kept = this.pictures.get(s.key);
          if (kept && s.pic && kept.pic === s.pic.rev) next.set(s.key, kept);
        }
        for (const [s, doc] of docs) next.set(s.key, { doc, page: 1, pic: s.pic!.rev });
      }
      if (this.gone || mine !== this.wanted) return this.release(opened);
      const before = this.pictures;
      this.pictures = next;
      this.letGo(before);
      this.set({ rev: render.rev, error: null, shown: next });
    } catch (error) {
      this.release(opened);
      if (this.gone || mine !== this.wanted) return;
      const message = error instanceof Error && error.message ? error.message : String(error);
      // The deck moved on mid-read: what is shown stays, and the view is asked again.
      if (message === RENDER_CHANGED) {
        this.asked = null;
        return this.onChanged();
      }
      this.asked = null;
      this.set({ error: message });
    }
  }

  /** Reads the pictures again from the first byte: Retry after a read that failed. */
  retry(view: DeckView | null): void {
    this.set({ error: null });
    this.update(view, true);
  }

  /** The docs of a set of pictures no longer shown go, but for those the pictures shown now still use. */
  private letGo(before: Map<string, Picture>): void {
    const used = new Set([...this.pictures.values()].map((p) => p.doc));
    const done = new Set<PdfDoc>();
    for (const picture of before.values()) {
      if (used.has(picture.doc) || done.has(picture.doc)) continue;
      done.add(picture.doc);
      picture.doc.destroy();
    }
  }

  private release(docs: PdfDoc[]): void {
    for (const doc of docs) doc.destroy();
  }

  /** Every doc goes: the deck's body left for good (its item closed, or it was let go of the kept ones). */
  destroy(): void {
    this.gone = true;
    const all = this.pictures;
    this.pictures = new Map();
    this.letGo(all);
  }
}

/** How many decks not shown keep their pictures, so a deck's tab shown again draws at once and reads nothing. */
export const KEPT_DECKS = 3;
/** The pictures of each deck item, by its host and id: a test's host never meets another's. */
const sets = new WeakMap<DeckHost, Map<string, FilePictures>>();
/** Every set alive, and the ones no body shows, the most recently left last. */
const alive = new Set<FilePictures>();
const kept: FilePictures[] = [];
/** Sets whose item closed while a body showed it: they go when that body does. */
const closed = new Set<FilePictures>();

function forget(set: FilePictures): void {
  const at = kept.indexOf(set);
  if (at >= 0) kept.splice(at, 1);
  alive.delete(set);
  const items = sets.get(set.host);
  if (items?.get(set.itemId) === set) items.delete(set.itemId);
  closed.delete(set);
  set.destroy();
}

function obtain(host: DeckHost, itemId: string, engine: PdfEngine, onChanged: () => void): FilePictures {
  let items = sets.get(host);
  if (!items) sets.set(host, (items = new Map()));
  const had = items.get(itemId);
  if (had && !had.isGone()) return had;
  const made = new FilePictures(host, engine, onChanged, itemId);
  items.set(itemId, made);
  alive.add(made);
  return made;
}

// A closed deck's pictures go with it.
onItemsGone((ids) => {
  const gone = new Set(ids);
  for (const set of [...alive]) {
    if (!gone.has(set.itemId)) continue;
    if (kept.includes(set)) forget(set);
    else closed.add(set);
  }
});

/** For tests: how many decks keep their pictures while not shown, and none after a reset. */
export const keptDeckCount = (): number => kept.length;
export function resetFilePictures(): void {
  for (const set of [...alive]) forget(set);
}

/**
 * The deck's file pictures for a body: the item's kept set when it has one (drawn at once, a new view reading only the
 * slides that changed), else a new one, which the body keeps among the `KEPT_DECKS` as it goes.
 */
export function useFilePictures(host: DeckHost, itemId: string, engine: PdfEngine, view: DeckView | null, onChanged: () => void): { pictures: FilePictures; state: FilePicturesState } {
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  const [pictures] = useState(() => obtain(host, itemId, engine, () => changed.current()));
  useEffect(() => {
    const at = kept.indexOf(pictures);
    if (at >= 0) kept.splice(at, 1);
    return () => {
      if (closed.has(pictures)) return forget(pictures);
      kept.push(pictures);
      while (kept.length > KEPT_DECKS) forget(kept[0]!);
    };
  }, [pictures]);
  const state = useSyncExternalStore(pictures.subscribe, pictures.get, pictures.get);
  useEffect(() => pictures.update(view), [pictures, view]);
  return { pictures, state };
}
