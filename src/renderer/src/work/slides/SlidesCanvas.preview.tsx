// A preview frame for `bun run ui:preview src/renderer/src/work/slides/SlidesCanvas.preview.tsx#SlidesPreview --width 864`:
// the slides kind in the canvas pane beside a thread, as the approved page draws it
// (.temp-code/prototypes/work-workspaces-2/slides.html, "Filmstrip and stage"), on slides drawn in place of pdf.js.
import type { ReactNode } from "react";
import type { DeckView } from "@shared/contract-work-slides";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { composerFixtureBase } from "../../chrome/Composer.fixtures";
import { defineChunk } from "../../lib/lazyChunk";
import { workCanvasChunk } from "../../surfaces/chunks";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush, resetCanvasStore, setFolded } from "../canvas/store";
import type { PdfEngine } from "../pdf/engine";
import { deckStoreOf } from "./deck";
import * as SlidesCanvas from "./SlidesCanvas";
import type { DeckParagraph, DeckSlide } from "@shared/contract-work-slides";
import { SelectionTools } from "../canvas/SelectionBar";
import { VersionList } from "./edit/History";
import { DECK_GROUND, DECK_INK, DECK_MUTED, DECK_THEME, LAYOUT_BARS, layoutsDoc, SPONSOR, sponsorDoc, TAG_BOX } from "./SlidesCanvas.preview.fixtures";
import { LayoutGrid } from "./edit/LayoutSelect";
import { ThemeList } from "./edit/ThemeMenu";
import { layoutsFor, PRESETS } from "./edit/add";
import { PresetGlyph } from "./edit/Insert";
import { MENU_ROW } from "work-kit/format";
import { ChevronRight, Plus } from "../../chrome/icons";
import { Chart, Media, Shapes, Table, TextBox, Video } from "../icons";
import { change, deckView, fakeDeckHost, slide, textShape } from "./testkit";

export type SlidesMoment =
  | "sugg"
  | "notes"
  | "ppt"
  | "loading"
  | "nopicture"
  | "picked"
  | "turned"
  | "typing"
  | "row"
  | "rownarrow"
  | "history"
  | "drag"
  | "shaperow"
  | "shaperownarrow"
  | "layouts"
  | "insert"
  | "theme"
  | "sheet"
  | "sheetunder"
  | "animate"
  | "animateppt"
  | "sorter"
  | "copy"
  | "google";

void workCanvasChunk.load();

const title = (id: number): string => SPONSOR[id - 1]?.title ?? `Slide ${id}`;

/** The prototype's revision: three slides reworded, Last year moved up beside the figures, a new slide after Packages. */
function revised(hosted: boolean): DeckView {
  const order = [1, 2, 3, 6, 4, 7, 5, 8];
  const slides = order.map((id, i) => {
    const base = { number: i + 1, title: title(id), from: "proposed" as const, page: i + 1 };
    if (id === 2) return slide(2, { ...base, change: "slide-2", tint: "add", changed: [[0.08, 0.16, 0.62, 0.27]], notes: "Lead with the turnout, then the stream." });
    if (id === 3 || id === 4) return slide(id, { ...base, change: `slide-${id}`, tint: "add", changed: [[0.086, 0.36, 0.8, 0.62]] });
    if (id === 6) return slide(6, { ...base, change: "slide-6", tint: "add" });
    if (id === 7) return slide(7, { ...base, change: "slide-7", tint: "add", changed: [[0.086, 0.2, 0.7, 0.5]] });
    return slide(id, base);
  });
  slides.splice(7, 0, slide(6, { key: "ghost:6", number: null, title: title(6), from: "file", page: 6, change: "slide-6", tint: "del" }));
  return deckView({
    name: "Sponsor deck.pptx",
    hosted,
    slides,
    changes: [
      change("slide-2", 2, { label: title(2), edits: [{ where: "Title", before: "Why sponsor us", after: "Why sponsor Spring LAN" }] }),
      change("slide-3", 3, { label: title(3) }),
      change("slide-6", 6, { kind: "moved", label: title(6) }),
      change("slide-4", 4, { label: title(4) }),
      change("slide-7", 7, { kind: "added", label: title(7) }),
    ],
    renders: { file: { rev: "f", size: 1, pages: 7 }, proposed: { rev: "p", size: 1, pages: 8 } },
  });
}

/** The widths the format row's controls draw at (work-kit's own measures), for a page where nothing lays out. */
const ROW_WIDTHS: Record<string, number> = { undo: 28, redo: 28, layout: 148, font: 120, size: 44, bold: 28, italic: 28, underline: 28, colour: 28, fill: 28, align: 40, bullets: 28, numbers: 28, arrange: 40, format: 28, insert: 62, theme: 66 };
const measureAt =
  (width: number) =>
  (el: HTMLElement): number =>
    el.dataset.formatItem ? (ROW_WIDTHS[el.dataset.formatItem] ?? 28) : el.dataset.formatEnd === "out" ? 108 : el.dataset.formatEnd === "view" ? 104 : width;

/** "Who comes" as he edits it: the title and its three points as text shapes in the deck's own look, where the picture draws them. */
/** A deck with slide 3 given a transition and builds of its own. */
const animated = (view: DeckView, over: Partial<DeckSlide>): DeckView => ({ ...view, slides: view.slides.map((s) => (s.id === 3 ? { ...s, ...over } : s)) });

function whoComes(): DeckView {
  const run = (text: string, size: number, color: string, bold = false) => ({ text, font: "Arial", size, color, ...(bold ? { bold } : {}) });
  const points: DeckParagraph[] = ["480 players across 3 titles", "6,200 stream viewers", "38% from engineering"].map((text) => ({ level: 0, align: "left", list: "none", runs: [run(text, 18, DECK_MUTED)] }));
  const order = [1, 2, 3, 4, 5, 6, 8];
  return deckView({
    slides: order.map((id, i) =>
      slide(id, {
        number: i + 1,
        title: title(id),
        page: i + 1,
        shapes:
          id === 3
            ? [
                textShape(2, [{ level: 0, align: "left", list: "none", runs: [run("Who comes", 30, DECK_INK, true)] }], [0.086, 0.165, 0.72, 0.265], { label: "Title", frame: { anchor: "top", insets: [0, 0, 0, 0], fit: "none", wrap: true } }),
                textShape(3, points, [0.086, 0.3, 0.72, 0.6], { label: "Text", frame: { anchor: "top", insets: [0, 0, 0, 0], fit: "none", wrap: true } }),
                TAG,
              ]
            : [],
        layout: id === 1 ? "Title Slide" : "Title and Content",
        ...(id === 1 ? { section: "Spring LAN" } : id === 4 ? { section: "The offer" } : {}),
        ...(id === 6 ? { hidden: true } : {}),
      }),
    ),
    renders: { file: { rev: "f", size: 1, pages: 7 }, proposed: null },
    hand: { undo: true, redo: false },
    size: { width: 9_144_000, height: 5_143_500 },
    theme: DECK_THEME,
    layouts: LAYOUTS,
    layoutsPic: { rev: "l", size: 1 },
  } as never);
}

/** PowerPoint's own layouts and their places. */
const LAYOUTS = [
  { name: "Title Slide", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "subtitle", idx: 1 }] },
  { name: "Title and Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }] },
  { name: "Section Header", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }] },
  { name: "Two Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }, { kind: "body", idx: 2 }] },
  { name: "Comparison", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }, { kind: "body", idx: 2 }, { kind: "body", idx: 3 }, { kind: "body", idx: 4 }] },
  { name: "Title Only", master: 0, holds: [{ kind: "title", idx: 0 }] },
  { name: "Blank", master: 0, holds: [] },
];

/** The tag on "Who comes" as the outline gives it: its corners and its own box on the 10 by 5.63 inch slide. */
const TAG = (() => {
  const [x0, y0, x1, y1] = TAG_BOX;
  const [w, h] = [9_144_000, 5_143_500];
  return {
    id: 4,
    name: "Rounded Rectangle 3",
    label: "Rounded rectangle",
    kind: "other" as const,
    shape: "roundRect",
    bbox: TAG_BOX,
    quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [[number, number], [number, number], [number, number], [number, number]],
    text: "",
    fill: "CFB991",
    line: { color: "none" },
    own: { box: [Math.round(x0 * w), Math.round(y0 * h), Math.round((x1 - x0) * w), Math.round((y1 - y0) * h)] as [number, number, number, number], rot: 0, flipH: false, flipV: false },
  };
})();

function setUp(moment: SlidesMoment): {
  view: DeckView;
  current?: string;
  engine?: PdfEngine;
  picked?: number;
  typing?: SlidesCanvas.SlidesDeps["typing"];
  dragging?: SlidesCanvas.SlidesDeps["dragging"];
  width?: number;
  look?: "slide" | "sorter";
  sheet?: boolean;
  tab?: "format" | "animate";
} {
  // The tag carried left until its centre is 3px short of the slide's: the snap puts it there, with a guide down the middle.
  if (moment === "drag") return { view: whoComes(), current: "3", picked: 4, width: 864, dragging: { shape: 4, dx: Math.round((0.5 - 0.74) * 9_144_000) + 30_000, dy: -400_000 } };
  if (moment === "shaperow" || moment === "layouts" || moment === "insert" || moment === "theme") return { view: whoComes(), current: "3", picked: 4, width: 1200 };
  if (moment === "shaperownarrow") return { view: whoComes(), current: "3", picked: 4, width: 520 };
  if (moment === "sheet") return { view: whoComes(), current: "3", picked: 4, width: 1200, sheet: true };
  // The Animate tab on "Who comes": a push from the right that moves on after 5 s, the title then the points on presses.
  if (moment === "animate") return { view: animated(whoComes(), { transition: { kind: "push", dir: "l", ms: 750, after: 5000 }, builds: { steps: [{ shapes: [2, 3], paras: [] }, { shapes: [3], paras: [] }, { shapes: [], paras: [] }], changed: 0, order: [2, 3] } }), current: "3", width: 816, sheet: true, tab: "animate" };
  // A slide whose effects are PowerPoint's: a wipe, and a motion path; under the slide on a 640px canvas.
  if (moment === "animateppt") return { view: animated(whoComes(), { transition: { kind: "wipe", ms: 500 }, builds: { steps: [{ shapes: [], paras: [] }], changed: 2, whole: "a motion path" } }), current: "3", width: 640, sheet: true, tab: "animate" };
  if (moment === "sheetunder") return { view: whoComes(), current: "3", picked: 4, width: 640, sheet: true };
  if (moment === "sorter") return { view: whoComes(), current: "3", width: 864, look: "sorter" };
  if (moment === "typing") return { view: whoComes(), current: "3", typing: { shape: 3, sel: { from: [1, 0], to: [1, 5] }, ground: DECK_GROUND }, width: 862 };
  if (moment === "row") return { view: whoComes(), current: "3", picked: 2, width: 1200 };
  if (moment === "rownarrow") return { view: whoComes(), current: "3", picked: 2, width: 520 };
  if (moment === "history") return { view: whoComes(), current: "3", width: 864 };
  if (moment === "copy" || moment === "google") {
    // Read only: an imported .ppt, or a Google deck Drive could not be reached for. No row, no mode.
    const order = [1, 2, 3, 4, 5, 6, 8];
    return {
      view: deckView({
        mode: undefined,
        readOnly: moment === "copy" ? { from: "ppt" } : { from: "google", offline: true },
        slides: order.map((id, i) => slide(id, { number: i + 1, title: title(id), page: i + 1 })),
        renders: { file: { rev: "f", size: 1, pages: 7 }, proposed: null },
      }),
      current: "2",
    };
  }
  if (moment === "notes") {
    const order = [1, 2, 3, 4, 5, 6, 8];
    return {
      view: deckView({
        mode: "writes",
        slides: order.map((id, i) => slide(id, { number: i + 1, title: title(id), page: i + 1, notes: id === 2 ? "Open with the turnout: 480 players and 6,200 on stream. Say the stream figure is from Twitch's own count." : "" })),
        written: { id: "w1", text: "Wrote notes for 7 slides", at: Date.now() - 60_000 },
        renders: { file: { rev: "f", size: 1, pages: 7 }, proposed: null },
      }),
      current: "2",
    };
  }
  if (moment === "picked" || moment === "turned") {
    // A shape picked on the stage: the title's box, and a box turned 12 degrees, by their own corners.
    const order = [1, 2, 3, 4, 5, 6, 8];
    const turned = moment === "turned";
    const quad = (turned ? [[0.1, 0.33], [0.72, 0.42], [0.69, 0.62], [0.07, 0.53]] : [[0.086, 0.2], [0.72, 0.2], [0.72, 0.31], [0.086, 0.31]]) as never;
    return {
      view: deckView({
        slides: order.map((id, i) => slide(id, { number: i + 1, title: title(id), page: i + 1, shapes: id === 2 ? [{ id: 3, name: "Title 1", bbox: [0.07, 0.2, 0.72, 0.62], text: title(2), kind: "text", quad, ...(turned ? { rot: 12 } : {}) }] : [] })),
        renders: { file: { rev: "f", size: 1, pages: 7 }, proposed: null },
      }),
      current: "2",
      picked: 3,
    };
  }
  if (moment === "loading") return { view: deckView(), engine: { open: () => new Promise(() => undefined) } };
  if (moment === "nopicture") {
    const order = [1, 2, 3, 4, 5, 6, 8];
    return { view: deckView({ slides: order.map((id, i) => slide(id, { number: i + 1, title: title(id) })), renders: { file: null, proposed: null }, renderError: "There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches." }) };
  }
  return { view: revised(moment === "ppt"), current: "2" };
}

const hosts = new Map<SlidesMoment, ReturnType<typeof fakeDeckHost>>();

/**
 * The pane's floating bar for a picked shape, as the frame draws it (a static page cannot hold the portal it opens
 * in): hidden here, and laid by the page that shows the preview where the frame lays it, above the anchor `askAnchor`
 * gives (geometry.ts), so a look at a real width shows where it falls.
 */
function AskBar() {
  return (
    <div data-preview-askbar hidden className="flex w-auto flex-row rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-overlay ring-1 ring-border">
      <SelectionTools selection={{ chip: { kind: "selection", label: "“Who comes”, slide 3", ref: { at: "file", host: "local", path: "/work/Sponsor deck.pptx" } }, rect: new DOMRect() }} onAsk={() => undefined} />
    </div>
  );
}

export function SlidesPreview({ moment = "sugg", previewWidth }: { moment?: SlidesMoment; previewWidth?: number }) {
  resetCanvasStore();
  const sessionId = `preview-slides-${moment}`;
  const itemId = `${sessionId}-item`;
  const name = moment === "copy" ? "Sponsor deck.ppt" : "Sponsor deck.pptx";
  const source: CanvasItem["source"] = moment === "google" ? { at: "google", account: "landon@example.com", fileId: "d1", mime: "application/vnd.google-apps.presentation" } : { at: "file", host: "local", path: `/work/${name}` };
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "slides" as CanvasKind, title: moment === "google" ? "Sponsor deck" : name, source, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const { view, current, engine, picked, typing, dragging, width: fixtureWidth, look, sheet, tab } = setUp(moment);
  const width = previewWidth ?? fixtureWidth;
  // One host a moment, whatever renders the page again: the deck's hand is kept by its host.
  const host = hosts.get(moment) ?? hosts.set(moment, fakeDeckHost({ ...view, itemId })).get(moment)!;
  const store = deckStoreOf(itemId);
  if (moment === "loading") host.open = () => new Promise(() => undefined);
  else store.view({ ...view, itemId });
  if (current) store.set({ current });
  store.set({ look: look ?? "slide", sheet: !!sheet, sheetTab: tab ?? "format" });
  if (moment === "ppt") store.set({ side: "powerpoint" });
  // The file's render in the deck's order; the proposed render in the revision's.
  let opened = 0;
  const docs = [sponsorDoc([1, 2, 3, 4, 5, 6, 8]), sponsorDoc([1, 2, 3, 6, 4, 7, 5, 8])];
  const fake: PdfEngine = engine ?? { open: async () => docs[Math.min(1, opened++)] };
  const module = {
    Body: (props: CanvasBodyProps) => (
      <SlidesCanvas.Body
        {...(props as CanvasBodyProps<undefined>)}
        host={host}
        engine={fake}
        width={width ?? 454}
        height={width ? 456 : 492}
        picked={picked}
        typing={typing}
        dragging={dragging}
        rowMeasure={measureAt(width ?? 454)}
      />
    ),
    Bar: (props: CanvasBodyProps) => <SlidesCanvas.Bar {...(props as CanvasBodyProps<undefined>)} host={host} engine={fake} />,
    TabEnd: SlidesCanvas.TabEnd as never,
  };
  const chunk = defineChunk(`preview-slides-${moment}`, () => Promise.resolve(module));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, slides: { ...CANVAS.slides, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  // The canvas alone, as a Files tab or a folded thread has it: the row at its full width or narrowed.
  if (width) {
    setFolded(sessionId, true);
    return (
      <div className="relative flex h-[560px] overflow-hidden rounded-xl border border-border" style={{ width }}>
        <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
          <div />
        </CanvasSeat>
        {moment === "history" ? <HistoryOpen /> : null}
        {moment === "row" ? <AskBar /> : null}
        {moment === "layouts" ? <LayoutsOpen view={view} /> : null}
        {moment === "insert" ? <InsertOpen /> : null}
        {moment === "theme" ? <ThemeOpen view={view} /> : null}
      </div>
    );
  }
  return (
    <div className="relative flex h-[560px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...composerFixtureBase} sessionId={sessionId} /> }} />
        </div>
      </CanvasSeat>
      {moment === "picked" || moment === "turned" ? <AskBar /> : null}
    </div>
  );
}

/** History open from the deck's bar, as its popover draws it (a static page cannot hold the portal it opens in). */
function HistoryOpen() {
  const now = Date.now();
  const kept = {
    list: [
      { id: "v4", at: now - 4 * 60_000, size: 1, first: false },
      { id: "v3", at: now - 52 * 60_000, size: 1, first: false },
      { id: "v2", at: now - 26 * 3_600_000, size: 1, first: false },
      { id: "v1", at: now - 3 * 86_400_000, size: 1, first: true },
    ],
    error: null,
  };
  return (
    <div className="absolute end-2 top-[74px] flex w-[280px] flex-col rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-overlay ring-1 ring-border">
      <VersionList kept={kept} restoring={null} onRetry={() => undefined} onRestore={() => undefined} />
    </div>
  );
}

/** The popover a press on the row's layout opens, as it draws (a static page cannot hold its portal): under the select. */
function LayoutsOpen({ view }: { view: DeckView }) {
  const slide3 = view.slides.find((s) => s.id === 3);
  return (
    <div className="absolute start-[78px] top-[114px] rounded-xl bg-popover p-3 text-popover-foreground shadow-overlay ring-1 ring-border" style={{ width: 3 * 102 + 2 * 8 + 24 }}>
      <LayoutGrid view={view} options={layoutsFor(view, slide3)} value={slide3?.layout ?? null} doc={layoutsDoc(Object.keys(LAYOUT_BARS))} onPick={() => undefined} />
    </div>
  );
}

/** Insert's menu as it draws (a static page cannot hold its portal): its rows, under its word. */
function InsertOpen() {
  const row = (icon: ReactNode, label: string, more = false) => (
    <div className={MENU_ROW}>
      <span aria-hidden className="grid size-3.5 flex-none place-items-center">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {more ? <ChevronRight className="ms-auto size-3" /> : null}
    </div>
  );
  return (
    <div className="absolute start-[787px] top-[114px] flex items-start gap-1">
      <div className="w-[200px] rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
        {row(<Plus />, "New slide")}
        <div className="-mx-1 my-1 h-px bg-border" />
        {row(<TextBox />, "Text box")}
        <div className="rounded-lg bg-(--ui-wash,var(--accent))">{row(<Shapes />, "Shape", true)}</div>
        {row(<Media />, "Picture…")}
        {row(<Table />, "Table", true)}
        {row(<Chart />, "Chart", true)}
        {row(<Video />, "Video…")}
      </div>
      <div className="mt-[44px] h-fit w-[196px] rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
        {PRESETS.map((p) => (
          <div key={p.preset}>{row(<PresetGlyph path={p.path} />, p.label)}</div>
        ))}
      </div>
    </div>
  );
}

/** Theme's popover as it draws: under its word. */
function ThemeOpen({ view }: { view: DeckView }) {
  return (
    <div className="absolute start-[851px] top-[114px] flex w-[288px] flex-col rounded-xl bg-popover p-1.5 text-popover-foreground shadow-overlay ring-1 ring-border">
      <ThemeList view={view} onPick={() => undefined} />
    </div>
  );
}
