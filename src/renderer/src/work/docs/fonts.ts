import { useEffect } from "react";

/**
 * The fonts a document names, loaded before its text is drawn with them
 * (docs/agents/work-editors.md "Fonts"). A text's font is its `fontFamily`
 * style, an Office name ("Calibri"); the window draws it with that font's
 * twin (work/formats/fonts.ts). A document that names no font loads nothing:
 * the faces and the code that registers them stay out of the page.
 */

type Loose = { type?: string; styles?: Record<string, unknown>; content?: unknown; children?: unknown };
type Watched = { document: readonly unknown[]; onChange(listener: () => void): (() => void) | void };

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

/** How long after an edit the document is read again for a font it did not name before. */
export const FONT_WATCH_MS = 500;

/** Loads the fonts the open document names, and any it comes to name (his own pick, or another's edit). */
export function useDocFonts(editor: Watched | null, load?: (names: string[]) => void): void {
  useEffect(() => {
    if (!editor) return;
    const ensure = load ?? ((names: string[]) => void import("../formats/fonts").then(({ ensureFonts }) => ensureFonts(names)));
    let seen = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = (): void => {
      timer = null;
      const names = docFonts(editor.document);
      const key = names.join("\n");
      if (key === seen) return;
      seen = key;
      if (names.length > 0) ensure(names);
    };
    look();
    const off = editor.onChange(() => {
      if (timer === null) timer = setTimeout(look, FONT_WATCH_MS);
    });
    return () => {
      if (typeof off === "function") off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor, load]);
}
