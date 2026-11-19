import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Bbox } from "@shared/contract-work-pdf";
import type { DeckShape, DeckSlide, DeckView, SlideChange } from "@shared/contract-work-slides";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { CSS_PER_POINT, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";
import { boxStyle } from "../pdf/layout";
import { deckStoreOf, linkDeckHost, openDeck, useDeck, useDeckView, useRender, type DeckHost, type DeckStore } from "./deck";

/**
 * The slides kind (docs/agents/work-slides.md; the approved page is
 * .temp-code/prototypes/work-workspaces-2/slides.html, "Filmstrip and
 * stage"): a strip of the deck's slides in the proposed order, the current
 * one on the stage with its notes under it. A slide is a picture of the
 * deck as LibreOffice draws it, so it keeps the deck's own look in both
 * themes; a tint TempCode lays on it takes the theme the picture is in.
 * An agent's revision is changes by slide, stepped from the bar.
 */

export type SlidesState = undefined;

export interface SlidesDeps {
  host?: DeckHost;
  engine?: PdfEngine;
  /** A preview's or a test's fixed size: jsdom lays nothing out. */
  width?: number;
  height?: number;
}

const hosts = new Map<string, DeckHost>();
function hostFor(env: string, itemId: string): DeckHost {
  const key = `${env}\n${itemId}`;
  let host = hosts.get(key);
  if (!host) {
    host = linkDeckHost(env, itemId);
    hosts.set(key, host);
  }
  return host;
}

export const STRIP = 140;
export const THUMB = 96;
export const STAGE_MAX = 760;
/** Under this the canvas itself is too narrow for a strip beside the stage: the strip becomes a row under it. */
export const NARROW = 400;

/** The stage's width: the room it has, at most 760px, and short enough that the notes start on screen. */
export function stageWidth(width: number, height: number, aspect: number): number {
  const room = Math.max(0, width - 32);
  const tall = height > 0 ? Math.max(200, (height - 150) * aspect) : room;
  return Math.floor(Math.min(room, STAGE_MAX, tall));
}

/** The change a slide's place on the stage belongs to, as the stepper counts them. */
export function changeIndex(view: DeckView, key: string | null): number {
  const slide = view.slides.find((s) => s.key === key);
  return slide?.change ? view.changes.findIndex((c) => c.id === slide.change) : -1;
}

/**
 * The host's reason a deck has no picture, without the words the state
 * line's own word already says ("There is no picture of the slides: …").
 */
export function renderDetail(error: string): string {
  const rest = error.replace(/^There is no picture of the slides:\s*/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The slide to show for a change: where it lands, else the place it leaves. */
export function slideOfChange(view: DeckView, change: SlideChange): DeckSlide | undefined {
  const all = view.slides.filter((s) => s.change === change.id);
  return all.find((s) => s.tint !== "del") ?? all[0];
}

export function Body(props: CanvasBodyProps<SlidesState> & SlidesDeps) {
  const host = props.host ?? hostFor(props.env, props.item.id);
  const store = deckStoreOf(props.item.id);
  useDeckView(host, store);
  return <SlidesBody {...props} host={host} store={store} engine={props.engine ?? pdfjsEngine} />;
}

export function SlidesBody({ item, source, shell, host, store, engine, width: fixedWidth, height: fixedHeight }: CanvasBodyProps<SlidesState> & { host: DeckHost; store: DeckStore; engine: PdfEngine; width?: number; height?: number }) {
  const { view, error, current, side } = useDeck(store);
  const fileRender = useRender(host, "file", view?.renders.file ?? null, engine);
  const proposedRender = useRender(host, "proposed", view?.renders.proposed ?? null, engine);
  const fileDoc = fileRender.doc;
  const proposedDoc = proposedRender.doc;
  // The host's own word first; else a render this window could not read.
  const renderError = view?.renderError ?? fileRender.error ?? proposedRender.error ?? undefined;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || fixedWidth) return;
    const read = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixedWidth, view !== null, side]);

  const run = useCallback((work: Promise<DeckView>, fallback: string): Promise<void> => work.then((next) => store.view(next), (e: unknown) => sayError(e, fallback)), [store]);
  const select = useCallback((key: string) => store.set({ current: key }), [store]);
  const retry = useCallback((): Promise<void> => {
    store.set({ error: null });
    return openDeck(host, store);
  }, [host, store]);
  useFeeds(shell, view, error, renderError, current, side, select, host, run, retry);

  // A deck the host could not open is the pane's state line alone, with Retry: no bones under it.
  if (error) return null;
  if (!view) return <DeckSkeleton />;
  if (side === "powerpoint") return <EmptyState title="Not built yet" />;

  const docOf = (slide: DeckSlide): PdfDoc | null => (slide.from === "proposed" ? proposedDoc : fileDoc);
  const shown = view.slides.find((s) => s.key === current) ?? view.slides[0];
  const narrow = size.width > 0 && size.width < NARROW;
  return (
    <div ref={box} data-slides className={`flex min-h-0 min-w-0 flex-1 ${narrow ? "flex-col-reverse" : ""}`} style={fixedHeight ? { height: fixedHeight } : undefined}>
      <Strip view={view} current={shown?.key ?? null} narrow={narrow} docOf={docOf} pictures={!view.renderError} onPick={select} />
      {shown ? (
        <Main
          key={shown.key}
          view={view}
          slide={shown}
          doc={view.renderError ? null : docOf(shown)}
          width={narrow ? size.width : size.width - STRIP}
          height={narrow ? size.height - 96 : size.height}
          itemTitle={item.title}
          source={source}
          shell={shell}
        />
      ) : null}
    </div>
  );
}

/** What the body tells the pane: the mode, the stepper by slide, the line after a direct write, a deck it cannot draw. */
function useFeeds(
  shell: CanvasShell,
  view: DeckView | null,
  error: string | null,
  renderError: string | undefined,
  current: string | null,
  side: "tempcode" | "powerpoint",
  select: (key: string) => void,
  host: DeckHost,
  run: (work: Promise<DeckView>, fallback: string) => Promise<void>,
  retry: () => Promise<void>,
): void {
  const inPowerPoint = side === "powerpoint";
  const mode = view?.mode;
  useEffect(() => {
    if (!mode || inPowerPoint) return shell.mode(null);
    shell.mode({ value: mode, set: (next) => void run(host.mode(next), "Couldn't change what the agent does") });
    return () => shell.mode(null);
  }, [shell, host, mode, inPowerPoint, run]);

  useEffect(() => {
    shell.statusLine(
      error
        ? { tone: "failed", word: "Couldn't open this deck", detail: error, action: { label: "Retry", run: retry } }
        : renderError
          ? { tone: "failed", word: "Can't draw the slides", detail: renderDetail(renderError) }
          : null,
    );
    return () => shell.statusLine(null);
  }, [shell, error, renderError, retry]);

  const written = view?.written;
  const pending = view?.changes.length ?? 0;
  useEffect(() => {
    if (!written || pending > 0 || inPowerPoint) return shell.written(null);
    shell.written({ text: `${written.text}, ${dayTime(written.at)}`, undo: () => run(host.undo(written.id), "Couldn't undo") });
    return () => shell.written(null);
  }, [shell, host, written, pending, inPowerPoint, run]);

  const index = view ? changeIndex(view, current) : -1;
  const changes = view?.changes;
  useEffect(() => {
    if (!view || !changes || changes.length === 0 || inPowerPoint) return shell.review(null);
    const which = (w: number | { group: string } | "all"): string[] | "all" => (w === "all" || typeof w !== "number" ? "all" : [changes[w]?.id].filter(Boolean));
    const review: ReviewAdapter = {
      groups: [{ id: "deck", label: "Slides", by: changes[0].by, count: changes.length }],
      index,
      count: changes.length,
      step: (to) => {
        const change = changes[to];
        const slide = change && slideOfChange(view, change);
        if (slide) select(slide.key);
      },
      accept: (w) => run(host.review(which(w), "accept"), "Couldn't accept the change"),
      reject: (w) => run(host.review(which(w), "reject"), "Couldn't reject the change"),
    };
    shell.review(review);
    return () => shell.review(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, host, changes, index, inPowerPoint, run, select]);
}

// ── the strip ────────────────────────────────────────────────────────

const FRAME_TINT = { add: "bg-(--add-bg)", del: "bg-(--del-bg)" } as const;

function Strip({ view, current, narrow, docOf, pictures, onPick }: { view: DeckView; current: string | null; narrow: boolean; docOf(slide: DeckSlide): PdfDoc | null; pictures: boolean; onPick(key: string): void }) {
  const list = useRef<HTMLDivElement>(null);
  // The current slide stays in view when the stepper moves the stage.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  // One Tab stop, as a listbox is: the slide on the stage takes it (the first while none is), and the arrows along the
  // strip, Home and End move the focus and the stage together.
  const stop = view.slides.some((slide) => slide.key === current) ? current : (view.slides[0]?.key ?? null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys = view.slides.map((slide) => slide.key);
    const at = keys.indexOf((event.target as HTMLElement).dataset.slide ?? stop ?? "");
    const back = narrow ? "ArrowLeft" : "ArrowUp";
    const on = narrow ? "ArrowRight" : "ArrowDown";
    const to = event.key === back ? at - 1 : event.key === on ? at + 1 : event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const key = keys[Math.max(0, Math.min(keys.length - 1, to))];
    if (!key) return;
    if (key !== current) onPick(key);
    list.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(key)}"]`)?.focus();
  };
  return (
    <div
      ref={list}
      data-slides-strip
      role="listbox"
      aria-label="Slides"
      aria-orientation={narrow ? "horizontal" : "vertical"}
      onKeyDown={onKeyDown}
      className={
        narrow
          ? "flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden overscroll-contain border-t border-border bg-sidebar p-2"
          : "flex w-[140px] shrink-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain border-e border-border bg-sidebar pt-2 pr-2 pb-4 pl-1"
      }
    >
      {view.slides.map((slide, index) => {
        const on = slide.key === current;
        return (
          <div key={slide.key} className={narrow ? "flex shrink-0 flex-col" : "contents"}>
            {slide.section ? <div className={`text-xs font-medium text-muted-foreground ${narrow ? "px-2 pb-1 whitespace-nowrap" : `${index === 0 ? "pt-1" : "pt-3"} pr-1 pb-1 pl-6`}`}>{slide.section}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={on}
              aria-current={on ? "true" : undefined}
              aria-label={`${slide.number === null ? "Removed" : `Slide ${slide.number}`}: ${slide.title || "Untitled"}`}
              data-slide={slide.key}
              data-tint={slide.tint ?? undefined}
              tabIndex={slide.key === stop ? 0 : -1}
              onClick={() => onPick(slide.key)}
              className="group/th relative flex shrink-0 items-start gap-1 rounded-md text-start"
            >
              <span className={`w-5 shrink-0 pt-1 text-end text-xs leading-4 tabular-nums ${on ? "text-foreground" : "text-muted-foreground"}`}>{slide.number ?? ""}</span>
              <span
                className={`block rounded-md p-[3px] transition-[background-color] duration-(--dur-hover) ease-(--ease-out) motion-reduce:transition-none ${
                  slide.tint === "add"
                    ? on
                      ? "bg-[color-mix(in_srgb,var(--success)_30%,transparent)]"
                      : FRAME_TINT.add
                    : slide.tint === "del"
                      ? FRAME_TINT.del
                      : on
                        ? "bg-muted"
                        : "group-hover/th:bg-foreground/5 group-active/th:bg-foreground/12 group-active/th:transition-none"
                }`}
              >
                <Picture doc={pictures ? docOf(slide) : null} page={slide.page} width={THUMB} ghost={slide.tint === "del"} title={slide.title} thumb />
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Whether an element is in its scroller's view, or near it; true where nothing lays out (a test, a static page). */
function useInView(ref: { current: Element | null }, margin = "200px"): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)), { rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin]);
  return seen;
}

/**
 * A slide at a width: the render's page, or while it comes (or with no
 * render) its title on a blank. A thumbnail paints only near the view, after
 * the stage, and lets pdf.js free the page when it leaves. A paint pdf.js
 * refuses on the stage says so in the slide's place, with Retry, as a PDF's
 * page does; a thumbnail stays a blank.
 */
const Picture = memo(function Picture({ doc, page, width, ghost = false, title, thumb = false, onPainted }: { doc: PdfDoc | null; page: number; width: number; ghost?: boolean; title: string; thumb?: boolean; onPainted?(host: HTMLElement): void }) {
  const host = useRef<HTMLSpanElement>(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const near = useInView(host);
  const size = doc?.size(page);
  const aspect = size ? size.width / size.height : 16 / 9;
  useEffect(() => {
    const el = host.current;
    if (!el || !doc || (thumb && !near)) return;
    const job = new AbortController();
    const scale = width / (doc.size(page).width * CSS_PER_POINT);
    const paint = (): void => {
      setFailed(false);
      doc.paint(page, el, scale, null, job.signal).then(
        () => {
          if (job.signal.aborted) return;
          setPainted(true);
          onPainted?.(el);
        },
        () => !job.signal.aborted && !thumb && setFailed(true),
      );
    };
    // The stage asks first: a thumbnail waits a beat, so the one worker draws the big slide before the strip.
    const wait = thumb ? setTimeout(paint, 60) : (paint(), undefined);
    return () => {
      clearTimeout(wait);
      job.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, width, thumb && near, tries]);
  useEffect(() => (doc && thumb && !near ? doc.release(page) : undefined), [doc, page, thumb, near]);
  useEffect(() => () => doc?.release(page), [doc, page]);
  return (
    <span className={`relative block overflow-hidden rounded-[3px] bg-muted outline-1 -outline-offset-1 outline-(--image-outline) ${ghost ? "opacity-45" : ""}`} style={{ width, height: Math.round(width / aspect) }}>
      <span ref={host} aria-hidden="true" className="absolute inset-0" />
      {!painted && !failed ? <span className="absolute inset-0 grid place-items-center overflow-hidden p-2 text-center text-xs leading-4 text-muted-foreground">{doc ? "" : title}</span> : null}
      {failed ? (
        <span data-slide-failed className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-[13px] leading-5 text-muted-foreground">
          Couldn't draw this slide
          <Button variant="ghost" size="xs" className="text-foreground" onClick={() => setTries((n) => n + 1)}>
            Retry
          </Button>
        </span>
      ) : null}
    </span>
  );
});

// ── the stage ────────────────────────────────────────────────────────

/** The tints a slide takes: the dark theme's on a dark picture, paper's on a light one. */
const TINTS = {
  dark: { add: "bg-(--add-bg-dark-pic)", sel: "bg-(--sel-bg-dark-pic)" },
  light: { add: "bg-(--add-bg-paper)", sel: "bg-(--sel-bg-paper)" },
} as const;

/** Whether a drawn picture is dark: its mean light over a coarse grid. */
export function toneOf(host: HTMLElement): "dark" | "light" {
  const canvas = host.querySelector("canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return "light";
  let sum = 0;
  let n = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const [r, g, b] = ctx.getImageData(Math.floor(((x + 0.5) * canvas.width) / 8), Math.floor(((y + 0.5) * canvas.height) / 8), 1, 1).data;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return sum / n < 128 ? "dark" : "light";
}

function Main({ view, slide, doc, width, height, itemTitle, source, shell }: { view: DeckView; slide: DeckSlide; doc: PdfDoc | null; width: number; height: number; itemTitle: string; source: CanvasBodyProps["source"]; shell: CanvasShell }) {
  const size = doc?.size(slide.page);
  const aspect = size ? size.width / size.height : 16 / 9;
  const w = width > 0 ? stageWidth(width, height, aspect) : STAGE_MAX;
  const [tone, setTone] = useState<"dark" | "light">("light");
  const [picked, setPicked] = useState<number | null>(null);
  const change = slide.change ? view.changes.find((c) => c.id === slide.change) : undefined;
  const tints = TINTS[tone];
  const pick = (shape: DeckShape, el: HTMLElement): void => {
    setPicked(shape.id);
    const words = shape.text.replace(/\s+/g, " ").trim();
    const short = words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
    shell.selection({
      chip: { kind: "selection", label: `“${short}”, slide ${slide.number ?? slide.id}`, ref: source, quote: `${words}\n(${itemTitle}, slide id ${slide.id}, shape ${shape.id} "${shape.name}")` },
      rect: el.getBoundingClientRect(),
    });
  };
  useEffect(() => () => shell.selection(null), [shell]);
  const shapes = slide.tint === "del" ? [] : slide.shapes.filter((s) => s.bbox && s.text.trim());
  // A change to the notes is drawn once, in the Notes section; the list above it is the slide's shapes.
  const notesEdit = change?.edits.find((e) => e.where === NOTES_WHERE);
  const edits = change?.edits.filter((e) => e !== notesEdit) ?? [];
  return (
    <div data-slides-main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="flex shrink-0 justify-center px-4 pt-4">
        <div data-slides-stage className="relative shrink-0" style={{ width: w }}>
          <Picture doc={doc} page={slide.page} width={w} ghost={slide.tint === "del"} title={slide.title} onPainted={(el) => setTone(toneOf(el))} />
          <div className="absolute inset-0">
            {slide.changed.map((b: Bbox, i) => (
              <span key={`c${i}`} data-slide-changed style={boxStyle(b)} className={`pointer-events-none absolute rounded-[3px] ${tints.add}`} />
            ))}
            {shapes.map((shape) => (
              <button
                key={shape.id}
                type="button"
                data-shape={shape.id}
                aria-label={shape.name}
                aria-pressed={picked === shape.id}
                style={boxStyle(shape.bbox!)}
                className={`absolute rounded-[4px] transition-[background-color] duration-(--dur-hover) ${picked === shape.id ? tints.sel : ""}`}
                onClick={(event) => pick(shape, event.currentTarget)}
              />
            ))}
          </div>
        </div>
      </div>
      {edits.length > 0 ? <Edits edits={edits} /> : null}
      <div className="shrink-0 px-5 pt-4 pb-5">
        <div className="text-xs font-medium text-muted-foreground">Notes</div>
        {notesEdit ? (
          <p data-slide-notes-edit tabIndex={0} className="focus-ring mt-1 max-w-[70ch] text-sm leading-[22px] text-pretty whitespace-pre-wrap">
            <Diff before={notesEdit.before} after={notesEdit.after} />
          </p>
        ) : slide.notes.trim() ? (
          <p tabIndex={0} className="focus-ring mt-1 max-w-[70ch] text-sm leading-[22px] text-pretty whitespace-pre-wrap">
            {slide.notes}
          </p>
        ) : (
          <p className="mt-1 text-sm leading-[22px] text-muted-foreground">None yet</p>
        )}
      </div>
    </div>
  );
}

/**
 * What the change says, under the stage: the words before struck in the
 * removed tint and the words after in the added tint, one paragraph a place.
 * The prototype tints the words in the slide itself; a real slide is a
 * picture, so its changed shapes are tinted there and the words are here.
 */
function Edits({ edits }: { edits: SlideChange["edits"] }) {
  return (
    <div data-slide-edits className="flex shrink-0 flex-col gap-3 px-5 pt-4">
      {edits.map((edit, i) => (
        <div key={i} className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{edit.where}</div>
          <p className="mt-1 max-w-[70ch] text-sm leading-[22px] text-pretty">
            <Diff before={edit.before} after={edit.after} />
          </p>
        </div>
      ))}
    </div>
  );
}

/** The `where` the host gives an edit of the speaker notes (src/main/server/work/slides/view.ts). */
const NOTES_WHERE = "Notes";

/** The words before, struck in the removed tint, then the words after in the added tint. */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <>
      {before ? <span className="rounded-sm bg-(--del-bg) text-foreground/70 line-through decoration-destructive/70">{before}</span> : null}
      {before && after ? " " : null}
      {after ? <span className="rounded-sm bg-(--add-bg)">{after}</span> : null}
    </>
  );
}

/** Loading, in the body's shape: the strip beside the stage, or under it in a canvas under 400px (`NARROW`), as the body lays it out. */
function DeckSkeleton() {
  return (
    <div data-slides-skeleton aria-busy="true" aria-label="Loading" className="@container flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 @max-[400px]:flex-col-reverse">
        <div className="flex w-[140px] shrink-0 flex-col overflow-hidden border-e border-border bg-sidebar pt-2 pr-2 pl-1 @max-[400px]:w-auto @max-[400px]:flex-row @max-[400px]:gap-1 @max-[400px]:border-e-0 @max-[400px]:border-t @max-[400px]:p-2">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex shrink-0 gap-1 py-[3px] @max-[400px]:py-0">
              <span className="w-5 @max-[400px]:hidden" />
              <Skeleton className="m-[3px] aspect-video w-24" />
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex justify-center px-4 pt-4">
            <Skeleton className="aspect-video w-full max-w-[560px]" />
          </div>
          <div className="flex flex-col gap-2 px-5 pt-4">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-3 w-[86%]" />
            <Skeleton className="h-3 w-[62%]" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── the tab row and the bar ──────────────────────────────────────────

/** A deck that lives in PowerPoint: TempCode or the real app, in the tab row as the sheet's Excel switch is. */
export function TabEnd({ item }: CanvasBodyProps<SlidesState>) {
  const store = deckStoreOf(item.id);
  const { view, side } = useDeck(store);
  if (!view?.hosted) return null;
  return (
    <Tabs value={side} onValueChange={(next) => store.set({ side: next as "tempcode" | "powerpoint" })} className="mx-1 shrink-0 gap-0">
      <TabsList aria-label="Open in" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
        <TabsIndicator />
        <TabsTrigger value="tempcode" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          TempCode
        </TabsTrigger>
        <TabsTrigger value="powerpoint" className={`${TABS_PILL_TRIGGER} px-2 text-xs`}>
          PowerPoint
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/**
 * While the deck loads the bar holds one bone where the mode will be, so the
 * body does not drop 32px when it lands; in the real PowerPoint the stepper
 * is not there: how many changes wait here, and the way back to them.
 */
export function Bar({ item }: CanvasBodyProps<SlidesState>) {
  const store = deckStoreOf(item.id);
  const { view, error, side } = useDeck(store);
  if (!view) return error ? null : <Skeleton className="h-3 w-30" />;
  const pending = view.changes.length;
  if (side !== "powerpoint" || pending === 0) return null;
  return (
    <>
      {/* Whole or gone: the narrow bar keeps Review alone rather than a cut sentence. */}
      <span data-narrow-hide className="min-w-0 truncate @max-[560px]/bar:hidden">
        {pending === 1 ? "1 suggestion waits in TempCode" : `${pending} suggestions wait in TempCode`}
      </span>
      <Button variant="ghost" size="xs" className="shrink-0" onClick={() => store.set({ side: "tempcode" })}>
        Review
      </Button>
    </>
  );
}
