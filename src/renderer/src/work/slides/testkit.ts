import type { DeckSlide, DeckView, ShowDeck, SlideChange } from "@shared/contract-work-slides";
import type { DeckHost } from "./deck";

/** A deck's view for the DOM tests and the preview, and a host that answers the canvas's calls as the host would. */

export function slide(id: number, over: Partial<DeckSlide> = {}): DeckSlide {
  return { key: String(id), id, number: id, title: `Slide ${id}`, notes: "", hidden: false, from: "file", page: id, change: null, tint: null, shapes: [], changed: [], ...over };
}

export function deckView(over: Partial<DeckView> = {}): DeckView {
  return {
    itemId: "deck1",
    sessionId: "t1",
    name: "Sponsor deck.pptx",
    rev: "r1",
    mode: "suggests",
    hosted: false,
    slides: Array.from({ length: 12 }, (_, i) => slide(i + 1)),
    changes: [],
    renders: { file: { rev: "f1", size: 1000, pages: 12 }, proposed: null },
    ...over,
  };
}

export function change(id: string, slideId: number, over: Partial<SlideChange> = {}): SlideChange {
  return { id, kind: "changed", slideId, label: `Slide ${slideId}`, edits: [], by: "agent:local:t1", ...over };
}

export function fakeDeckHost(initial: DeckView): DeckHost & { calls: Array<[string, unknown]>; view: DeckView; push(view: DeckView): void } {
  const listeners = new Set<(view: DeckView) => void>();
  const host = {
    view: initial,
    calls: [] as Array<[string, unknown]>,
    push(view: DeckView) {
      host.view = view;
      for (const l of listeners) l(view);
    },
    async open() {
      host.calls.push(["open", null]);
      return host.view;
    },
    /** The file as it is: the view's slides that are in the file, in the file's order. */
    async show(): Promise<ShowDeck> {
      host.calls.push(["show", null]);
      const slides = host.view.slides.filter((s) => s.from === "file").sort((a, b) => a.page - b.page);
      return { itemId: host.view.itemId, name: host.view.name, rev: host.view.rev, render: host.view.renders.file, slides: slides.map((s) => ({ id: s.id, number: s.page, page: s.page, title: s.title, notes: s.notes, hidden: s.hidden })) };
    },
    async read() {
      return new Uint8Array();
    },
    async review(changes: string[] | "all", verdict: "accept" | "reject", rev?: string) {
      host.calls.push(["review", rev === undefined ? { changes, verdict } : { changes, verdict, rev }]);
      const gone = new Set(changes === "all" ? host.view.changes.map((c) => c.id) : changes);
      host.view = {
        ...host.view,
        changes: host.view.changes.filter((c) => !gone.has(c.id)),
        slides: host.view.slides.filter((s) => !(s.change && gone.has(s.change) && s.tint === "del")).map((s) => (s.change && gone.has(s.change) ? { ...s, change: null, tint: null, changed: [] } : s)),
      };
      return host.view;
    },
    async mode(mode: "suggests" | "writes") {
      host.calls.push(["mode", mode]);
      host.view = { ...host.view, mode };
      return host.view;
    },
    async undo(writeId: string) {
      host.calls.push(["undo", writeId]);
      host.view = { ...host.view, written: undefined };
      return host.view;
    },
    onView(listener: (view: DeckView) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}
