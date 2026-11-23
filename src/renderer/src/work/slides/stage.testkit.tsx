/**
 * The real canvas pane with a deck in it, for the DOM tests of his hand on a
 * deck: a host that keeps one view (testkit.ts), pages of words in place of
 * pdf.js, and the stage given a box so a press has a place on the slide. A
 * test file mocks `lib/connection`, `./show/Show` and the toaster itself (see
 * ShapeEditor.dom.test.tsx) and hands its hoisted holder to `harness`.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { DeckShape, DeckView } from "@shared/contract-work-slides";
import type { CanvasItem } from "@shared/work";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef, CanvasSelection, CanvasShell } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { PdfDoc, PdfEngine } from "../pdf/engine";
import { fakeDoc } from "../pdf/testkit";
import type { MediaSize } from "./edit/Insert";
import { boxShape, deckView, fakeDeckHost, slide, textShape } from "./testkit";

export interface Holder {
  current: ReturnType<typeof fakeHost> | null;
  pushes: Set<(push: never) => void>;
  opens: Set<() => void>;
  toasts: string[];
}

/** The size the fake pages are drawn at: a 16:9 slide. */
const WIDE = { width: 480, height: 270 };
export const pageOf = (words: string) => ({ size: WIDE, runs: [{ str: words, box: [0.1, 0.1, 0.9, 0.3] as [number, number, number, number] }] });

/** A title, a plain box and a picture on one slide, each with its own box on the slide. */
export const TITLE: DeckShape = textShape(2, [{ level: 0, align: "left", list: "none", runs: [{ text: "Who comes", font: "Calibri", size: 40, color: "1F1F1F" }] }], [0.1, 0.1, 0.9, 0.3], {
  label: "Title",
  own: { box: [1_219_200, 685_800, 9_753_600, 1_371_600], rot: 0, flipH: false, flipV: false },
});
export const BOX: DeckShape = boxShape(5, [0.5, 0.5, 0.7, 0.7], { label: "Rectangle 4", shape: "rect" });
export const PICTURE: DeckShape = boxShape(4, [0.1, 0.5, 0.3, 0.9], { kind: "picture", label: "Picture" });

export function handView(over: Partial<DeckView> = {}): DeckView {
  return deckView({
    slides: [slide(3, { number: 1, page: 1, shapes: [TITLE, PICTURE, BOX], layout: "Title and Content" }), slide(5, { number: 2, page: 2, layout: "Title Only" })],
    renders: { file: { rev: "f1", size: 10, pages: 2 }, proposed: null },
    hand: { undo: false, redo: false },
    size: { width: 12_192_000, height: 6_858_000 },
    theme: { colors: { dk1: "000000", lt1: "FFFFFF", accent1: "4472C4", accent2: "ED7D31" }, major: "Calibri Light", minor: "Calibri" },
    layouts: [
      { name: "Title Slide", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "subtitle", idx: 1 }] },
      { name: "Title and Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }] },
      { name: "Two Content", master: 0, holds: [{ kind: "title", idx: 0 }, { kind: "body", idx: 1 }, { kind: "body", idx: 2 }] },
      { name: "Title Only", master: 0, holds: [{ kind: "title", idx: 0 }] },
      { name: "Blank", master: 0, holds: [] },
    ],
    ...over,
  });
}

export function harness(holder: Holder) {
  /** The file before his edit, then after it. */
  let pictures: PdfDoc[] = [];
  /** While set, every picture open after the first waits on it: the new picture is still being drawn. */
  let gate: Promise<void> | null = null;
  let deckHost = fakeDeckHost(handView());
  const selections: Array<CanvasSelection | null> = [];
  const spied = new WeakMap<CanvasShell, CanvasShell>();
  const spy = (shell: CanvasShell): CanvasShell => {
    let got = spied.get(shell);
    if (!got) {
      got = { ...shell, selection: (s: CanvasSelection | null) => (selections.push(s), shell.selection(s)) };
      spied.set(shell, got);
    }
    return got;
  };
  /** How big a picture he adds is, which jsdom cannot read. */
  let mediaSize: MediaSize = async () => ({ width: 800, height: 600 });
  const kinds = (width: number, height: number): Record<string, CanvasKindDef> => {
    let opened = 0;
    const engine: PdfEngine = {
      open: async () => {
        const at = opened++;
        if (at > 0 && gate) await gate;
        return pictures[Math.min(at, pictures.length - 1)];
      },
    };
    const module = import("./SlidesCanvas").then((m) => ({
      Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} shell={spy(props.shell)} host={deckHost} engine={engine} width={width} height={height} mediaSize={(f, k) => mediaSize(f, k)} />,
      Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<undefined>)} host={deckHost} engine={engine} />,
      TabEnd: m.TabEnd as never,
    }));
    return { ...CANVAS, slides: { ...CANVAS.slides, chunk: defineChunk(`test-stage-${Math.random()}`, () => module) } };
  };
  let n = 0;
  const found = (selector: string): Promise<HTMLElement> =>
    waitFor(
      () => {
        const el = document.querySelector<HTMLElement>(selector);
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 5000 },
    );
  const picture = (): string => document.querySelector("[data-slides-stage] [data-slide-picture]")?.textContent ?? "";

  const api = {
    get host() {
      return deckHost;
    },
    selections,
    reset() {
      pictures = [fakeDoc([pageOf("Who comes"), pageOf("Slide 2")]), fakeDoc([pageOf("Who comes today"), pageOf("Slide 2")])];
      gate = null;
      selections.length = 0;
    },
    measureMedia(next: MediaSize) {
      mediaSize = next;
    },
    /** Holds every new picture until the returned call lets it paint. */
    holdPictures(): () => void {
      let paint!: () => void;
      gate = new Promise<void>((done) => (paint = done));
      return () => paint();
    },
    open(view: DeckView = handView(), { width = 800, height = 700 } = {}) {
      const item: CanvasItem = canvasItem(`stage${++n}`, { kind: "slides", title: "Sponsor deck.pptx", source: { at: "file", host: "local", path: "/work/deck.pptx" } });
      deckHost = fakeDeckHost({ ...view, itemId: item.id });
      holder.current = fakeHost([item], holder as never);
      return render(
        <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds(width, height) as never}>
          <div />
        </CanvasSeat>,
      );
    },
    found,
    picture,
    /** The deck open with its stage settled, the layer a press lands on given a box of 1000 by 500. */
    async stage(view: DeckView = handView(), size?: { width: number; height: number }) {
      api.open(view, size);
      await waitFor(() => expect(picture()).not.toBe(""), { timeout: 5000 });
      const layer = await found("[data-slides-shapes]");
      layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
      const press = (x: number, y: number): boolean => fireEvent.click(layer, { clientX: x * 1000, clientY: y * 500 });
      const shape = (id: number): HTMLElement => layer.querySelector<HTMLElement>(`[data-shape="${id}"]`)!;
      /** The stage's own width and height in CSS pixels, which the selection is drawn in. */
      const drawn = (): { w: number; h: number } => {
        const w = Number.parseFloat(document.querySelector<HTMLElement>("[data-slides-stage]")!.style.width);
        return { w, h: Math.round(w / (16 / 9)) };
      };
      return { layer, press, shape, drawn };
    },
    /** The stage's height in CSS pixels, as the overlays are drawn. */
    stageHeight: (): number => Math.round(Number.parseFloat(document.querySelector<HTMLElement>("[data-slides-stage]")!.style.width) / (16 / 9)),
    edits: () => deckHost.calls.filter(([name]) => name === "edit").map(([, ops]) => ops),
    rowItem: (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-format-row] [data-format-item="${id}"] button, [data-format-row] [data-format-item="${id}"] input`)!,
  };
  return api;
}
