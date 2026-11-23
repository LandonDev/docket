import type { DeckParagraph, DeckShape, DeckSlide, DeckVersion, DeckView, ShowDeck, SlideChange, SlideOp, DeckColour } from "@shared/contract-work-slides";
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

/** A text shape on a slide, its words in runs, at a box of the slide (shares of its width and height). */
export function textShape(id: number, paragraphs: DeckParagraph[], box: [number, number, number, number] = [0.1, 0.1, 0.9, 0.3], over: Partial<DeckShape> = {}): DeckShape {
  const [x0, y0, x1, y1] = box;
  return {
    id,
    name: `Text ${id}`,
    label: `Text ${id}`,
    kind: "text",
    bbox: box,
    quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    rot: 0,
    flip: false,
    text: paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n"),
    paragraphs,
    frame: { anchor: "top", insets: [91440, 45720, 91440, 45720], fit: "none", wrap: true },
    ...over,
  };
}

/** The run look of a `format` edit's `set`, without what it sets on the paragraph. */
const lookOnly = <T extends { level?: unknown; align?: unknown; list?: unknown }>({ level: _level, align: _align, list: _list, ...look }: T): Omit<T, "level" | "align" | "list"> => look;

/** A look as the host reads it back: a theme colour as the hex it comes to (the fake leaves the tint out). */
function drawn<T extends { color?: DeckColour }>(look: T, view: DeckView): Omit<T, "color"> & { color?: string } {
  const { color, ...rest } = look;
  if (color === undefined) return rest;
  const slot = typeof color === "string" ? null : ({ tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" } as Record<string, string>)[color.slot] ?? color.slot;
  return { ...rest, color: slot === null ? (color as string) : (view.theme?.colors[slot] ?? "000000") };
}

/** A deck's words after one of his edits, as the host would read them back. */
function edited(view: DeckView, op: SlideOp): DeckView {
  if (op.op !== "runs" && op.op !== "format") return view;
  const shapeOf = (s: DeckShape): DeckShape => {
    if (s.id !== op.shape || !s.paragraphs) return s;
    const old = s.paragraphs;
    const paragraphs: DeckParagraph[] =
      op.op === "runs"
        ? op.paragraphs.map((p) => {
            const base = old[p.from ?? 0] ?? old[0];
            return {
              level: p.level ?? base?.level ?? 0,
              align: p.align ?? base?.align ?? "left",
              list: p.list ?? base?.list ?? "none",
              runs: p.runs.map(({ from, ...run }) => ({ ...(from ? old[from[0]]?.runs[from[1]] : base?.runs[0]), ...drawn(run, view) })),
            };
          })
        : old.map((p) => ({ ...p, ...("align" in op.set ? { align: op.set.align! } : {}), runs: p.runs.map((r) => ({ ...r, ...drawn(lookOnly(op.set), view) })) }));
    return { ...s, paragraphs, text: paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n") };
  };
  return { ...view, slides: view.slides.map((sl) => (sl.id === op.slide ? { ...sl, shapes: sl.shapes.map(shapeOf) } : sl)) };
}

const bump = (rev: string): string => `${rev}+`;

export function fakeDeckHost(initial: DeckView): DeckHost & {
  calls: Array<[string, unknown]>;
  view: DeckView;
  push(view: DeckView): void;
  /** while set, an edit is refused with this sentence */
  refuse: string | null;
  /** while set, every edit waits on it */
  hold: Promise<void> | null;
  kept: DeckVersion[];
} {
  const listeners = new Set<(view: DeckView) => void>();
  /** The file changed: a new revision of the deck and of its picture. */
  const moved = (view: DeckView): DeckView => ({ ...view, rev: bump(view.rev), renders: { ...view.renders, file: view.renders.file ? { ...view.renders.file, rev: bump(view.renders.file.rev) } : null } });
  const host = {
    view: initial,
    calls: [] as Array<[string, unknown]>,
    refuse: null as string | null,
    hold: null as Promise<void> | null,
    kept: [] as DeckVersion[],
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
    async edit(ops: SlideOp[]) {
      host.calls.push(["edit", ops]);
      if (host.hold) await host.hold;
      if (host.refuse) throw new Error(host.refuse);
      host.view = { ...moved(ops.reduce(edited, host.view)), hand: { undo: true, redo: false } };
      return host.view;
    },
    async step(dir: "undo" | "redo") {
      host.calls.push(["step", dir]);
      host.view = { ...moved(host.view), hand: { undo: dir === "redo", redo: dir === "undo" } };
      return host.view;
    },
    async versions() {
      host.calls.push(["versions", null]);
      if (host.hold) await host.hold;
      return host.kept;
    },
    async restore(version: string) {
      host.calls.push(["restore", version]);
      host.view = { ...moved(host.view), hand: { undo: false, redo: false } };
      return host.view;
    },
    onView(listener: (view: DeckView) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}
