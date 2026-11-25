import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useColorScheme } from "../../hooks/useColorScheme";
import { languageForPath, schemeExtensions } from "../../surfaces/editorChrome";
import { editorSearch } from "../../surfaces/editorSearch";
import { useWorkCommands } from "../formats/command";
import type { TextReader } from "./fileSession";
import { handOver, openingCaret, type TextPlace } from "./textPlace";
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
 * wrapped lines for prose, and the code editor's Find and Replace (⌘F, ⌥⌘F). It reports his edits and nothing else,
 * as a reader of the text, so a key never copies the whole file (the session reads it when it needs it); a text
 * replaced from the host mounts a new one (`key`), so an Undo never brings back what another writer's version replaced,
 * and the new one opens where he was (`place`). Its frame is a Work editor's (`data-editor-keys="text"`): ⌘F is its
 * find, never the Files place's search.
 */
export function FileTextEditor({
  name,
  path,
  text,
  readOnly,
  onChange,
  place,
}: {
  name: string;
  path: string;
  text: string;
  readOnly: boolean;
  onChange(text: TextReader): void;
  place?: RefObject<TextPlace | null>;
}) {
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
    const was = place?.current ?? null;
    const state = EditorState.create({
      doc: text,
      selection: openingCaret(was, text),
      extensions: [
        minimalSetup,
        editorSearch,
        ...(prose ? [EditorView.lineWrapping] : [lineNumbers()]),
        FRAME,
        theme.of(schemeExtensions(scheme)),
        language.of([]),
        locked.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.contentAttributes.of({ "aria-label": name }),
        EditorView.updateListener.of((update) => {
          // Every change of the text is his: nothing else writes into this buffer. The text is handed over unread.
          if (!update.docChanged) return;
          changed.current(handOver(update.state.doc));
        }),
      ],
    });
    const made = new EditorView({ state, parent: host.current });
    view.current = made;
    if (was) made.scrollDOM.scrollTop = was.top;
    let live = true;
    void languageForPath(path).then((extension) => {
      if (live && extension) made.dispatch({ effects: language.reconfigure(extension), annotations: [Transaction.addToHistory.of(false)] });
    });
    return () => {
      live = false;
      if (place) place.current = { top: made.scrollDOM.scrollTop, head: made.state.selection.main.head };
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

  // Edit → Find… and ⌘F with the caret in the text: the find bar over the text (its Replace greyed where it is read only).
  useWorkCommands(host, { find: () => void (view.current && openSearchPanel(view.current)) });

  return <div ref={host} data-file-text data-editor-keys="text" className="min-h-0 flex-1 overflow-hidden bg-background text-[13px]" />;
}
