import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DUR } from "../../../lib/ease";
import { CSS_PER_POINT, type PdfDoc } from "../../pdf/engine";
import type { ShowMotion } from "./state";

/**
 * A show's pictures (docs/DESIGN.md "The show"): a slide is a page of the
 * deck's render, or a step's own one-page picture, painted at the size of
 * the window it is in. The page a press shows next is painted ahead under
 * the one shown, and the one shown stays until the new one is whole, so
 * nothing dips to black between two pictures. The new one then comes in by
 * its motion: a build's fade, the slide's own fade or push, else a cut.
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
    // A render replaced meanwhile is destroyed, and pdf.js throws when asked for its page: there is nothing to free.
    try {
      doc.release(page);
    } catch {
      /* destroyed */
    }
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

/** A motion token as the picture's own window has it (index.css, mirrored into a show's window): a curve, or a time in ms. */
function token(el: HTMLElement, name: string): string {
  return el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue(name).trim() ?? "";
}
const ms = (value: string, fallback: number): number => (/^\d+(\.\d+)?ms$/.test(value) ? parseFloat(value) : fallback);

/** The Web Animations of a picture coming in over the one it replaces: transform and opacity alone, on the app's tokens. */
function play(motion: NonNullable<ShowMotion>, into: HTMLElement, from: HTMLElement | null): Animation[] {
  // A document with no Web Animations (a test's) cuts.
  if (typeof into.animate !== "function") return [];
  if (motion.kind !== "push") {
    // A build's fade and a slide's: the new picture over the old, which stays whole under it.
    return [into.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(token(into, "--dur-slow"), DUR.slow * 1000), easing: token(into, "--ease-out") || undefined })];
  }
  // Pushed: the new slide comes from the side the push names and the old one leaves by the other.
  const [x, y] = { l: [100, 0], r: [-100, 0], u: [0, 100], d: [0, -100] }[motion.dir];
  const timing = { duration: ms(token(into, "--dur-drawer"), DUR.drawer * 1000), easing: token(into, "--ease-drawer") || undefined };
  const shift = (dx: number, dy: number): string => `translate(${dx}%, ${dy}%)`;
  return [into.animate([{ transform: shift(x, y) }, { transform: shift(0, 0) }], timing), ...(from ? [from.animate([{ transform: shift(0, 0) }, { transform: shift(-x, -y) }], timing)] : [])];
}

export interface SlidePictureProps {
  doc: PdfDoc | null;
  /** the page to show */
  page: number;
  /** the page the next press shows: painted under this one, ready; of `aheadDoc` when it is another render (a step's picture) */
  ahead?: number | null;
  aheadDoc?: PdfDoc | null;
  /** the picture asked for is still being read: what is shown stays, and no title stands in */
  waiting?: boolean;
  /** how the picture asked for comes in once it is whole; a new `motionKey` is a new arrival */
  motion?: ShowMotion;
  motionKey?: string;
  /** laid over the picture, in its box (a slide's video) */
  children?: ReactNode;
  width: number;
  ratio?: number;
  /** the slide's title, drawn while there is no picture of it */
  title?: string;
  className?: string;
  /** told once the picture asked for is painted, so a clock waits for what the room sees */
  onShown?(): void;
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
export function SlidePicture({ doc, page, ahead = null, aheadDoc, width, ratio = 1, title = "", className = "", waiting = false, motion = null, motionKey, children, onShown }: SlidePictureProps) {
  const [painted, setPainted] = useState<readonly Drawn[]>([]);
  const [last, setLast] = useState<Drawn | null>(null);
  const [onPainted] = useState(() => (drawn: Drawn): void => setPainted((was) => (was.some((d) => same(d, drawn)) ? was : [...was, drawn])));
  const has = (drawn: Drawn | null): drawn is Drawn => painted.some((d) => same(d, drawn));
  const wanted: Drawn | null = !waiting && doc && page >= 1 && page <= doc.pages ? { doc, page } : null;
  const wantedDone = has(wanted);
  // With no render at all (the host cannot draw this deck) nothing of an older one stays: the title stands in.
  const shown = wantedDone ? wanted : (doc || waiting) && has(last) ? last : null;
  useEffect(() => {
    if (wantedDone && wanted && !same(wanted, last)) setLast(wanted);
  });
  useEffect(() => {
    if (wantedDone) onShown?.();
  }, [wantedDone, onShown]);
  const nextDoc = aheadDoc ?? doc;
  const next: Drawn | null = nextDoc && typeof ahead === "number" && ahead >= 1 && ahead <= nextDoc.pages ? { doc: nextDoc, page: ahead } : null;

  // An arrival: the picture shown changes while a motion is asked for. The one it replaces stays under it, whole,
  // until the motion ends; a press during it ends that motion at once and starts the next from there.
  const [arrival, setArrival] = useState<{ from: Drawn | null; to: Drawn | null; motion: ShowMotion; key?: string; n: number }>({ from: null, to: shown, motion: null, key: motionKey, n: 0 });
  if (!same(arrival.to, shown) && !(arrival.to === null && shown === null)) {
    const moving = !!motion && !!arrival.to && !!shown && motionKey !== undefined && motionKey !== arrival.key;
    setArrival({ from: moving ? arrival.to : null, to: shown, motion: moving ? motion : null, key: shown ? motionKey : arrival.key, n: arrival.n + 1 });
  }
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const { from, to, motion: m } = arrival;
    if (!m || !to || !box.current) return;
    const el = (d: Drawn): HTMLElement | null => box.current?.querySelector<HTMLElement>(`[data-layer="${nameOf(d.doc)}:${d.page}"]`) ?? null;
    const into = el(to);
    if (!into) return;
    const running = play(m, into, from ? el(from) : null);
    let live = true;
    void Promise.all(running.map((a) => a.finished)).then(
      () => live && setArrival((was) => (was.n === arrival.n ? { ...was, from: null, motion: null } : was)),
      () => undefined,
    );
    return () => {
      live = false;
      running.forEach((a) => a.finish());
    };
  }, [arrival]);
  const leaving = arrival.motion ? arrival.from : null;
  const layers = [leaving, shown, wanted, next].filter((d, i, all): d is Drawn => !!d && all.findIndex((o) => same(o, d)) === i);
  // A layer that left takes its mark with it, so a page shown again later is painted again before it counts.
  useEffect(() => {
    setPainted((was) => (was.every((d) => layers.some((l) => same(l, d))) ? was : was.filter((d) => layers.some((l) => same(l, d)))));
  });
  const aspect = aspectOf(doc, page);
  return (
    <div ref={box} data-show-picture data-page={shown && shown.doc === doc ? shown.page : undefined} className={`relative overflow-hidden ${className}`} style={{ width, height: Math.round(width / aspect) }}>
      {layers.map((d) => {
        const key = `${nameOf(d.doc)}:${d.page}`;
        // The arriving picture lies over the one leaving, which lies over the rest.
        const z = same(d, shown) ? 2 : same(d, leaving) ? 1 : 0;
        return (
          <div key={key} data-layer={key} className="absolute inset-0" style={{ zIndex: z }}>
            <Layer doc={d.doc} page={d.page} width={width} ratio={ratio} shown={same(d, shown) || same(d, leaving)} onPainted={onPainted} />
          </div>
        );
      })}
      {!doc && !waiting && title ? <div className="absolute inset-0 grid place-items-center overflow-hidden p-2 text-center text-xs leading-4 text-muted-foreground">{title}</div> : null}
      {children ? <div className="absolute inset-0 z-[3]">{children}</div> : null}
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
