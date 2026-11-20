import { loadavg } from "node:os";
import type { Chromium, Page } from "work-kit/mail/proof";

/**
 * The list's speed on the dummy corpus, in a real Chromium (docs/agents/work-mail.md "Proving it").
 * Two questions. Does a mailbox of 5,000 threads first paint within a frame (16ms) of one of 50?
 * And does scrolling through all 5,000, once loaded, leave any task over 50ms? The two sizes are
 * run turn about (50, 5,000, 50, 5,000, …) so both see the same load, and the median is the answer;
 * run it pinned to a few cores (`taskset -c 0-3 bun scripts/mail-preview.ts --speed`).
 */

const ROW = "[data-mail-list] [role=option]";

/** Marks, from inside the page, the first frame in which the list's rows are on it. */
const WATCH = `(() => {
  const tick = () => {
    if (document.querySelector(${JSON.stringify(ROW)})) {
      // The frame after the rows are in the document is the one that painted them.
      requestAnimationFrame(() => (window.__rowsAt = performance.now()));
    } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Milliseconds from the dummy mail being ready to the frame that painted the list's first rows, with `threads` in the inbox. */
async function firstPaint(browser: Chromium, url: string, threads: number): Promise<number> {
  const page = await browser.page(1280, 800);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
  // The corpus's own inbox is thirteen threads; the rest are generated.
  await page.goto(`${url}?theme=dark&threads=${Math.max(0, threads - 13)}`);
  await page.until("window.__rowsAt", "the list's first rows");
  // From the moment the dummy mail exists: making 5,000 invented threads is the fixture's cost, not the list's.
  const at = await page.eval<number>("window.__rowsAt - window.__mailBuiltAt");
  await page.send("Page.close").catch(() => {});
  return at;
}

export interface Speed {
  runs: number;
  small: { threads: number; median: number; all: number[] };
  large: { threads: number; median: number; all: number[] };
  /** How much later the large list first paints, by the medians. */
  over: number;
  scroll: { rows: number; drawn: number; wheels: number; longTasks: number[]; worstFrame: number; frames: number };
  load: number[];
}

/** Loads every page of the open mailbox, then scrolls through it with the wheel and reports what stalled. */
async function scrollThrough(page: Page, rows: number): Promise<Speed["scroll"]> {
  const SCROLLER = `document.querySelector(${JSON.stringify("[data-mail-list] .mail-scroll")})`;
  const total = `Number(document.querySelector(${JSON.stringify(ROW)})?.getAttribute("aria-setsize") ?? 0)`;
  // Each visit to the foot asks for the next fifty.
  for (let i = 0; i < 400 && (await page.eval<number>(total)) < rows; i++) {
    await page.eval(`${SCROLLER}.scrollTop = ${SCROLLER}.scrollHeight`);
    await page.wait(20);
  }
  const loaded = await page.eval<number>(total);
  await page.eval(`${SCROLLER}.scrollTop = 0`);
  await page.wait(300);
  await page.eval(`(() => {
    window.__long = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)); }).observe({ entryTypes: ["longtask"] });
    window.__frames = [];
    let last = performance.now();
    const tick = (now) => { window.__frames.push(now - last); last = now; window.__ticking && requestAnimationFrame(tick); };
    window.__ticking = true;
    requestAnimationFrame(tick);
  })()`);
  const at = await page.centre(ROW);
  const wheels = 400;
  // A hard scroll: 1,200px a turn of the wheel, a turn each frame, down through the whole list and back.
  for (let i = 0; i < wheels; i++) {
    await page.wheel(at?.x ?? 150, at?.y ?? 300, i < wheels * 0.75 ? 1200 : -3600);
    await page.wait(16);
  }
  await page.wait(200);
  const out = await page.eval<{ long: number[]; frames: number[]; drawn: number }>(`(() => { window.__ticking = false; return { long: window.__long, frames: window.__frames.slice(2), drawn: document.querySelectorAll(${JSON.stringify(ROW)}).length } })()`);
  return { rows: loaded, drawn: out.drawn, wheels, longTasks: out.long, worstFrame: Math.round(Math.max(0, ...out.frames)), frames: out.frames.length };
}

export async function runSpeed(browser: Chromium, url: string, runs = 7): Promise<Speed> {
  const small: number[] = [];
  const large: number[] = [];
  // One of each first, thrown away: the first page of a fresh browser pays for the browser.
  await firstPaint(browser, url, 50);
  await firstPaint(browser, url, 5000);
  for (let i = 0; i < runs; i++) {
    small.push(await firstPaint(browser, url, 50));
    large.push(await firstPaint(browser, url, 5000));
  }
  const page = await browser.page(1280, 800);
  await page.goto(`${url}?theme=dark&threads=4987`);
  await page.until(`document.querySelector(${JSON.stringify(ROW)})`, "the list");
  const scroll = await scrollThrough(page, 5000);
  await page.send("Page.close").catch(() => {});
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    runs,
    small: { threads: 50, median: round(median(small)), all: small.map(round) },
    large: { threads: 5000, median: round(median(large)), all: large.map(round) },
    over: round(median(large) - median(small)),
    scroll,
    load: loadavg().map(round),
  };
}
