import type { ShowDeck } from "@shared/contract-work-slides";
import { RENDER_CHANGED } from "../deck";
import type { ShowHost } from "./Show";

/**
 * Any PDF as a show (docs/agents/work-slides.md "Presenting a PDF"): each page a slide, in its order, with no notes,
 * no builds, no transitions and no clips. The show reads the PDF's bytes by range as it reads a deck's render, so a
 * PDF kind hands its own reader and nothing is copied.
 */

export interface PdfBytes {
  /** names this file's bytes: a read at another rev is refused */
  rev: string;
  size: number;
  /** how many pages it has */
  pages: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** The show's host over one PDF: its pages as slides, its bytes read at its rev, and a file that never changes under it. */
export function pdfShowHost(pdf: PdfBytes, name: string): ShowHost {
  if (!(pdf.pages >= 1)) throw new Error("This PDF has no pages to show");
  const deck: ShowDeck = {
    itemId: `pdf:${pdf.rev}`,
    name,
    rev: pdf.rev,
    render: { rev: pdf.rev, size: pdf.size, pages: pdf.pages },
    slides: Array.from({ length: pdf.pages }, (_, i) => ({ id: i + 1, number: i + 1, page: i + 1, title: `Page ${i + 1}`, notes: "", hidden: false })),
  };
  return {
    show: async () => deck,
    read: async (offset, length, rev) => {
      if (rev !== pdf.rev) throw new Error(RENDER_CHANGED);
      return pdf.read(offset, length);
    },
    onRev: () => () => undefined,
  };
}
