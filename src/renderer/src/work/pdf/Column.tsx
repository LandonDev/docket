import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { PdfField, PdfMark, PdfSignature } from "@shared/contract-work-pdf";
import { pdfCiteHref, type Bbox, type PdfCite } from "@shared/pdfCite";
import type { CanvasSource } from "@shared/work";
import { Copy } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import type { CanvasShell } from "../canvas/kind";
import type { PdfDoc } from "./engine";
import { FieldLayer, type FieldActions } from "./Fields";
import type { FindHit } from "./find";
import { boxStyle, currentPage, layOut, quadsOf, RAIL_FROM, railWidth, scaleFor, scrollTarget, sideInset, visibleRange, type PageSlot } from "./layout";
import { useNav, type PdfNav } from "./nav";

/**
 * The page column (docs/DESIGN.md "The canvas pane", PDF): paper on
 * `stage`, the pages a window of the file around the viewport, each the
 * file's own picture with its words selectable over it and TempCode's
 * marks on top: the form's values, his highlights, the find's matches and
 * the clause a citation points at. Nothing of the agent's reading is drawn
 * on the page; it is in the thread, citing its page.
 */

export interface ColumnProps {
  doc: PdfDoc;
  nav: PdfNav;
  itemId: string;
  title: string;
  source: CanvasSource;
  fields: readonly PdfField[];
  marks: readonly PdfMark[];
  /** The field the stepper is on. */
  current: string | null;
  signature: PdfSignature | null;
  actions: FieldActions & { mark(page: number, quads: Bbox[], text: string): Promise<unknown>; unmark(markId: string): Promise<unknown> };
  shell: CanvasShell;
  /** The citation to mark, until another is clicked. */
  cite: PdfCite | null;
  /** A preview's fixed width: there is no layout to measure in a static page. */
  width?: number;
  height?: number;
}

const MARK = "bg-[color-mix(in_srgb,var(--paper-ink)_12%,transparent)]";

export function Column(props: ColumnProps) {
  const { doc, nav, fields, marks, shell, source, title, itemId } = props;
  const state = useNav(nav);
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: props.width ?? 0, height: props.height ?? 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [sized, bump] = useState(0);
  const rail = doc.pages > RAIL_FROM;
  const columnWidth = Math.max(0, box.width - (rail ? railWidth(box.width) : 0));
  const inset = sideInset(box.width);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || props.width) return;
    const read = (): void => setBox({ width: el.parentElement?.clientWidth ?? el.clientWidth, height: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [props.width]);
  useEffect(() => nav.measured(box.width), [nav, box.width]);

  // The widest page known sets fit width; sizes are learnt as pages are read.
  const widest = useMemo(() => {
    let w = 0;
    for (let page = 1; page <= Math.min(doc.pages, 50); page++) w = Math.max(w, doc.size(page).width);
    return w;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, sized]);
  const scale = scaleFor(state.zoom, columnWidth - inset * 2, widest);
  const { slots, height } = useMemo(() => layOut(doc.pages, (page) => doc.size(page), scale), [doc, scale, sized]);
  const contentWidth = Math.max(columnWidth, ...slots.slice(0, 50).map((slot) => slot.width + inset * 2));
  const [first, last] = visibleRange(slots, scrollTop, box.height || 800);

  // Pages after the first are measured as the column reaches them, so a file of mixed sizes lays out true.
  useEffect(() => {
    let live = true;
    const want: number[] = [];
    for (let page = first; page <= last; page++) want.push(page);
    const before = want.map((page) => doc.size(page));
    void Promise.all(want.map((page) => doc.measure(page).catch(() => null))).then((got) => {
      if (!live) return;
      if (got.some((s, i) => s && (s.width !== before[i].width || s.height !== before[i].height))) bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, first, last]);

  // The bar's pager and the find scroll the column through the nav.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  useEffect(() => {
    nav.scrollTo = (page, at) => {
      const slot = slotsRef.current[page - 1];
      const el = scroller.current;
      if (!slot || !el) return;
      el.scrollTop = scrollTarget(slot, at);
      // The scroll event comes a frame later, or not at all where nothing lays out: read the place now.
      syncRef.current();
    };
    return () => {
      nav.scrollTo = null;
    };
  }, [nav]);

  // Keep the reader's place across a zoom: the same point of the same page stays at the top.
  const anchor = useRef<{ page: number; within: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    const slot = slots[a.page - 1];
    if (slot) el.scrollTop = slot.top + a.within * slot.height;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const syncRef = useRef<() => void>(() => undefined);
  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const page = currentPage(slots, el.scrollTop, el.clientHeight || box.height);
    nav.seen(page);
    const slot = slots[page - 1];
    if (slot) anchor.current = { page, within: Math.max(0, (el.scrollTop - slot.top) / Math.max(1, slot.height)) };
  };
  syncRef.current = onScroll;

  // A reopened file (a tab switch, a new version) comes back to the page he was on.
  useEffect(() => {
    const page = nav.get().page;
    if (box.height === 0 || page <= 1 || props.cite) return;
    const slot = slots[page - 1];
    if (slot && scroller.current) {
      scroller.current.scrollTop = scrollTarget(slot);
      syncRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, box.height > 0]);

  // A citation: scroll to its page and box once the column is laid out.
  const cite = props.cite;
  useEffect(() => {
    if (!cite || box.height === 0) return;
    const slot = slots[cite.page - 1];
    if (slot && scroller.current) {
      scroller.current.scrollTop = scrollTarget(slot, cite.bbox);
      syncRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cite, box.height > 0]);

  // A selection of words on a page feeds the floating bar: Ask, Highlight, Copy.
  const onPointerUp = useCallback((): void => {
    const selection = globalThis.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const pageEl = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("[data-pdf-page]");
    const text = selection.toString().replace(/\s+/g, " ").trim();
    if (!pageEl || !text) return;
    const page = Number(pageEl.dataset.pdfPage);
    const quads = quadsOf(range.getClientRects(), pageEl.getBoundingClientRect());
    if (quads.length === 0) return;
    const short = text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
    shell.selection({
      chip: { kind: "selection", label: `“${short}”, p. ${page}`, ref: source, quote: `${text}\n${pdfCiteHref({ itemId, page, bbox: hull(quads) })}` },
      rect: range.getBoundingClientRect(),
      tools: (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void props.actions.mark(page, quads, text);
              selection.removeAllRanges();
              shell.selection(null);
            }}
          >
            Highlight
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy />
          </Button>
        </>
      ),
    });
  }, [itemId, props.actions, shell, source]);

  useEffect(() => {
    const clear = (): void => {
      const selection = globalThis.getSelection?.();
      if (!selection || selection.isCollapsed) shell.selection(null);
    };
    document.addEventListener("selectionchange", clear);
    return () => document.removeEventListener("selectionchange", clear);
  }, [shell]);

  const byPage = useMemo(() => groupBy(fields, (f) => f.page), [fields]);
  const marksByPage = useMemo(() => groupBy(marks, (m) => m.page), [marks]);
  const hitsByPage = useMemo(() => {
    const out = new Map<number, { hit: FindHit; current: boolean }[]>();
    state.find.hits.forEach((hit, index) => {
      const list = out.get(hit.page) ?? [];
      list.push({ hit, current: index === state.find.current });
      out.set(hit.page, list);
    });
    return out;
  }, [state.find.hits, state.find.current]);

  const pages: ReactNode[] = [];
  for (let page = first; page <= last; page++) {
    const slot = slots[page - 1];
    if (!slot) continue;
    pages.push(
      <Page
        key={page}
        doc={doc}
        slot={slot}
        scale={scale}
        left={Math.max(inset, (contentWidth - slot.width) / 2)}
        title={title}
        source={source}
        itemId={itemId}
        shell={shell}
        overlay={
          <>
            {(marksByPage.get(page) ?? []).map((mark) =>
              mark.quads.map((quad, i) => (
                <button
                  key={`${mark.id}-${i}`}
                  type="button"
                  aria-label={`Highlight: ${mark.text}`}
                  data-pdf-mark={mark.id}
                  style={boxStyle(quad)}
                  className={`absolute rounded-[1px] ${MARK} mix-blend-multiply`}
                  onClick={(event) =>
                    shell.selection({
                      chip: { kind: "selection", label: `“${mark.text.slice(0, 40)}”, p. ${page}`, ref: source, quote: mark.text },
                      rect: event.currentTarget.getBoundingClientRect(),
                      tools: (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void props.actions.unmark(mark.id);
                            shell.selection(null);
                          }}
                        >
                          Remove highlight
                        </Button>
                      ),
                    })
                  }
                />
              )),
            )}
            {(hitsByPage.get(page) ?? []).map(({ hit, current }, i) =>
              hit.boxes.map((b, j) => <span key={`h${i}-${j}`} data-pdf-hit={current ? "current" : ""} style={boxStyle(b)} className={`pointer-events-none absolute rounded-[1px] ${current ? "bg-(--find-bg-paper-current)" : "bg-(--find-bg-paper)"}`} />),
            )}
            {cite && cite.page === page && cite.bbox ? <span data-pdf-cite style={boxStyle(cite.bbox)} className="pointer-events-none absolute rounded-[2px] bg-(--sel-bg-paper)" /> : null}
            {byPage.get(page)?.length ? <FieldLayer fields={byPage.get(page)!} current={props.current} height={slot.height} signature={props.signature} actions={props.actions} /> : null}
          </>
        }
      />,
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-(--stage)">
      {rail ? <Rail doc={doc} nav={nav} page={state.page} width={railWidth(box.width)} /> : null}
      <div
        ref={scroller}
        data-pdf-column={itemId}
        // Focusable from code alone (no Tab stop of its own): where Find gives the focus back when the bar holds no Find.
        tabIndex={-1}
        className="focus-ring relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
        onScroll={onScroll}
        onPointerUp={onPointerUp}
        style={props.height ? { height: props.height } : undefined}
      >
        <div className="relative" style={{ height, width: contentWidth }}>
          {pages}
        </div>
      </div>
    </div>
  );
}

function hull(quads: readonly Bbox[]): Bbox {
  return [Math.min(...quads.map((q) => q[0])), Math.min(...quads.map((q) => q[1])), Math.max(...quads.map((q) => q[2])), Math.max(...quads.map((q) => q[3]))];
}

function groupBy<T>(list: readonly T[], key: (t: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const item of list) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/** One sheet: the picture, its words, then TempCode's marks. A page with no words is a scan: a drag draws a region to ask about. */
const Page = memo(function Page({
  doc,
  slot,
  scale,
  left,
  overlay,
  title,
  source,
  itemId,
  shell,
}: {
  doc: PdfDoc;
  slot: PageSlot;
  scale: number;
  left: number;
  overlay: ReactNode;
  title: string;
  source: CanvasSource;
  itemId: string;
  shell: CanvasShell;
}) {
  const picture = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState(false);
  // A paint pdf.js refused: the page says so in its place, with Retry.
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [scan, setScan] = useState(false);
  const [region, setRegion] = useState<Bbox | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const page = slot.page;

  useEffect(() => {
    const host = picture.current;
    if (!host) return;
    const job = new AbortController();
    // A zoom repaints after the column settles, not on every step of it.
    const wait = setTimeout(() => {
      setFailed(false);
      doc.paint(page, host, scale, words.current, job.signal).then(
        () => !job.signal.aborted && setPainted(true),
        () => !job.signal.aborted && setFailed(true),
      );
    }, painted ? 120 : 0);
    return () => {
      clearTimeout(wait);
      job.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, scale, tries]);
  // What pdf.js holds for the page goes when the page leaves the window.
  useEffect(() => () => doc.release(page), [doc, page]);
  useEffect(() => {
    let live = true;
    doc.text(page).then(
      (runs) => live && setScan(runs.length === 0),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [doc, page]);

  const at = (event: ReactPointerEvent<HTMLElement>): { x: number; y: number } => {
    const r = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) };
  };

  return (
    <div
      data-pdf-page={page}
      data-scan={scan || undefined}
      className={`absolute overflow-hidden bg-(--paper) text-(--paper-ink) outline-1 outline-(--image-outline) ${scan ? "cursor-crosshair select-none" : ""}`}
      style={{ top: slot.top, left, width: slot.width, height: slot.height }}
      onPointerDown={
        scan
          ? (event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = at(event);
              setRegion(null);
              shell.selection(null);
            }
          : undefined
      }
      onPointerMove={
        scan
          ? (event) => {
              const from = drag.current;
              if (!from) return;
              const to = at(event);
              setRegion([Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y)]);
            }
          : undefined
      }
      onPointerUp={
        scan
          ? (event) => {
              drag.current = null;
              const r = region;
              if (!r || r[2] - r[0] < 0.01 || r[3] - r[1] < 0.01) return setRegion(null);
              const page_ = event.currentTarget.getBoundingClientRect();
              const rect = new DOMRect(page_.left + r[0] * page_.width, page_.top + r[1] * page_.height, (r[2] - r[0]) * page_.width, (r[3] - r[1]) * page_.height);
              shell.selection({ chip: { kind: "selection", label: `Region of p. ${page}, ${title}`, ref: source, quote: pdfCiteHref({ itemId, page, bbox: r }) }, rect });
            }
          : undefined
      }
    >
      <div ref={picture} aria-hidden="true" className="absolute inset-0" />
      {!painted ? <div aria-hidden="true" className="absolute inset-0 bg-(--paper)" /> : null}
      {failed ? (
        <div data-pdf-page-failed className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-[13px] leading-5 text-[color-mix(in_srgb,var(--paper-ink)_60%,transparent)]">
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
      {overlay}
      {region ? <span data-pdf-region style={boxStyle(region)} className="pointer-events-none absolute bg-(--sel-bg-paper) outline-1 outline-(--accent)" /> : null}
    </div>
  );
});

const THUMB = 44;
const THUMB_ROW = 4;

/** The thumbnail rail, for a long file: one small picture a page, the current one on `muted`. */
function Rail({ doc, nav, page, width }: { doc: PdfDoc; nav: PdfNav; page: number; width: number }) {
  const list = useRef<HTMLDivElement>(null);
  const thumb = width < 76 ? 36 : THUMB;
  const first = doc.size(1);
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
  // The current page stays in view as the column scrolls.
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
        onClick={() => nav.goTo(n)}
        className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 rounded-md px-2 pt-1.5 pb-1 text-xs leading-4 text-muted-foreground tabular-nums transition-[background-color] duration-(--dur-hover) hover:bg-foreground/5 aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
        style={{ top: 8 + (n - 1) * row }}
      >
        <Thumb doc={doc} page={n} width={thumb} height={pictureHeight} />
        {n}
      </button>,
    );
  }
  return (
    <div
      ref={list}
      data-pdf-rail
      className="relative shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain border-e border-border scrollbar-none"
      style={{ width }}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
    >
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
    const wait = setTimeout(() => void doc.paint(page, el, width / (doc.size(page).width * (96 / 72)), null, job.signal).catch(() => undefined), 80);
    return () => {
      clearTimeout(wait);
      job.abort();
    };
  }, [doc, page, width]);
  useEffect(() => () => doc.release(page), [doc, page]);
  return <span ref={host} aria-hidden="true" className="block overflow-hidden bg-(--paper) outline-1 outline-(--image-outline)" style={{ width, height }} />;
});
