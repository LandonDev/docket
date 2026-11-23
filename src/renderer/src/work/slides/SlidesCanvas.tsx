import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Bbox } from "@shared/contract-work-pdf";
import type { DeckShape, DeckSlide, DeckView, SlideChange } from "@shared/contract-work-slides";
import { formatKeyOf } from "work-kit/format/keys";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { dayTime } from "../../lib/duration";
import { bareKey, chordKey, modKey } from "../../lib/keys";
import { IS_MAC } from "../../lib/platform";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { CanvasBodyProps, CanvasShell, ReviewAdapter } from "../canvas/kind";
import { CSS_PER_POINT, pdfjsEngine, type PdfDoc, type PdfEngine } from "../pdf/engine";
import { boxStyle } from "../pdf/layout";
import { deckStoreOf, linkDeckHost, openDeck, showHostOf, useDeck, useDeckView, useRender, type DeckHost, type DeckStore } from "./deck";
import { DeckRow, keyAct, targetOf, type Target } from "./edit/DeckRow";
import { HistoryButton } from "./edit/History";
import { typable, type Sel } from "./edit/model";
import { CONFLICT_WORD, HandSession, type HandState, type Start } from "./edit/session";
import { TypingBox } from "./edit/TypingBox";
import { askAnchor, groundOf, HANDLE, HANDLE_EDGE, hit, KIND_WORDS, pickable, readingOrder, ROTATE_HANDLE, selectionOf, textFrameOf, type Quad } from "./geometry";
import { present, presentKey, PresentButton, type PresentAsk } from "./Present";

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
  /** A preview's: the shape picked on the stage when it mounts. */
  picked?: number;
  /** A preview's: the typing box open on a shape when the stage mounts, with words selected, on a ground jsdom cannot read. */
  typing?: { shape: number; sel?: Sel; ground?: string };
  /** A preview's: how wide the format row and its controls are, which jsdom cannot measure. */
  rowMeasure?: (el: HTMLElement) => number;
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

/** His hand on a deck, one per item and host while the window lives: the body, the row and the bar share it. */
const hands = new WeakMap<DeckHost, Map<string, HandSession>>();
function handOf(itemId: string, host: DeckHost, store: DeckStore): HandSession {
  let items = hands.get(host);
  if (!items) hands.set(host, (items = new Map()));
  let session = items.get(itemId);
  if (!session) items.set(itemId, (session = new HandSession(host, store)));
  return session;
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

/** A deck can be presented when the host has a picture of the file. */
export const canPresent = (view: DeckView | null): view is DeckView => !!view && !!view.renders.file && !view.renderError;

/** Starts a show of the deck's file: from its first slide, or from the slide on the stage when that slide is in the file. */
export function startPresenting(host: DeckHost, store: DeckStore, ask: PresentAsk, engine?: PdfEngine): void {
  const { view, current } = store.get();
  if (!canPresent(view)) return;
  const here = view.slides.find((s) => s.key === current);
  present((show) =>
    show.startShow({
      host: showHostOf(host),
      title: view.name.replace(/\.pptx$/i, ""),
      from: ask.from === "here" && here ? here.id : "start",
      mode: ask.mode,
      ...(ask.display !== undefined ? { display: ask.display } : {}),
      ...(engine ? { engine } : {}),
    }),
  );
}

export function Body(props: CanvasBodyProps<SlidesState> & SlidesDeps) {
  const host = props.host ?? hostFor(props.env, props.item.id);
  const store = deckStoreOf(props.item.id);
  useDeckView(host, store);
  return <SlidesBody {...props} host={host} store={store} engine={props.engine ?? pdfjsEngine} />;
}

export function SlidesBody({
  item,
  source,
  shell,
  host,
  store,
  engine,
  width: fixedWidth,
  height: fixedHeight,
  picked: firstPicked,
  typing: firstTyping,
  rowMeasure,
}: CanvasBodyProps<SlidesState> & Omit<SlidesDeps, "host" | "engine"> & { host: DeckHost; store: DeckStore; engine: PdfEngine }) {
  const { view, error, current, side } = useDeck(store);
  const session = handOf(item.id, host, store);
  const hand = useSyncExternalStore(session.subscribe, session.get, session.get);
  // A box open when the tab closes, or the item leaves, commits.
  useEffect(() => () => void session.commit(), [session]);
  // A render whose bytes moved on mid-read asks for the view again, whose new revision reads afresh.
  const refresh = useCallback(() => void openDeck(host, store), [host, store]);
  const fileRender = useRender(host, "file", view?.renders.file ?? null, engine, refresh);
  const proposedRender = useRender(host, "proposed", view?.renders.proposed ?? null, engine, refresh);
  const fileDoc = fileRender.doc;
  const proposedDoc = proposedRender.doc;
  // The host's own word first; else a render this window could not read.
  const renderError = view?.renderError ?? fileRender.error ?? proposedRender.error ?? undefined;
  const box = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: fixedWidth ?? 0, height: fixedHeight ?? 0 });
  const [tone, setTone] = useState<"dark" | "light">("light");
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
  // A picture this window could not read is read again on Retry, the strip and the text diffs staying drawn meanwhile;
  // a deck the host has no picture of (its own word) has nothing here to read again.
  // Retry reads again only the render that failed, so the slides of the other never blank.
  const fileFailed = fileRender.error !== null;
  const proposedFailed = proposedRender.error !== null;
  const readFailed = !view?.renderError && (fileFailed || proposedFailed);
  const retryFile = fileRender.retry;
  const retryProposed = proposedRender.retry;
  const retryRender = useMemo(
    () =>
      readFailed
        ? () => {
            if (fileFailed) retryFile();
            if (proposedFailed) retryProposed();
          }
        : undefined,
    [readFailed, fileFailed, proposedFailed, retryFile, retryProposed],
  );
  // The review is bound to the changes he is shown: their revision goes with every press, single or all, and with no
  // revision (a host that sends none) no verdict is offered. Where the host has a picture of them, he decides on the
  // stage: the verbs are held while the proposed render loads or is replaced, and until the stage has painted the slide
  // on screen from it; a failed paint holds them until its Retry paints. With no picture (LibreOffice out of reach) the
  // outline and the text diffs are the review, on the changes' revision.
  const reviewRev = view?.changesRev ?? view?.renders.proposed?.rev;
  const pictured = !!view && !view.renderError && !!view.renders.proposed;
  const shownSlide = view ? (view.slides.find((s) => s.key === current) ?? view.slides[0]) : undefined;
  const shownDoc = shownSlide && !view?.renderError ? (shownSlide.from === "proposed" ? proposedDoc : fileDoc) : null;
  // A paint counts only for the stage mounted now. Each mount of the stage takes a token of its own and says when it
  // comes and goes: another slide (A, then B, then A again), PowerPoint and back, a failed open, any remount. The approval
  // leaves with its stage, and a paint from a stage already gone never counts, so the verdicts never open on a blank stage.
  const live = useRef(new Set<number>());
  const [stageOn, setStageOn] = useState<number | null>(null);
  const [painted, setPainted] = useState<{ key: string; doc: PdfDoc; stage: number } | null>(null);
  const stageCame = useCallback((token: number) => {
    live.current.add(token);
    setStageOn(token);
  }, []);
  const stageWent = useCallback((token: number) => {
    live.current.delete(token);
    setStageOn((on) => (on === token ? null : on));
    setPainted((p) => (p?.stage === token ? null : p));
  }, []);
  const bound = pictured && proposedDoc !== null && proposedRender.rev === view?.renders.proposed?.rev;
  const seen = !!shownSlide && !!shownDoc && painted?.key === shownSlide.key && painted.doc === shownDoc && stageOn !== null && painted.stage === stageOn;
  const held = !reviewRev || (pictured && !(bound && seen));
  const target = view ? targetOf(view, shownSlide, hand, session) : null;
  const reload = useCallback(() => void session.reload(), [session]);
  useFeeds(shell, view, error, renderError, current, side, select, host, run, retry, retryRender, reviewRev, held, store, hand, session, reload);

  // A deck the host could not open is the pane's state line alone, with Retry: no bones under it.
  if (error) return null;
  if (!view) return <DeckSkeleton row={source.at === "file"} />;
  if (side === "powerpoint") return <EmptyState title="Not built yet" />;

  const docOf = (slide: DeckSlide): PdfDoc | null => (slide.from === "proposed" ? proposedDoc : fileDoc);
  const revOf = (doc: PdfDoc): string | null => (doc === fileDoc ? fileRender.rev : doc === proposedDoc ? proposedRender.rev : null);
  const shown = view.slides.find((s) => s.key === current) ?? view.slides[0];
  const narrow = size.width > 0 && size.width < NARROW;
  const presentFrom = (ask: PresentAsk): void => {
    void session.commit();
    startPresenting(host, store, ask, engine);
  };
  return (
    <div
      ref={setRoot}
      data-slides
      data-editor-keys={view.hand ? "slides" : "read"}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      style={fixedHeight ? { height: fixedHeight } : undefined}
      onKeyDown={(event) => {
        // The keys that start a show, while the keyboard is in the deck (PowerPoint's own, and a clicker's F5); in the
        // typing box ⌘↩ is the box's, and a show started from it takes his words first.
        const ask = canPresent(view) ? presentKey(event) : null;
        if (ask) {
          event.preventDefault();
          presentFrom(ask);
          return;
        }
        if (!view.hand || (event.target as Element).closest?.("input, textarea, [contenteditable=true], [data-slide-typing]")) return;
        // His own edits to the file: the platform's undo and redo keys.
        const z = event.key.toLowerCase() === "z";
        if (modKey(event) && !event.altKey && (z || (!IS_MAC && event.key.toLowerCase() === "y" && !event.shiftKey))) {
          event.preventDefault();
          const dir = z && !event.shiftKey ? "undo" : "redo";
          // With the box open (the keyboard on the row) they are the box's own.
          if (hand.box) session[dir]();
          else if (view.hand[dir]) void session.step(dir);
          return;
        }
        // The row's keys, on the picked shape.
        const key = formatKeyOf(event.nativeEvent, "slides", { mac: IS_MAC, editorKeys: true });
        if (key && keyAct(key, target, session)) event.preventDefault();
      }}
    >
      {view.hand ? <DeckRow view={view} target={target} hand={hand} session={session} tone={tone} boundary={root} onPresent={canPresent(view) ? presentFrom : undefined} measure={rowMeasure} /> : null}
      <div ref={box} className={`flex min-h-0 min-w-0 flex-1 ${narrow ? "flex-col-reverse" : ""}`}>
        <Strip view={view} current={shown?.key ?? null} narrow={narrow} fileDoc={fileDoc} proposedDoc={proposedDoc} pictures={!view.renderError} onPick={select} />
        {shown ? (
          <Main
            key={shown.key}
            view={view}
            slide={shown}
            doc={view.renderError ? null : docOf(shown)}
            onMount={stageCame}
            onUnmount={stageWent}
            onPainted={(doc, stage) => {
              if (live.current.has(stage)) setPainted({ key: shown.key, doc, stage });
              session.painted(shown.key, revOf(doc));
            }}
            onPaintFailed={(stage) => {
              setPainted((p) => (p?.stage === stage ? null : p));
              session.paintFailed(shown.key);
            }}
            onTone={setTone}
            width={narrow ? size.width : size.width - STRIP}
            height={narrow ? size.height - 96 : size.height}
            itemTitle={item.title}
            source={source}
            shell={shell}
            picked={firstPicked}
            typing={firstTyping}
            session={session}
            hand={hand}
            target={target}
            tone={tone}
          />
        ) : null}
      </div>
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
  retryRender: (() => void) | undefined,
  reviewRev: string | undefined,
  held: boolean,
  store: DeckStore,
  hand: HandState,
  session: HandSession,
  reload: () => void,
): void {
  const inPowerPoint = side === "powerpoint";
  const mode = view?.mode;
  useEffect(() => {
    if (!mode || inPowerPoint) return shell.mode(null);
    shell.mode({ value: mode, set: (next) => void run(host.mode(next), "Couldn't change what the agent does") });
    return () => shell.mode(null);
  }, [shell, host, mode, inPowerPoint, run]);

  // His own edit that did not go in comes before a picture that could not be drawn: his words wait in the box.
  const failure = hand.failure;
  useEffect(() => {
    shell.statusLine(
      error
        ? { tone: "failed", word: "Couldn't open this deck", detail: error, action: { label: "Retry", run: retry } }
        : failure?.conflict
          ? { tone: "failed", word: failure.message, detail: "Your words are still in the box", action: failure.message === CONFLICT_WORD ? { label: "Reload", run: reload } : undefined }
          : failure
            ? { tone: "failed", word: "Couldn't save your words", detail: failure.message, action: { label: "Retry", run: () => session.commit() } }
            : renderError
              ? { tone: "failed", word: "Can't draw the slides", detail: renderDetail(renderError), action: retryRender ? { label: "Retry", run: retryRender } : undefined }
              : null,
    );
    return () => shell.statusLine(null);
  }, [shell, error, renderError, retry, retryRender, failure, reload, session]);

  // What saved means for the file, where he can edit it by hand (FILES-SEAM.md "Save state").
  const editable = !!view?.hand && !inPowerPoint;
  const saved = editable ? session.saved(reload) : null;
  const savedKey = saved ? `${saved.state}:${saved.at ?? ""}:${saved.detail ?? ""}` : "";
  useEffect(() => {
    shell.saved?.(saved);
    return () => shell.saved?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, savedKey]);

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
      // Only the verdicts wait on the paint: Previous and Next stay live, so a keyboard review keeps its place in the bar
      // and a slide whose picture failed never stops him reaching the next change.
      verdictsHeld: held,
      accept: (w) => decide(which(w), "accept"),
      reject: (w) => decide(which(w), "reject"),
    };
    // A press goes with the revision of the changes he saw, never without one; one the host refuses (the changes moved
    // on since) says so, and the deck is read again, so he decides only on what is drawn.
    function decide(changes: string[] | "all", verdict: "accept" | "reject"): Promise<void> {
      if (held || !reviewRev) return Promise.reject(new Error("The slides are still being drawn"));
      return host.review(changes, verdict, reviewRev).then(
        (next) => store.view(next),
        (e: unknown) => {
          sayError(e, verdict === "accept" ? "Couldn't accept the change" : "Couldn't reject the change");
          return openDeck(host, store);
        },
      );
    }
    shell.review(review);
    return () => shell.review(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, host, changes, index, inPowerPoint, run, select, reviewRev, held, store]);
}

// ── the strip ────────────────────────────────────────────────────────

const FRAME_TINT = { add: "bg-(--add-bg)", del: "bg-(--del-bg)" } as const;

/** The strip draws again only when the deck, the slide on the stage or a render does: not on each word he types. */
const Strip = memo(function Strip({
  view,
  current,
  narrow,
  fileDoc,
  proposedDoc,
  pictures,
  onPick,
}: {
  view: DeckView;
  current: string | null;
  narrow: boolean;
  fileDoc: PdfDoc | null;
  proposedDoc: PdfDoc | null;
  pictures: boolean;
  onPick(key: string): void;
}) {
  const docOf = (slide: DeckSlide): PdfDoc | null => (slide.from === "proposed" ? proposedDoc : fileDoc);
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
});

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
/**
 * Lets pdf.js free a page it drew. A render that was replaced (the deck changed) is destroyed before the pictures
 * that drew from it are let go, and pdf.js throws when a destroyed document is asked for a page: there is nothing
 * left to free, and the throw, from an effect's clean-up, took the whole canvas down ("It could not be shown").
 */
export function freePage(doc: PdfDoc | null, page: number): void {
  try {
    doc?.release(page);
  } catch {
    /* destroyed: nothing to free */
  }
}

const Picture = memo(function Picture({
  doc,
  page,
  width,
  ghost = false,
  title,
  thumb = false,
  onPainted,
  onFailed,
}: {
  doc: PdfDoc | null;
  page: number;
  width: number;
  ghost?: boolean;
  title: string;
  thumb?: boolean;
  onPainted?(host: HTMLElement): void;
  onFailed?(): void;
}) {
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
        () => {
          if (job.signal.aborted || thumb) return;
          setFailed(true);
          onFailed?.();
        },
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
  useEffect(() => (doc && thumb && !near ? freePage(doc, page) : undefined), [doc, page, thumb, near]);
  useEffect(() => () => freePage(doc, page), [doc, page]);
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
  dark: { add: "bg-(--add-bg-dark-pic)" },
  light: { add: "bg-(--add-bg-paper)" },
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

/**
 * The colour of the slide just inside a shape's edges, read from the stage's drawn picture (`groundOf`): seven
 * samples along each edge, 3px in. Null where nothing is drawn yet (no canvas, or a picture with no pixels to read).
 */
function groundAt(stage: Element | null, quad: Quad, width: number, height: number): string | null {
  const canvas = stage?.querySelector("canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx || canvas.width === 0 || width <= 0) return null;
  const k = canvas.width / width;
  const pts = quad.map(([x, y]) => ({ x: x * width, y: y * height }));
  const mid = { x: pts.reduce((n, p) => n + p.x, 0) / 4, y: pts.reduce((n, p) => n + p.y, 0) / 4 };
  const samples: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % 4]];
    for (let j = 1; j <= 7; j++) {
      const t = j / 8;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const toward = Math.hypot(mid.x - p.x, mid.y - p.y) || 1;
      const x = Math.round((p.x + ((mid.x - p.x) / toward) * 3) * k);
      const y = Math.round((p.y + ((mid.y - p.y) / toward) * 3) * k);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const [r, g, bl, al] = ctx.getImageData(x, y, 1, 1).data;
      samples.push([r, g, bl, al]);
    }
  }
  return groundOf(samples);
}

/** Every stage mount ever made in this window, counted: each takes the next as its token. */
let stageMounts = 0;

function Main({
  view,
  slide,
  doc,
  width,
  height,
  itemTitle,
  source,
  shell,
  onPainted,
  onPaintFailed,
  onMount,
  onUnmount,
  onTone,
  picked: firstPicked,
  typing: firstTyping,
  session,
  hand,
  target,
  tone,
}: {
  /** the shape picked when the stage mounts (a preview) */
  picked?: number;
  /** the box open when the stage mounts (a preview) */
  typing?: SlidesDeps["typing"];
  session: HandSession;
  hand: HandState;
  target: Target;
  /** the picture's tone, read from its pixels when it paints */
  tone: "dark" | "light";
  onTone(tone: "dark" | "light"): void;
  view: DeckView;
  slide: DeckSlide;
  doc: PdfDoc | null;
  width: number;
  height: number;
  itemTitle: string;
  source: CanvasBodyProps["source"];
  shell: CanvasShell;
  /** this stage (its mount's token) painted this slide from `doc`: the review it shows may open */
  onPainted(doc: PdfDoc, stage: number): void;
  onPaintFailed(stage: number): void;
  /** this mount of the stage came, or went: an approval lives no longer than the stage that earned it */
  onMount(stage: number): void;
  onUnmount(stage: number): void;
}) {
  // A token for this mount alone, taken when it mounts: a remount of the same slide is another stage.
  const [stage] = useState(() => ++stageMounts);
  useLayoutEffect(() => {
    onMount(stage);
    return () => onUnmount(stage);
  }, [stage, onMount, onUnmount]);
  const size = doc?.size(slide.page);
  const aspect = size ? size.width / size.height : 16 / 9;
  const w = width > 0 ? stageWidth(width, height, aspect) : STAGE_MAX;
  // The shape picked is the session's, so the row acts on it; it is let go when the stage leaves the slide.
  const picked = hand.picked?.slideKey === slide.key ? hand.picked.shapeId : null;
  useLayoutEffect(() => {
    if (firstPicked !== undefined) session.pick(slide.key, firstPicked);
    return () => {
      if (session.get().picked?.slideKey === slide.key) session.pick(slide.key, null);
    };
  }, [session, slide.key, firstPicked]);
  const change = slide.change ? view.changes.find((c) => c.id === slide.change) : undefined;
  const tints = TINTS[tone];
  // A press takes the keyboard to the shape it picked, so Escape and the arrows answer after a pick by pointer.
  const byPointer = useRef(false);
  const pick = (shape: DeckShape, el: HTMLElement): void => {
    session.pick(slide.key, shape.id);
    const words = shape.text.replace(/\s+/g, " ").trim();
    const short = words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
    // A shape with no words is named by what it is.
    const what = words ? `“${short}”` : KIND_WORDS[shape.kind ?? "other"];
    // The bar floats under the slide, not beside the shape: over the picture it would take the press meant for the next shape.
    const at = askAnchor((layer.current?.parentElement ?? el).getBoundingClientRect());
    shell.selection({
      chip: { kind: "selection", label: `${what}, slide ${slide.number ?? slide.id}`, ref: source, quote: `${words ? `${words}\n` : ""}(${itemTitle}, slide id ${slide.id}, shape ${shape.id} "${shape.name}")` },
      rect: new DOMRect(at.left, at.top, 0, 0),
    });
  };
  const unpick = (): void => {
    session.pick(slide.key, null);
    shell.selection(null);
  };
  useEffect(() => () => shell.selection(null), [shell]);
  // What a press can pick: every shape of a kind whose box was held to the drawn pixels (geometry.ts), by its own
  // corners. A host a release behind sends no corners: its shapes with words are picked by their box, as before.
  const shapes = useMemo(
    () =>
      slide.tint === "del"
        ? []
        : slide.shapes.flatMap((s): Array<DeckShape & { quad: Quad }> => {
            if (pickable(s)) return [s];
            if (s.quad || !s.bbox || !s.text.trim()) return [];
            const [x0, y0, x1, y1] = s.bbox;
            return [{ ...s, quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }];
          }),
    [slide],
  );
  const layer = useRef<HTMLDivElement>(null);
  const buttonOf = (id: number): HTMLElement | null => layer.current?.querySelector<HTMLElement>(`[data-shape="${id}"]`) ?? null;
  const h = Math.round(w / aspect);
  const selected = shapes.find((s) => s.id === picked);
  const selection = selected ? selectionOf(selected.quad, w, h) : null;
  // The typing box, while it is on this slide: on the shape's corners as the deck has them now.
  const boxHere = hand.box?.slideKey === slide.key ? hand.box : null;
  const boxShape = boxHere ? (shapes.find((s) => s.id === boxHere.shape.id) ?? null) : null;
  const [ground, setGround] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (boxShape) setGround(groundAt(layer.current?.parentElement ?? null, boxShape.quad, w, h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxShape?.id, w, h]);
  // While he types the floating bar steps aside; once the box goes, the shape is Ask's again, in its new words.
  const typingHere = !!boxHere;
  const wasTyping = useRef(typingHere);
  useEffect(() => {
    if (typingHere) shell.selection(null);
    else if (wasTyping.current && selected) {
      const el = buttonOf(selected.id);
      if (el) pick(selected, el);
    }
    wasTyping.current = typingHere;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingHere]);
  /** A second press on a picked text shape, Return or F2 on it: his words go in a box over it. */
  const openBox = (shape: DeckShape, start: Start): boolean => session.open(slide, shape, start);
  useLayoutEffect(() => {
    const shape = firstTyping && shapes.find((s) => s.id === firstTyping.shape);
    if (!shape || !openBox(shape, "end")) return;
    if (firstTyping.sel) session.select(firstTyping.sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A change to the notes is drawn once, in the Notes section; the list above it is the slide's shapes.
  const notesEdit = change?.edits.find((e) => e.where === NOTES_WHERE);
  const edits = change?.edits.filter((e) => e !== notesEdit) ?? [];
  return (
    <div data-slides-main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="flex shrink-0 justify-center bg-(--slide-stage) px-4 pt-4 pb-(--slide-stage-inset)">
        <div data-slides-stage className="relative shrink-0" style={{ width: w }}>
          <Picture
            doc={doc}
            page={slide.page}
            width={w}
            ghost={slide.tint === "del"}
            title={slide.title}
            onPainted={(el) => {
              onTone(toneOf(el));
              if (doc) onPainted(doc, stage);
            }}
            onFailed={() => onPaintFailed(stage)}
          />
          <div
            ref={layer}
            data-slides-shapes
            role="group"
            aria-label="Shapes on this slide"
            className="absolute inset-0"
            // A press picks the topmost shape under it, by its own corners (a turned shape's box is wider than it
            // is); a press on the bare slide lets the selection go.
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const box = event.currentTarget.getBoundingClientRect();
              const under = box.width > 0 && box.height > 0 ? hit(shapes, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height) : null;
              const el = under ? buttonOf(under.id) : null;
              if (under && el) {
                if (under.id === picked && typable(under) && openBox(under, { x: event.clientX, y: event.clientY })) return;
                byPointer.current = true;
                el.focus({ preventScroll: true });
                byPointer.current = false;
                pick(under, el);
              } else unpick();
            }}
            // Tab walks the shapes from the back of the slide to the front; the arrows move the selection in reading order; Escape lets it go.
            onKeyDown={(event) => {
              const at = Number((event.target as HTMLElement).dataset.shape);
              if (!at) return;
              if (event.key === "Escape") {
                unpick();
                return;
              }
              // Return opens the box with the words selected, F2 with the caret at their end, as in PowerPoint.
              if ((event.key === "Enter" && bareKey(event)) || (event.key === "F2" && !chordKey(event))) {
                const shape = shapes.find((s) => s.id === at);
                if (shape && typable(shape) && openBox(shape, event.key === "Enter" ? "all" : "end")) event.preventDefault();
                return;
              }
              // The bare arrows only: with a modifier they are someone else's (a word, a line, the window).
              const by = !bareKey(event) ? 0 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (!by) return;
              const order = readingOrder(shapes);
              const next = order[order.findIndex((o) => o.id === at) + by];
              event.preventDefault();
              event.stopPropagation();
              buttonOf(next?.id ?? at)?.focus();
            }}
          >
            {slide.changed.map((b: Bbox, i) => (
              <span key={`c${i}`} data-slide-changed style={boxStyle(b)} className={`pointer-events-none absolute rounded-[3px] ${tints.add}`} />
            ))}
            {shapes.map((shape) => {
              const xs = shape.quad.map((p) => p[0]);
              const ys = shape.quad.map((p) => p[1]);
              return (
                <button
                  key={shape.id}
                  type="button"
                  data-shape={shape.id}
                  aria-label={shapeLabel(shape)}
                  aria-pressed={picked === shape.id}
                  style={boxStyle([Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(1, Math.max(...xs)), Math.min(1, Math.max(...ys))])}
                  // The layer takes the press and finds the shape by its corners; the button is the shape for the keyboard and a screen reader.
                  // Picked, the selection's own outline says where the keyboard is; let go, the focus ring does.
                  className="pointer-events-none absolute rounded-[4px] aria-pressed:outline-none"
                  onClick={(event) => pick(shape, event.currentTarget)}
                  onFocus={(event) => {
                    if (picked !== shape.id && !byPointer.current) pick(shape, event.currentTarget);
                  }}
                />
              );
            })}
            {boxHere && boxShape ? (
              <TypingBox
                key={boxHere.id}
                session={session}
                box={boxHere}
                target={target}
                place={textFrameOf(boxShape.quad, !!boxShape.flip, w, h)}
                emu={w / (view.size?.width ?? (aspect < 1.5 ? 9_144_000 : 12_192_000))}
                frame={boxShape.frame}
                // With no picture the slide is the blank's own fill, and so is the box.
                ground={firstTyping?.ground ?? ground ?? (doc ? null : "var(--muted)")}
                tone={tone}
                label={boxShape.label ?? KIND_WORDS[boxShape.kind ?? "other"]}
                onLeave={() => buttonOf(boxShape.id)?.focus({ preventScroll: true })}
              />
            ) : null}
            {selection ? <Selection selection={selection} width={w} height={h} /> : null}
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

/** A shape as a screen reader says it: what it is on its slide ("Title", "Text 2"), then its words. */
function shapeLabel(shape: DeckShape): string {
  const what = shape.label ?? KIND_WORDS[shape.kind ?? "other"];
  const words = shape.text.replace(/\s+/g, " ").trim();
  return words ? `${what}: ${words.length > 80 ? `${words.slice(0, 80).trimEnd()}…` : words}` : what;
}

/**
 * A picked shape's selection (docs/DESIGN.md "The slide editor"): a 1px outline on its corners, eight 8px handles
 * and a rotate handle over its top edge, drawn at screen size whatever the slide's zoom and turned with the shape.
 * One look in both themes (`sel-line-dark-pic` on `paper`): it sits on the deck, not on the app.
 */
function Selection({ selection, width, height }: { selection: ReturnType<typeof selectionOf>; width: number; height: number }) {
  const { corners, handles, rotate, stem } = selection;
  const [tl, tr] = corners;
  const turn = (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI;
  return (
    <svg data-slide-selection aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="pointer-events-none absolute inset-0 overflow-visible">
      <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="none" stroke="var(--sel-line-dark-pic)" strokeWidth={1} />
      <line x1={stem[0].x} y1={stem[0].y} x2={stem[1].x} y2={stem[1].y} stroke="var(--sel-line-dark-pic)" strokeWidth={1} />
      <circle data-handle="rotate" cx={rotate.x} cy={rotate.y} r={ROTATE_HANDLE / 2 - HANDLE_EDGE / 2} fill="var(--paper)" stroke="var(--sel-line-dark-pic)" strokeWidth={HANDLE_EDGE} />
      {handles.map((p, i) => (
        <rect
          key={i}
          data-handle={i}
          x={p.x - HANDLE / 2 + HANDLE_EDGE / 2}
          y={p.y - HANDLE / 2 + HANDLE_EDGE / 2}
          width={HANDLE - HANDLE_EDGE}
          height={HANDLE - HANDLE_EDGE}
          rx={2}
          transform={`rotate(${turn} ${p.x} ${p.y})`}
          fill="var(--paper)"
          stroke="var(--sel-line-dark-pic)"
          strokeWidth={HANDLE_EDGE}
        />
      ))}
    </svg>
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
      {before ? <span className="rounded-sm bg-(--del-bg) text-(--soft-foreground) line-through decoration-destructive/70">{before}</span> : null}
      {before && after ? " " : null}
      {after ? <span className="rounded-sm bg-(--add-bg)">{after}</span> : null}
    </>
  );
}

/**
 * Loading, in the body's shape: the strip beside the stage, or under it in a canvas under 400px (`NARROW`), as the
 * body lays it out; for a file, which he can most often edit, the format row's 36px over them, so nothing drops when
 * the deck lands.
 */
function DeckSkeleton({ row }: { row: boolean }) {
  return (
    <div data-slides-skeleton aria-busy="true" aria-label="Loading" className="@container flex min-h-0 flex-1 flex-col">
      {row ? (
        <div data-slides-skeleton-row className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ) : null}
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
          {/* On the stage band, as the loaded slide is (:406), so nothing moves when the deck lands. */}
          <div data-slides-skeleton-stage className="flex justify-center bg-(--slide-stage) px-4 pt-4 pb-(--slide-stage-inset)">
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
 * body does not drop 32px when it lands. In TempCode it ends with History
 * where he can edit the deck by hand, and with Present (Present.tsx) where the
 * format row is not drawn (the row's way out is Present otherwise); in the
 * real PowerPoint the stepper is not there: how many changes wait here, and
 * the way back to them.
 */
export function Bar({ item, env, host: given, engine }: CanvasBodyProps<SlidesState> & SlidesDeps) {
  const store = deckStoreOf(item.id);
  const { view, error, side } = useDeck(store);
  if (!view) return error ? null : <Skeleton className="h-3 w-30" />;
  const pending = view.changes.length;
  const host = given ?? hostFor(env, item.id);
  if (side !== "powerpoint") {
    // Present, at the bar's end, wherever the host has a picture of the file to show and the row does not hold it.
    const presentHere = !view.hand && canPresent(view);
    if (!view.hand && !presentHere) return null;
    return (
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {view.hand ? <HistoryButton host={host} session={handOf(item.id, host, store)} /> : null}
        {presentHere ? <PresentButton onPresent={(ask) => startPresenting(host, store, ask, engine)} /> : null}
      </div>
    );
  }
  if (pending === 0) return null;
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
