// @vitest-environment jsdom
/**
 * The Preview frame (docs/DESIGN.md "Work editors: Preview") over a fake
 * source and a fake PDF engine: the bar, the body by picture, the column and
 * its fold, loading, failure with Retry, what the format drops, the export,
 * a long preview's line and the real app's own picture.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyResolver } from "../../lib/appCommands";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void toasts.push(m), { error: (m: string) => void toasts.push(`error: ${m}`) }),
}));

import { fakeDoc, fakeEngine, LETTER } from "../pdf/testkit";
import { countLine, drawnByLine, openingFormat, Preview, sealedPage, type PreviewProps } from "./PreviewFrame";
import { MARGIN_PRESETS, NotInReach, type DrawOptions, type Drawn, type PageSetupModel, type PreviewBytes, type PreviewFormat, type PreviewPicture, type PreviewSource } from "./preview";

beforeEach(() => {
  toasts.length = 0;
  localStorage.clear();
});
afterEach(cleanup);

const FORMATS: PreviewFormat[] = [
  { id: "docx", label: "Word", ext: "docx", paged: true, verb: "Export" },
  { id: "pdf", label: "PDF", ext: "pdf", paged: true, verb: "Export" },
  { id: "md", label: "Markdown", ext: "md", paged: false, verb: "Export" },
  { id: "html", label: "Web page", ext: "html", paged: false, verb: "Export" },
];

const pdf = (rev: string): PreviewBytes => ({ rev, size: 100, read: async (_o, length) => new Uint8Array(length) });
const paged = (rev: string, pages = 3, over: Partial<Extract<PreviewPicture, { kind: "paged" }>> = {}): PreviewPicture => ({ kind: "paged", pdf: pdf(rev), pages, drawnBy: "libreoffice", ...over });

/** A source whose draws the test answers by hand, recording every ask. */
function fake(over: Partial<PreviewSource> = {}) {
  const asked: { format: string; opts: Omit<DrawOptions, "signal"> }[] = [];
  const exported: string[] = [];
  const waiting: { resolve(drawn: Drawn): void; reject(error: Error): void }[] = [];
  const source: PreviewSource = {
    formats: FORMATS,
    draw(format, { signal: _signal, ...opts }) {
      asked.push({ format, opts });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    export: async (format) => (exported.push(format), { name: `Plan.${format}` }),
    ...over,
  };
  return { source, asked, exported, answer: (drawn: Drawn, at = waiting.length - 1) => act(async () => waiting[at]!.resolve(drawn)), fail: (message: string, at = waiting.length - 1) => act(async () => waiting[at]!.reject(new Error(message))) };
}

/** Every render's pages are three sheets of Letter, whatever its rev. */
const engine = () => fakeEngine(() => fakeDoc(Array.from({ length: 3 }, (_, i) => ({ size: LETTER, runs: [{ str: `Page ${i + 1}`, box: [0.1, 0.1, 0.9, 0.13] as [number, number, number, number] }] }))));

/** Mounts the frame and lets its first draw start: the draw is asked a tick after the render. */
async function show(f: ReturnType<typeof fake>, over: Partial<PreviewProps> = {}) {
  const closed = vi.fn();
  const view = render(<Preview source={f.source} title="Plan" kind="document" onClose={closed} engine={engine()} width={864} height={700} tight={false} {...over} />);
  await act(async () => {});
  return { ...view, closed };
}

const head = (): string => document.querySelector("[data-preview-head]")?.textContent ?? "";
const count = (): string | null => document.querySelector("[data-preview-count]")?.textContent ?? null;
const column = (): HTMLElement | null => document.querySelector("[data-preview-column]");

describe("the words", () => {
  it("opens on the format asked for, else the one last used for the kind, else the first", () => {
    expect(openingFormat(FORMATS, "document")).toBe("docx");
    localStorage.setItem("work.preview.format.document", "md");
    expect(openingFormat(FORMATS, "document")).toBe("md");
    expect(openingFormat(FORMATS, "sheet")).toBe("docx");
    expect(openingFormat(FORMATS, "document", "pdf")).toBe("pdf");
    // A format this item does not have (kept from another kind of item) is not opened.
    localStorage.setItem("work.preview.format.document", "csv");
    expect(openingFormat(FORMATS, "document")).toBe("docx");
    expect(openingFormat(FORMATS, "document", "print")).toBe("docx");
  });

  it("says who drew a picture, once, and nothing for a file that is its own text", () => {
    expect(drawnByLine(paged("r"), FORMATS[0])).toBe("As LibreOffice draws it");
    expect(drawnByLine(paged("r", 3, { drawnBy: "word" }), FORMATS[0])).toBe("As Word draws it");
    expect(drawnByLine(paged("r", 3, { drawnBy: "powerpoint" }), FORMATS[0])).toBe("As PowerPoint draws it");
    expect(drawnByLine(paged("r", 3, { drawnBy: "tempcode" }), FORMATS[1])).toBe("The file itself");
    expect(drawnByLine(paged("r", 3, { drawnBy: "tempcode" }), { id: "print", label: "Print", paged: true, verb: "Print…" })).toBe("As it will print");
    expect(drawnByLine({ kind: "text", text: "# Plan" }, FORMATS[2])).toBeNull();
  });

  it("counts pages, or slides, or a place in a whole of which part was drawn", () => {
    expect(countLine(2, 5, paged("r", 5), FORMATS[0])).toBe("Page 2 of 5");
    expect(countLine(1, 12, paged("r", 12), { ...FORMATS[0]!, unit: "slide" })).toBe("Slide 1 of 12");
    expect(countLine(3, 50, paged("r", 50, { shown: { from: 1, to: 50, of: 2084 } }), FORMATS[0])).toBe("Page 3 of 2,084");
    expect(countLine(1, 50, paged("r", 50, { shown: { from: 51, to: 100, of: 2084 } }), FORMATS[0])).toBe("Page 51 of 2,084");
  });

  it("seals a web page: the policy and the link target come first in its head, before anything the page says", () => {
    const SEAL = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">`;
    const sealed = sealedPage("<!doctype html><html><head><title>Plan</title><link rel='stylesheet' href='https://example.com/a.css'></head><body><img src='https://example.com/x.png'></body></html>");
    expect(sealed).toContain(`<head>${SEAL}<title>Plan</title>`);
    expect(sealed.indexOf("Content-Security-Policy")).toBeLessThan(sealed.indexOf("stylesheet"));
    expect(sealedPage('<html><head lang="en"></head></html>')).toContain(`<head lang="en">${SEAL}`);
    // `<header>` is not the head: a page with none is given one, since a policy in the body is ignored.
    expect(sealedPage("<header>Plan</header><p>bare</p>")).toBe(`<head>${SEAL}</head><header>Plan</header><p>bare</p>`);
    expect(sealedPage("<p>bare</p>")).toBe(`<head>${SEAL}</head><p>bare</p>`);
  });
});

describe("the frame", () => {
  it("draws the format he last used: the paper's shape while it is drawn, then the pages, who drew them, the count and what the format drops", async () => {
    localStorage.setItem("work.preview.format.document", "docx");
    const f = fake();
    await show(f);
    expect(f.asked).toEqual([{ format: "docx", opts: {} }]);
    expect(head()).toBe("Drawing the pages");
    expect(document.querySelector("[aria-busy=true]")).not.toBeNull();
    // Nothing is counted and nothing is lost until there is a picture; Export is live all along.
    expect(count()).toBeNull();
    expect(column()).toBeNull();
    expect(screen.queryByText("In this format")).toBeNull();
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false);

    await f.answer({ picture: paged("r1"), drops: ["3 suggestions go as tracked changes", "Aptos is drawn as Carlito here; Word will use Aptos"] });
    await waitFor(() => expect(count()).toBe("Page 1 of 3"));
    expect(head()).toBe("As LibreOffice draws it");
    const col = column()!;
    expect(within(col).getByText("In this format")).toBeTruthy();
    expect(within(col).getByText("3 suggestions go as tracked changes")).toBeTruthy();
    expect(within(col).getByText("Aptos is drawn as Carlito here; Word will use Aptos")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Plan as Word" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Preview" })).toBeTruthy();
  });

  it("says nothing of losses when the format loses nothing", async () => {
    const f = fake();
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    await waitFor(() => expect(count()).toBe("Page 1 of 3"));
    expect(column()).toBeNull();
    expect(screen.queryByText("In this format")).toBeNull();
  });

  it("switches format from the bar: a file that is its own text has no paper, no zoom, no count and no line about who drew it", async () => {
    const f = fake();
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    expect(screen.getByRole("button", { name: /Fit width/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Markdown" })));
    await waitFor(() => expect(f.asked.at(-1)).toEqual({ format: "md", opts: {} }));
    expect(screen.getByRole("status").textContent).toBe("Drawing the file");
    await f.answer({ picture: { kind: "text", text: "# Plan\n\nSetup starts at 8." }, drops: ["2 comments stay behind"] });
    const text = document.querySelector("[data-preview-text]")!;
    expect(text.textContent).toBe("# Plan\n\nSetup starts at 8.");
    expect(text.className).toContain("font-mono");
    expect(screen.queryByRole("button", { name: /Fit width/ })).toBeNull();
    expect(count()).toBeNull();
    expect(document.querySelector("[data-preview-head]")).toBeNull();
    expect(within(column()!).getByText("2 comments stay behind")).toBeTruthy();
    // Picking the format it is on draws nothing again.
    const before = f.asked.length;
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Markdown" })));
    expect(f.asked.length).toBe(before);
  });

  it("a draw that was overtaken by another format is dropped", async () => {
    const f = fake();
    await show(f);
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Markdown" })));
    // Word's picture arrives after he moved on: it is not shown.
    await f.answer({ picture: paged("late"), drops: ["late"] }, 0);
    expect(screen.queryByText("late")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Drawing the file");
  });

  it("draws a web page in a frame where no script runs, at a phone's, a tablet's or a desktop's width", async () => {
    const f = fake();
    await show(f, { initial: "html" });
    await f.answer({ picture: { kind: "html", html: "<!doctype html><html><head></head><body><h1>Plan</h1></body></html>" }, drops: [] });
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(frame.title).toBe("Plan as a web page");
    expect(frame.style.width).toBe("1280px");
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Phone" })));
    expect(document.querySelector("iframe")!.style.width).toBe("390px");
    // Zoomed down to fit, never up.
    expect(document.querySelector("iframe")!.style.transform).toBe("scale(1)");
  });

  it("folds its column under 600px of canvas: the losses become lines over the paper", async () => {
    const f = fake();
    await show(f, { width: 500, tight: true });
    await f.answer({ picture: paged("r1"), drops: ["2 comments stay behind"] });
    await waitFor(() => expect(count()).toBe("Page 1 of 3"));
    expect(column()).toBeNull();
    const lines = document.querySelector("[data-preview-drops]")!;
    expect(lines.textContent).toBe("2 comments stay behind");
    expect(lines.className).toContain("text-xs");
    // No page set-up, so no Page button to hold its rows.
    expect(screen.queryByRole("button", { name: "Page" })).toBeNull();
    // The format is a menu button when the segment does not fit.
    expect(document.querySelector("[data-preview-format]")!.getAttribute("data-preview-format")).toBe("menu");
    expect(screen.queryByRole("tab", { name: "Markdown" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Word/ })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Markdown/ })));
    expect(f.asked.at(-1)?.format).toBe("md");
  });

  it("under 440px Edit is its glyph and the zoom goes; on a file he cannot edit the way out reads Back", async () => {
    const f = fake();
    const first = await show(f, { width: 400, tight: true });
    await f.answer({ picture: paged("r1"), drops: [] });
    expect(screen.queryByRole("button", { name: /Fit width/ })).toBeNull();
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.textContent).toBe("");
    fireEvent.click(edit);
    expect(first.closed).toHaveBeenCalledTimes(1);
    first.unmount();

    const g = fake();
    const second = await show(g, { readOnly: true });
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.textContent).toBe("Back");
    fireEvent.click(back);
    expect(second.closed).toHaveBeenCalledTimes(1);
  });

  it("when the format cannot be drawn it says why once, with Retry, and Export still works", async () => {
    const f = fake();
    await show(f);
    await f.fail("LibreOffice on tempcode-box did not answer");
    const failed = document.querySelector("[data-preview-failed]")!;
    expect(within(failed as HTMLElement).getByText("Can't draw this format here")).toBeTruthy();
    expect(within(failed as HTMLElement).getByText("LibreOffice on tempcode-box did not answer. Exporting still works.")).toBeTruthy();
    expect(count()).toBeNull();
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    expect(f.exported).toEqual(["docx"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(f.asked).toHaveLength(2);
    expect(document.querySelector("[data-preview-failed]")).toBeNull();
    // It knows nothing of how many pages there were: a failed draw taught it nothing.
    expect(head()).toBe("Drawing the pages");
    await f.answer({ picture: paged("r1"), drops: [] });
    await waitFor(() => expect(count()).toBe("Page 1 of 3"));
  });

  it("a render that went under the pages (the document was drawn again elsewhere) is drawn once more by itself; only a second loss is said, with Retry", async () => {
    const f = fake();
    render(<Preview source={f.source} title="Plan" kind="document" onClose={() => {}} engine={{ open: () => Promise.reject(new Error("that preview is gone: draw it again")) }} width={864} height={700} tight={false} />);
    await act(async () => {});
    await f.answer({ picture: paged("r1"), drops: [] });
    // Drawn again with nothing said: he sees the paper's shape, not a failure.
    await waitFor(() => expect(f.asked).toHaveLength(2));
    expect(document.querySelector("[data-preview-failed]")).toBeNull();
    // The same render lost again is a host that cannot keep it: said, with Retry.
    await f.answer({ picture: paged("r1"), drops: [] });
    expect(await screen.findByText("That preview is gone: draw it again. Exporting still works.")).toBeTruthy();
    expect(f.asked).toHaveLength(2);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(f.asked).toHaveLength(3));
  });

  it("drawn again, it says how many pages it is drawing", async () => {
    const f = fake();
    await show(f);
    await f.answer({ picture: paged("r1", 5), drops: [] });
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "PDF" })));
    expect(head()).toBe("Drawing the pages");
    await f.answer({ picture: paged("r2", 1, { drawnBy: "tempcode" }), drops: [] });
    await waitFor(() => expect(head()).toBe("The file itself"));
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Word" })));
    expect(head()).toBe("Drawing 5 pages");
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "PDF" })));
    expect(head()).toBe("Drawing 1 page");
  });

  it("Export asks the source for the format on screen and keeps it as the one to open on next; it says where only when the source put the file somewhere", async () => {
    const f = fake();
    await show(f);
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "PDF" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    expect(f.exported).toEqual(["pdf"]);
    expect(localStorage.getItem("work.preview.format.document")).toBe("pdf");
    // The system's save dialog was the answer.
    expect(toasts).toEqual([]);

    cleanup();
    const g = fake({ export: async () => ({ name: "Budget.xlsx", where: "Spring LAN" }) });
    await show(g, { kind: "sheet" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    await waitFor(() => expect(toasts).toEqual(["Saved Budget.xlsx to Spring LAN"]));

    cleanup();
    toasts.length = 0;
    const h = fake({ export: async () => Promise.reject(new Error("the disk is full")) });
    await show(h);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    await waitFor(() => expect(toasts).toEqual(["error: the disk is full"]));
    expect(localStorage.getItem("work.preview.format.document")).toBe("pdf");
  });

  it("a print is not the format Export… opens on next: that stays the last file he made", async () => {
    const f = fake({ formats: [...FORMATS, { id: "print", label: "Print", paged: true, verb: "Print…" }] });
    await show(f, { initial: "print" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Print…" })));
    expect(f.exported).toEqual(["print"]);
    expect(localStorage.getItem("work.preview.format.document")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "PDF" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export" })));
    expect(localStorage.getItem("work.preview.format.document")).toBe("pdf");
  });

  it("holds its own keys as a file he can only read: ⌘P can be Print in it, and ⌘B stays the app's", async () => {
    const f = fake();
    await show(f);
    const frame = document.querySelector<HTMLElement>("[data-preview]")!;
    expect(frame.getAttribute("data-editor-keys")).toBe("read");
    // As the document mounts it: inside the Body's root, which says what the kind answers, and beside the editor.
    frame.parentElement!.setAttribute("data-editor-answers", "export print");
    const resolve = createKeyResolver();
    const key = (k: string) => new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true, bubbles: true });
    const heard = (k: string) => {
      let got: ReturnType<typeof resolve> = null;
      const on = (e: KeyboardEvent): void => void (got = resolve(e, { lightboxOpen: false }));
      window.addEventListener("keydown", on, true);
      screen.getByRole("button", { name: "Edit" }).dispatchEvent(key(k));
      window.removeEventListener("keydown", on, true);
      return got;
    };
    expect(heard("p")).toEqual({ id: "print" });
    expect(heard("b")).toEqual({ id: "toggle_sidebar" });
    expect(heard("k")).toEqual({ id: "open_search" });
    // A kind that answers no Print leaves ⌘P the app's.
    frame.parentElement!.setAttribute("data-editor-answers", "export");
    expect(heard("p")).toEqual({ id: "go_to_file" });
  });

  it("the one primary button says the format's own verb", async () => {
    const f = fake({ formats: [{ id: "print", label: "Print", paged: true, verb: "Print…" }, { id: "gsheet", label: "Google Sheets", paged: false, verb: "Save to Google Sheets" }] });
    await show(f);
    expect(screen.getByRole("button", { name: "Print…" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Google Sheets" })));
    expect(screen.getByRole("button", { name: "Save to Google Sheets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Print…" })).toBeNull();
  });

  it("a long file draws its first pages and offers the rest: the count is of the whole", async () => {
    const f = fake();
    await show(f);
    await f.answer({ picture: paged("r1", 50, { shown: { from: 1, to: 50, of: 2084 } }), drops: [] });
    await waitFor(() => expect(count()).toBe("Page 1 of 2,084"));
    expect(head()).toBe("The first 50 pagesDraw all 2,084");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Draw all 2,084" })));
    expect(f.asked.at(-1)).toEqual({ format: "docx", opts: { pages: [1, Number.MAX_SAFE_INTEGER] } });
    expect(head()).toBe("Drawing 2,084 pages");
    await f.answer({ picture: paged("r2", 2084), drops: [] });
    await waitFor(() => expect(head()).toBe("As LibreOffice draws it"));
    expect(screen.queryByRole("button", { name: /Draw all/ })).toBeNull();
  });
});

describe("the keys", () => {
  it("takes the focus when it opens, on the way back, and Escape goes back to the words", async () => {
    const f = fake();
    const view = await show(f);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Export" }), { key: "Escape" });
    expect(view.closed).toHaveBeenCalledTimes(1);
    // A key from a layer drawn outside the frame (a menu, the Page popover) is that layer's.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(view.closed).toHaveBeenCalledTimes(1);
  });

  it("names each menu button for what it sets, not only by its value", async () => {
    const f = fake({ setup: { kind: "document", common: { paper: "A4", orientation: "portrait", margins: { ...MARGIN_PRESETS.Narrow }, header: true, footer: true }, columns: 1, differentFirst: false, set: (async () => {}) as never } });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    expect(screen.getByRole("button", { name: "Zoom: Fit width" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Paper: A4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Margins: Narrow" })).toBeTruthy();
    cleanup();
    const g = fake();
    await show(g, { width: 500, tight: true });
    expect(screen.getByRole("button", { name: "Format: Word" })).toBeTruthy();
  });
});

describe("the real app's own picture", () => {
  const office = (state: "ready" | "asleep" | "not open" | "none") => async () => ({ app: "Word" as const, state });

  it("offers Check in Word when Word is in reach, draws in Word on his press with the paper kept and dimmed, then says Word drew it", async () => {
    const f = fake({ office: office("ready") });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: ["Aptos is drawn as Carlito here; Word will use Aptos"] });
    const check = await screen.findByRole("button", { name: "Check in Word" });
    await act(async () => fireEvent.click(check));
    expect(f.asked.at(-1)).toEqual({ format: "docx", opts: { by: "office" } });
    expect(head()).toBe("Drawing in Word");
    expect(screen.queryByRole("button", { name: "Check in Word" })).toBeNull();
    await waitFor(() => expect(document.querySelector<HTMLElement>("[data-paged-sheets]")!.style.opacity).toBe("0.55"));
    await f.answer({ picture: paged("r-word", 3, { drawnBy: "word" }), drops: [] });
    await waitFor(() => expect(head()).toBe("As Word draws it"));
    expect(screen.queryByRole("button", { name: "Check in Word" })).toBeNull();
    // What LibreOffice's picture lost, Word's does not.
    expect(column()).toBeNull();
  });

  it("Word's picture that lands after he moved to another format is dropped: it is not that format's", async () => {
    const f = fake({ office: office("ready") });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Check in Word" })));
    const wordDraw = f.asked.length - 1;
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Markdown" })));
    await waitFor(() => expect(f.asked.at(-1)?.format).toBe("md"));
    await f.answer({ picture: { kind: "text", text: "# Plan" }, drops: [] });
    await f.answer({ picture: paged("r-word", 3, { drawnBy: "word" }), drops: [] }, wordDraw);
    expect(document.querySelector("[data-preview-text]")!.textContent).toBe("# Plan");
    expect(document.querySelector("[data-paged-view]")).toBeNull();
    expect(head()).toBe("");
  });

  it("an asleep machine is woken by the press, and says so", async () => {
    const f = fake({ office: office("asleep") });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Check in Word" })));
    expect(head()).toBe("Waking Windows");
  });

  it("when Word could not draw it after all, LibreOffice's picture stays, it is said once, and the press is offered again", async () => {
    const f = fake({ office: office("ready") });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Check in Word" })));
    await f.fail("Word closed while it was drawing");
    await waitFor(() => expect(toasts).toEqual(["error: Word closed while it was drawing"]));
    expect(head()).toBe("As LibreOffice draws itCheck in Word");
    expect(document.querySelector<HTMLElement>("[data-paged-sheets]")!.style.opacity).toBe("1");
  });

  it("names the app in the refusal when the source says it is not in reach", async () => {
    let calls = 0;
    const f = fake({ office: office("ready") });
    const draw = f.source.draw.bind(f.source);
    f.source.draw = (format, opts) => (opts.by === "office" ? (calls++, Promise.reject(new NotInReach("Word", "not open"))) : draw(format, opts));
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Check in Word" })));
    await waitFor(() => expect(toasts).toEqual(["error: Word is not in reach"]));
    expect(calls).toBe(1);
    expect(head()).toContain("As LibreOffice draws it");
  });

  it("never offers it for an app that is shut or absent, for a format that has no pages, or when the source has no way to ask", async () => {
    for (const state of ["not open", "none"] as const) {
      const f = fake({ office: office(state) });
      await show(f);
      await f.answer({ picture: paged("r1"), drops: [] });
      await waitFor(() => expect(count()).toBe("Page 1 of 3"));
      expect(screen.queryByRole("button", { name: "Check in Word" })).toBeNull();
      cleanup();
    }
    const asked = vi.fn(office("ready"));
    const g = fake({ office: asked });
    await show(g, { initial: "md" });
    await g.answer({ picture: { kind: "text", text: "x" }, drops: [] });
    expect(asked).not.toHaveBeenCalled();
    cleanup();
    const h = fake();
    await show(h);
    await h.answer({ picture: paged("r1"), drops: [] });
    await waitFor(() => expect(count()).toBe("Page 1 of 3"));
    expect(screen.queryByRole("button", { name: /Check in/ })).toBeNull();
  });
});

describe("the Page section", () => {
  const setupOf = (set: PageSetupModel["set"]): PageSetupModel => ({
    kind: "document",
    common: { paper: "Letter", orientation: "portrait", margins: { ...MARGIN_PRESETS.Normal }, header: true, footer: true },
    columns: 1,
    differentFirst: false,
    set: set as never,
  });

  it("stands over the losses in the column, with the kind's own rows after the ones every kind shares, and a change draws the file again", async () => {
    const sets: unknown[] = [];
    const f = fake({ setup: setupOf(async (next: unknown) => void sets.push(next)) });
    await show(f, { pageRows: <div data-own-row>Different first page</div> });
    await f.answer({ picture: paged("r1"), drops: ["2 comments stay behind"] });
    const col = column()!;
    const text = col.textContent ?? "";
    expect(text.indexOf("Page")).toBeLessThan(text.indexOf("In this format"));
    for (const label of ["Paper", "Orientation", "Margins", "Headers and footers"]) expect(within(col).getByText(label)).toBeTruthy();
    expect(within(col).getByRole("button", { name: /Letter/ })).toBeTruthy();
    expect(within(col).getByRole("button", { name: /Portrait/ })).toBeTruthy();
    expect(within(col).getByRole("button", { name: /Normal/ })).toBeTruthy();
    expect(text.indexOf("Headers and footers")).toBeLessThan(text.indexOf("Different first page"));

    const before = f.asked.length;
    await act(async () => fireEvent.click(within(col).getByRole("switch", { name: "Headers and footers" })));
    expect(sets).toEqual([{ common: { paper: "Letter", orientation: "portrait", margins: MARGIN_PRESETS.Normal, header: false, footer: false } }]);
    await waitFor(() => expect(f.asked.length).toBe(before + 1));

    await act(async () => fireEvent.click(within(column()!).getByRole("button", { name: /Letter/ })));
    await act(async () => fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "A4" })));
    expect(sets.at(-1)).toMatchObject({ common: { paper: "A4" } });
  });

  it("is in a popover from the bar's Page button when the column is folded, and absent for a format with no pages", async () => {
    const f = fake({ setup: setupOf(async () => {}) });
    await show(f, { width: 500, tight: true });
    await f.answer({ picture: paged("r1"), drops: [] });
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Page" })));
    const pop = await screen.findByRole("dialog", { name: "Page" });
    expect(within(pop).getByText("Margins")).toBeTruthy();
    cleanup();

    const g = fake({ setup: setupOf(async () => {}) });
    await show(g, { initial: "md" });
    await g.answer({ picture: { kind: "text", text: "x" }, drops: [] });
    expect(document.querySelector("[data-preview-page]")).toBeNull();
  });

  it("stays beside a format that could not be drawn: the set-up is still his to change, with no losses to list", async () => {
    const f = fake({ setup: setupOf(async () => {}) });
    await show(f);
    await f.fail("LibreOffice on tempcode-box did not answer");
    const col = column()!;
    expect(within(col).getByText("Margins")).toBeTruthy();
    expect(screen.queryByText("In this format")).toBeNull();
    cleanup();
    const g = fake({ setup: setupOf(async () => {}) });
    await show(g, { width: 500, tight: true });
    await g.fail("LibreOffice on tempcode-box did not answer");
    expect(column()).toBeNull();
    expect(screen.getByRole("button", { name: "Page" })).toBeTruthy();
  });

  it("says so when the set-up could not be changed, and draws nothing again", async () => {
    const f = fake({ setup: setupOf(async () => Promise.reject(new Error("the document is read only"))) });
    await show(f);
    await f.answer({ picture: paged("r1"), drops: [] });
    const before = f.asked.length;
    await act(async () => fireEvent.click(within(column()!).getByRole("switch", { name: "Headers and footers" })));
    await waitFor(() => expect(toasts).toEqual(["error: the document is read only"]));
    expect(f.asked.length).toBe(before);
  });
});
