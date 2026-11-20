import { join } from "node:path";
import type { Chromium, Page } from "work-kit/mail/proof";

/**
 * The review shots of Mail: one scene for each surface the design names, each
 * shot dark and light, at 1280 by 800 and 640 by 800. A scene is an address
 * (the fixture client's settings) and what to do once the page stands.
 */

export interface Scene {
  name: string;
  /** Added to the page's address. */
  query?: string;
  /** Runs once the list has drawn, to open what the scene shows. */
  set?: (page: Page) => Promise<void>;
  /** True once the scene has settled and can be shot. */
  ready?: string;
}

/** Every mail frame on the page has been measured and shown, and every picture it may show has landed. */
const FRAMES = `[...document.querySelectorAll("iframe[data-mail]")]`;
const FRAMES_SHOWN = `${FRAMES}.length > 0 && ${FRAMES}.every((f) => f.classList.contains("opacity-100"))`;
/** Every picture among a mail's files shows itself in its chip's tile (the reader fetches them as the mail opens). */
const TILES_READY = `[...document.querySelectorAll("[data-mail-pane] button[aria-label^='View ']")].every((b) => b.querySelector("img"))`;
const FRAMES_READY = `${FRAMES_SHOWN} && ${FRAMES}.every((f) => !f.contentDocument.querySelector("img[data-pic-held]")) && ${TILES_READY}`;
/** A real click on the first element the selector finds, once it is there. */
const press = (selector: string) => async (page: Page) => {
  await page.until(`document.querySelector(${JSON.stringify(selector)})`, selector);
  // The thread is still settling as its frames are measured: press where the control comes to rest.
  await page.until(FRAMES_SHOWN.replace(".length > 0 &&", ".length >= 0 &&"), "the frames");
  await page.wait(250);
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  const at = await page.centre(selector);
  if (at) await page.click(at.x, at.y);
};
const then =
  (...steps: ((page: Page) => Promise<void>)[]) =>
  async (page: Page) => {
    for (const step of steps) await step(page);
  };
/** A row of the list, and the list once its rows have drawn. */
const ROW = "[data-mail-list] [role=option]";
const ROWS = `document.querySelectorAll(${JSON.stringify(ROW)}).length > 5`;
/** The pointer over an element, so a row shows what it shows under it. */
function hover(selector: string) {
  return async (page: Page) => {
    await page.until(`document.querySelector(${JSON.stringify(selector)})`, selector);
    const at = await page.centre(selector);
    if (at) await page.hover(at.x, at.y);
  };
}
/** A real click, with the mod key held, on the nth row: it ticks the row. */
function tick(n: number) {
  return async (page: Page) => {
    const at = await page.centre(`${ROW}:nth-of-type(${n})`);
    if (at) await page.click(at.x, at.y, { meta: true });
    await page.wait(60);
  };
}
/** Words typed into the search field with real keys. */
function typed(text: string) {
  return async (page: Page) => {
    // The rows are on the page a moment before the page's key listener is: a person is never that quick.
    await page.wait(150);
    await page.press("/");
    await page.until(`document.activeElement?.getAttribute("aria-label") === "Search mail"`, "the search field");
    await page.type(text);
  };
}
/** A real click on the first element under `selector` whose words are exactly `text`. */
function pressText(selector: string, text: string) {
  const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;
  return async (page: Page) => {
    await page.until(find, `${text} in ${selector}`);
    await page.wait(400);
    const at = await page.eval<{ x: number; y: number }>(`(() => { const r = ${find}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`);
    await page.click(at.x, at.y);
  };
}
/** A real key, once the page's key listener is there. */
function keyed(key: string, modifiers: { shift?: boolean } = {}) {
  return async (page: Page) => {
    await page.wait(150);
    await page.press(key, modifiers);
  };
}
const opened = (id: string) => async (page: Page) => {
  await page.eval(`window.__mail.open(${JSON.stringify(id)})`);
  await page.until(`document.querySelector("[data-mail-pane] h2")`, "the thread's subject");
};

export const SCENES: Scene[] = [
  { name: "reader-designed", set: opened("c-receipt"), ready: FRAMES_READY },
  { name: "reader-pictures-held", query: "pictures=ask", set: opened("c-newsletter"), ready: FRAMES_SHOWN },
  { name: "reader-details", set: then(opened("c-receipt"), press("[data-mail-pane] [data-slot=popover-trigger]")), ready: `${FRAMES_READY} && document.querySelector("[data-slot=popover-content]")` },
  { name: "reader-more", set: then(opened("c-invoice"), press("[data-mail-pane] button[aria-label=More]")), ready: `document.querySelector("[role=menu]")` },
  { name: "reader-message-menu", set: then(opened("c-invoice"), press("[data-mail-pane] button[aria-label^='More for']")), ready: `document.querySelector("[role=menu]")` },
  { name: "viewer", set: then(opened("c-bios"), press("[data-mail-pane] button[aria-label^='View ana-portrait']")), ready: `document.querySelector("[role=dialog] img")` },
  { name: "thread", set: opened("c-invoice"), ready: FRAMES_READY },
  { name: "thread-six", set: opened("c-sitemap"), ready: FRAMES_READY },
  { name: "reader-files", set: opened("c-bios"), ready: `document.querySelector("[data-mail-pane] button[aria-label^='View ']") && ${TILES_READY}` },
  { name: "reader-plain-quotes", set: opened("c-frontdesk") },
  { name: "reader-inline", set: opened("c-logo"), ready: FRAMES_READY },
  { name: "reader-arabic", set: opened("c-arabic"), ready: FRAMES_READY },
  { name: "reply", set: then(opened("c-invoice"), press("[data-mail-pane] button.mail-reply-row")), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  { name: "new-mail", set: async (page) => void (await page.eval(`window.__mail.compose({ open: { kind: "new" }, full: true })`)), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  { name: "held-draft", set: async (page) => void (await page.eval(`window.__mail.compose({ open: { kind: "row", id: "c-held" }, full: true })`)), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  {
    name: "held-sending",
    set: then(
      async (page) => void (await page.eval(`window.__mail.compose({ open: { kind: "row", id: "c-held" }, full: true })`)),
      pressText("[aria-label=Compose] button", "Send"),
      // The draft speaks of an attachment and carries none, so Send asks once; this is the answer.
      pressText("[role=dialog] button", "Send"),
    ),
    ready: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Undo") && document.body.textContent.includes("Sending to")`,
  },
  { name: "settings", query: "page=settings", ready: `document.querySelector("h2")?.textContent === "Mail" && document.querySelectorAll("h3").length === 4` },
  { name: "settings-signature", query: "page=settings", set: press("section:nth-of-type(3) button.group\\/row"), ready: `document.querySelector("[role=dialog] .tiptap")` },
  { name: "settings-account", query: "page=settings", set: press("section:nth-of-type(4) button.group\\/row"), ready: `document.querySelector("[role=dialog]")` },
  { name: "invite", set: opened("c-invite"), ready: `${FRAMES_READY} && document.querySelector("[data-mail-pane] [aria-label=Invitation]")` },
  { name: "list", ready: ROWS },
  { name: "list-two-lines", query: "density=two", ready: ROWS },
  { name: "list-open", set: opened("c-invoice"), ready: FRAMES_READY },
  { name: "list-hover", set: hover(`${ROW}:nth-of-type(3)`), ready: ROWS },
  { name: "list-selected", set: then(tick(4), tick(6), tick(9)), ready: `document.querySelector("[data-mail-list]").textContent.includes("3 selected")` },
  { name: "list-menu", set: press("[data-mail-list] button[aria-haspopup=menu]"), ready: `document.querySelector("[role=menu]")` },
  { name: "list-search", set: typed("from:marisol has:attachment"), ready: `document.querySelector("[role=listbox][aria-label='Search results']")` },
  { name: "list-search-hint", set: typed("invoice ha"), ready: `[...document.querySelectorAll("[data-mail-list] button")].some((b) => b.textContent === "has:attachment")` },
  { name: "list-trash", query: "box=trash", set: opened("c-trashed"), ready: `document.querySelector("[data-mail-pane] h2")` },
  { name: "list-snoozed", query: "box=snoozed", ready: `document.querySelector(${JSON.stringify(ROW)})` },
  { name: "list-drafts", query: "box=drafts", ready: `document.querySelector("[data-mail-list] li")` },
  { name: "list-empty", query: "box=scheduled", ready: `document.querySelector("[data-mail-list]").textContent.includes("Nothing scheduled")` },
  { name: "keys", set: keyed("?", { shift: true }), ready: `document.querySelector("[role=dialog]")?.textContent.includes("Keyboard shortcuts")` },
  { name: "snooze", set: then(opened("c-invoice"), keyed("b")), ready: `document.querySelector("[role=dialog]")?.textContent.includes("Snooze until")` },
  { name: "loading", query: "late=1" },
];

const SIZES: [number, number][] = [
  [1280, 800],
  [640, 800],
];

export async function shoot(browser: Chromium, url: string, scene: Scene, dir: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    for (const [width, height] of SIZES) {
      const page = await browser.page(width, height);
      await page.goto(`${url}?theme=${theme}${scene.query ? `&${scene.query}` : ""}`);
      if (scene.name !== "loading" && !scene.query?.includes("page=") && !scene.query?.includes("box=")) await page.until(`document.querySelector(${JSON.stringify(ROW)})`, "the list");
      await scene.set?.(page);
      if (scene.ready) await page.until(scene.ready, `${scene.name} to settle`);
      // Pictures land a turn after their frame; a shot waits for them.
      await page.wait(scene.name === "loading" ? 60 : 500);
      await page.shot(join(dir, `${scene.name}.${theme}.${width}.png`));
      await page.send("Page.close").catch(() => {});
    }
  }
}
