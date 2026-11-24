import type { ExportAnswer, PreviewAnswer, PreviewFormatId, PreviewOfficeAnswer, PreviewResult } from "@shared/contract-work-formats";
import { PREVIEW_READ_MAX } from "@shared/contract-work-formats";
import type { CanvasSource } from "@shared/work";
import type { AnyEditor, DocumentHandle, PagesHtmlOptions } from "work-kit/editor";
import type { DocumentPage, PageSetup } from "work-kit/editor/page";
import { paraOf } from "work-kit/editor/para";
import { registry } from "../../lib/connection";
import { fileStem, fromBase64, mimeOf, paperFor, saveFile } from "../formats/model";
import { NotInReach, type CommonSetup, type DocumentSetup, type Drawn, type PaperName, type PreviewBytes, type PreviewFormat, type PreviewSource } from "../formats/preview";
import { docFonts } from "./fonts";
import { servedBy } from "./host";

/**
 * The document's side of Preview (docs/agents/work-docs.md "Preview"): each
 * format the document goes out as, drawn as that file will be.
 *
 * - Word, OpenDocument and Rich Text are written on the host from the live
 *   text, converted there, and drawn by LibreOffice from the exported file
 *   itself (`work.formats.preview`).
 * - PDF is the document's print page, printed on the host: in Pages the
 *   sheets as he sees them (the editor's `pagesHtml`, with the faces inlined),
 *   else the page written here from the editor's blocks.
 * - Markdown is the text the host writes; a web page is the page written
 *   here.
 *
 * Export writes the document as it stands when he presses, never a picture
 * kept from an earlier look: Word, OpenDocument and Rich Text through
 * `work.formats.export` (which needs no renderer, so Word still goes out
 * when LibreOffice cannot draw it), a PDF through the same print the
 * preview makes (the host answers a page it already printed from its kept
 * render, so an unchanged document saves the bytes he saw).
 *
 * What a format cannot hold is counted from the document (`docDrops`), with
 * what the host's own writer said it dropped after it.
 */

export type DocFormat = "docx" | "pdf" | "print" | "md" | "html" | "odt" | "rtf";

/** In the bar's order: what Word and mail read first. */
export const DOC_FORMATS: readonly (PreviewFormat & { id: DocFormat })[] = [
  { id: "docx", label: "Word", ext: "docx", paged: true, verb: "Export" },
  { id: "pdf", label: "PDF", ext: "pdf", paged: true, verb: "Export" },
  // What goes to paper is the PDF: the same picture, and the verb is Print….
  { id: "print", label: "Print", paged: true, verb: "Print…" },
  { id: "md", label: "Markdown", ext: "md", paged: false, verb: "Export" },
  { id: "html", label: "Web page", ext: "html", paged: false, verb: "Export" },
  { id: "odt", label: "OpenDocument", ext: "odt", paged: true, verb: "Export" },
  { id: "rtf", label: "Rich Text", ext: "rtf", paged: true, verb: "Export" },
];

/** What of a document a format may not hold, counted. */
export interface DocFacts {
  /** comment threads, not their marks: a thread over three lines is one */
  comments: number;
  /** of those, the threads someone answered */
  replied: number;
  /** suggestions waiting on him */
  suggestions: number;
  /** of those, an agent's, which the host leaves out of the file until he accepts them (`heldSuggestions`) */
  held?: number;
  footnotes: number;
  /** runs and blocks with any colour, text or background */
  colours: number;
  /** runs whose text colour is set by the theme */
  themeColours?: number;
  underlines: number;
  /** runs that name a font or a size */
  fonts?: number;
  /** paragraphs with spacing, indents or page rules of their own */
  spacing?: number;
  /** paragraphs that wear a named style (Title, Caption, a file's own) */
  styles?: number;
}

type Loose = { type?: unknown; props?: Record<string, unknown>; content?: unknown; children?: unknown; styles?: Record<string, unknown> };

const coloured = (value: unknown): boolean => typeof value === "string" && value !== "" && value !== "default";

/** What the editor's blocks hold that a format may drop: colours, underlines, footnotes, fonts and sizes, a paragraph's own formatting. */
export function blockFacts(blocks: readonly unknown[]): Required<Pick<DocFacts, "footnotes" | "colours" | "themeColours" | "underlines" | "fonts" | "spacing" | "styles">> {
  const facts = { footnotes: 0, colours: 0, themeColours: 0, underlines: 0, fonts: 0, spacing: 0, styles: 0 };
  const inline = (content: unknown): void => {
    if (!Array.isArray(content)) {
      // A table's content: rows of cells, each holding inline content.
      const rows = (content as { rows?: { cells?: unknown[] }[] } | null)?.rows;
      if (Array.isArray(rows)) for (const row of rows) for (const cell of row.cells ?? []) inline(Array.isArray(cell) ? cell : (cell as Loose | null)?.content);
      return;
    }
    for (const piece of content as Loose[]) {
      if (piece.type === "footnote") facts.footnotes++;
      const styles = piece.styles ?? {};
      if (coloured(styles.textColor) || coloured(styles.backgroundColor) || coloured(styles.color) || coloured(styles.highlight)) facts.colours++;
      if (typeof styles.color === "string" && styles.color.startsWith("theme:")) facts.themeColours++;
      if (coloured(styles.fontFamily) || coloured(styles.fontSize)) facts.fonts++;
      if (styles.underline === true) facts.underlines++;
      // A link holds its own runs.
      if (Array.isArray(piece.content)) inline(piece.content);
    }
  };
  const walk = (list: readonly unknown[]): void => {
    for (const block of list as Loose[]) {
      if (coloured(block.props?.textColor) || coloured(block.props?.backgroundColor)) facts.colours++;
      const { style, ...rest } = paraOf(block as { props?: object });
      if (style) facts.styles++;
      if (Object.keys(rest).length > 0) facts.spacing++;
      inline(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return facts;
}

/**
 * The styling a format cannot hold, said once each. Markdown holds none of it (its colours are said
 * in a line of their own). Word keeps all of it (work-kit's writer: fonts by their Office names,
 * sizes, colours, the named styles, spacing, the page), and OpenDocument and Rich Text are made
 * from that Word file.
 */
function styling(facts: DocFacts): string[] {
  const lines: string[] = [];
  if ((facts.fonts ?? 0) > 0) lines.push("Fonts and sizes stay behind");
  if ((facts.styles ?? 0) > 0) lines.push("Named styles stay behind");
  if ((facts.spacing ?? 0) > 0) lines.push("Paragraph spacing stays behind");
  return lines;
}

const some = (n: number, one: string, many: string): string | null => (n > 0 ? (n === 1 ? one : many.replace("{n}", n.toLocaleString("en-US"))) : null);

/**
 * What a format drops of this document, one plain line each, counted from
 * the document. Each line says what happens to the thing. Only what is true
 * of today's writers is said. LibreOffice keeps linked replies in OpenDocument.
 * In Rich Text, it makes them separate comments and sets theme text colours
 * to their current RGB values (formats/previewLosses.live.test.ts).
 * An agent's suggestions stay out of the file until he accepts them.
 */
export function docDrops(format: DocFormat, facts: DocFacts): string[] {
  const lines: (string | null)[] = [];
  const paper = format === "pdf" || format === "print" || format === "html";
  if (format === "docx" || format === "odt" || format === "rtf") {
    const held = Math.min(facts.held ?? 0, facts.suggestions);
    lines.push(some(facts.suggestions - held, "1 suggestion goes as a tracked change", "{n} suggestions go as tracked changes"));
    lines.push(some(held, "1 suggestion stays out until you accept it", "{n} suggestions stay out until you accept them"));
    if (format === "rtf") {
      lines.push(some(facts.replied, "Replies to 1 comment become separate comments", "Replies to {n} comments become separate comments"));
      if ((facts.themeColours ?? 0) > 0) lines.push("Theme text colours become fixed colours");
    }
  } else {
    lines.push(some(facts.comments, "1 comment stays behind", "{n} comments stay behind"));
    lines.push(some(facts.suggestions, "1 suggestion stays out until you accept it", "{n} suggestions stay out until you accept them"));
  }
  if (paper) lines.push(some(facts.footnotes, "1 footnote moves to the end", "{n} footnotes move to the end"));
  if (format === "md") {
    if (facts.colours > 0) lines.push("Colours stay behind");
    if (facts.underlines > 0) lines.push("Underlines stay behind");
    lines.push(...styling(facts));
  }
  return lines.filter((line): line is string => line !== null);
}

/**
 * What a styled document's page set-up loses on paper, said on PDF and Print: columns are not drawn in Pages or the page
 * written from the blocks (Word and LibreOffice draw them), and the header and footer print only from the sheets
 * Pages draws, never from the page written in Flow.
 */
export function pageDrops(styled: Pick<DocumentPage, "setup" | "header" | "footer"> | null, sheets: boolean): string[] {
  if (!styled) return [];
  const lines: string[] = [];
  const columns = styled.setup?.columns ?? 1;
  if (columns > 1) lines.push(`${columns} columns print as one; Word keeps them`);
  const said = (band: DocumentPage["header"] | undefined): boolean => !!band && band.start.length + band.center.length + band.end.length > 0;
  if (!sheets && ((styled.setup?.header && said(styled.header)) || (styled.setup?.footer && said(styled.footer)))) lines.push("The header and footer print only from Pages");
  return lines;
}

type Request = <T>(env: string, method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<T>;

export interface DocPreviewDeps {
  env: string;
  source: CanvasSource;
  /** the canvas item it is open in: its renders are kept under it on the host and go when it goes */
  itemId?: string;
  title: string;
  /** the mounted editor; null while the document is still opening */
  editor(): AnyEditor | null;
  /** comments (and those with replies) and suggestions as the canvas counts them now */
  review(): Pick<DocFacts, "comments" | "replied" | "suggestions">;
  /** A test hands in its own wire, page writer and save. */
  request?: Request;
  /** the document's styles, theme and page set-up as they stand; null for a classic document */
  styled?(): DocumentPage | null;
  page?(editor: AnyEditor, title: string, print: { paper: "A4" | "Letter" } | null, styled: DocumentPage | null): Promise<string>;
  save?(name: string, blob: Blob): void;
  /** hands a PDF to this computer to print, which says where it went (work/formats/printOut.ts) */
  print?(name: string, bytes: Uint8Array): Promise<void>;
  locale?: string;
  /**
   * A styled document's pages as the editor holds them (its `DocumentHandle`), in either view; null
   * for a classic one or while it opens. `pagesHtml` answers null in Flow. `setSetup` is there only
   * where he may edit. `settled` waits until what was just set is laid out.
   */
  pages?(): DocPages | null;
  /** The `@font-face` rules a print of the pages carries (a test hands its own; the default reads the faces as `data:` URLs). */
  faces?(editor: AnyEditor, styled: DocumentPage): Promise<string>;
}

export type DocPages = Pick<DocumentHandle, "pagesHtml"> & Partial<Pick<DocumentHandle, "setSetup">> & { settled?(): Promise<void> };
type SetSetup = DocumentHandle["setSetup"];

/** The papers a document may take: Preview's list less what the document's set-up does not hold (Tabloid). */
export const DOC_PAPERS: readonly PaperName[] = ["Letter", "A4", "Legal", "A3", "A5"];

/**
 * The document's own set-up as Preview's Page section reads it, and writes it back through the editor:
 * paper, orientation, margins and the header and footer chosen there are the document's.
 */
export function documentSetup(setup: PageSetup, setSetup: SetSetup, settled?: () => Promise<void>): DocumentSetup {
  const common: CommonSetup = { paper: setup.paper, orientation: setup.orientation, margins: { ...setup.margins }, header: setup.header, footer: setup.footer, papers: DOC_PAPERS };
  return {
    kind: "document",
    common,
    columns: Math.min(3, Math.max(1, Math.round(setup.columns))) as 1 | 2 | 3,
    differentFirst: setup.differentFirst,
    async set(next) {
      const c = next.common;
      if (c && !DOC_PAPERS.includes(c.paper)) throw new Error(`A document cannot be set on ${c.paper}`);
      const patch: Parameters<SetSetup>[0] = {
        ...(c ? { paper: c.paper as PageSetup["paper"], orientation: c.orientation, margins: { ...c.margins }, header: c.header, footer: c.footer } : {}),
        ...(next.columns !== undefined ? { columns: next.columns } : {}),
        ...(next.differentFirst !== undefined ? { differentFirst: next.differentFirst } : {}),
      };
      if (!setSetup(patch)) throw new Error("The page set-up could not be changed");
      await settled?.();
    },
  };
}

const linkRequest: Request = (env, method, params, opts) => registry.linkOf(env).request(method, params, opts);

/** The font a document's text is in on paper when nothing names one: Office's own default, drawn with its twin. */
export const DOC_PAPER_FONT = "Calibri";

/** The print window loads no file, so a printed page carries its faces: the same ones LibreOffice draws Word's file with. */
async function docPrintFonts(editor: AnyEditor, styled: DocumentPage | null): Promise<{ faces: string; body: string }> {
  const { printFonts } = await import("../formats/fonts");
  const { resolveStyle, pageFonts, NORMAL } = await import("work-kit/editor/page");
  const body = styled ? (resolveStyle(styled.styles, NORMAL).fontFamily ?? DOC_PAPER_FONT) : DOC_PAPER_FONT;
  const named = styled ? [...pageFonts(styled), ...docFonts(editor.document as readonly unknown[])] : [];
  return printFonts(named, body);
}

async function writePage(editor: AnyEditor, title: string, print: { paper: "A4" | "Letter" } | null, styled: DocumentPage | null): Promise<string> {
  const { htmlDocument } = await import("work-kit/formats/html");
  const blocks = editor.document as never;
  // A styled document's page wears its own styles, theme and sheet; a classic one keeps the page's own look.
  const own = styled ? { page: styled } : {};
  if (!print) return htmlDocument(editor, blocks, { title, ...own });
  return htmlDocument(editor, blocks, { title, print, ...own, fonts: await docPrintFonts(editor, styled) });
}

/**
 * The editor's own marks, kept out of a print of the sheets he sees (docs/DESIGN.md "Document pages": no mark of the
 * editor's own): a comment's wash and underline, the people's carets with their names, and their selections. The
 * copy keeps the elements, so the sheets' heights stay as laid out; these rules only draw them as plain text.
 */
export const PRINT_UNMARKED =
  "<style>" +
  ".te-thread,.te-thread-shown,.te-thread-active,.te-thread-flash,.te-thread-settle,.te-thread-hot,.ProseMirror-yjs-selection{background:none!important;text-decoration:none!important}" +
  ".bn-collaboration-cursor__base,.bn-collaboration-cursor__caret,.bn-collaboration-cursor__label,.collaboration-cursor__caret,.collaboration-cursor__label{display:none!important}" +
  "</style>";

/** The sheets' page with the editor's marks drawn out of it. */
export const withoutEditorMarks = (html: string): string => (html.includes("</head>") ? html.replace("</head>", `${PRINT_UNMARKED}</head>`) : html.replace("<body>", `<body>${PRINT_UNMARKED}`));

const cancelled = (): DOMException => new DOMException("The draw was cancelled", "AbortError");
const unique = (lines: readonly string[]): string[] => [...new Set(lines.filter((line) => line.trim()))];
/** A host's warning as a line of the column: no closing full stop, as the document's own lines have none. */
const asLine = (warning: string): string => warning.trim().replace(/\.$/, "");

/** The document's `PreviewSource`: one object for as long as the document is the same one. */
export function docPreviewSource(deps: DocPreviewDeps): PreviewSource {
  const request = deps.request ?? linkRequest;
  const page = deps.page ?? writePage;
  const faces = deps.faces ?? (async (editor: AnyEditor, styled: DocumentPage) => (await docPrintFonts(editor, styled)).faces);
  const save = deps.save ?? saveFile;
  const print =
    deps.print ??
    (async (name: string, bytes: Uint8Array): Promise<void> => {
      const { printPdf } = await import("../formats/printOut");
      await printPdf(name, bytes);
    });
  const stem = (): string => fileStem(deps.title);
  /** What a call names: the item is this host's alone, so a host that serves the document for it is told the source only. */
  const target = (home: boolean): { source: CanvasSource; itemId?: string } => ({ source: deps.source, ...(home && deps.itemId ? { itemId: deps.itemId } : {}) });

  /** Asked of the item's host, or of the host that serves a LifeOS document when that is another. */
  const onHost = async <T>(ask: (env: string, home: boolean) => Promise<T>): Promise<T> => {
    try {
      return await ask(deps.env, true);
    } catch (err) {
      const other = servedBy(err);
      if (other && other !== deps.env) return ask(other, false);
      throw err;
    }
  };

  const facts = (): DocFacts => ({ ...blockFacts((deps.editor()?.document ?? []) as readonly unknown[]), ...deps.review() });

  const bytesOf = (env: string, home: boolean, answer: PreviewAnswer): PreviewBytes => ({
    rev: answer.rev,
    size: answer.size,
    read: async (offset, length) => {
      const got = await request<{ data: string }>(env, "work.formats.previewRead", { ...target(home), rev: answer.rev, offset, length: Math.min(length, PREVIEW_READ_MAX) }, { timeoutMs: 60_000 });
      return fromBase64(got.data);
    },
  });

  const mustHaveEditor = (): AnyEditor => {
    const editor = deps.editor();
    if (!editor) throw new Error("The document is still opening");
    return editor;
  };

  /**
   * The page a print is made of. In Pages it is the sheets as he sees them, the editor's own frame
   * written out (one print contract: Pages is the PDF, page for page); in Flow, or for a classic
   * document, the page written from the blocks.
   */
  const printPage = async (paper: "A4" | "Letter"): Promise<{ html: string; drops: string[] }> => {
    const editor = mustHaveEditor();
    const styled = deps.styled?.() ?? null;
    const pages = styled ? deps.pages?.() : null;
    if (pages && styled) {
      await pages.settled?.();
      const options: PagesHtmlOptions = { title: deps.title, faces: await faces(editor, styled) };
      const html = pages.pagesHtml(options);
      if (html) return { html: withoutEditorMarks(html), drops: pageDrops(styled, true) };
    }
    return { html: await page(editor, deps.title, { paper }, styled), drops: pageDrops(styled, false) };
  };

  /** The format as pages on the host: a render it already keeps for this very text is answered as it is. */
  const render = async (format: PreviewFormatId, signal: AbortSignal, by?: "word"): Promise<{ env: string; home: boolean; answer: PreviewAnswer; drops: string[] }> => {
    const paper = paperFor(deps.locale ?? globalThis.navigator?.language ?? "en-US");
    const printed = format === "pdf" ? await printPage(paper) : undefined;
    const html = printed?.html;
    if (signal.aborted) throw cancelled();
    return onHost(async (env, home) => {
      if (signal.aborted) throw cancelled();
      const answer = await request<PreviewResult>(env, "work.formats.preview", { ...target(home), format, ...(html ? { html, paper } : {}), ...(by ? { by } : {}) }, { timeoutMs: 5 * 60_000 });
      if (signal.aborted) throw cancelled();
      if ("notInReach" in answer) throw new NotInReach("Word", answer.notInReach);
      return { env, home, answer, drops: printed?.drops ?? [] };
    });
  };

  /** The last PDF Preview drew: what PDF and Print show, so what they save and print (the text may have moved on since). */
  let shown: { env: string; home: boolean; answer: PreviewAnswer } | null = null;

  const drawPaged = async (format: PreviewFormatId, signal: AbortSignal, by?: "word"): Promise<Drawn> => {
    // A new draw takes the picture's place: until it lands nothing is shown, and a press makes the print anew.
    if (format === "pdf" && !by) shown = null;
    const made = await render(format, signal, by);
    if (format === "pdf" && !by && !signal.aborted) shown = made;
    return {
      picture: { kind: "paged", pdf: bytesOf(made.env, made.home, made.answer), pages: made.answer.pages, drawnBy: made.answer.drawnBy },
      drops: unique([...docDrops(format, { ...facts(), held: made.answer.heldSuggestions ?? 0 }), ...made.drops, ...made.answer.warnings.map(asLine)]),
    };
  };

  /** The file itself, written by the host from the live text: Word, OpenDocument, Rich Text or Markdown. */
  const written = async (format: "docx" | "odt" | "rtf" | "md"): Promise<ExportAnswer> =>
    onHost((env) => request<ExportAnswer>(env, "work.formats.export", { source: deps.source, format }, { timeoutMs: 5 * 60_000 }));

  /** Every byte of a render's file, a frame at a time. */
  const whole = async (bytes: PreviewBytes): Promise<Uint8Array<ArrayBuffer>> => {
    const out = new Uint8Array(bytes.size);
    for (let offset = 0; offset < bytes.size; ) {
      const part = await bytes.read(offset, Math.min(PREVIEW_READ_MAX, bytes.size - offset));
      if (part.length === 0) throw new Error("The file could not be read to its end");
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };

  return {
    formats: [...DOC_FORMATS],
    // Read each time Preview draws: the document's set-up as it stands, for a styled document he may edit. A reader, and a classic document, have no Page section.
    get setup() {
      const styled = deps.styled?.() ?? null;
      const pages = styled ? deps.pages?.() : null;
      const set = pages?.setSetup;
      return styled && pages && set ? documentSetup(styled.setup, (patch) => set(patch), pages.settled) : undefined;
    },
    async office(format = "docx") {
      if (format !== "docx") return null;
      const { state } = await onHost((env, home) => request<PreviewOfficeAnswer>(env, "work.formats.previewOffice", target(home)));
      return { app: "Word", state };
    },
    async draw(format, opts) {
      if (opts.signal.aborted) throw cancelled();
      if (opts.by === "office") {
        if (format !== "docx") throw new NotInReach("Word", "none");
        return drawPaged("docx", opts.signal, "word");
      }
      if (format === "md") {
        const made = await written("md");
        if (opts.signal.aborted) throw cancelled();
        const text = new TextDecoder().decode(fromBase64(made.data));
        return { picture: { kind: "text", text }, drops: unique([...docDrops("md", facts()), ...made.warnings.map(asLine)]) };
      }
      if (format === "html") {
        const html = await page(mustHaveEditor(), deps.title, null, deps.styled?.() ?? null);
        if (opts.signal.aborted) throw cancelled();
        return { picture: { kind: "html", html }, drops: docDrops("html", facts()) };
      }
      if (format === "pdf" || format === "docx" || format === "odt" || format === "rtf") return drawPaged(format, opts.signal);
      // Print is the PDF: the pages that will go to paper, with a PDF's own lines, the host's among them.
      if (format === "print") return drawPaged("pdf", opts.signal);
      throw new Error(`A document does not go out as ${format}`);
    },
    async export(format) {
      const id = format as DocFormat;
      // The document as it stands now: never a picture kept from an earlier look.
      if (id === "html") {
        const name = `${stem()}.html`;
        save(name, new Blob([await page(mustHaveEditor(), deps.title, null, deps.styled?.() ?? null)], { type: mimeOf(id) }));
        return { name };
      }
      if (id === "md" || id === "docx" || id === "odt" || id === "rtf") {
        const made = await written(id);
        save(made.name, new Blob([fromBase64(made.data)], { type: mimeOf(id) }));
        return { name: made.name };
      }
      if (id !== "pdf" && id !== "print") throw new Error(`A document does not go out as ${format}`);
      // The pages he checked: the render Preview shows, read from the host that keeps it, even when another window has
      // changed the text since. With none shown, or its render gone, the print is made now.
      let made = shown ?? (await render("pdf", new AbortController().signal));
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await whole(bytesOf(made.env, made.home, made.answer));
      } catch {
        // The render went (drawn again in another window): once more, from the text as it stands.
        made = await render("pdf", new AbortController().signal);
        bytes = await whole(bytesOf(made.env, made.home, made.answer));
      }
      if (id === "print") await print(made.answer.name, bytes);
      else save(made.answer.name, new Blob([bytes], { type: mimeOf("pdf") }));
      return { name: made.answer.name };
    },
  };
}
