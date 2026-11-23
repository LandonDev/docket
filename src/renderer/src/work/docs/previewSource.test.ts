import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => ({ request: () => Promise.reject(new Error("no link in a test")) }) } }));

import type { AnyEditor } from "work-kit/editor";
import type { DocumentPage } from "work-kit/editor/page";
import { paraText } from "work-kit/editor/para";
import { NotInReach } from "../formats/preview";
import { previewProblems } from "../formats/previewContract";
import { blockFacts, DOC_FORMATS, docDrops, docPreviewSource, type DocFacts, type DocPreviewDeps } from "./previewSource";

/**
 * The document's side of Preview (docs/agents/work-docs.md "Preview"): what
 * each format drops, counted from the document, and each format drawn as
 * the file it will be, over a fake host.
 */

const NONE: DocFacts = { comments: 0, replied: 0, suggestions: 0, footnotes: 0, colours: 0, underlines: 0 };

describe("what a document holds that a format may drop", () => {
  it("counts colours, underlines and footnotes through the blocks: runs, links, table cells and nested blocks", () => {
    const blocks = [
      { type: "heading", props: { textColor: "blue", backgroundColor: "default" }, content: [{ type: "text", text: "Plan", styles: {} }] },
      {
        type: "paragraph",
        props: { textColor: "default", backgroundColor: "yellow" },
        content: [
          { type: "text", text: "red", styles: { textColor: "red" } },
          { type: "text", text: "marked", styles: { backgroundColor: "green", underline: true } },
          { type: "footnote", props: { note: "Clause 3.2" } },
          { type: "link", href: "https://example.com", content: [{ type: "text", text: "site", styles: { underline: true } }] },
        ],
        children: [{ type: "bulletListItem", props: {}, content: [{ type: "text", text: "x", styles: { textColor: "default" } }, { type: "footnote", props: {} }] }],
      },
      { type: "table", props: {}, content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "a", styles: { textColor: "purple" } }], { content: [{ type: "text", text: "b", styles: { underline: true } }] }] }] } },
    ];
    expect(blockFacts(blocks)).toEqual({ footnotes: 2, colours: 5, themeColours: 0, underlines: 3, fonts: 0, spacing: 0, styles: 0 });
    expect(blockFacts([])).toEqual({ footnotes: 0, colours: 0, themeColours: 0, underlines: 0, fonts: 0, spacing: 0, styles: 0 });
  });

  it("counts the styling a format may not hold: runs that name a font or a size, a run's own colours, a paragraph's spacing, a named style", () => {
    const blocks = [
      { type: "paragraph", props: { para: paraText({ style: "Title" }) }, content: [{ type: "text", text: "Plan", styles: {} }] },
      { type: "paragraph", props: { para: paraText({ style: "Caption", spaceAfter: 12 }) }, content: [{ type: "text", text: "Fig", styles: { fontSize: "9" } }] },
      {
        type: "paragraph",
        props: { para: paraText({ lineSpacing: 1.5 }) },
        content: [
          { type: "text", text: "a", styles: { fontFamily: "Cambria", fontSize: "14" } },
          { type: "text", text: "b", styles: { color: "theme:accent1", bold: true } },
          { type: "link", href: "https://example.com", content: [{ type: "text", text: "c", styles: { highlight: "#FFFF00", fontFamily: "Arial" } }] },
        ],
      },
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "plain", styles: { bold: true } }] },
    ];
    expect(blockFacts(blocks)).toEqual({ footnotes: 0, colours: 2, themeColours: 1, underlines: 0, fonts: 3, spacing: 2, styles: 2 });
  });
});

describe("In this format", () => {
  const full: DocFacts = { comments: 2, replied: 1, suggestions: 3, footnotes: 1, colours: 6, underlines: 2 };

  it("says nothing when nothing is lost", () => {
    for (const f of DOC_FORMATS) expect(docDrops(f.id, NONE), f.id).toEqual([]);
  });

  it("Word takes comments whole and suggestions as tracked changes", () => {
    expect(docDrops("docx", full)).toEqual(["3 suggestions go as tracked changes"]);
    expect(docDrops("docx", { ...NONE, suggestions: 1 })).toEqual(["1 suggestion goes as a tracked change"]);
    expect(docDrops("docx", { ...NONE, comments: 5 })).toEqual([]);
  });

  it("an agent's suggestions stay out of Word, OpenDocument and Rich Text until he accepts them; a person's still go as tracked changes", () => {
    expect(docDrops("docx", { ...full, held: 2 })).toEqual(["1 suggestion goes as a tracked change", "2 suggestions stay out until you accept them"]);
    expect(docDrops("odt", { ...full, held: 3 })).toEqual(["3 suggestions stay out until you accept them"]);
    expect(docDrops("rtf", { ...NONE, suggestions: 1, held: 1 })).toEqual(["1 suggestion stays out until you accept it"]);
    // The host's count never says more stayed out than the canvas holds.
    expect(docDrops("docx", { ...NONE, suggestions: 1, held: 4 })).toEqual(["1 suggestion stays out until you accept it"]);
  });

  it("OpenDocument keeps linked replies, theme colours and styled paragraphs", () => {
    const styled: DocFacts = { ...full, themeColours: 3, fonts: 2, styles: 1, spacing: 1 };
    expect(docDrops("odt", styled)).toEqual(["3 suggestions go as tracked changes"]);
  });

  it("Rich Text makes replies separate comments and fixes theme text colours", () => {
    expect(docDrops("rtf", { ...full, themeColours: 2 })).toEqual([
      "3 suggestions go as tracked changes", "Replies to 1 comment become separate comments", "Theme text colours become fixed colours",
    ]);
    expect(docDrops("rtf", { ...NONE, comments: 4, replied: 2 })).toEqual(["Replies to 2 comments become separate comments"]);
    expect(docDrops("rtf", { ...NONE, comments: 2, colours: 2 })).toEqual([]);
    expect(docDrops("rtf", { ...NONE, themeColours: 1 })).toEqual(["Theme text colours become fixed colours"]);
  });

  it("a PDF and a web page leave comments and suggestions here and gather footnotes at the end; they keep every colour", () => {
    const lines = ["2 comments stay behind", "3 suggestions stay out until you accept them", "1 footnote moves to the end"];
    expect(docDrops("pdf", full)).toEqual(lines);
    expect(docDrops("print", full)).toEqual(lines);
    expect(docDrops("html", full)).toEqual(lines);
    expect(docDrops("pdf", { ...NONE, comments: 1, suggestions: 1, footnotes: 2 })).toEqual(["1 comment stays behind", "1 suggestion stays out until you accept it", "2 footnotes move to the end"]);
    // The page writes a text colour and a highlight inline (work-kit's HTML writer): neither is lost.
    expect(docDrops("pdf", { ...NONE, colours: 3 })).toEqual([]);
    expect(docDrops("html", { ...NONE, colours: 3, underlines: 2 })).toEqual([]);
  });

  it("Markdown has no colour and no underline", () => {
    expect(docDrops("md", full)).toEqual(["2 comments stay behind", "3 suggestions stay out until you accept them", "Colours stay behind", "Underlines stay behind"]);
    expect(docDrops("md", { ...NONE, footnotes: 4 })).toEqual([]);
  });

  it("Markdown says the styling it cannot hold; Word, OpenDocument, Rich Text, a PDF and a web page keep it all", () => {
    const styled: DocFacts = { ...NONE, colours: 2, fonts: 3, spacing: 1, styles: 2 };
    expect(docDrops("md", styled)).toEqual(["Colours stay behind", "Fonts and sizes stay behind", "Named styles stay behind", "Paragraph spacing stays behind"]);
    for (const format of ["docx", "odt", "rtf", "pdf", "print", "html"] as const) expect(docDrops(format, styled), format).toEqual([]);
    // Each is said only of a document that has it.
    expect(docDrops("md", { ...NONE, fonts: 1 })).toEqual(["Fonts and sizes stay behind"]);
  });

  it("every line says what happens to the thing, in one line", () => {
    for (const f of DOC_FORMATS) for (const line of docDrops(f.id, full)) expect(line, `${f.id}: ${line}`).toMatch(/^[A-Z0-9][^\n.]*$/);
  });
});

/** A host that keeps renders as the real one does: by what they were made from, under the item that shows the document, read by range. */
function host() {
  const calls: { env: string; method: string; params: Record<string, unknown> }[] = [];
  const pdfBytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const fileBytes = new Uint8Array([80, 75, 3, 4, 9, 9, 9, 9, 9, 9]);
  const renders = new Map<string, Uint8Array>();
  let n = 0;
  const state = { servedBy: null as string | null, gone: false, warnings: [] as string[], drawable: true, text: "v1", held: 0, office: "ready" as "ready" | "asleep" | "not open" | "none", declined: null as "asleep" | null };
  const request = async <T,>(env: string, method: string, params: unknown): Promise<T> => {
    const p = params as Record<string, unknown>;
    calls.push({ env, method, params: p });
    if (state.servedBy && env !== state.servedBy) throw new Error(`this host does not serve LifeOS documents; ${state.servedBy} does, and here they are read-only`);
    // A host that serves the document for another knows nothing of that one's items.
    if (state.servedBy && p.itemId !== undefined) throw new Error("that item is not open");
    if (method === "work.formats.previewOffice") return { app: "word", state: state.office } as T;
    if (method === "work.formats.preview") {
      if (p.by === "word") {
        if (state.declined) return { notInReach: state.declined } as T;
        if (state.office === "none" || state.office === "not open") return { notInReach: state.office } as T;
      }
      if (!state.drawable && p.format !== "pdf") throw new Error("libreoffice is not installed on env_box, and no linked host converts docx to pdf");
      const rev = `${"0".repeat(31)}${++n}`;
      renders.set(rev, new TextEncoder().encode(`%PDF-1.7 ${state.text}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`));
      return { rev, size: renders.get(rev)!.length, pages: 3, drawnBy: p.by === "word" ? "word" : p.format === "pdf" ? "tempcode" : "libreoffice", name: `Plan.${String(p.format)}`, warnings: state.warnings, ...(state.held ? { heldSuggestions: state.held } : {}) } as T;
    }
    if (method === "work.formats.previewRead") {
      const got = state.gone ? undefined : renders.get(String(p.rev));
      if (!got) {
        state.gone = false;
        throw new Error("that preview is gone: draw it again");
      }
      const slice = got.slice(Number(p.offset), Number(p.offset) + Number(p.length));
      return { data: btoa(String.fromCharCode(...slice)) } as T;
    }
    if (method === "work.formats.export") {
      if (p.format === "md") return { name: "Plan.md", data: btoa(`# Plan ${state.text}`), warnings: ["1 moved block written in its new place."] } as T;
      if (p.format !== "docx" && !state.drawable) throw new Error("libreoffice is not installed on env_box");
      return { name: `Plan.${String(p.format)}`, data: btoa(String.fromCharCode(...fileBytes)), warnings: [] } as T;
    }
    throw new Error(`unknown method ${method}`);
  };
  return { calls, request, state, pdfBytes, fileBytes };
}

const SOURCE = { at: "file", host: "env_box", path: "/w/Plan.tcdoc" } as const;
const editor = { document: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "red", styles: { textColor: "red" } }, { type: "footnote", props: {} }] }] } as unknown as AnyEditor;

function source(h: ReturnType<typeof host>, over: Partial<DocPreviewDeps> = {}) {
  const saved: { name: string; bytes: Uint8Array; type: string }[] = [];
  const printed: { name: string; bytes: Uint8Array }[] = [];
  const pages: (string | null)[] = [];
  const pageOf: (DocumentPage | null)[] = [];
  const made = docPreviewSource({
    env: "env_box",
    source: SOURCE,
    itemId: "i1",
    title: 'Plan: "spring"',
    editor: () => editor,
    review: () => ({ comments: 2, replied: 1, suggestions: 1 }),
    request: h.request,
    page: async (_editor, title, print, styled) => (pages.push(print?.paper ?? null), pageOf.push(styled), `<!doctype html><html><head><title>${title}</title></head><body>page</body></html>`),
    save: (name, blob) => void blob.arrayBuffer().then((buffer) => saved.push({ name, bytes: new Uint8Array(buffer), type: blob.type })),
    print: async (name, bytes) => void printed.push({ name, bytes }),
    locale: "en-US",
    ...over,
  });
  return { source: made, saved, printed, pages, pageOf };
}
const signal = (): AbortSignal => new AbortController().signal;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the document's Preview source", () => {
  it("keeps the Preview contract", async () => {
    const h = host();
    expect(await previewProblems(source(h).source)).toEqual([]);
  });

  it.each(["ready", "asleep", "not open", "none"] as const)("keeps the contract when Word is %s", async (state) => {
    const h = host();
    h.state.office = state;
    const { source: s } = source(h);
    expect(await s.office!()).toEqual({ app: "Word", state });
    expect(await previewProblems(s, { only: ["docx"] })).toEqual([]);
    const draw = s.draw("docx", { by: "office", signal: signal() });
    if (state === "ready" || state === "asleep") {
      expect(await draw).toMatchObject({ picture: { drawnBy: "word" } });
    } else {
      try {
        await draw;
        throw new Error("expected a refusal");
      } catch (err) {
        expect(err).toBeInstanceOf(NotInReach);
        expect(err).toMatchObject({ app: "Word", why: state });
      }
    }
    expect(h.calls.at(-1)?.params).toMatchObject({ format: "docx", by: "word" });
  });

  it("only offers Office for Word, and passes through a late asleep refusal", async () => {
    const h = host();
    const { source: s } = source(h);
    for (const format of ["odt", "rtf", "pdf", "print", "md", "html"]) {
      expect(await s.office!(format)).toBeNull();
      await expect(s.draw(format, { by: "office", signal: signal() })).rejects.toBeInstanceOf(NotInReach);
    }
    expect(h.calls).toEqual([]);
    h.state.declined = "asleep";
    await expect(s.draw("docx", { by: "office", signal: signal() })).rejects.toMatchObject({ app: "Word", why: "asleep" });
  });

  it("asks the LifeOS serving host for Word readiness and its render", async () => {
    const h = host();
    h.state.servedBy = "env_mac";
    const lifeos = { at: "lifeos", table: "docs", id: "plan" } as const;
    const { source: s } = source(h, { source: lifeos });
    expect(await s.office!("docx")).toEqual({ app: "Word", state: "ready" });
    const draw = await s.draw("docx", { by: "office", signal: signal() });
    expect(draw.picture).toMatchObject({ drawnBy: "word" });
    expect(h.calls.map((c) => [c.env, c.method, c.params.itemId])).toEqual([
      ["env_box", "work.formats.previewOffice", "i1"],
      ["env_mac", "work.formats.previewOffice", undefined],
      ["env_box", "work.formats.preview", "i1"],
      ["env_mac", "work.formats.preview", undefined],
    ]);
  });

  it("lists Word first, then PDF and Print, Markdown, a web page, OpenDocument and Rich Text", () => {
    const h = host();
    expect(source(h).source.formats.map((f) => [f.id, f.label, f.paged, f.verb])).toEqual([
      ["docx", "Word", true, "Export"],
      ["pdf", "PDF", true, "Export"],
      ["print", "Print", true, "Print…"],
      ["md", "Markdown", false, "Export"],
      ["html", "Web page", false, "Export"],
      ["odt", "OpenDocument", true, "Export"],
      ["rtf", "Rich Text", true, "Export"],
    ]);
  });

  it("Word's lines say the agent's suggestion the host left out of the file stays out", async () => {
    const h = host();
    h.state.held = 1;
    const drawn = await source(h).source.draw("docx", { signal: signal() });
    expect(drawn.drops).toEqual(["1 suggestion stays out until you accept it"]);
  });

  it("Word is exported and drawn on the host, under the item, and read by range at its rev", async () => {
    const h = host();
    const { source: s } = source(h);
    const drawn = await s.draw("docx", { signal: signal() });
    expect(h.calls).toEqual([{ env: "env_box", method: "work.formats.preview", params: { source: SOURCE, itemId: "i1", format: "docx" } }]);
    expect(drawn.picture).toMatchObject({ kind: "paged", pages: 3, drawnBy: "libreoffice" });
    expect(drawn.drops).toEqual(["1 suggestion goes as a tracked change"]);
    if (drawn.picture.kind !== "paged") throw new Error("not paged");
    const { pdf } = drawn.picture;
    expect(new TextDecoder().decode(await pdf.read(0, 8))).toBe("%PDF-1.7");
    expect(h.calls.at(-1)).toEqual({ env: "env_box", method: "work.formats.previewRead", params: { source: SOURCE, itemId: "i1", rev: pdf.rev, offset: 0, length: 8 } });
    // Never more than the wire takes in one call.
    await pdf.read(0, 64 * 1024 * 1024);
    expect(h.calls.at(-1)!.params.length).toBe(4 * 1024 * 1024);
  });

  it("a PDF is the print page written here and printed there, on the locale's paper; the host's own losses follow the document's", async () => {
    const h = host();
    h.state.warnings = ["2 pictures from the web left out of the PDF"];
    const { source: s, pages } = source(h);
    const drawn = await s.draw("pdf", { signal: signal() });
    expect(pages).toEqual(["Letter"]);
    expect(h.calls[0]!.params).toMatchObject({ format: "pdf", paper: "Letter", html: expect.stringContaining("<body>page</body>") });
    expect(drawn.picture).toMatchObject({ kind: "paged", drawnBy: "tempcode" });
    expect(drawn.drops).toEqual(["2 comments stay behind", "1 suggestion stays out until you accept it", "1 footnote moves to the end", "2 pictures from the web left out of the PDF"]);
    const a4 = source(h, { locale: "en-GB" });
    await a4.source.draw("pdf", { signal: signal() });
    expect(a4.pages).toEqual(["A4"]);
  });

  it("a styled document's page is written with its own styles, theme and sheet, for a PDF and for a web page; a classic one with none", async () => {
    const h = host();
    const page = { schema: 1 } as DocumentPage;
    const styled = source(h, { styled: () => page });
    await styled.source.draw("pdf", { signal: signal() });
    await styled.source.draw("html", { signal: signal() });
    expect(styled.pageOf).toEqual([page, page]);
    const classic = source(h);
    await classic.source.draw("pdf", { signal: signal() });
    expect(classic.pageOf).toEqual([null]);
  });

  it("Markdown is the host's text and a web page the page written here, with no print rules", async () => {
    const h = host();
    const { source: s, pages } = source(h);
    const md = await s.draw("md", { signal: signal() });
    expect(md.picture).toEqual({ kind: "text", text: "# Plan v1" });
    expect(md.drops).toEqual(["2 comments stay behind", "1 suggestion stays out until you accept it", "Colours stay behind", "1 moved block written in its new place"]);
    const html = await s.draw("html", { signal: signal() });
    expect(html.picture).toMatchObject({ kind: "html", html: expect.stringContaining('<title>Plan: "spring"</title>') });
    expect(pages).toEqual([null]);
    // The web page is made here: the host is asked nothing for it.
    expect(h.calls.map((c) => c.method)).toEqual(["work.formats.export"]);
  });

  it("a LifeOS document another host serves is drawn, read and exported on that host, which is told the source and never this host's item", async () => {
    const h = host();
    h.state.servedBy = "env_mac";
    const { source: s, saved } = source(h);
    const drawn = await s.draw("rtf", { signal: signal() });
    expect(h.calls.map((c) => [c.env, c.method, "itemId" in c.params])).toEqual([
      ["env_box", "work.formats.preview", true],
      ["env_mac", "work.formats.preview", false],
    ]);
    if (drawn.picture.kind !== "paged") throw new Error("not paged");
    expect(new TextDecoder().decode(await drawn.picture.pdf.read(0, 4))).toBe("%PDF");
    expect(h.calls.at(-1)).toMatchObject({ env: "env_mac", method: "work.formats.previewRead" });
    expect("itemId" in h.calls.at(-1)!.params).toBe(false);
    await s.export("rtf");
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ env: "env_mac", method: "work.formats.export", params: { source: SOURCE, format: "rtf" } });
    expect(saved.map((f) => f.name)).toEqual(["Plan.rtf"]);
    // A PDF there too: printed and read on the serving host.
    await s.export("pdf");
    await flush();
    expect(saved.map((f) => f.name)).toEqual(["Plan.rtf", "Plan.pdf"]);
  });

  it("Export writes the document as it stands when he presses, never the picture of an earlier look", async () => {
    const h = host();
    const { source: s, saved } = source(h);
    await s.draw("md", { signal: signal() });
    await s.draw("pdf", { signal: signal() });
    // He goes back to the words and changes them, opens Preview again and presses Export before the new picture lands.
    h.state.text = "v2";
    await s.export("md");
    await s.export("pdf");
    await flush();
    expect(new TextDecoder().decode(saved[0]!.bytes)).toBe("# Plan v2");
    expect(new TextDecoder().decode(saved[1]!.bytes)).toContain("%PDF-1.7 v2");
    expect(saved.map((f) => [f.name, f.type])).toEqual([
      ["Plan.md", "text/markdown;charset=utf-8"],
      ["Plan.pdf", "application/pdf"],
    ]);
  });

  it("Word, OpenDocument and Rich Text are exported by the host's own writer, which needs no renderer: Word goes out when LibreOffice cannot draw it", async () => {
    const h = host();
    h.state.drawable = false;
    const { source: s, saved } = source(h);
    await expect(s.draw("docx", { signal: signal() })).rejects.toThrow("libreoffice is not installed on env_box");
    expect(await s.export("docx")).toEqual({ name: "Plan.docx" });
    await flush();
    expect(h.calls.at(-1)).toEqual({ env: "env_box", method: "work.formats.export", params: { source: SOURCE, format: "docx" } });
    expect(saved).toEqual([{ name: "Plan.docx", bytes: h.fileBytes, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }]);
    // OpenDocument is that Word file through LibreOffice: without it the refusal is the host's own.
    await expect(s.export("odt")).rejects.toThrow("libreoffice is not installed on env_box");
  });

  it("a PDF he never drew is printed for the export, and one whose render went between the two calls is printed once more", async () => {
    const h = host();
    const { source: s, saved } = source(h);
    await s.export("pdf");
    await flush();
    expect(h.calls.map((c) => c.method)).toEqual(["work.formats.preview", "work.formats.previewRead"]);
    h.state.gone = true;
    await s.export("pdf");
    await flush();
    expect(h.calls.slice(2).map((c) => c.method)).toEqual(["work.formats.preview", "work.formats.previewRead", "work.formats.preview", "work.formats.previewRead"]);
    expect(saved.map((f) => f.name)).toEqual(["Plan.pdf", "Plan.pdf"]);
  });

  it("saves the web page under the document's name with nothing a path could make of it", async () => {
    const h = host();
    const { source: s, saved } = source(h);
    expect(await s.export("html")).toEqual({ name: "Plan spring.html" });
    await flush();
    expect(saved.map((f) => [f.name, f.type])).toEqual([["Plan spring.html", "text/html;charset=utf-8"]]);
    expect(new TextDecoder().decode(saved[0]!.bytes)).toContain("<body>page</body>");
    expect(h.calls).toEqual([]);
  });

  it("Print is the PDF's own pages with a PDF's losses, and Print… hands those bytes to this computer, saving nothing", async () => {
    const h = host();
    const { source: s, saved, printed, pages } = source(h);
    const drawn = await s.draw("print", { signal: signal() });
    expect(pages).toEqual(["Letter"]);
    expect(h.calls[0]!.params).toMatchObject({ format: "pdf", paper: "Letter" });
    expect(drawn.picture).toMatchObject({ kind: "paged", pages: 3, drawnBy: "tempcode" });
    expect(drawn.drops).toEqual(["2 comments stay behind", "1 suggestion stays out until you accept it", "1 footnote moves to the end"]);
    // What the host left out of the pages is said on Print as on PDF: they are the same pages.
    h.state.warnings = ["2 pictures from the web left out of the PDF"];
    expect((await s.draw("print", { signal: signal() })).drops).toEqual((await s.draw("pdf", { signal: signal() })).drops);
    expect((await s.draw("print", { signal: signal() })).drops).toContain("2 pictures from the web left out of the PDF");
    expect(await s.export("print")).toEqual({ name: "Plan.pdf" });
    await flush();
    expect(printed).toHaveLength(1);
    expect(printed[0]!.name).toBe("Plan.pdf");
    expect(new TextDecoder().decode(printed[0]!.bytes)).toContain("%PDF-1.7 v1");
    expect(saved).toEqual([]);
    // What he printed is the document as it stands at the press.
    h.state.text = "v2";
    await s.export("print");
    expect(new TextDecoder().decode(printed[1]!.bytes)).toContain("%PDF-1.7 v2");
  });

  it("says why when this computer could not print it", async () => {
    const h = host();
    const { source: s } = source(h, { print: () => Promise.reject(new Error("No application knows how to open this file")) });
    await expect(s.export("print")).rejects.toThrow("No application knows how to open this file");
  });

  it("a cancelled draw answers no picture, and a document still opening cannot be drawn as a page", async () => {
    const h = host();
    const { source: s } = source(h);
    const gone = new AbortController();
    gone.abort();
    await expect(s.draw("docx", { signal: gone.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls).toEqual([]);
    const opening = source(h, { editor: () => null });
    await expect(opening.source.draw("pdf", { signal: signal() })).rejects.toThrow("The document is still opening");
    await expect(opening.source.draw("html", { signal: signal() })).rejects.toThrow("The document is still opening");
    // Word is made on the host from the live text: it needs no editor here.
    await expect(opening.source.draw("docx", { signal: signal() })).resolves.toMatchObject({ picture: { kind: "paged" } });
    await expect(s.draw("csv", { signal: signal() })).rejects.toThrow("A document does not go out as csv");
  });
});
