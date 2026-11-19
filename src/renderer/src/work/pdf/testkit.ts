import type { PdfField, PdfSignature, PdfView } from "@shared/contract-work-pdf";
import { boxStyle } from "./layout";
import { PasswordNeeded, type PageSize, type PdfDoc, type PdfEngine, type TextRun } from "./engine";
import type { PdfHost } from "./item";

/**
 * A PDF without pdf.js, for the DOM tests and the preview: each page a list
 * of runs of text at their boxes, drawn as words on paper. The real engine
 * draws a canvas; this one writes the words into the page so a static
 * preview shows them and a test can read them.
 */

export interface FakePage {
  size?: PageSize;
  runs: TextRun[];
  /** Drawn on the page, for the preview: a heading or a paragraph as the file has it. */
  lines?: Array<{ text: string; box: [number, number, number, number]; size?: number; bold?: boolean }>;
}

export const LETTER: PageSize = { width: 612, height: 792 };

export function fakeDoc(pages: FakePage[]): PdfDoc & { painted: number[]; released: number[] } {
  const painted: number[] = [];
  const released: number[] = [];
  return {
    pages: pages.length,
    painted,
    released,
    size: (n) => pages[n - 1]?.size ?? pages[0]?.size ?? LETTER,
    measure: async (n) => pages[n - 1]?.size ?? LETTER,
    async paint(n, host, scale) {
      painted.push(n);
      const page = pages[n - 1];
      const lines = page?.lines ?? page?.runs.map((run) => ({ text: run.str, box: run.box, size: undefined, bold: false })) ?? [];
      const ownerDocument = host.ownerDocument;
      host.replaceChildren(
        ...lines.map((line) => {
          const el = ownerDocument.createElement("span");
          const s = boxStyle(line.box);
          el.textContent = line.text;
          el.style.cssText = `position:absolute;left:${s.left};top:${s.top};width:${s.width};white-space:nowrap;overflow:hidden;font:${line.bold ? 700 : 400} ${((line.size ?? 9.5) * scale * 96) / 72}px/1.35 "Times New Roman",Tinos,"Liberation Serif",serif;`;
          return el;
        }),
      );
    },
    text: async (n) => pages[n - 1]?.runs ?? [],
    release: (n) => void released.push(n),
    destroy: () => undefined,
  };
}

export function fakeEngine(doc: PdfDoc | (() => PdfDoc), options: { password?: string } = {}): PdfEngine & { opened: number } {
  const engine = {
    opened: 0,
    async open(file: { password?: string }) {
      engine.opened++;
      if (options.password !== undefined && file.password !== options.password) {
        throw new PasswordNeeded(file.password !== undefined);
      }
      return typeof doc === "function" ? doc() : doc;
    },
  };
  return engine;
}

export function pdfView(over: Partial<PdfView> = {}): PdfView {
  return { itemId: "pdf1", sessionId: "t1", name: "Ballroom contract.pdf", size: 1000, rev: "r1", mode: "suggests", fields: [], marks: [], hasSignature: false, signed: false, ...over };
}

export function field(key: string, over: Partial<PdfField> = {}): PdfField {
  return { key, label: key, type: "text", page: 1, bbox: [0.1, 0.5, 0.5, 0.53], origin: "acroform", value: null, state: "empty", provenance: [], ...over };
}

/** A host that keeps one item's view and answers the canvas's calls the way the host would. */
export function fakePdfHost(initial: PdfView): PdfHost & { calls: Array<[string, unknown]>; push(view: PdfView): void; view: PdfView } {
  const listeners = new Set<(view: PdfView) => void>();
  let saved: PdfSignature | null = null;
  const host = {
    view: initial,
    calls: [] as Array<[string, unknown]>,
    push(view: PdfView) {
      host.view = view;
      for (const l of listeners) l(view);
    },
    async open() {
      host.calls.push(["open", null]);
      return host.view;
    },
    async read() {
      return new Uint8Array();
    },
    async review(keys: string[] | "all", verdict: "accept" | "reject") {
      host.calls.push(["review", { keys, verdict }]);
      host.view = {
        ...host.view,
        fields: host.view.fields.map((f) =>
          f.state === "proposed" && (keys === "all" || keys.includes(f.key)) ? { ...f, state: verdict === "accept" ? "accepted" : "empty", value: verdict === "accept" ? (f.proposed ?? null) : f.value, proposed: undefined } : f,
        ),
      };
      return host.view;
    },
    async setField(key: string, value: string | boolean | null) {
      host.calls.push(["setField", { key, value }]);
      host.view = { ...host.view, fields: host.view.fields.map((f) => (f.key === key ? { ...f, value, state: value === null ? "empty" : "accepted", proposed: undefined } : f)) };
      return host.view;
    },
    async mark(page: number, quads: unknown, text: string) {
      host.calls.push(["mark", { page, quads, text }]);
      return host.view;
    },
    async unmark(markId: string) {
      host.calls.push(["unmark", markId]);
      return host.view;
    },
    async mode(mode: "suggests" | "writes") {
      host.calls.push(["mode", mode]);
      host.view = { ...host.view, mode };
      return host.view;
    },
    async undo(writeId: string) {
      host.calls.push(["undo", writeId]);
      host.view = { ...host.view, written: undefined };
      return host.view;
    },
    async signature() {
      return saved;
    },
    async setSignature(signature: PdfSignature | null) {
      host.calls.push(["setSignature", signature]);
      saved = signature;
      host.view = { ...host.view, hasSignature: !!signature };
    },
    async sign(signed: boolean) {
      host.calls.push(["sign", signed]);
      host.view = { ...host.view, signed, fields: host.view.fields.map((f) => (f.type === "signature" ? { ...f, state: signed ? "accepted" : "needs-owner" } : f)) };
      return host.view;
    },
    async export() {
      host.calls.push(["export", null]);
      return { name: host.view.name, size: 0, warnings: [] };
    },
    onView(listener: (view: PdfView) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return host;
}
