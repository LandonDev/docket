import { memo, useEffect, useRef, useState } from "react";
import { CSS_PER_POINT, type PdfDoc } from "../../pdf/engine";

/**
 * A show's pictures (docs/DESIGN.md "The show"): a slide is a page of the
 * deck's render, painted at the size of the window it is in. A change of
 * slide is a cut to a picture already painted: the page a press shows next
 * is painted ahead under the one shown, and the one shown stays until the
 * new one is whole, so nothing dips to black between two slides.
 */

/** Pages a show's layers hold, per render: pdf.js frees a page only when no layer of any window still shows it. */
const held = new WeakMap<PdfDoc, Map<number, number>>();
function hold(doc: PdfDoc, page: number): () => void {
  let pages = held.get(doc);
  if (!pages) held.set(doc, (pages = new Map()));
  pages.set(page, (pages.get(page) ?? 0) + 1);
  return () => {
    const left = (pages.get(page) ?? 1) - 1;
    if (left > 0) return void pages.set(page, left);
    pages.delete(page);
    doc.release(page);
  };
}

/** A page's width over its height; 16:9 until its size is read. */
export const aspectOf = (doc: PdfDoc | null, page: number): number => {
  const size = doc?.size(page);
  return size && size.height > 0 ? size.width / size.height : 16 / 9;
};

/** The largest box of a shape that fits a room. */
export function fit(room: { width: number; height: number }, aspect: number): { width: number; height: number } {
  const width = Math.max(0, Math.floor(Math.min(room.width, room.height * aspect)));
  return { width, height: Math.round(width / aspect) };
}

/**
 * One page painted into its box. `ratio` is the window's pixels a CSS pixel
 * over the main window's (the engine reads the main window's): a slideshow
 * on a projector is painted for the projector.
 */
const Layer = memo(function Layer({ doc, page, width, ratio, shown, onPainted }: { doc: PdfDoc; page: number; width: number; ratio: number; shown: boolean; onPainted(drawn: { doc: PdfDoc; page: number }): void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => hold(doc, page), [doc, page]);
  useEffect(() => {
    const el = host.current;
    if (!el || width <= 0) return;
    const job = new AbortController();
    const scale = (width * ratio) / (doc.size(page).width * CSS_PER_POINT);
    // A paint refused (the render was replaced under it) leaves what the layer holds: the picture before stays up.
    doc.paint(page, el, scale, null, job.signal).then(
      () => void (job.signal.aborted || onPainted({ doc, page })),
      () => undefined,
    );
    return () => job.abort();
  }, [doc, page, width, ratio, onPainted]);
  return <div ref={host} data-show-page={page} aria-hidden="true" className={`absolute inset-0 ${shown ? "" : "invisible"}`} />;
});

export interface SlidePictureProps {
  doc: PdfDoc | null;
  /** the page to show */
  page: number;
  /** the page the next press shows: painted under this one, ready */
  ahead?: number | null;
  width: number;
  ratio?: number;
  /** the slide's title, drawn while there is no picture of it */
  title?: string;
  className?: string;
}

/** One page of one render: the same page of the render that replaces it is another layer. */
interface Drawn {
  doc: PdfDoc;
  page: number;
}
const same = (a: Drawn | null, b: Drawn | null): boolean => !!a && !!b && a.doc === b.doc && a.page === b.page;
/** A name for each render, for a layer's key. */
const names = new WeakMap<PdfDoc, number>();
let named = 0;
const nameOf = (doc: PdfDoc): number => names.get(doc) ?? (names.set(doc, ++named), named);

/**
 * A slide at a width: its page, and under it the page a press shows next.
 * What is shown stays until what is asked for has a picture: another slide,
 * or the same deck drawn again after its file changed (the old render's
 * picture outlives its render, so a save mid-talk never blanks the room's
 * screen).
 */
export function SlidePicture({ doc, page, ahead = null, width, ratio = 1, title = "", className = "" }: SlidePictureProps) {
  const [painted, setPainted] = useState<readonly Drawn[]>([]);
  const [last, setLast] = useState<Drawn | null>(null);
  const [onPainted] = useState(() => (drawn: Drawn): void => setPainted((was) => (was.some((d) => same(d, drawn)) ? was : [...was, drawn])));
  const has = (drawn: Drawn | null): drawn is Drawn => painted.some((d) => same(d, drawn));
  const wanted: Drawn | null = doc && page >= 1 && page <= doc.pages ? { doc, page } : null;
  const wantedDone = has(wanted);
  // With no render at all (the host cannot draw this deck) nothing of an older one stays: the title stands in.
  const shown = wantedDone ? wanted : doc && has(last) ? last : null;
  useEffect(() => {
    if (wantedDone && wanted && !same(wanted, last)) setLast(wanted);
  });
  const next: Drawn | null = doc && typeof ahead === "number" && ahead >= 1 && ahead <= doc.pages ? { doc, page: ahead } : null;
  const layers = [shown, wanted, next].filter((d, i, all): d is Drawn => !!d && all.findIndex((o) => same(o, d)) === i);
  // A layer that left takes its mark with it, so a page shown again later is painted again before it counts.
  useEffect(() => {
    setPainted((was) => (was.every((d) => layers.some((l) => same(l, d))) ? was : was.filter((d) => layers.some((l) => same(l, d)))));
  });
  const aspect = aspectOf(doc, page);
  return (
    <div data-show-picture data-page={shown && shown.doc === doc ? shown.page : undefined} className={`relative overflow-hidden ${className}`} style={{ width, height: Math.round(width / aspect) }}>
      {layers.map((d) => (
        <Layer key={`${nameOf(d.doc)}:${d.page}`} doc={d.doc} page={d.page} width={width} ratio={ratio} shown={same(d, shown)} onPainted={onPainted} />
      ))}
      {!doc && title ? <div className="absolute inset-0 grid place-items-center overflow-hidden p-2 text-center text-xs leading-4 text-muted-foreground">{title}</div> : null}
    </div>
  );
}

/** Whether an element is in its own window's view, or near it; true where nothing lays out (a test). */
function useNear(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    // The observer of the element's own window: the main window's would watch the wrong viewport.
    const Observer = el?.ownerDocument.defaultView?.IntersectionObserver;
    if (!el || !Observer) return setNear(true);
    const observer = new Observer((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

/** A small slide for the strip and the picker: painted only near the view. */
export const Thumb = memo(function Thumb({ doc, page, width, ratio = 1, title }: { doc: PdfDoc | null; page: number; width: number; ratio?: number; title: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const near = useNear(box);
  const aspect = aspectOf(doc, page);
  return (
    <span ref={box} className="block overflow-hidden rounded-[3px] bg-muted outline-1 -outline-offset-1 outline-(--image-outline)" style={{ width, height: Math.round(width / aspect) }}>
      {near ? <SlidePicture doc={doc} page={page} width={width} ratio={ratio} title={title} /> : null}
    </span>
  );
});
