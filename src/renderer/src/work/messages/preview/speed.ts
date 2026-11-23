import { loadavg } from "node:os";
import type { Chromium, Page } from "work-kit/mail/proof";

/**
 * The view's speed on made-up conversations, in a real Chromium
 * (docs/agents/work-messages.md "Proving it"). Does a list of 2,000
 * conversations, and a conversation of 5,000 messages, first paint as soon as
 * the everyday ones? And does a hard scroll through each leave any task over
 * 50ms? The sizes are run turn about so both see the same load, and the
 * median is the answer; run it pinned to a few cores
 * (`taskset -c 0-3 bun scripts/messages-preview.ts --speed`).
 */

const ROW = "[role=listbox][aria-label=Conversations] [role=option]";
const MESSAGE = "[data-block]";

/** Marks, from inside the page, the first frame in which `selector` is on it. */
const watch = (selector: string): string => `(() => {
  const tick = () => {
    if (document.querySelector(${JSON.stringify(selector)})) requestAnimationFrame(() => (window.__paintedAt = performance.now()));
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (n: number): number => Math.round(n * 10) / 10;

/** Milliseconds from the page's script starting to the frame that painted `selector`, in `scene`. */
async function firstPaint(browser: Chromium, url: string, scene: string, selector: string): Promise<number> {
  const page = await browser.page(1280, 800);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: watch(selector) });
  await page.goto(`${url}?theme=dark&scene=${scene}`);
  await page.until("window.__paintedAt", `${scene}'s first rows`);
  const at = await page.eval<number>("window.__paintedAt - window.__builtAt");
  await page.send("Page.close").catch(() => {});
  return at;
}

export interface Scroll {
  drawn: number;
  wheels: number;
  longTasks: number[];
  worstFrame: number;
  frames: number;
  /** How far the scroller went, in px: a scroll that moved nothing proves nothing. */
  travelled: number;
}

/** A hard scroll with the wheel over `selector`'s scroller, there and back, and what stalled. */
async function scrollThrough(page: Page, selector: string, direction: 1 | -1): Promise<Scroll> {
  const SCROLLER = `(() => { let el = document.querySelector(${JSON.stringify(selector)}); while (el && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement; return el; })()`;
  await page.wait(300);
  await page.eval(`(() => {
    window.__long = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)); }).observe({ entryTypes: ["longtask"] });
    window.__frames = [];
    window.__from = ${SCROLLER}.scrollTop;
    window.__far = 0;
    let last = performance.now();
    const el = ${SCROLLER};
    const tick = (now) => { window.__frames.push(now - last); last = now; window.__far = Math.max(window.__far, Math.abs(el.scrollTop - window.__from)); window.__ticking && requestAnimationFrame(tick); };
    window.__ticking = true;
    requestAnimationFrame(tick);
  })()`);
  const at = await page.centre(selector);
  const wheels = 400;
  // 1,200px a turn of the wheel, a turn each frame: three quarters of the way out, then back three times as fast.
  for (let i = 0; i < wheels; i++) {
    await page.wheel(at?.x ?? 150, at?.y ?? 300, direction * (i < wheels * 0.75 ? 1200 : -3600));
    await page.wait(16);
  }
  await page.wait(200);
  const out = await page.eval<{ long: number[]; frames: number[]; drawn: number; far: number }>(`(() => { window.__ticking = false; return { long: window.__long, frames: window.__frames.slice(2), drawn: document.querySelectorAll(${JSON.stringify(selector)}).length, far: window.__far } })()`);
  return { drawn: out.drawn, wheels, longTasks: out.long, worstFrame: Math.round(Math.max(0, ...out.frames)), frames: out.frames.length, travelled: Math.round(out.far) };
}

export interface Speed {
  runs: number;
  list: { small: number; large: number; all: { small: number[]; large: number[] }; scroll: Scroll };
  open: { small: number; large: number; all: { small: number[]; large: number[] }; scroll: Scroll };
  load: number[];
}

async function pair(browser: Chromium, url: string, small: string, large: string, selector: string, runs: number) {
  const a: number[] = [];
  const b: number[] = [];
  // One of each first, thrown away: the first page of a fresh browser pays for the browser.
  await firstPaint(browser, url, small, selector);
  await firstPaint(browser, url, large, selector);
  for (let i = 0; i < runs; i++) {
    a.push(await firstPaint(browser, url, small, selector));
    b.push(await firstPaint(browser, url, large, selector));
  }
  return { small: round(median(a)), large: round(median(b)), all: { small: a.map(round), large: b.map(round) } };
}

export async function runSpeed(browser: Chromium, url: string, runs = 7): Promise<Speed> {
  const list = await pair(browser, url, "list", "heavy-list", ROW, runs);
  const open = await pair(browser, url, "open-direct", "heavy-open", MESSAGE, runs);
  const listPage = await browser.page(1280, 800);
  await listPage.goto(`${url}?theme=dark&scene=heavy-list`);
  await listPage.until(`document.querySelector(${JSON.stringify(ROW)})`, "the list");
  const listScroll = await scrollThrough(listPage, ROW, 1);
  await listPage.send("Page.close").catch(() => {});
  const openPage = await browser.page(1280, 800);
  await openPage.goto(`${url}?theme=dark&scene=heavy-open`);
  await openPage.until(`document.querySelector(${JSON.stringify(MESSAGE)})`, "the conversation");
  // The conversation opens at its foot: the hard scroll goes up through its history.
  const openScroll = await scrollThrough(openPage, MESSAGE, -1);
  await openPage.send("Page.close").catch(() => {});
  return { runs, list: { ...list, scroll: listScroll }, open: { ...open, scroll: openScroll }, load: loadavg().map(round) };
}
