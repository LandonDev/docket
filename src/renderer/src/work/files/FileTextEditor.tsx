import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useColorScheme } from "../../hooks/useColorScheme";
import { languageForPath, schemeExtensions } from "../../surfaces/editorChrome";
import { isProse } from "./fileText";

/** The frame inside the pane: the editor fills it and scrolls in its own native scroller, with room around the text. */
const FRAME = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { padding: "16px 0 48px" },
  ".cm-line": { padding: "0 20px" },
  ".cm-gutters": { paddingLeft: "8px" },
});

/**
 * A CodeMirror buffer over the file's text: the scheme's theme, the path's language, line numbers for code and
 * wrapped lines for prose. It reports his edits and nothing else; a text replaced from the host mounts a new one
 * (`key`), so an Undo never brings back what another writer's version replaced.
 */
export function FileTextEditor({ name, path, text, readOnly, onChange }: { name: string; path: string; text: string; readOnly: boolean; onChange(text: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const scheme = useColorScheme();
  const parts = useRef({ theme: new Compartment(), language: new Compartment(), locked: new Compartment() });
  const changed = useRef(onChange);
  useLayoutEffect(() => {
    changed.current = onChange;
  });

  useEffect(() => {
    if (!host.current) return;
    const { theme, language, locked } = parts.current;
    const prose = isProse(name);
    const state = EditorState.create({
      doc: text,
      extensions: [
        minimalSetup,
        ...(prose ? [EditorView.lineWrapping] : [lineNumbers()]),
        FRAME,
        theme.of(schemeExtensions(scheme)),
        language.of([]),
        locked.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.contentAttributes.of({ "aria-label": name }),
        EditorView.updateListener.of((update) => {
          // Every change of the text is his: nothing else writes into this buffer.
          if (update.docChanged) changed.current(update.state.doc.toString());
        }),
      ],
    });
    const made = new EditorView({ state, parent: host.current });
    view.current = made;
    let live = true;
    void languageForPath(path).then((extension) => {
      if (live && extension) made.dispatch({ effects: language.reconfigure(extension), annotations: [Transaction.addToHistory.of(false)] });
    });
    return () => {
      live = false;
      made.destroy();
      view.current = null;
    };
    // The first text only: this editor is the text's owner from then on, and a new text from the host remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const { theme, locked } = parts.current;
    view.current?.dispatch({ effects: [theme.reconfigure(schemeExtensions(scheme)), locked.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)])], annotations: [Transaction.addToHistory.of(false)] });
  }, [scheme, readOnly]);

  return <div ref={host} data-file-text className="min-h-0 flex-1 overflow-hidden bg-background text-[13px]" />;
}
