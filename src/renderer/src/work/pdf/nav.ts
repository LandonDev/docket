import { useSyncExternalStore } from "react";
import type { PdfDoc } from "./engine";
import { findOnPage, type FindHit } from "./find";
import type { Zoom } from "./layout";

/**
 * What the PDF's body and its bar share for one item: the page the column
 * shows, the zoom and the find. The bar reads and steers it; the body
 * scrolls. One per item while the window lives, so a tab switch keeps the
 * place.
 */
export interface NavState {
  page: number;
  pages: number;
  zoom: Zoom;
  /** The body's width, so the bar knows what fits. */
  width: number;
  /** The stepper is in the bar, so the kind's tools give it room. */
  reviewing: boolean;
  find: { open: boolean; query: string; hits: FindHit[]; current: number; searching: boolean };
}

const CLOSED: NavState["find"] = { open: false, query: "", hits: [], current: -1, searching: false };

export class PdfNav {
  private state: NavState = { page: 1, pages: 0, zoom: "fit", width: 0, reviewing: false, find: CLOSED };
  private listeners = new Set<() => void>();
  private doc: PdfDoc | null = null;
  private search: AbortController | null = null;
  /** The match shown, kept by itself: an index would name another match once the list sorts. */
  private shown: FindHit | null = null;
  /** The body's way to scroll: a page, and a box on it to bring into view. */
  scrollTo: ((page: number, box?: [number, number, number, number]) => void) | null = null;

  get = (): NavState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<NavState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  attach(doc: PdfDoc | null): void {
    if (doc === this.doc) return;
    this.doc = doc;
    // While a file (re)opens the place is kept, so the column comes back to the page he was on.
    if (!doc) {
      this.search?.abort();
      return this.set({ pages: 0 });
    }
    this.set({ pages: doc.pages, page: Math.min(Math.max(1, this.state.page), doc.pages) });
    if (this.state.find.query) this.query(this.state.find.query);
  }
  /** The body saw the column scroll. */
  seen(page: number): void {
    if (page !== this.state.page) this.set({ page });
  }
  measured(width: number): void {
    if (Math.abs(width - this.state.width) >= 1) this.set({ width });
  }
  review(reviewing: boolean): void {
    if (reviewing !== this.state.reviewing) this.set({ reviewing });
  }
  goTo(page: number): void {
    const to = Math.min(Math.max(1, page), Math.max(1, this.state.pages));
    this.set({ page: to });
    this.scrollTo?.(to);
  }
  zoom(zoom: Zoom): void {
    this.set({ zoom });
  }
  openFind(): void {
    if (!this.state.find.open) this.set({ find: { ...this.state.find, open: true } });
  }
  closeFind(): void {
    this.search?.abort();
    this.shown = null;
    this.set({ find: CLOSED });
  }
  /** Finds `query` on every page, in order, the count growing as pages are read. */
  query(query: string): void {
    this.search?.abort();
    this.shown = null;
    const doc = this.doc;
    const q = query.trim();
    this.set({ find: { open: true, query, hits: [], current: -1, searching: !!q && !!doc } });
    if (!q || !doc) return;
    const search = new AbortController();
    this.search = search;
    void (async () => {
      const hits: FindHit[] = [];
      // The search reads from the page shown onward and wraps, so the first match it finds is the nearest one ahead,
      // or the first in the file when none lies ahead. That match stays current, by itself, as the list fills and sorts.
      const from = this.state.page;
      const order = Array.from({ length: doc.pages }, (_, i) => ((from - 1 + i) % doc.pages) + 1);
      let lastPush = 0;
      for (const page of order) {
        const runs = await doc.text(page).catch(() => []);
        if (search.signal.aborted) return;
        hits.push(...findOnPage(page, runs, q));
        const now = Date.now();
        if (now - lastPush > 120 || page === order.at(-1)) {
          lastPush = now;
          const sorted = [...hits].sort((a, b) => a.page - b.page);
          const first = this.shown === null && hits.length > 0;
          if (first) this.shown = hits[0];
          this.set({ find: { ...this.state.find, hits: sorted, current: this.shown ? sorted.indexOf(this.shown) : -1, searching: page !== order.at(-1) } });
          if (first) this.show(this.state.find.current);
        }
      }
    })();
  }
  step(by: 1 | -1): void {
    const { hits, current } = this.state.find;
    if (hits.length === 0) return;
    const next = (current + by + hits.length) % hits.length;
    this.shown = hits[next];
    this.set({ find: { ...this.state.find, current: next } });
    this.show(next);
  }
  private show(index: number): void {
    const hit = this.state.find.hits[index];
    if (hit) this.scrollTo?.(hit.page, hit.boxes[0]);
  }
}

const navs = new Map<string, PdfNav>();
export function navOf(itemId: string): PdfNav {
  let nav = navs.get(itemId);
  if (!nav) {
    nav = new PdfNav();
    navs.set(itemId, nav);
  }
  return nav;
}

export function useNav(nav: PdfNav): NavState {
  return useSyncExternalStore(nav.subscribe, nav.get, nav.get);
}

/** For tests: every item starts from page 1 again. */
export function resetNavs(): void {
  navs.clear();
}
