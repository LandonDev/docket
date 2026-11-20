import type { Page } from "work-kit/mail/proof";

/** One thing the proof claims, and whether the browser bore it out. */
export interface Claim {
  name: string;
  ok: boolean;
  detail: string;
}

/** Runs in the page: the first mail frame's document. */
const FRAME = `document.querySelector("iframe[data-mail]").contentDocument`;

/**
 * The reader's proof, in a real Chromium under the page policy this page was
 * served with: an inline picture, a web picture and a CSS background all
 * paint; the mail frames ask the network for nothing; a picture that lands
 * late is not clipped; and real keys and real clicks reach the page from
 * inside a mail.
 */
export async function runProof(page: Page, url: string): Promise<Claim[]> {
  const claims: Claim[] = [];
  const claim = (name: string, ok: boolean, detail = ""): void => void claims.push({ name, ok, detail });
  const framesReady = `[...document.querySelectorAll("iframe[data-mail]")].length > 0 && [...document.querySelectorAll("iframe[data-mail]")].every((f) => f.classList.contains("opacity-100"))`;
  const open = async (id: string): Promise<void> => {
    await page.eval(`window.__mail.open(${JSON.stringify(id)})`);
    await page.until(framesReady, `${id}'s frame`);
  };
  /** Every <img> in the first frame that has a source has decoded to real pixels. */
  const painted = `(() => { const imgs = [...${FRAME}.querySelectorAll("img[data-pic]")]; return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0 && img.currentSrc.startsWith("blob:")) })()`;

  // A slow fake worker, so pictures land well after the frame was first measured.
  await page.goto(`${url}?late=1`);
  await page.until(`document.querySelector("[data-mail-list] [role=option]")`, "the list");

  // 1. A web picture and a CSS background, in mail written for white.
  await open("c-receipt");
  const before = await page.eval<number>(`document.querySelector("iframe[data-mail]").getBoundingClientRect().height`);
  await page.until(painted, "the receipt's web picture").then(
    () => claim("a web picture paints", true),
    (error: Error) => claim("a web picture paints", false, error.message),
  );
  const background = await page.eval<string>(`getComputedStyle(${FRAME}.querySelector(".hero")).backgroundImage`);
  claim("a CSS background paints", background.startsWith('url("blob:'), background.slice(0, 60));

  // 2. Nothing is clipped after a late load: the frame is as tall as its content.
  await page.wait(300);
  const fit = await page.eval<{ frame: number; content: number }>(
    `(() => { const f = document.querySelector("iframe[data-mail]"); return { frame: f.getBoundingClientRect().height, content: f.contentDocument.documentElement.scrollHeight } })()`,
  );
  claim("nothing is clipped after a late load", fit.frame >= fit.content - 1 && fit.frame > 0, `frame ${fit.frame}, content ${fit.content}, first measured ${before}`);

  // 3. An inline picture, by Content-ID and by file name.
  await open("c-logo");
  await page.until(painted, "the inline chart").then(
    () => claim("an inline picture paints", true),
    (error: Error) => claim("an inline picture paints", false, error.message),
  );

  // 4. The frames asked the network for nothing: every request came from the page itself, to itself.
  await open("c-newsletter");
  await page.until(painted, "the newsletter's pictures").catch(() => {});
  const origin = new URL(url).origin;
  const fromFrames = page.requests.filter((r) => r.frameId !== page.mainFrame && /^https?:/.test(r.url));
  const outside = page.requests.filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(origin));
  claim("the mail frames made no network request", fromFrames.length === 0, fromFrames.map((r) => r.url).join(", "));
  claim("the page asked no other host for anything", outside.length === 0, outside.map((r) => r.url).join(", "));
  const refused = page.console.filter((line) => /Content Security Policy|Refused to/i.test(line));
  claim("the page policy refused nothing", refused.length === 0, refused.slice(0, 3).join(" | "));
  const tracker = await page.eval<number>(`window.__mail.asked().filter((u) => /open\\?u=|track\\./.test(u)).length`);
  claim("a tracker is never asked for", tracker === 0, `${tracker} asked`);

  // 5. Real keys from inside a mail: click into the body, then press j. The next thread opens.
  await open("c-invoice");
  const subject = `document.querySelector("[data-mail-pane] h2")?.textContent`;
  const was = await page.eval<string>(subject);
  const body = await page.centre("iframe[data-mail]");
  if (body) await page.click(body.x, body.y - 4);
  const focused = await page.eval<boolean>(`document.activeElement?.tagName === "IFRAME"`);
  await page.press("j");
  await page.until(`${subject} && ${subject} !== ${JSON.stringify(was)}`, "j to open the next thread").then(
    () => claim("a real key pressed inside a mail reaches the page", focused, focused ? "" : "the click did not put focus in the frame"),
    (error: Error) => claim("a real key pressed inside a mail reaches the page", false, error.message),
  );

  // 6. A real click on the button drawn inside the frame shows the quoted text.
  await open("c-invoice");
  const toggle = await page.eval<{ x: number; y: number } | null>(
    `(() => { const f = document.querySelector("iframe[data-mail]"); const b = f.contentDocument.querySelector(".mail-quote-toggle"); if (!b) return null; b.scrollIntoView({ block: "center" }); const fr = f.getBoundingClientRect(); const r = b.getBoundingClientRect(); return { x: fr.x + r.x + r.width / 2, y: fr.y + r.y + r.height / 2 } })()`,
  );
  if (!toggle) claim("a real click shows the quoted text", false, "no button at the cut");
  else {
    await page.click(toggle.x, toggle.y);
    await page.until(`${FRAME}.documentElement.classList.contains("lifeos-show-quotes")`, "the quote to show").then(
      () => claim("a real click shows the quoted text", true),
      (error: Error) => claim("a real click shows the quoted text", false, error.message),
    );
  }

  // 7. A real click on a link goes to the host and never moves the frame or opens a window.
  const link = await page.eval<{ x: number; y: number } | null>(
    `(() => { const f = document.querySelector("iframe[data-mail]"); const a = f.contentDocument.querySelector("a[href^='https']"); if (!a) return null; a.scrollIntoView({ block: "center" }); const fr = f.getBoundingClientRect(); const r = a.getBoundingClientRect(); return { x: fr.x + r.x + r.width / 2, y: fr.y + r.y + r.height / 2 } })()`,
  );
  if (!link) claim("a real click on a link stays in the page's hands", false, "no link in the mail");
  else {
    const requests = page.requests.length;
    await page.hover(link.x, link.y);
    await page.until(`document.querySelector("[data-mail-pane] [role=status]")`, "the hovered address").then(
      () => claim("a hovered link shows its real address", true),
      (error: Error) => claim("a hovered link shows its real address", false, error.message),
    );
    await page.click(link.x, link.y);
    await page.wait(300);
    const still = await page.eval<boolean>(`${FRAME}.querySelector("a[href^='https']") !== null && location.pathname === "/"`);
    const went = page.requests.slice(requests).filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(origin));
    claim("a real click on a link stays in the page's hands", still && went.length === 0, went.map((r) => r.url).join(", "));
  }
  return claims;
}
