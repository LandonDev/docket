import type { Bbox } from "@shared/contract-work-pdf";

/**
 * What the PDF and slides canvases draw a file with. The real one is pdf.js,
 * loaded with the canvas (never in the first paint) and fed bytes by range
 * from the host; a test or a preview hands in its own.
 */

/** A page's size in PDF points, after its rotation. */
export interface PageSize {
  width: number;
  height: number;
}

/** A run of the page's text and where it is, as shares of the page (top-left origin). */
export interface TextRun {
  str: string;
  box: Bbox;
}

export interface PdfDoc {
  readonly pages: number;
  /** A page's size; pages not read yet take the first page's. */
  size(page: number): PageSize;
  /** Reads a page's size; the doc's `size` knows it from then on. */
  measure(page: number): Promise<PageSize>;
  /**
   * Draws a page into `host` at `scale` CSS pixels a point, and its words into
   * `text` (selectable, transparent over the picture) when given.
   */
  paint(page: number, host: HTMLElement, scale: number, text: HTMLElement | null, signal: AbortSignal): Promise<void>;
  /** The page's words, for find and for a selection's place. Cached. */
  text(page: number): Promise<TextRun[]>;
  /** A page left the window: what pdf.js decoded for it (images, fonts, its drawing) is let go. */
  release(page: number): void;
  destroy(): void;
}

export interface PdfEngine {
  /**
   * Opens a file of `size` bytes read through `read`. Rejects with a
   * `PasswordNeeded` when the file is encrypted and the password is missing
   * or wrong.
   */
  open(file: { size: number; read(offset: number, length: number): Promise<Uint8Array>; password?: string; onFail?(message: string): void }): Promise<PdfDoc>;
}

export class PasswordNeeded extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? "Wrong password" : "This file needs a password");
  }
}

/** CSS pixels a point at 100%: pdf.js's own 96/72. */
export const CSS_PER_POINT = 96 / 72;
/** The most canvas pixels one page may take, whatever the zoom and the screen. */
const MAX_PIXELS = 16_777_216;
/** A read the host answers in one frame. */
const READ_CHUNK = 1024 * 1024;

type Pdfjs = typeof import("pdfjs-dist");
type Loaded = { pdfjs: Pdfjs; worker: InstanceType<Pdfjs["PDFWorker"]>; data: typeof import("./pdfjsData").ShippedData };
let loading: Promise<Loaded> | null = null;

/**
 * pdf.js and one worker for the window, handed to every document: a
 * document closing never takes the worker down under one that is opening,
 * as the shared `workerPort` would.
 */
function loadPdfjs(): Promise<Loaded> {
  loading ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?worker"), import("./pdfjsData")]).then(([pdfjs, Worker, shipped]) => ({
    pdfjs,
    // pdf.js's CMaps, two standard fonts and image decoders, by name from the build's assets.
    data: shipped.ShippedData,
    // pdf.js types `port` as a worker it made itself; any Worker is one.
    worker: new pdfjs.PDFWorker({ port: new Worker.default() as never }),
  }));
  return loading;
}

/**
 * Answers one of pdf.js's range requests. pdf.js keeps one reader a
 * request, which closes on its first answer, so a request is answered once
 * and whole: its slices are read (at most a frame each) and joined. A read
 * that fails is tried once more; a second failure answers null, and the
 * engine fails the document, since pdf.js never asks for that range again.
 */
export async function readRange(read: (offset: number, length: number) => Promise<Uint8Array>, begin: number, end: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  for (let at = begin; at < end; at += READ_CHUNK) {
    const length = Math.min(READ_CHUNK, end - at);
    const bytes = await read(at, length)
      .catch(() => read(at, length))
      .catch(() => null);
    if (!bytes || bytes.length === 0) return null;
    parts.push(bytes);
  }
  if (parts.length === 1) return parts[0];
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return whole;
}

/** Turns a text item's place (PDF space) into shares of the page, top-left origin. */
export function runBox(
  transform: readonly number[],
  width: number,
  height: number,
  viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] },
): Bbox | null {
  const x = transform[4];
  const y = transform[5];
  // A run's height is its font's: the transform's vertical scale when the item gives none.
  const h = height || Math.hypot(transform[2], transform[3]);
  if (!(width > 0) || !(h > 0) || viewport.width <= 0 || viewport.height <= 0) return null;
  const [ax, ay] = viewport.convertToViewportPoint(x, y);
  const [bx, by] = viewport.convertToViewportPoint(x + width, y + h);
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  const box: Bbox = [clamp(Math.min(ax, bx) / viewport.width), clamp(Math.min(ay, by) / viewport.height), clamp(Math.max(ax, bx) / viewport.width), clamp(Math.max(ay, by) / viewport.height)];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/** pdf.js's text layer, positioned by its CSS variables: the few rules it needs, scoped to the canvas. */
const TEXT_LAYER_CSS = `
[data-pdf-text]{position:absolute;inset:0;overflow:clip;line-height:1;text-align:initial;transform-origin:0 0;forced-color-adjust:none;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
[data-pdf-text] :is(span,br){position:absolute;color:transparent;white-space:pre;cursor:text;transform-origin:0 0;user-select:text}
[data-pdf-text]>:not(.markedContent),[data-pdf-text] .markedContent span:not(.markedContent){--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
[data-pdf-text] .markedContent{display:contents}
[data-pdf-text] ::selection{background:var(--sel-bg-paper);color:transparent}
[data-pdf-text] .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
`;
let styled = false;
function textLayerStyle(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const style = document.createElement("style");
  style.dataset.pdfText = "";
  style.textContent = TEXT_LAYER_CSS;
  document.head.appendChild(style);
}

/** The real engine: pdf.js on the file's bytes, fetched by range as pages need them. */
export const pdfjsEngine: PdfEngine = {
  async open({ size, read, password, onFail }) {
    const { pdfjs, worker, data } = await loadPdfjs();
    textLayerStyle();
    const first = await read(0, Math.min(size, READ_CHUNK));
    const range = new pdfjs.PDFDataRangeTransport(size, first, first.length >= size);
    // A range pdf.js asked for and never got is never asked again: its pages would wait for good.
    // So a read that fails twice fails the document, which the body shows with Retry.
    let closed = false;
    let fail: (error: Error) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    failed.catch(() => undefined);
    range.requestDataRange = (begin: number, end: number) => {
      if (closed) return;
      void readRange(read, begin, end).then((bytes) => {
        if (closed) return;
        if (!bytes) {
          const error = new Error("The host stopped sending this file.");
          fail(error);
          onFail?.(error.message);
          return;
        }
        try {
          range.onDataRange(begin, bytes);
        } catch {
          // pdf.js dropped the request (the document closed under it): nothing waits for these bytes.
        }
      });
    };
    // 256 KB a range, not pdf.js's 64: a file whose page dictionaries are spread through it (a classic xref) needs a quarter of the round trips
    // to open, though pdf.js may then read most of it before page 1 (34 MB in 4.3 s at 20 MB/s, against 21 MB in 7.1 s at 64 KB).
    const task = pdfjs.getDocument({ range, worker, password, rangeChunkSize: 262_144, enableXfa: false, disableAutoFetch: false, BinaryDataFactory: data as never });
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await Promise.race([task.promise, failed]);
    } catch (error) {
      closed = true;
      void task.destroy();
      if (error instanceof pdfjs.PasswordException) throw new PasswordNeeded(error.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
      throw error;
    }
    const sizes = new Map<number, PageSize>();
    const texts = new Map<number, Promise<TextRun[]>>();
    /** Pages pdf.js has loaded: only these have anything to let go. */
    const loaded = new Set<number>();
    const pageOf = (n: number) => {
      loaded.add(n);
      return doc.getPage(n);
    };
    const measure = async (n: number): Promise<PageSize> => {
      const page = await pageOf(n);
      const viewport = page.getViewport({ scale: 1 });
      const got = { width: viewport.width, height: viewport.height };
      sizes.set(n, got);
      return got;
    };
    await measure(1);
    return {
      pages: doc.numPages,
      size: (n) => sizes.get(n) ?? sizes.get(1)!,
      measure,
      async paint(n, host, scale, text, signal) {
        const page = await pageOf(n);
        if (signal.aborted) return;
        const viewport = page.getViewport({ scale: scale * CSS_PER_POINT });
        sizes.set(n, { width: viewport.width / scale / CSS_PER_POINT, height: viewport.height / scale / CSS_PER_POINT });
        const dpr = Math.min(globalThis.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, viewport.width * viewport.height)));
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        const job = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0], annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS });
        const stop = (): void => job.cancel();
        signal.addEventListener("abort", stop, { once: true });
        try {
          await job.promise;
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        } finally {
          signal.removeEventListener("abort", stop);
        }
        if (signal.aborted) return;
        // The new picture replaces the old one only once it is whole, so a zoom never flashes white.
        host.replaceChildren(canvas);
        if (!text) return;
        text.replaceChildren();
        text.style.setProperty("--total-scale-factor", String(scale * CSS_PER_POINT));
        const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
        signal.addEventListener("abort", () => layer.cancel(), { once: true });
        await layer.render().catch(() => undefined);
      },
      text(n) {
        let got = texts.get(n);
        if (!got) {
          got = (async () => {
            const page = await pageOf(n);
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const runs: TextRun[] = [];
            for (const item of content.items) {
              if (!("str" in item) || !item.str.trim()) continue;
              const box = runBox(item.transform as number[], item.width, item.height, viewport);
              if (box) runs.push({ str: item.str, box });
            }
            return runs;
          })();
          texts.set(n, got);
          got.catch(() => texts.delete(n));
        }
        return got;
      },
      release(n) {
        // A page never loaded has nothing to free; asking for it would load it.
        if (!loaded.delete(n)) return;
        void doc.getPage(n).then(
          (page) => page.cleanup(),
          () => undefined,
        );
      },
      destroy() {
        closed = true;
        void task.destroy();
      },
    };
  },
};

/** Base64 from the host into bytes. */
export function fromBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
