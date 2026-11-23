// A preview frame for `bun run ui:preview src/renderer/src/work/slides/SlidesCanvas.preview.tsx#SlidesPreview --width 864`:
// the slides kind in the canvas pane beside a thread, as the approved page draws it
// (.temp-code/prototypes/work-workspaces-2/slides.html, "Filmstrip and stage"), on slides drawn in place of pdf.js.
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
import { applyCanvasPush, resetCanvasStore } from "../canvas/store";
import type { PdfEngine } from "../pdf/engine";
import { deckStoreOf } from "./deck";
import * as SlidesCanvas from "./SlidesCanvas";
import { SPONSOR, sponsorDoc } from "./SlidesCanvas.preview.fixtures";
import { change, deckView, fakeDeckHost, slide } from "./testkit";

export type SlidesMoment = "sugg" | "notes" | "ppt" | "loading" | "nopicture" | "picked" | "turned";

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

function setUp(moment: SlidesMoment): { view: DeckView; current?: string; engine?: PdfEngine; picked?: number } {
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

export function SlidesPreview({ moment = "sugg" }: { moment?: SlidesMoment }) {
  resetCanvasStore();
  const sessionId = `preview-slides-${moment}`;
  const itemId = `${sessionId}-item`;
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "slides" as CanvasKind, title: "Sponsor deck.pptx", source: { at: "file", host: "local", path: "/work/Sponsor deck.pptx" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const { view, current, engine, picked } = setUp(moment);
  const host = fakeDeckHost({ ...view, itemId });
  const store = deckStoreOf(itemId);
  if (moment === "loading") host.open = () => new Promise(() => undefined);
  else store.view({ ...view, itemId });
  if (current) store.set({ current });
  if (moment === "ppt") store.set({ side: "powerpoint" });
  // The file's render in the deck's order; the proposed render in the revision's.
  let opened = 0;
  const docs = [sponsorDoc([1, 2, 3, 4, 5, 6, 8]), sponsorDoc([1, 2, 3, 6, 4, 7, 5, 8])];
  const fake: PdfEngine = engine ?? { open: async () => docs[Math.min(1, opened++)] };
  const module = {
    Body: (props: CanvasBodyProps) => <SlidesCanvas.Body {...(props as CanvasBodyProps<undefined>)} host={host} engine={fake} width={454} height={492} picked={picked} />,
    Bar: SlidesCanvas.Bar as never,
    TabEnd: SlidesCanvas.TabEnd as never,
  };
  const chunk = defineChunk(`preview-slides-${moment}`, () => Promise.resolve(module));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, slides: { ...CANVAS.slides, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  return (
    <div className="flex h-[560px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...composerFixtureBase} sessionId={sessionId} /> }} />
        </div>
      </CanvasSeat>
    </div>
  );
}
