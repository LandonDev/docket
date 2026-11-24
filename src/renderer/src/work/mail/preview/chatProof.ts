import { join } from "node:path";
import type { Page } from "work-kit/mail/proof";
import type { Claim } from "./proof";

/**
 * The chat beside the mail, by real pointer and key events in a real Chromium under the app's page policy, on the
 * fixture client (`?chat=1`, preview/chat.tsx): Ask opens the dock on the open mail with its subject in the head; ⌘L
 * closes and opens it; a draft card's Put in reply fills the reply box and nothing is sent; a triage card's press
 * archives exactly the ticked rows, once; Undo brings them back. A picture at each step into `dir`.
 */
export async function runChatProof(page: Page, url: string, dir: string, theme: "dark" | "light" = "dark"): Promise<Claim[]> {
  const claims: Claim[] = [];
  const claim = (name: string, ok: boolean, detail = ""): void => void claims.push({ name, ok, detail });
  const tag = (scope: string, text: string, as: string): Promise<boolean> =>
    page.eval<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute("aria-label") === ${JSON.stringify(text)}); if (!b) return false; b.setAttribute("data-proof", ${JSON.stringify(as)}); return true })()`);
  const press = async (selector: string): Promise<void> => {
    await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
    const at = await page.centre(selector);
    if (!at) throw new Error(`nothing at ${selector}`);
    await page.click(at.x, at.y);
  };
  const text = (selector: string): Promise<string> => page.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
  const calls = (): Promise<{ sends: unknown[]; batches: { ids: string[]; act: unknown }[] }> => page.eval(`JSON.parse(JSON.stringify(window.__mailChat.calls))`);
  const shot = (name: string): Promise<void> => page.shot(join(dir, `chat-${name}${theme === "light" ? ".light" : ""}.png`));
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const seen = await page.eval<string>(`JSON.stringify({ dock: document.querySelector("[data-mail-dock]")?.outerHTML.slice(0, 400) ?? null, seat: document.querySelector("[data-mail-dock-seat]")?.outerHTML.slice(0, 200) ?? null, errors: window.__mailChat?.errors ?? [] })`).catch(() => "");
      claim(name, false, `${(error as Error).message} ${seen}`);
    }
  };

  let countBefore = 0;
  await page.goto(`${url}?chat=1${theme === "light" ? "&theme=light" : ""}`);
  await page.until(`document.querySelector("[data-mail-list] [role=option]")`, "the list");

  // 1. Ask on an open mail: the dock, its head naming the mail.
  await step("Ask opens the dock on the open mail, its subject in the head", async () => {
    await page.eval(`window.__mail.open("c-invoice")`);
    await page.until(`[...document.querySelectorAll("[data-mail-pane] button")].some((b) => b.textContent.trim() === "Ask")`, "the reader's Ask");
    await tag("[data-mail-pane]", "Ask", "ask");
    await press("[data-proof=ask]");
    await page.until(`document.querySelector("[data-mail-dock] h3")?.textContent === "Re: Invoice 1042"`, "the dock's head", 10_000);
    claim("Ask opens the dock on the open mail, its subject in the head", true);
    await page.wait(400);
    await shot("ask");
  });

  // 2. ⌘L (Ctrl+L here) closes it and opens it again.
  await step("Cmd+L closes the dock and opens it again", async () => {
    await page.press("l", { ctrl: true });
    await page.until(`!document.querySelector("[data-mail-dock]")`, "the dock gone", 5_000);
    await page.press("l", { ctrl: true });
    await page.until(`!!document.querySelector("[data-mail-dock]")`, "the dock back", 10_000);
    claim("Cmd+L closes the dock and opens it again", true);
  });

  // 3. A draft card's Put in reply: the reply box holds the draft; nothing is sent.
  await step("Put in reply fills the reply box with the draft, and nothing is sent", async () => {
    await page.until(`document.querySelector("[data-chat-cards] [data-draft-state]")?.textContent === "Draft"`, "the draft card", 10_000);
    const rows = await text("[data-chat-cards] [data-recipients]");
    claim("the draft card names its recipient in full", rows.includes("marisol@riveradental.com"), rows);
    await tag("[data-chat-cards]", "Put in reply", "put");
    await press("[data-proof=put]");
    await page.until(`document.querySelector("[data-mail-pane]")?.innerText.includes("Invoice 1042 is attached again with PO 7731")`, "the draft's words in the reply box", 10_000);
    await page.wait(1500);
    const state = await text("[data-chat-cards] [data-draft-state]");
    const sent = (await calls()).sends.length;
    claim("Put in reply fills the reply box with the draft, and nothing is sent", sent === 0 && state === "In your reply", `sends ${sent}, card "${state}"`);
    await shot("put-in-reply");
  });

  // 4. A triage card: untick one row, press once; Mail's own bulk act runs once, on the ticked rows alone.
  await step("the triage press archives exactly the ticked rows, once", async () => {
    await page.until(`document.querySelectorAll("[data-chat-cards] [role=checkbox]").length === 3`, "three ticked rows", 10_000);
    await press(`[data-chat-cards] [role=checkbox][aria-label="Five intake forms patients finish"]`);
    await page.until(`[...document.querySelectorAll("[data-chat-cards] button")].some((b) => b.textContent.trim() === "Archive 2")`, "the press naming 2");
    await shot("triage-ticked");
    const count = async (): Promise<number> => Number((await text("[data-mail-pane]")).match(/\d+ of (\d+)/)?.[1] ?? NaN);
    const before = await count();
    await tag("[data-chat-cards]", "Archive 2", "archive");
    await press("[data-proof=archive]");
    await page.wait(800);
    const { batches } = await calls();
    const once = batches.length === 1 && JSON.stringify(batches[0]) === JSON.stringify({ ids: ["c-receipt", "c-workspace"], act: { kind: "archive", archived: true } });
    const after = await count();
    claim("the triage press archives exactly the ticked rows, once", once && after === before - 2, `${JSON.stringify(batches)}; the inbox ${before} → ${after}`);
    countBefore = before;
    await shot("triage-archived");
  });

  // 5. Undo, from Mail's own toast: the rows come back.
  await step("Undo brings the archived rows back", async () => {
    await page.until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Undo")`, "the toast's Undo", 5_000);
    await tag("", "Undo", "undo");
    await press("[data-proof=undo]");
    await page.until(`(document.querySelector("[data-mail-pane]")?.textContent.match(/\\d+ of (\\d+)/)?.[1] ?? "") === "${countBefore}"`, "the rows back", 10_000);
    claim("Undo brings the archived rows back", true);
    await shot("triage-undone");
  });
  return claims;
}
