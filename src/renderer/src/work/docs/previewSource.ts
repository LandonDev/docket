import type { ExportAnswer, PreviewAnswer, PreviewFormatId } from "@shared/contract-work-formats";
import { PREVIEW_READ_MAX } from "@shared/contract-work-formats";
import type { CanvasSource } from "@shared/work";
import type { AnyEditor } from "work-kit/editor";
import { registry } from "../../lib/connection";
import { fileStem, fromBase64, mimeOf, paperFor, saveFile } from "../formats/model";
import type { Drawn, PreviewBytes, PreviewFormat, PreviewSource } from "../formats/preview";
import { servedBy } from "./host";

/**
 * The document's side of Preview (docs/agents/work-docs.md "Preview"): each
 * format the document goes out as, drawn as that file will be.
 *
 * - Word, OpenDocument and Rich Text are written on the host from the live
 *   text, converted there, and drawn by LibreOffice from the exported file
 *   itself (`work.formats.preview`).
 * - PDF is the document's print page, written here from the editor's blocks
 *   and printed on the host.
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
  footnotes: number;
  /** runs and blocks with any colour, text or background */
  colours: number;
  underlines: number;
}

type Loose = { type?: unknown; props?: Record<string, unknown>; content?: unknown; children?: unknown; styles?: Record<string, unknown> };

const coloured = (value: unknown): boolean => typeof value === "string" && value !== "" && value !== "default";

/** What the editor's blocks hold that a format may drop: colours, underlines, footnotes. */
export function blockFacts(blocks: readonly unknown[]): Pick<DocFacts, "footnotes" | "colours" | "underlines"> {
  const facts = { footnotes: 0, colours: 0, underlines: 0 };
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
      if (coloured(styles.textColor) || coloured(styles.backgroundColor)) facts.colours++;
      if (styles.underline === true) facts.underlines++;
      // A link holds its own runs.
      if (Array.isArray(piece.content)) inline(piece.content);
    }
  };
  const walk = (list: readonly unknown[]): void => {
    for (const block of list as Loose[]) {
      if (coloured(block.props?.textColor) || coloured(block.props?.backgroundColor)) facts.colours++;
      inline(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return facts;
}

const some = (n: number, one: string, many: string): string | null => (n > 0 ? (n === 1 ? one : many.replace("{n}", n.toLocaleString("en-US"))) : null);

/**
 * What a format drops of this document, one plain line each, counted from
 * the document. Each line says what happens to the thing. Only what is true
 * of today's writers is said: Word and OpenDocument take comments and
 * suggestions whole; Rich Text takes a comment without its replies; a PDF
 * and a web page gather footnotes at the end (and keep every colour, which
 * the page writes inline); Markdown has no colour and no underline.
 */
export function docDrops(format: DocFormat, facts: DocFacts): string[] {
  const lines: (string | null)[] = [];
  const paper = format === "pdf" || format === "print" || format === "html";
  if (format === "docx" || format === "odt" || format === "rtf") {
    lines.push(some(facts.suggestions, "1 suggestion goes as a tracked change", "{n} suggestions go as tracked changes"));
    if (format === "rtf") lines.push(some(facts.replied, "1 comment loses its replies", "{n} comments lose their replies"));
  } else {
    lines.push(some(facts.comments, "1 comment stays behind", "{n} comments stay behind"));
    lines.push(some(facts.suggestions, "1 suggestion stays out until you accept it", "{n} suggestions stay out until you accept them"));
  }
  if (paper) lines.push(some(facts.footnotes, "1 footnote moves to the end", "{n} footnotes move to the end"));
  if (format === "md") {
    if (facts.colours > 0) lines.push("Colours stay behind");
    if (facts.underlines > 0) lines.push("Underlines stay behind");
  }
  return lines.filter((line): line is string => line !== null);
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
  page?(editor: AnyEditor, title: string, print: { paper: "A4" | "Letter" } | null): Promise<string>;
  save?(name: string, blob: Blob): void;
  /** hands a PDF to this computer to print, which says where it went (work/formats/printOut.ts) */
  print?(name: string, bytes: Uint8Array): Promise<void>;
  locale?: string;
}

const linkRequest: Request = (env, method, params, opts) => registry.linkOf(env).request(method, params, opts);

async function writePage(editor: AnyEditor, title: string, print: { paper: "A4" | "Letter" } | null): Promise<string> {
  const { htmlDocument } = await import("work-kit/formats/html");
  return htmlDocument(editor, editor.document as never, print ? { title, print } : { title });
}

const cancelled = (): DOMException => new DOMException("The draw was cancelled", "AbortError");
const unique = (lines: readonly string[]): string[] => [...new Set(lines.filter((line) => line.trim()))];
/** A host's warning as a line of the column: no closing full stop, as the document's own lines have none. */
const asLine = (warning: string): string => warning.trim().replace(/\.$/, "");

/** The document's `PreviewSource`: one object for as long as the document is the same one. */
export function docPreviewSource(deps: DocPreviewDeps): PreviewSource {
  const request = deps.request ?? linkRequest;
  const page = deps.page ?? writePage;
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

  /** The format as pages on the host: a render it already keeps for this very text is answered as it is. */
  const render = async (format: PreviewFormatId, signal: AbortSignal): Promise<{ env: string; home: boolean; answer: PreviewAnswer }> => {
    const paper = paperFor(deps.locale ?? globalThis.navigator?.language ?? "en-US");
    const html = format === "pdf" ? await page(mustHaveEditor(), deps.title, { paper }) : undefined;
    if (signal.aborted) throw cancelled();
    const made = await onHost(async (env, home) => ({
      env,
      home,
      answer: await request<PreviewAnswer>(env, "work.formats.preview", { ...target(home), format, ...(html ? { html, paper } : {}) }, { timeoutMs: 5 * 60_000 }),
    }));
    if (signal.aborted) throw cancelled();
    return made;
  };

  const drawPaged = async (format: PreviewFormatId, signal: AbortSignal): Promise<Drawn> => {
    const made = await render(format, signal);
    return {
      picture: { kind: "paged", pdf: bytesOf(made.env, made.home, made.answer), pages: made.answer.pages, drawnBy: made.answer.drawnBy },
      drops: unique([...docDrops(format, facts()), ...made.answer.warnings.map(asLine)]),
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
    async draw(format, opts) {
      if (opts.signal.aborted) throw cancelled();
      if (format === "md") {
        const made = await written("md");
        if (opts.signal.aborted) throw cancelled();
        const text = new TextDecoder().decode(fromBase64(made.data));
        return { picture: { kind: "text", text }, drops: unique([...docDrops("md", facts()), ...made.warnings.map(asLine)]) };
      }
      if (format === "html") {
        const html = await page(mustHaveEditor(), deps.title, null);
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
        save(name, new Blob([await page(mustHaveEditor(), deps.title, null)], { type: mimeOf(id) }));
        return { name };
      }
      if (id === "md" || id === "docx" || id === "odt" || id === "rtf") {
        const made = await written(id);
        save(made.name, new Blob([fromBase64(made.data)], { type: mimeOf(id) }));
        return { name: made.name };
      }
      if (id !== "pdf" && id !== "print") throw new Error(`A document does not go out as ${format}`);
      // The print the preview makes: an unchanged document is answered from the render the host keeps, the bytes he saw.
      let made = await render("pdf", new AbortController().signal);
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await whole(bytesOf(made.env, made.home, made.answer));
      } catch {
        // The render went between the two calls (drawn again in another window): once more.
        made = await render("pdf", new AbortController().signal);
        bytes = await whole(bytesOf(made.env, made.home, made.answer));
      }
      if (id === "print") await print(made.answer.name, bytes);
      else save(made.answer.name, new Blob([bytes], { type: mimeOf("pdf") }));
      return { name: made.answer.name };
    },
  };
}
