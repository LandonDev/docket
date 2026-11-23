import type { DeckColour, DeckParagraph, DeckShape, DeckSlide, DeckVersion, DeckView, ShowDeck, SlideChange, SlideOp } from "@shared/contract-work-slides";
import type { DeckHost } from "./deck";
import { OFFICE_THEME } from "work-kit/format/theme";

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

/** A shape at a box of the slide (shares), with its own box in EMU on a 16:9 slide, as the outline gives it. */
export function boxShape(id: number, box: [number, number, number, number], over: Partial<DeckShape> = {}, size = SIZE): DeckShape {
  const [x0, y0, x1, y1] = box;
  return {
    id,
    name: `Shape ${id}`,
    kind: "other",
    bbox: box,
    quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    text: "",
    own: { box: [Math.round(x0 * size.width), Math.round(y0 * size.height), Math.round((x1 - x0) * size.width), Math.round((y1 - y0) * size.height)], rot: 0, flipH: false, flipV: false },
    ...over,
  };
}

/** A 16:9 slide in EMU. */
export const SIZE = { width: 12_192_000, height: 6_858_000 };

/** A shape where a geometry edit puts it: its own box, turn and corners. */
function placed(shape: DeckShape, op: Extract<SlideOp, { op: "geometry" }>, size: { width: number; height: number }): DeckShape {
  const own = { box: op.box ?? shape.own?.box ?? [0, 0, 1, 1], rot: op.rot ?? shape.own?.rot ?? 0, flipH: op.flipH ?? shape.own?.flipH ?? false, flipV: op.flipV ?? shape.own?.flipV ?? false };
  const [l, t, w, h] = own.box;
  const r = (own.rot * Math.PI) / 180;
  const c = { x: l + w / 2, y: t + h / 2 };
  const at = (u: number, v: number): [number, number] => [(c.x + u * Math.cos(r) - v * Math.sin(r)) / size.width, (c.y + u * Math.sin(r) + v * Math.cos(r)) / size.height];
  const quad: DeckShape["quad"] = [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  return { ...shape, own, quad, rot: own.rot, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

/** What the fake host makes of an `insert`: a shape of its kind, the next id on the slide. */
function inserted(slide: DeckSlide, op: Extract<SlideOp, { op: "insert" }>, size: { width: number; height: number }): DeckShape {
  const id = op.id ?? Math.max(1, ...slide.shapes.map((s) => s.id)) + 1;
  const [l, t, w, h] = op.box;
  const kind = op.what === "text" ? "text" : op.what === "shape" ? "other" : op.what === "video" ? "media" : op.what;
  const base = boxShape(id, [l / size.width, t / size.height, (l + w) / size.width, (t + h) / size.height], { kind, name: `${op.what} ${id}` }, size);
  return op.what === "text" ? { ...base, text: op.text ?? "", paragraphs: [{ level: 0, align: "left", list: "none", runs: [{ text: op.text ?? "", font: "Calibri", size: 18, color: "000000" }] }], frame: { anchor: "top", insets: [91440, 45720, 91440, 45720], fit: "grow", wrap: true } } : op.what === "shape" ? { ...base, shape: op.preset ?? "rect" } : base;
}

/** The deck after one of his edits to a slide's shapes, its slides or its theme, as the host would read it back. */
function arranged(view: DeckView, op: SlideOp): DeckView {
  const size = view.size ?? SIZE;
  const onSlide = (id: number, edit: (slide: DeckSlide) => DeckSlide): DeckView => ({ ...view, slides: view.slides.map((s) => (s.id === id && s.tint !== "del" ? edit(s) : s)) });
  const renumber = (slides: DeckSlide[]): DeckSlide[] => slides.map((s, i) => ({ ...s, number: i + 1 }));
  switch (op.op) {
    case "geometry":
      return onSlide(op.slide, (s) => ({ ...s, shapes: s.shapes.map((sh) => (sh.id === op.shape ? placed(sh, op, size) : sh)) }));
    case "delete":
      return onSlide(op.slide, (s) => ({ ...s, shapes: s.shapes.filter((sh) => sh.id !== op.shape) }));
    case "insert":
      return onSlide(op.slide, (s) => ({ ...s, shapes: [...s.shapes, inserted(s, op, size)] }));
    case "fill":
      return onSlide(op.slide, (s) => ({ ...s, shapes: s.shapes.map((sh) => (sh.id === op.shape ? { ...sh, fill: op.color === null ? "none" : typeof op.color === "string" ? op.color : slotHex(op.color.slot, view) } : sh)) }));
    case "line":
      return onSlide(op.slide, (s) => ({ ...s, shapes: s.shapes.map((sh) => (sh.id === op.shape ? { ...sh, line: { ...sh.line, ...(op.color !== undefined ? { color: op.color === null ? "none" : typeof op.color === "string" ? op.color : slotHex(op.color.slot, view) } : {}), ...(op.width !== undefined ? { width: op.width } : {}), ...(op.dash ? { dash: op.dash } : {}) } } : sh)) }));
    case "order":
      return onSlide(op.slide, (s) => {
        const at = s.shapes.findIndex((sh) => sh.id === op.shape);
        if (at < 0) return s;
        const list = s.shapes.filter((sh) => sh.id !== op.shape);
        const to = op.to === "front" ? list.length : op.to === "back" ? 0 : op.to === "forward" ? Math.min(list.length, at + 1) : Math.max(0, at - 1);
        list.splice(to, 0, s.shapes[at]);
        return { ...s, shapes: list };
      });
    case "hide":
      return onSlide(op.slide, (s) => ({ ...s, hidden: op.hidden }));
    case "layout":
      return onSlide(op.slide, (s) => ({ ...s, layout: op.layout }));
    case "transition":
      return onSlide(op.slide, (s) => ({
        ...s,
        transition: op.kind === "none" && op.click !== false && op.after == null ? undefined : { kind: op.kind, ...(op.dir ? { dir: op.dir } : {}), ms: 750, ...(op.after != null ? { after: op.after * 1000 } : {}), ...(op.click === false ? { click: false } : {}) },
      }));
    case "builds":
      // As the deck tool reads back what it wrote: each shape hidden until its press, and the order.
      return onSlide(op.slide, (s) => {
        const order = op.order as number[];
        return { ...s, builds: order.length ? { steps: order.map((_, i) => ({ shapes: order.slice(i).sort((a, b) => a - b), paras: [] })).concat([{ shapes: [], paras: [] }]), changed: 0, order } : undefined };
      });
    case "theme":
      return { ...view, theme: { colors: { ...view.theme?.colors, ...op.colors }, major: op.major ?? view.theme?.major ?? "", minor: op.minor ?? view.theme?.minor ?? "" } };
    case "move": {
      const moving = view.slides.find((s) => s.id === op.slide);
      if (!moving) return view;
      const rest = view.slides.filter((s) => s.id !== op.slide);
      rest.splice(op.after === 0 ? 0 : rest.findIndex((s) => s.id === op.after) + 1, 0, moving);
      return { ...view, slides: renumber(rest) };
    }
    case "remove":
      return { ...view, slides: renumber(view.slides.filter((s) => s.id !== op.slide)) };
    case "duplicate":
    case "add": {
      const id = op.id ?? Math.max(0, ...view.slides.map((s) => s.id)) + 1;
      const at = op.op === "add" ? (op.after === 0 ? 0 : view.slides.findIndex((s) => s.id === op.after) + 1) : view.slides.findIndex((s) => s.id === op.slide) + 1;
      const from = op.op === "duplicate" ? view.slides.find((s) => s.id === op.slide) : undefined;
      const made = from ? { ...from, key: String(id), id, section: undefined } : slide(id, { layout: op.op === "add" ? op.layout : undefined, title: op.op === "add" ? (op.title ?? "") : "" });
      const slides = [...view.slides];
      slides.splice(at, 0, made);
      return { ...view, slides: renumber(slides) };
    }
    case "section": {
      const starts = view.slides.filter((s) => s.section !== undefined);
      if (op.act === "add") return onSlide(op.at, (s) => ({ ...s, section: op.name }));
      const target = starts[op.section];
      if (!target) return view;
      return onSlide(target.id, (s) => ({ ...s, section: op.act === "rename" ? op.name : undefined }));
    }
    default:
      return view;
  }
}

/** A theme's slot as its hex: the deck's own theme, else Office's; text and background by the names a run uses. */
function slotHex(slot: string, view: DeckView): string {
  const name = ({ tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" } as Record<string, string>)[slot] ?? slot;
  return view.theme?.colors[name] ?? (OFFICE_THEME.colours as Record<string, string>)[name] ?? "000000";
}

/** A colour as the outline reads it back: a theme's slot as the theme's hex (the fake leaves the tint out). */
const hexOf = (color: DeckColour | undefined, view: DeckView): { color?: string } => (color === undefined ? {} : { color: typeof color === "string" ? color : slotHex(color.slot, view) });

/** A deck's words after one of his edits, as the host would read them back. */
function edited(view: DeckView, op: SlideOp): DeckView {
  if (op.op !== "runs" && op.op !== "format") return arranged(view, op);
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
              runs: p.runs.map(({ from, color, ...run }) => ({ ...(from ? old[from[0]]?.runs[from[1]] : base?.runs[0]), ...run, ...hexOf(color, view) })),
            };
          })
        : old.map((p) => {
            const { color, ...set } = op.set;
            return { ...p, ...("align" in op.set ? { align: op.set.align! } : {}), runs: p.runs.map((r) => ({ ...r, ...set, ...hexOf(color, view) })) };
          });
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
    async attach(name: string, data: Uint8Array) {
      host.calls.push(["attach", { name, size: data.length }]);
      return `token:${name}`;
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
