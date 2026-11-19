// Runs the PDF canvas in headless Chrome with the real pdf.js and proves two
// of milestone 33's done-when lines: a 300-page PDF opens and searches, and a
// citation link lands on its clause. `bun src/renderer/src/work/pdf/proof/run.ts [outDir]`
// prints one JSON line (the result) and writes screenshots to outDir
// (default /tmp/m33-proof). browser.proof.test.ts runs it and checks the result.
//
// Node APIs only (it is typechecked with the renderer), run under Bun for the
// global WebSocket that drives Chrome over CDP.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { build, type Plugin } from "esbuild";
import { PDFDocument, StandardFonts, grayscale } from "pdf-lib";

const root = resolve(import.meta.dirname, "../../../../../..");
const renderer = join(root, "src/renderer/src");
const out = resolve(process.argv[2] ?? "/tmp/m33-proof");

export const PAGES = 300;
export const FIND = "insurance certificate";
export const FIND_PAGES = [5, 155, 287];
export const CITE_PAGE = 212;
export const CLAUSE = ["7.2 Cancellation. If Licensee cancels after March 1, 2027, Purdue keeps", "the deposit, and the balance stated in Schedule B falls due at once."];
const ITEM = "proof-pdf";
/** The host link's pace for reads: 20 ms each and 50 ms a megabyte (20 MB/s), so range reading shows. */
export const PACE = { perRead: 20, perMB: 50 };

// ── the file ─────────────────────────────────────────────────────────

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
/** A grey noise PNG that does not compress: each page's "scan", so the file is big enough for range reads to show. */
function noisePng(size: number, seed: number): Uint8Array {
  let s = Math.imul(seed, 2654435761) >>> 0;
  const rows = Buffer.alloc(size * (size + 1));
  for (let i = 0; i < rows.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    rows[i] = i % (size + 1) === 0 ? 0 : 150 + (s >>> 25);
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

const WORDS = "the licensee shall provide staff seating power network access during the event and return the hall in the condition it was found with all furniture and fittings in place".split(" ");
/**
 * `objectStreams`: the page dicts packed together, as most writers do today.
 * Without them (pdf-lib's classic xref) each page's dict sits beside its own
 * picture, so a walk of the page tree reads the whole file a chunk at a time.
 */
export async function makePdf(objectStreams: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  for (let n = 1; n <= PAGES; n++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Event planning guide 2027`, { x: 72, y: 740, size: 9, font, color: grayscale(0.4) });
    page.drawText(`Section ${Math.ceil(n / 10)}. Page ${n}`, { x: 72, y: 712, size: 15, font: bold });
    const scan = await pdf.embedPng(noisePng(300, n));
    page.drawImage(scan, { x: 430, y: 600, width: 110, height: 110 });
    let y = 680;
    for (let line = 0; line < 46; line++) {
      if (FIND_PAGES.includes(n) && line === 20) {
        page.drawText(`Insurance certificate: deliver it to the venue fourteen days before load in.`, { x: 72, y, size: 10.5, font: bold });
      } else if (n === CITE_PAGE && (line === 24 || line === 25)) {
        page.drawText(CLAUSE[line - 24], { x: 72, y, size: 10.5, font: bold });
      } else {
        const words = Array.from({ length: 14 }, (_, i) => WORDS[(n * 7 + line * 13 + i * 5) % WORDS.length]);
        page.drawText(`${words.join(" ")}.`, { x: 72, y, size: 10.5, font });
      }
      y -= 13;
    }
  }
  return pdf.save({ useObjectStreams: objectStreams });
}

// ── the page ─────────────────────────────────────────────────────────

const aliases: Plugin = {
  name: "proof-aliases",
  setup(b) {
    const map: Array<[RegExp, string]> = [
      [/^@renderer\//, `${renderer}/`],
      [/^@aliax\//, `${renderer}/aliax/`],
      [/^@server\/shared\//, `${root}/src/shared/`],
      [/^@shared\//, `${root}/src/shared/`],
    ];
    b.onResolve({ filter: /^@(renderer|aliax|server\/shared|shared)\// }, async (args) => {
      const [re, to] = map.find(([re]) => re.test(args.path))!;
      return b.resolve(args.path.replace(re, to), { kind: args.kind, resolveDir: args.resolveDir });
    });
    // Vite's `?worker`: pdf.js's worker is served beside the bundle and started as a module worker.
    b.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: "proof-worker" }));
    b.onLoad({ filter: /.*/, namespace: "proof-worker" }, (args) => ({
      contents: /pdf\.worker/.test(args.path) ? `export default class extends Worker { constructor() { super("/pdf.worker.min.mjs", { type: "module" }); } }` : `export default class { postMessage() {} terminate() {} addEventListener() {} }`,
      loader: "js",
    }));
    b.onResolve({ filter: /\?(raw|url|inline)$/ }, (args) => ({ path: args.path, namespace: "proof-empty" }));
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "proof-empty" }));
    b.onLoad({ filter: /.*/, namespace: "proof-empty" }, () => ({ contents: `export default ""`, loader: "js" }));
  },
};

async function bundle(dir: string): Promise<void> {
  await build({
    entryPoints: [join(import.meta.dirname, "page.tsx")],
    bundle: true,
    format: "esm",
    outfile: join(dir, "page.js"),
    jsx: "automatic",
    target: "chrome130",
    plugins: [aliases],
    loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }) },
    logLevel: "error",
  });
}

async function css(): Promise<string> {
  const { compile } = await import("@tailwindcss/node");
  const { Scanner } = await import("@tailwindcss/oxide");
  const path = join(renderer, "index.css");
  const compiler = await compile(readFileSync(path, "utf8"), { base: renderer, onDependency: () => undefined });
  return compiler.build(new Scanner({ sources: [{ base: join(root, "src/renderer"), pattern: "**/*", negated: false }, ...compiler.sources] }).scan());
}

function serve(dir: string, pdfs: Record<string, Uint8Array>): Promise<{ server: Server; port: number }> {
  const files: Record<string, [string, string]> = {
    "/": [join(dir, "index.html"), "text/html"],
    "/page.js": [join(dir, "page.js"), "text/javascript"],
    "/app.css": [join(dir, "app.css"), "text/css"],
    "/pdf.worker.min.mjs": [join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), "text/javascript"],
  };
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const pdf = pdfs[url];
    if (pdf) {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (!m) return void res.writeHead(200, { "content-length": pdf.length }).end(Buffer.from(pdf));
      const from = Number(m[1]);
      const to = Math.min(pdf.length - 1, Number(m[2]));
      res.writeHead(206, { "content-range": `bytes ${from}-${to}/${pdf.length}`, "content-length": to - from + 1 });
      return void res.end(Buffer.from(pdf.subarray(from, to + 1)));
    }
    const file = files[url];
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": file[1] }).end(readFileSync(file[0]));
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, port: (server.address() as { port: number }).port })));
}

// ── Chrome ───────────────────────────────────────────────────────────

export function chromePath(): string | null {
  if (process.env.TEMP_CODE_CHROME) return existsSync(process.env.TEMP_CODE_CHROME) ? process.env.TEMP_CODE_CHROME : null;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const build of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const binary = join(cache, build, "chrome-headless-shell-linux64/chrome-headless-shell");
    if (existsSync(binary)) return binary;
  }
  return null;
}

interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  eval<T>(expression: string): Promise<T>;
  close(): void;
}

async function launch(chrome: string, profile: string): Promise<{ proc: ChildProcess; cdp: Cdp }> {
  const proc = spawn(chrome, ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  if (!existsSync(portFile)) throw new Error("Chrome did not open its debugging port");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => ((ws.onopen = done), (ws.onerror = fail)));
  let id = 0;
  const waiting = new Map<number, { done(v: unknown): void; fail(e: Error): void }>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { exceptionDetails?: { text: string; exception?: { description?: string } } } };
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? "exception");
    if (msg.id === undefined) return;
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.fail(new Error(msg.error.message));
    else w?.done(msg.result);
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((done, fail) => {
      waiting.set(++id, { done: done as (v: unknown) => void, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const cdp: Cdp = {
    send,
    async eval<T>(expression: string) {
      const got = await send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (got.exceptionDetails) throw new Error(`${got.exceptionDetails.exception?.description ?? got.exceptionDetails.text}\npage errors: ${errors.join("\n")}`);
      return got.result.value;
    },
    close: () => ws.close(),
  };
  return { proc, cdp };
}

async function waitFor<T>(cdp: Cdp, what: string, expression: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    const got = await cdp.eval<T | null>(expression);
    if (got) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function shot(cdp: Cdp, name: string): Promise<string> {
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const path = join(out, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

/** Ink on a page's picture: its canvas drawn into a scratch one (works whether pdf.js kept the canvas or sent it to a worker). */
const INK = (page: number): string => `(() => {
  const c = document.querySelector('[data-pdf-page="${page}"] canvas');
  if (!c || !c.width) return null;
  const s = document.createElement('canvas'); s.width = c.width; s.height = c.height;
  const x = s.getContext('2d'); x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, s.width, s.height).data;
  let ink = 0; for (let i = 0; i < d.length; i += 4 * 3) if (d[i] < 128 && d[i + 3] > 0) ink++;
  return ink > 300 ? ink : null;
})()`;
const BAR = `document.querySelector('[data-proof-bar]').textContent`;
const PAGER = (page: number): string => `(${BAR}).replace(/\\s+/g, ' ').includes('${page} / ${PAGES}')`;
const NAV = `window.__proof.nav(${JSON.stringify(ITEM)})`;

/** Each rect's overlap with the other, as a share of its own area. */
function cover(a: Rect, b: Rect): { ofA: number; ofB: number } {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return { ofA: (w * h) / ((a.right - a.left) * (a.bottom - a.top)), ofB: (w * h) / ((b.right - b.left) * (b.bottom - b.top)) };
}
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ── the proofs ───────────────────────────────────────────────────────

export interface ProofResult {
  pages: number;
  pace: typeof PACE;
  open: Record<"packed" | "classic", { fileBytes: number; docOpenMs: number; bytesAtDocOpen: number; readsAtDocOpen: number; paintMs: number; bytesBeforePaint: number; readsBeforePaint: number; ink: number; pager: boolean; mountedPages: number; rail: boolean; railButtons: number; bytesWhenQuiet: number; readsWhenQuiet: number }>;
  find: { ms: number; hitPages: number[]; firstLanded: number; stepMs: number; pager287: boolean; currentOn287: number; hitOverWordsShare: number };
  cite: { href: string; clauseBox: number[]; ms: number; scrolledTo: number; pageInView: boolean; citeOnPage: boolean; citeCoversClause: number; clauseCoversCite: number; hashUntouched: boolean; shown: string[]; inkOnCitedPage: number };
  /** With M33_DECK_PDF (a 12-slide deck LibreOffice drew to PDF): the slides canvas's strip and stage on it. */
  slides?: { stripPictures: number; stageInk: number; ms: number };
  shots: string[];
  pageErrors: string[];
}

type OpenResult = ProofResult["open"]["packed"];

/** Loads the proof page, mounts the PDF at `url`, and times page 1's paint against the bytes read. */
async function openPdf(cdp: Cdp, port: number, url: string, size: number): Promise<OpenResult & { t0: number }> {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await waitFor(cdp, "the proof page", `document.documentElement?.dataset.proofReady === "1" && !window.__proof.reads.calls`);
  const t0 = await cdp.eval<number>(`(window.__proof.mountPdf({ url: ${JSON.stringify(url)}, size: ${size}, itemId: ${JSON.stringify(ITEM)}, name: "Event planning guide 2027.pdf", pace: ${JSON.stringify(PACE)} }), performance.now())`);
  const painted = await waitFor<{ ink: number; bytes: number; calls: number; t: number }>(cdp, "page 1 to paint", `(() => { const ink = ${INK(1)}; return ink ? { ink, bytes: window.__proof.reads.bytes, calls: window.__proof.reads.calls, t: performance.now() } : null })()`, 60_000);
  const pager = await waitFor<boolean>(cdp, "the pager", PAGER(1));
  const layout = await cdp.eval<{ mounted: number; rail: boolean; railButtons: number; openedAt: number; bytesAtOpen: number; readsAtOpen: number }>(`({ mounted: document.querySelectorAll('[data-pdf-page]').length, rail: !!document.querySelector('[data-pdf-rail]'), railButtons: document.querySelectorAll('[data-pdf-rail] button').length, openedAt: window.__proof.reads.openedAt, bytesAtOpen: window.__proof.reads.bytesAtOpen, readsAtOpen: window.__proof.reads.readsAtOpen })`);
  // Then the reads after the paint: pdf.js's own fetching ahead, until it goes quiet for 1.5 s (or 20 s pass).
  const settled = await waitFor<{ bytes: number; calls: number }>(cdp, "the reads to go quiet", `(() => { const l = window.__proof.reads.log; const last = l.length ? l[l.length - 1][0] : 0; return performance.now() - last > 1500 || performance.now() - ${t0} > 20000 ? { bytes: window.__proof.reads.bytes, calls: window.__proof.reads.calls } : null })()`, 30_000);
  return {
    t0,
    fileBytes: size,
    docOpenMs: Math.round(layout.openedAt - t0),
    bytesAtDocOpen: layout.bytesAtOpen,
    readsAtDocOpen: layout.readsAtOpen,
    paintMs: Math.round(painted.t - t0),
    bytesBeforePaint: painted.bytes,
    readsBeforePaint: painted.calls,
    ink: painted.ink,
    pager,
    mountedPages: layout.mounted,
    rail: layout.rail,
    railButtons: layout.railButtons,
    bytesWhenQuiet: settled.bytes,
    readsWhenQuiet: settled.calls,
  };
}

export async function runProof(): Promise<ProofResult> {
  const chrome = chromePath();
  if (!chrome) throw new Error("no headless Chrome: install Playwright's chrome-headless-shell or set TEMP_CODE_CHROME");
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "m33-proof-"));
  const packed = await makePdf(true);
  const classic = await makePdf(false);
  const deck = process.env.M33_DECK_PDF ? new Uint8Array(readFileSync(process.env.M33_DECK_PDF)) : null;
  writeFileSync(join(out, "guide-300.pdf"), packed);
  writeFileSync(join(dir, "app.css"), await css());
  await bundle(dir);
  writeFileSync(join(dir, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body,#root{height:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>`);
  const { server, port } = await serve(dir, { "/packed.pdf": packed, "/classic.pdf": classic, ...(deck ? { "/deck.pdf": deck } : {}) });
  const { proc, cdp } = await launch(chrome, join(dir, "profile"));
  const shots: string[] = [];
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // 1. Open: the file of packed page dicts (the proofs run on), then the classic one, each on a fresh page.
    const opened = await openPdf(cdp, port, "/packed.pdf", packed.length);
    shots.push(await shot(cdp, "1-open-page-1"));
    const { t0: _p, ...packedOpen } = opened;

    // 2. Find: the known pages, exactly; step to 287.
    const f0 = await cdp.eval<number>(`(${NAV}.query(${JSON.stringify(FIND)}), performance.now())`);
    const found = await waitFor<{ pages: number[]; t: number }>(cdp, "find to finish", `(() => { const f = ${NAV}.get().find; return !f.searching && f.hits.length ? { pages: f.hits.map((h) => h.page), t: performance.now() } : null })()`, 60_000);
    const firstLanded = await waitFor<number>(cdp, "the first hit", `document.querySelector('[data-pdf-page="5"] [data-pdf-hit="current"]') ? ${NAV}.get().page : null`);
    const s0 = await cdp.eval<number>(`(${NAV}.step(1), ${NAV}.step(1), performance.now())`);
    const landed = await waitFor<{ t: number; n: number }>(cdp, "the hit on 287", `(() => { const n = document.querySelectorAll('[data-pdf-page="287"] [data-pdf-hit="current"]').length; return n && ${PAGER(287)} && ${INK(287)} ? { n, t: performance.now() } : null })()`);
    // The current hit's box is over pdf.js's own text-layer span for those words.
    await waitFor(cdp, "page 287's text layer", `[...document.querySelectorAll('[data-pdf-page="287"] [data-pdf-text] span')].some((s) => s.textContent.includes('Insurance certificate'))`);
    const hitRects = await cdp.eval<{ hit: Rect; words: Rect }>(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };
      const span = [...document.querySelectorAll('[data-pdf-page="287"] [data-pdf-text] span')].find((s) => s.textContent.includes('Insurance certificate'));
      const range = document.createRange(); const t = span.firstChild; const at = t.textContent.indexOf('Insurance certificate');
      range.setStart(t, at); range.setEnd(t, at + 'Insurance certificate'.length);
      const w = range.getBoundingClientRect();
      return { hit: r(document.querySelector('[data-pdf-page="287"] [data-pdf-hit="current"]')), words: { left: w.left, top: w.top, right: w.right, bottom: w.bottom } };
    })()`);
    shots.push(await shot(cdp, "2-find-on-287"));
    await cdp.eval(`${NAV}.closeFind()`);

    // 3. A citation: the clause's box from pdf.js's words, a real click on the link, the page and the mark.
    const runs = await cdp.eval<Array<{ str: string; box: number[] }>>(`window.__proof.doc().text(${CITE_PAGE})`);
    const clauseRuns = runs.filter((run) => CLAUSE.some((line) => line.includes(run.str.trim()) && run.str.trim().length > 8));
    if (!clauseRuns.length) throw new Error(`pdf.js found no clause runs on page ${CITE_PAGE}`);
    const union = [Math.min(...clauseRuns.map((r) => r.box[0])), Math.min(...clauseRuns.map((r) => r.box[1])), Math.max(...clauseRuns.map((r) => r.box[2])), Math.max(...clauseRuns.map((r) => r.box[3]))];
    const thou = [Math.floor(union[0] * 1000), Math.floor(union[1] * 1000), Math.ceil(union[2] * 1000), Math.ceil(union[3] * 1000)];
    const href = `#pdf:${ITEM}:${CITE_PAGE}:${thou.join(",")}`;
    await cdp.eval(`(() => { const p = document.createElement('p'); p.innerHTML = 'The cancellation terms are in <a href="${href}" class="text-(--link) underline">p. ${CITE_PAGE}, clause 7.2</a>.'; document.getElementById('thread').append(p) })()`);
    const link = await cdp.eval<{ x: number; y: number }>(`(() => { const b = document.querySelector('#thread a').getClientRects()[0]; return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`);
    const c0 = await cdp.eval<number>(`performance.now()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: link.x, y: link.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    const cited = await waitFor<{ t: number; page: number }>(cdp, "the citation to land", `(() => document.querySelector('[data-pdf-page="${CITE_PAGE}"] [data-pdf-cite]') && ${INK(CITE_PAGE)} && [...document.querySelectorAll('[data-pdf-page="${CITE_PAGE}"] [data-pdf-text] span')].some((s) => s.textContent.includes('7.2 Cancellation')) ? { t: performance.now(), page: ${NAV}.get().page } : null)()`);
    await new Promise((r) => setTimeout(r, 400));
    const landedCite = await cdp.eval<{ cite: Rect; clause: Rect; column: Rect; hash: string; shown: string[]; ink: number }>(`(() => {
      const r = (b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
      const spans = [...document.querySelectorAll('[data-pdf-page="${CITE_PAGE}"] [data-pdf-text] span')].filter((s) => ${JSON.stringify(CLAUSE)}.some((l) => s.textContent.trim().length > 8 && l.includes(s.textContent.trim())));
      const bs = spans.map((s) => s.getBoundingClientRect());
      return {
        cite: r(document.querySelector('[data-pdf-page="${CITE_PAGE}"] [data-pdf-cite]').getBoundingClientRect()),
        clause: { left: Math.min(...bs.map((b) => b.left)), top: Math.min(...bs.map((b) => b.top)), right: Math.max(...bs.map((b) => b.right)), bottom: Math.max(...bs.map((b) => b.bottom)) },
        column: r(document.querySelector('[data-pdf-column]').getBoundingClientRect()),
        hash: location.hash, shown: window.__proof.shown, ink: ${INK(CITE_PAGE)},
      };
    })()`);
    shots.push(await shot(cdp, "3-cite-p212"));
    const { t0: _c, ...classicOpen } = await openPdf(cdp, port, "/classic.pdf", classic.length);
    let slides: ProofResult["slides"];
    if (deck) {
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await waitFor(cdp, "the proof page", `document.documentElement?.dataset.proofReady === "1" && !window.__proof.reads.calls`);
      const d0 = await cdp.eval<number>(`(window.__proof.mountSlides({ url: "/deck.pdf", size: ${deck.length}, pages: 12 }), performance.now())`);
      const inked = (sel: string): string => `[...document.querySelectorAll('${sel}')].filter((c) => { const s = document.createElement('canvas'); s.width = c.width; s.height = c.height; if (!c.width) return false; const x = s.getContext('2d'); x.drawImage(c, 0, 0); const d = x.getImageData(0, 0, s.width, s.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 5) if (d[i] + d[i + 1] + d[i + 2] < 600) n++; return n > 5; }).length`;
      const got = await waitFor<{ strip: number; stage: number; t: number }>(cdp, "the deck to paint", `(() => { const all = ${inked("canvas")}; const big = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 400).length; const strip = all - big; const stage = big; return strip >= 12 && stage >= 1 ? { strip, stage, t: performance.now() } : null })()`, 30_000);
      await new Promise((r) => setTimeout(r, 300));
      shots.push(await shot(cdp, "4-slides-twelve"));
      slides = { stripPictures: got.strip, stageInk: got.stage, ms: Math.round(got.t - d0) };
    }
    const overlap = cover(landedCite.cite, landedCite.clause);
    const inView = landedCite.cite.top >= landedCite.column.top && landedCite.cite.bottom <= landedCite.column.bottom;
    return {
      pages: PAGES,
      pace: PACE,
      open: { packed: packedOpen, classic: classicOpen },
      find: { ms: Math.round(found.t - f0), hitPages: found.pages, firstLanded, stepMs: Math.round(landed.t - s0), pager287: true, currentOn287: landed.n, hitOverWordsShare: Number(cover(hitRects.words, hitRects.hit).ofA.toFixed(3)) },
      cite: { href, clauseBox: union.map((n) => Number(n.toFixed(4))), ms: Math.round(cited.t - c0), scrolledTo: cited.page, pageInView: inView, citeOnPage: true, citeCoversClause: Number(overlap.ofB.toFixed(3)), clauseCoversCite: Number(overlap.ofA.toFixed(3)), hashUntouched: landedCite.hash === "", shown: landedCite.shown, inkOnCitedPage: landedCite.ink },
      slides,
      shots,
      pageErrors: [],
    };
  } catch (error) {
    shots.push(await shot(cdp, "failed").catch(() => ""));
    const state = await cdp.eval(`({ page: ${NAV}.get().page, cites: [...document.querySelectorAll('[data-pdf-cite]')].map((c) => c.closest('[data-pdf-page]')?.dataset.pdfPage), mounted: [...document.querySelectorAll('[data-pdf-page]')].map((p) => p.dataset.pdfPage).join(','), hash: location.hash, shown: window.__proof.shown, scrollTop: document.querySelector('[data-pdf-column]')?.scrollTop, bar: ${BAR} })`).catch((e: Error) => e.message);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nstate: ${JSON.stringify(state)}`);
  } finally {
    cdp.close();
    proc.kill("SIGKILL");
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runProof().then(
    (result) => {
      writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      process.exit(0);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    },
  );
}
