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
const FRAMES_READY = `${FRAMES_SHOWN} && ${FRAMES}.every((f) => !f.contentDocument.querySelector("img[data-pic-held]"))`;
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
  { name: "reader-files", set: opened("c-bios") },
  { name: "reader-plain-quotes", set: opened("c-frontdesk") },
  { name: "reader-inline", set: opened("c-logo"), ready: FRAMES_READY },
  { name: "reader-arabic", set: opened("c-arabic"), ready: FRAMES_READY },
  { name: "reply", set: then(opened("c-invoice"), press("[data-mail-pane] button.mail-reply-row")), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  { name: "new-mail", set: async (page) => void (await page.eval(`window.__mail.compose({ open: { kind: "new" }, full: true })`)), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  { name: "held-draft", set: async (page) => void (await page.eval(`window.__mail.compose({ open: { kind: "row", id: "c-held" }, full: true })`)), ready: `document.querySelector("[aria-label=Compose] .tiptap")` },
  { name: "settings", query: "page=settings", ready: `document.querySelector("h2")?.textContent === "Mail" && document.querySelectorAll("h3").length === 4` },
  { name: "settings-signature", query: "page=settings", set: press("section:nth-of-type(3) button.group\\/row"), ready: `document.querySelector("[role=dialog] .tiptap")` },
  { name: "settings-account", query: "page=settings", set: press("section:nth-of-type(4) button.group\\/row"), ready: `document.querySelector("[role=dialog]")` },
  { name: "list", ready: `document.querySelectorAll("[data-mail-list] li").length > 5` },
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
      if (scene.name !== "loading" && !scene.query?.includes("page=")) await page.until(`document.querySelector("[data-mail-list] li")`, "the list");
      await scene.set?.(page);
      if (scene.ready) await page.until(scene.ready, `${scene.name} to settle`);
      // Pictures land a turn after their frame; a shot waits for them.
      await page.wait(scene.name === "loading" ? 60 : 500);
      await page.shot(join(dir, `${scene.name}.${theme}.${width}.png`));
      await page.send("Page.close").catch(() => {});
    }
  }
}
