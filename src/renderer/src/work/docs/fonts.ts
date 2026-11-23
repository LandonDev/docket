import type { EditorFonts } from "work-kit/editor";

/**
 * The fonts a document's text names (docs/agents/work-editors.md "Fonts"). A text's font is its
 * `fontFamily` style, an Office name ("Calibri"); the window draws it with that font's twin
 * (work/formats/fonts.ts). The editor loads them itself through `DOC_FONTS`; `docFonts` is for a
 * page written out, which carries the faces it names.
 */

type Loose = { type?: string; styles?: Record<string, unknown>; content?: unknown; children?: unknown };

/** The fonts a document's text names, once each, in the order they first appear. */
export function docFonts(blocks: readonly unknown[]): string[] {
  const names = new Set<string>();
  const inline = (content: unknown): void => {
    if (!Array.isArray(content)) {
      // A table's content: rows of cells, each holding inline content.
      const rows = (content as { rows?: { cells?: unknown[] }[] } | null)?.rows;
      if (Array.isArray(rows)) for (const row of rows) for (const cell of row.cells ?? []) inline(Array.isArray(cell) ? cell : (cell as Loose | null)?.content);
      return;
    }
    for (const piece of content as Loose[]) {
      const font = piece.styles?.fontFamily;
      if (typeof font === "string" && font.trim()) names.add(font.trim());
      // A link holds its own runs.
      if (Array.isArray(piece.content)) inline(piece.content);
    }
  };
  const walk = (list: readonly unknown[]): void => {
    for (const block of list as Loose[]) {
      inline(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return [...names];
}

/**
 * A document's fonts, for the editor (work-kit's kit, `fonts`): the faces a styled document names
 * are loaded by the window (work/formats/fonts.ts, fetched only then). The editor asks when a
 * styled document opens, when its fonts change and when he opens the font list. One object for
 * every document, in the app and on the guest page.
 */
export const DOC_FONTS: EditorFonts = {
  ensure: (names) => import("../formats/fonts").then(({ ensureFonts }) => ensureFonts(names)),
};
