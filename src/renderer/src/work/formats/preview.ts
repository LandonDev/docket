/**
 * The Preview contract (docs/agents/work-editors.md "Preview"): what a kind's
 * `Body` hands the one Preview frame (`PreviewFrame.tsx`), so a document, a sheet
 * and a deck show "this is the file you will get" on one surface. The frame
 * knows nothing of a kind: it lists the source's formats, asks it to draw one,
 * shows the picture with what the format drops, and asks it to export.
 *
 * A source may rename nothing here and may leave any optional member out.
 * `previewProblems` (previewContract.ts) holds a source to these rules; each
 * build runs it on its own source in its own tests.
 */

/** One way out of the item: a file format, or Print. */
export interface PreviewFormat {
  /** the source's own name for it, given back to `draw` and `export`: `docx`, `pdf`, `print`, `csv`, … */
  id: string;
  /** as the bar says it: "Word", "PDF", "Print" */
  label: string;
  /** the file's extension, with no dot; absent for Print */
  ext?: string;
  /** drawn as pages (the bar shows zoom and "Page 2 of 5") */
  paged: boolean;
  /** the one primary button's word */
  verb: "Export" | "Print…" | (string & {});
  /** what a page of it is called in the bar's count: "Page 2 of 5", or "Slide 1 of 12" for a deck's own formats */
  unit?: "page" | "slide";
}

/** Bytes of one finished render, read by range; `rev` names it, so every read is of the same render. */
export interface PreviewBytes {
  rev: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Who drew a paged picture: said once, in the line over the first page. */
export type DrawnBy = "tempcode" | "libreoffice" | "word" | "excel" | "powerpoint";

export type PreviewPicture =
  | {
      kind: "paged";
      pdf: PreviewBytes;
      /** the pages in `pdf`, the ones the frame draws */
      pages: number;
      drawnBy: DrawnBy;
      /**
       * Set when `pdf` holds only part of the whole (a sheet of 2,084 pages
       * draws its first 50): `from` and `to` are which pages of the whole
       * the PDF's first and last are, 1-based and inclusive, so
       * `to - from + 1` is `pages`; `of` is about how many the whole has.
       * The bar then reads "Page 3 of 2,084".
       */
      shown?: { from: number; to: number; of: number };
    }
  | { kind: "text"; text: string }
  | { kind: "html"; html: string }
  | { kind: "table"; name: string; rows: string[][]; sheets?: string[] }
  | { kind: "files"; files: Array<{ name: string; thumb: string }> }
  | { kind: "video"; video: PreviewBytes; poster: string; seconds: number; size: string };

/** The papers Page set-up offers, by Office's names. */
export const PAPERS = ["Letter", "A4", "Legal", "Tabloid", "A3", "A5"] as const;
export type PaperName = (typeof PAPERS)[number];

/** A paper's size in points (1/72 inch), portrait. */
export const PAPER_POINTS: Record<PaperName, { width: number; height: number }> = {
  Letter: { width: 612, height: 792 },
  A4: { width: 595.3, height: 841.9 },
  Legal: { width: 612, height: 1008 },
  Tabloid: { width: 792, height: 1224 },
  A3: { width: 841.9, height: 1190.55 },
  A5: { width: 419.55, height: 595.3 },
};

/** Margins in points. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Word's own named margins, in points; anything else reads "Custom". */
export const MARGIN_PRESETS = {
  Normal: { top: 72, right: 72, bottom: 72, left: 72 },
  Narrow: { top: 36, right: 36, bottom: 36, left: 36 },
  Moderate: { top: 72, right: 54, bottom: 72, left: 54 },
  Wide: { top: 72, right: 144, bottom: 72, left: 144 },
} as const satisfies Record<string, Margins>;
export type MarginPreset = keyof typeof MARGIN_PRESETS;

/** The preset a set of margins is, or null for margins of his own. */
export function marginPresetOf(margins: Margins): MarginPreset | null {
  for (const name of Object.keys(MARGIN_PRESETS) as MarginPreset[]) {
    const p = MARGIN_PRESETS[name];
    if (p.top === margins.top && p.right === margins.right && p.bottom === margins.bottom && p.left === margins.left) return name;
  }
  return null;
}

/** The page set-up every kind has. */
export interface CommonSetup {
  paper: PaperName;
  orientation: "portrait" | "landscape";
  margins: Margins;
  /** the running header and footer, each on or off */
  header: boolean;
  footer: boolean;
  /** the papers this kind may be set on, in the menu's order; left out, every one of `PAPERS` */
  papers?: readonly PaperName[];
}

/** How a sheet is scaled onto its pages: a percent, or fitted to a count of pages wide and tall (null: as many as it takes). */
export type SheetScale = { kind: "percent"; percent: number } | { kind: "fit"; wide: number | null; tall: number | null };

/** The rows and columns repeated on every page, as Excel writes them ("1:2", "A:B"). */
export interface SheetTitles {
  rows: string | null;
  columns: string | null;
}

type SetOf<T> = (next: Partial<Omit<T, "kind" | "set">>) => Promise<void>;

export interface DocumentSetup {
  kind: "document";
  common: CommonSetup;
  columns: 1 | 2 | 3;
  differentFirst: boolean;
  set: SetOf<DocumentSetup>;
}
export interface SheetSetup {
  kind: "sheet";
  common: CommonSetup;
  scale: SheetScale;
  printArea: string | null;
  titles: SheetTitles;
  gridlines: boolean;
  headings: boolean;
  set: SetOf<SheetSetup>;
}
export interface DeckSetup {
  kind: "deck";
  common: CommonSetup;
  layout: "slides" | "notes" | { handouts: 2 | 3 | 4 | 6 };
  hidden: boolean;
  set: SetOf<DeckSetup>;
}

/** Page set-up: one arm per kind. `common` is every kind's; each build fills its own arm. */
export type PageSetupModel = DocumentSetup | SheetSetup | DeckSetup;

export type OfficeApp = "Word" | "Excel" | "PowerPoint";

/** The real Office app cannot draw this now: `draw` with `by: 'office'` rejects with it. */
export class NotInReach extends Error {
  constructor(
    readonly app: OfficeApp,
    readonly why: "none" | "asleep" | "not open",
  ) {
    super(`${app} is not in reach`);
    this.name = "NotInReach";
  }
}

export interface DrawOptions {
  /** his press on "Check in Word" (or Excel, or PowerPoint); the draw rejects with NotInReach when the app cannot */
  by?: "office";
  /** only these pages, 1-based and inclusive (a sheet of thousands of pages draws its first 50) */
  pages?: [number, number];
  /** which sheet, for a format that holds one (CSV) */
  sheet?: string;
  signal: AbortSignal;
}

export interface Drawn {
  picture: PreviewPicture;
  /** what this format cannot hold, one plain line each, counted from the item; empty when nothing is lost */
  drops: string[];
}

export interface PreviewSource {
  formats: PreviewFormat[];
  setup?: PageSetupModel;
  /**
   * Whether the real Office app can draw this format now: drives "Check in
   * Word". Absent or null: never offered. `ready` and `asleep` offer it (a press on
   * an asleep one wakes the machine and draws); `not open` is an app he has
   * shut, which no press starts unseen; `none` is no Office in reach of a
   * press from this window. The frame names the format it is shown, for a kind whose real app draws only some of
   * its formats (PowerPoint draws a deck's slides, not its handouts).
   */
  office?(format?: string): Promise<{ app: OfficeApp; state: "ready" | "asleep" | "not open" | "none" } | null>;
  /** Draws the format. `by: 'office'` is his press on "Check in …": the app's own picture, or a rejection with NotInReach. */
  draw(format: string, opts: DrawOptions): Promise<Drawn>;
  /**
   * Writes the file out, or prints it. `where` is the place it was saved, when the source put it somewhere itself
   * ("Spring LAN"): the frame then says "Saved <name> to <where>". Without it the system's own save or print dialog
   * was the answer, and the frame says nothing more.
   */
  export(format: string): Promise<{ name: string; where?: string }>;
}
