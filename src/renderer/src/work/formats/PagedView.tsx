import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { CSS_PER_POINT, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";
import { COLUMN_TOP, currentPage, layOut, NARROW, PAGE_GAP, scaleFor, scrollTarget, visibleRange, type PageSlot } from "../pdf/layout";
import type { PreviewBytes } from "./preview";

/**
 * A file's pages as the Preview frame draws them (docs/DESIGN.md "Work
 * editors: Preview"): paper on `stage`, 12px between sheets, a thumbnail
 * rail from 20 pages, the page read out as he scrolls. It draws one finished
 * render (`PreviewBytes`, read by range at its `rev`) through the PDF kind's
 * engine and layout maths, which it only reads; nothing here marks, fills or
 * cites a page, and nothing is kept: this is a picture of a file that is
 * about to be made.
 *
 * The line over the first sheet (who drew it) and the column beside the
 * paper are the frame's, handed in: they scroll with the pages and the
 * column stays in view.
 */

/** Fit the paper's width, fit a whole page in the window, or a fixed share of its size. */
export type PagedZoom = "width" | "page" | 1 | 1.25 | 1.5;
export const PAGED_ZOOMS: readonly PagedZoom[] = ["width", "page", 1, 1.25, 1.5];
export const ZOOM_WORDS: Record<string, string> = { width: "Fit width", page: "Fit page", "1": "100%", "1.25": "125%", "1.5": "150%" };

/** Pages from which the thumbnail rail shows. */
export const RAIL_FROM = 20;
/** The column beside the paper, and its gap. */
export const SIDE_WIDTH = 232;
export const SIDE_GAP = 16;
const BOTTOM = 24;
/** The line over the first sheet: at least 24px, 8px above the paper. */
const HEAD_GAP = 8;

export const sideInset = (narrow: boolean): number => (narrow ? 12 : 24);
export const railWidth = (width: number): number => (width < NARROW ? 60 : 76);

/**
 * The scale (CSS px a point over `CSS_PER_POINT`) at a zoom: `room` is the
 * width the paper may take, `tall` the height one page may take, `widest`
 * and `tallest` the largest page in points.
 */
export function pagedScale(zoom: PagedZoom, room: number, tall: number, widest: number, tallest: number): number {
  if (zoom !== "width" && zoom !== "page") return zoom;
  const byWidth = scaleFor("fit", room, widest);
  if (zoom === "width" || !(tall > 0) || !(tallest > 0)) return byWidth;
  // A whole page in the window, never wider than the room and never so small it cannot be read as a page.
  return Math.max(0.2, Math.min(byWidth, tall / (tallest * CSS_PER_POINT)));
}

export interface PagedViewProps {
  bytes: PreviewBytes;
  zoom: PagedZoom;
  /** What the pages are, for the scroller's name: "Run of show as Word". */
  label: string;
  /** The page at the top of the window, and how many the render holds, as he scrolls. */
  onPage?(page: number, pages: number): void;
  /** The render could not be read (its host is gone, its rev is stale): the frame says so with Retry. */
  onFail?(message: string): void;
  /** Over the first sheet, as wide as the paper. */
  head?: ReactNode;
  /** Beside the paper, 16px off it, in view as the pages scroll. */
  side?: ReactNode;
  /** While another picture of the same file is drawn (Word's): the paper stays, dimmed. */
  dim?: boolean;
  /** Slides and other wide pages: the loading shape is 16:9. */
  wide?: boolean;
  /** A test or a preview hands in its own engine and size: jsdom lays nothing out. */
  engine?: PdfEngine;
  width?: number;
  height?: number;
}

type Opened = { doc: PdfDoc } | { failed: string } | null;

export function PagedView(props: PagedViewProps) {
  const { bytes, onPage, onFail } = props;
  const engine = props.engine ?? pdfjsEngine;
  const [opened, setOpened] = useState<Opened>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  // One render, one open: a new rev is a new file.
  useEffect(() => {
    let live = true;
    let doc: PdfDoc | null = null;
    setOpened(null);
    const fail = (message: string): void => {
      if (!live) return;
      setOpened({ failed: message });
      failRef.current?.(message);
    };
    engine.open({ size: bytes.size, read: (offset, length) => bytes.read(offset, length), onFail: fail }).then(
      (got) => {
        if (!live) return got.destroy();
        doc = got;
        setOpened({ doc: got });
      },
      (error: unknown) => fail(error instanceof Error && error.message ? error.message : "The file could not be read"),
    );
    return () => {
      live = false;
      doc?.destroy();
    };
    // The render is named by its rev: the object around it may be new each time the frame renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, bytes.rev, bytes.size]);

  if (opened && "failed" in opened) return null;
  if (!opened) return <PagedSkeleton head={props.head} side={props.side} wide={props.wide} width={props.width} />;
  return <Pages {...props} doc={opened.doc} onPage={onPage} />;
}

/** The pages' place while the render opens: paper's shape on the card step, still. */
export function PagedSkeleton({ head, side, wide, aspect, pages = 2, width }: { head?: ReactNode; side?: ReactNode; wide?: boolean | undefined; aspect?: number; pages?: number; width?: number | undefined }) {
  const [ref, box] = useBox(width, undefined);
  const narrow = box.width > 0 && box.width < FOLD;
  return (
    <div ref={ref} aria-busy="true" className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-(--stage)">
      <div className={`flex min-w-0 flex-1 justify-center gap-4 pt-4 pb-6 ${narrow ? "px-3" : "px-6"}`}>
        {/* As wide as the paper will be at Fit width: the room it has, up to 125% of a page (1020px), so nothing moves when the pages land. */}
        <div className="flex max-w-[1020px] min-w-0 flex-1 flex-col gap-3">
          {head ? <div style={{ marginBottom: HEAD_GAP - PAGE_GAP }}>{head}</div> : null}
          {Array.from({ length: pages }, (_, i) => (
            // The paper's own shape where the kind knows it, so nothing moves when the pages land; Letter (or 16:9) where it does not.
            <div key={i} className={`flex w-full flex-col gap-2.5 bg-card px-12 py-11 outline-1 outline-border ${aspect ? "" : wide ? "aspect-video" : "aspect-[440/569]"}`} style={aspect ? { aspectRatio: String(aspect) } : undefined}>
              <Skeleton className="mb-2 h-3 w-[38%]" />
              {(wide ? [70, 54, 62] : [92, 88, 96, 60, 0, 90, 94, 72, 0, 86, 90, 54]).map((w, n) => (w ? <Skeleton key={n} className="h-2" style={{ width: `${w}%` }} /> : <span key={n} className="h-1" />))}
            </div>
          ))}
        </div>
        {side && !narrow ? <div className="w-[232px] shrink-0 pt-0.5">{side}</div> : null}
      </div>
    </div>
  );
}

/** The canvas width under which the column folds into the bar (the frame reads the same number). */
export const FOLD = 600;

function useBox(width: number | undefined, height: number | undefined): [React.RefObject<HTMLDivElement | null>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: width ?? 0, height: height ?? 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || width) return;
    const read = (): void => setBox({ width: el.clientWidth, height: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  return [ref, box];
}

function Pages({ doc, zoom, label, onPage, head, side, dim, width, height }: PagedViewProps & { doc: PdfDoc }) {
  const [root, box] = useBox(width, height);
  const scroller = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [sized, bump] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  const [page, setPage] = useState(1);

  const rail = doc.pages >= RAIL_FROM;
  const narrow = box.width > 0 && box.width < FOLD;
  const inset = sideInset(narrow);
  const showSide = !!side && !narrow;
  const room = Math.max(0, box.width - (rail ? railWidth(box.width) : 0) - inset * 2 - (showSide ? SIDE_WIDTH + SIDE_GAP : 0));

  // The largest page known sets the fit; sizes are learnt as pages are read.
  const [widest, tallest] = useMemo(() => {
    let w = 0;
    let h = 0;
    for (let n = 1; n <= Math.min(doc.pages, 50); n++) {
      const s = doc.size(n);
      w = Math.max(w, s.width);
      h = Math.max(h, s.height);
    }
    return [w, h];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, sized]);
  const tall = Math.max(0, (box.height || 800) - COLUMN_TOP - BOTTOM - (headHeight ? headHeight + HEAD_GAP : 0));
  const scale = pagedScale(zoom, room, tall, widest, tallest);
  const { slots, height: laid } = useMemo(() => layOut(doc.pages, (n) => doc.size(n), scale), [doc, scale, sized]);
  // layOut counts the column's own top and bottom; here the scroller's padding holds them.
  const stackHeight = Math.max(0, laid - COLUMN_TOP - BOTTOM);
  const paperWidth = Math.max(0, ...slots.slice(0, 50).map((slot) => slot.width));

  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el) return setHeadHeight(0);
    const read = (): void => setHeadHeight(el.offsetHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [head !== undefined && head !== null]);

  // Where the sheets start inside the scroller: under its top padding and the line over them.
  const base = (): number => (stack.current?.offsetTop ?? COLUMN_TOP + (headHeight ? headHeight + HEAD_GAP : 0)) - COLUMN_TOP;
  const [first, last] = visibleRange(slots, scrollTop - base(), box.height || 800);

  // Pages after the first are measured as the window reaches them, so a file of mixed sizes lays out true.
  useEffect(() => {
    let live = true;
    const want: number[] = [];
    for (let n = first; n <= last; n++) want.push(n);
    const before = want.map((n) => doc.size(n));
    void Promise.all(want.map((n) => doc.measure(n).catch(() => null))).then((got) => {
      if (live && got.some((s, i) => s && (s.width !== before[i].width || s.height !== before[i].height))) bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [doc, first, last]);

  // His place holds across a zoom: the same point of the same page stays at the top.
  const anchor = useRef<{ page: number; within: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    const slot = a ? slots[a.page - 1] : undefined;
    if (el && a && slot) el.scrollTop = base() + slot.top + a.within * slot.height;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const seen = useRef(onPage);
  seen.current = onPage;
  const read = (): void => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const at = el.scrollTop - base();
    const now = currentPage(slots, at, el.clientHeight || box.height);
    setPage(now);
    const slot = slots[now - 1];
    if (slot) anchor.current = { page: now, within: Math.max(0, (at - slot.top) / Math.max(1, slot.height)) };
  };
  useEffect(() => {
    seen.current?.(page, doc.pages);
  }, [page, doc.pages]);

  const goTo = (n: number): void => {
    const slot = slots[n - 1];
    const el = scroller.current;
    if (!slot || !el) return;
    el.scrollTop = n === 1 ? 0 : base() + scrollTarget(slot);
    // The scroll event comes a frame later, or not at all where nothing lays out: read the place now.
    read();
  };

  const sheets: ReactNode[] = [];
  for (let n = first; n <= last; n++) {
    const slot = slots[n - 1];
    if (slot) sheets.push(<Sheet key={n} doc={doc} slot={slot} scale={scale} left={Math.max(0, (paperWidth - slot.width) / 2)} />);
  }

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 bg-(--stage)">
      {rail ? <Rail doc={doc} page={page} width={railWidth(box.width)} onPick={goTo} /> : null}
      <div
        ref={scroller}
        data-paged-view
        role="group"
        aria-label={label}
        // A scroller he can reach with Tab, so the arrows, Page Up and Page Down move the paper.
        tabIndex={0}
        className="focus-ring relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
        onScroll={read}
        style={height ? { height } : undefined}
      >
        <div className="flex w-max min-w-full justify-center pt-4 pb-6" style={{ paddingInline: inset, columnGap: SIDE_GAP }}>
          <div className="flex min-w-0 flex-col" style={{ width: paperWidth || undefined }}>
            {head ? (
              <div ref={headRef} style={{ marginBottom: HEAD_GAP }}>
                {head}
              </div>
            ) : null}
            <div
              ref={stack}
              data-paged-sheets
              className="relative transition-opacity duration-(--dur-base) ease-(--ease-out) motion-reduce:transition-none"
              style={{ height: stackHeight, width: paperWidth, opacity: dim ? 0.55 : 1 }}
            >
              {sheets}
            </div>
          </div>
          {showSide ? (
            <div data-paged-side className="sticky top-4 shrink-0 self-start pt-0.5" style={{ width: SIDE_WIDTH }}>
              {side}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One sheet: the file's own picture, with its words selectable over it. */
const Sheet = memo(function Sheet({ doc, slot, scale, left }: { doc: PdfDoc; slot: PageSlot; scale: number; left: number }) {
  const picture = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const page = slot.page;

  useEffect(() => {
    const host = picture.current;
    if (!host) return;
    const job = new AbortController();
    // A zoom repaints after the column settles, not on every step of it; the old picture stays until the new one is whole.
    const wait = setTimeout(
      () => {
        setFailed(false);
        doc.paint(page, host, scale, words.current, job.signal).then(
          () => !job.signal.aborted && setPainted(true),
          () => !job.signal.aborted && setFailed(true),
        );
      },
      painted ? 120 : 0,
    );
    return () => {
      clearTimeout(wait);
      job.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, scale, tries]);
  // What pdf.js holds for the page goes when the page leaves the window.
  useEffect(() => () => doc.release(page), [doc, page]);

  return (
    <div data-paged-page={page} className="absolute overflow-hidden bg-(--paper) text-(--paper-ink) outline-1 outline-(--image-outline)" style={{ top: slot.top - COLUMN_TOP, left, width: slot.width, height: slot.height }}>
      <div ref={picture} aria-hidden="true" className="absolute inset-0" />
      {failed ? (
        <div data-paged-page-failed className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-[13px] leading-5 text-(--paper-ink-2)">
          Couldn't draw this page
          <Button
            variant="ghost"
            size="xs"
            className="text-(--paper-ink) hover:bg-[color-mix(in_srgb,var(--paper-ink)_6%,transparent)] active:bg-[color-mix(in_srgb,var(--paper-ink)_12%,transparent)]"
            onClick={() => setTries((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div ref={words} data-pdf-text className="absolute inset-0" />
    </div>
  );
});

const THUMB_ROW = 4;

/** The thumbnail rail of a long file: one small picture a page, the page being read on `muted`. */
function Rail({ doc, page, width, onPick }: { doc: PdfDoc; page: number; width: number; onPick(page: number): void }) {
  const list = useRef<HTMLDivElement>(null);
  const first = doc.size(1);
  const wide = first.width > first.height;
  // 44 by 57 for paper, 52 by 29 for a slide; a step smaller in the narrow rail.
  const thumb = width < 76 ? (wide ? 44 : 36) : wide ? 52 : 44;
  const pictureHeight = Math.round((thumb * first.height) / Math.max(1, first.width));
  const row = pictureHeight + 14 + 10 + 4 + THUMB_ROW;
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const read = (): void => setHeight(el.clientHeight || 600);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The page being read stays in view as the paper scrolls.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const y = 8 + (page - 1) * row;
    if (y < el.scrollTop || y + row > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, [page, row]);
  const from = Math.max(1, Math.floor((top - 8) / row) - 4);
  const to = Math.min(doc.pages, Math.ceil((top + height) / row) + 4);
  const items: ReactNode[] = [];
  for (let n = from; n <= to; n++) {
    items.push(
      <button
        key={n}
        type="button"
        aria-current={n === page ? "true" : undefined}
        aria-label={`Page ${n}`}
        onClick={() => onPick(n)}
        className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 rounded-md px-2 pt-1.5 pb-1 text-xs leading-4 text-muted-foreground tabular-nums transition-[background-color] duration-(--dur-hover) hover:bg-foreground/5 active:bg-foreground/12 active:transition-none aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
        style={{ top: 8 + (n - 1) * row }}
      >
        <Thumb doc={doc} page={n} width={thumb} height={pictureHeight} />
        {n}
      </button>,
    );
  }
  return (
    <div ref={list} data-paged-rail className="relative shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain border-e border-border scrollbar-none" style={{ width }} onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      <div style={{ height: 16 + doc.pages * row }}>{items}</div>
    </div>
  );
}

const Thumb = memo(function Thumb({ doc, page, width, height }: { doc: PdfDoc; page: number; width: number; height: number }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const job = new AbortController();
    // A thumbnail waits a moment, so a fast scroll through the rail paints only where it stops.
    const wait = setTimeout(() => void doc.paint(page, el, width / (doc.size(page).width * CSS_PER_POINT), null, job.signal).catch(() => undefined), 80);
    return () => {
      clearTimeout(wait);
      job.abort();
    };
  }, [doc, page, width]);
  useEffect(() => () => doc.release(page), [doc, page]);
  return <span ref={host} aria-hidden="true" className="block overflow-hidden bg-(--paper) outline-1 outline-(--image-outline)" style={{ width, height }} />;
});
