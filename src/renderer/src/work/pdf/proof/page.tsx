// The proof page (browser.proof.test.ts, run.ts): the PDF kind's Body and Bar
// with the real pdf.js engine, in headless Chrome, on a file the runner
// serves by range. It exposes `window.__proof` for the runner to drive over
// CDP; nothing here is part of the app.
import { createRoot } from "react-dom/client";
import type { CanvasItem, CanvasKind } from "@shared/work";
import type { CanvasBodyProps, CanvasShell } from "../../canvas/kind";
import { installCiteClicks, type CiteHost } from "../cite";
import { pdfjsEngine, type PdfDoc, type PdfEngine } from "../engine";
import type { PdfHost } from "../item";
import { navOf } from "../nav";
import { Bar, Body } from "../PdfCanvas";
import { fakePdfHost, pdfView } from "../testkit";
import { Body as SlidesBody } from "../../slides/SlidesCanvas";
import { deckView, fakeDeckHost } from "../../slides/testkit";

const shell: CanvasShell = {
  review: () => undefined,
  selection: () => undefined,
  presence: () => undefined,
  mode: () => undefined,
  statusLine: () => undefined,
  written: () => undefined,
  detail: () => undefined,
  openHistory: () => undefined,
  held: () => undefined,
};

/** The bytes the host has handed the engine, and when. */
const reads = { bytes: 0, calls: 0, full: 0, openedAt: 0, bytesAtOpen: 0, readsAtOpen: 0, log: [] as Array<[at: number, offset: number, length: number]> };
/** When the one link is free again: reads share its bandwidth, as they share the host's socket. */
let busyUntil = 0;
/** The real engine, its doc kept so the runner can ask pdf.js for a page's words. */
let opened: PdfDoc | null = null;
const engine: PdfEngine = {
  open: async (file) => {
    opened = await pdfjsEngine.open(file);
    Object.assign(reads, { openedAt: performance.now(), bytesAtOpen: reads.bytes, readsAtOpen: reads.calls });
    return opened;
  },
};

/** `perRead` ms and `perMB` ms a megabyte: the host link's pace, so a read is not free as it is on loopback. */
function rangeHost(url: string, size: number, itemId: string, name: string, pace: { perRead: number; perMB: number }): PdfHost {
  const host = fakePdfHost(pdfView({ itemId, name, size, rev: "proof" }));
  host.read = async (_which, offset, length) => {
    const end = Math.min(size, offset + length) - 1;
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (res.status !== 206) throw new Error(`range read answered ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    busyUntil = Math.max(performance.now(), busyUntil) + pace.perRead + (bytes.length / 1_048_576) * pace.perMB;
    await new Promise((done) => setTimeout(done, busyUntil - performance.now()));
    reads.log.push([Math.round(performance.now()), offset, bytes.length]);
    reads.bytes += bytes.length;
    if (reads.bytes >= size && !reads.full) reads.full = performance.now();
    reads.calls++;
    return bytes;
  };
  return host;
}

const shown: string[] = [];
const citeHost: CiteHost = { environmentOf: () => "local", show: async (_env, sessionId, itemId) => void shown.push(`${sessionId}/${itemId}`) };

function mountPdf(options: { url: string; size: number; itemId: string; name: string; pace: { perRead: number; perMB: number } }): void {
  const item: CanvasItem = { id: options.itemId, sessionId: "proof", workspaceId: "ws", kind: "pdf" as CanvasKind, title: options.name, source: { at: "file", host: "local", path: `/proof/${options.name}` }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const host = rangeHost(options.url, options.size, options.itemId, options.name, options.pace);
  const props: CanvasBodyProps<undefined> = { item, source: item.source, env: "local", state: undefined, setState: () => undefined, shell };
  installCiteClicks(() => Promise.resolve(citeHost));
  createRoot(document.getElementById("root")!).render(
    <div className="flex h-full w-full">
      <section data-session-drop="proof" className="flex w-[340px] shrink-0 flex-col gap-3 border-r border-border p-4 text-sm" id="thread" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center border-b border-border px-2" data-proof-bar>
          <Bar {...props} host={host} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <Body {...props} host={host} engine={engine} />
        </div>
      </div>
    </div>,
  );
}

/** The slides canvas on a deck LibreOffice drew to a PDF, its pages read by range like the PDF's. */
function mountSlides(options: { url: string; size: number; pages: number }): void {
  const item: CanvasItem = { id: "proof-deck", sessionId: "proof", workspaceId: "ws", kind: "slides" as CanvasKind, title: "Spring showcase.pptx", source: { at: "file", host: "local", path: "/proof/Spring showcase.pptx" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const view = deckView({ itemId: item.id, sessionId: "proof", name: item.title, renders: { file: { rev: "proof", size: options.size, pages: options.pages }, proposed: null } });
  const host = fakeDeckHost(view);
  const pdf = rangeHost(options.url, options.size, item.id, item.title, { perRead: 0, perMB: 0 });
  host.read = (_which, offset, length) => pdf.read("file", offset, length);
  const props: CanvasBodyProps<undefined> = { item, source: item.source, env: "local", state: undefined, setState: () => undefined, shell };
  createRoot(document.getElementById("root")!).render(
    <div className="flex h-full w-full flex-col">
      <SlidesBody {...props} host={host} engine={pdfjsEngine} />
    </div>,
  );
}

declare global {
  interface Window {
    __proof: typeof proof;
  }
}

const proof = {
  t0: performance.now(),
  reads,
  shown,
  mountPdf,
  mountSlides,
  nav: navOf,
  doc: () => opened,
};
window.__proof = proof;
document.documentElement.dataset.proofReady = "1";
