import { BUILT_IN_STYLES, defaultStyles, findMatches, headingLevel, MENU_STYLES, NORMAL, readFormat, setLineStyle, setMark, toggleList, type AnyEditor, type DocumentPage } from "work-kit/editor";
import { LIST_TYPE, listKindOf, nearestFrom, stepTo, type Frame, type FrameIn, type FrameState } from "./frame";

/**
 * A document's side of the phone's frame (frame.ts): the editor's selection read into the app's bar, the app's
 * presses run on the editor, and Find drawn on the text with the page's own highlights, never in the document and
 * never by taking the focus (a field that took it would raise the keyboard).
 */

/** A classic document's styles: the format row's own (work-kit format-row.tsx). */
const CLASSIC = [NORMAL, "Heading 1", "Heading 2", "Heading 3", "Quote"];
const DEFAULTS = defaultStyles();
/** The page's highlights, washed as work-kit washes a match (guest.css). */
export const HIT = "tc-find-hit";
export const CURRENT = "tc-find-current";

/** The styles the app may set: a styled document's menu and its own, a classic one's five; a list keeps the plain ones. */
export function stylesOffered(page: DocumentPage | null, inList: boolean): string[] {
  const offered: string[] = page ? [...MENU_STYLES] : [...CLASSIC];
  if (page)
    for (const name of Object.keys(page.styles).sort((a, b) => a.localeCompare(b))) if (!(BUILT_IN_STYLES as readonly string[]).includes(name)) offered.push(name);
  return inList ? offered.filter((name) => name === NORMAL || (!headingLevel(name) && name !== "Quote")) : offered;
}

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

export interface DocumentBinding {
  /** Read the selection again (the document's styles changed). */
  refresh(): void;
  receive(message: FrameIn): void;
  stop(): void;
}

export function bindDocument(
  frame: Frame,
  editor: AnyEditor,
  o: { page(): DocumentPage | null; editable: boolean; win?: Window & { CSS?: { highlights?: Highlights }; Highlight?: HighlightCtor } },
): DocumentBinding {
  const win = o.win ?? (window as NonNullable<typeof o.win>);
  const read = (): FrameState | null => {
    try {
      const page = o.page();
      const f = readFormat(editor, page?.styles ?? DEFAULTS, page?.theme.fonts.body ?? "");
      return {
        editing: o.editable && editor.isFocused(),
        style: f.style,
        styles: o.editable ? stylesOffered(page, f.inList) : [],
        bold: f.marks.bold,
        italic: f.marks.italic,
        list: listKindOf(f.list),
        undo: o.editable && f.canUndo,
        redo: o.editable && f.canRedo,
      };
    } catch {
      // An editor between documents reads nothing: the bar keeps what it showed.
      return null;
    }
  };
  const push = (): void => {
    const now = read();
    if (now) frame.state(now);
  };

  // Find: the query, its matches where they stood when searched, and the one in hand.
  let query = "";
  let matches: { from: number; to: number }[] = [];
  let current = -1;
  let again: number | null = null;
  const rangeOf = (m: { from: number; to: number }): Range | null => {
    try {
      const view = editor.prosemirrorView;
      const start = view.domAtPos(m.from);
      const end = view.domAtPos(m.to);
      const range = win.document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch {
      return null;
    }
  };
  const draw = (): void => {
    const highlights = win.CSS?.highlights;
    const Ctor = win.Highlight;
    if (!highlights || !Ctor) return;
    const ranges = matches.map(rangeOf);
    const hand = ranges[current] ?? null;
    if (!ranges.length) {
      highlights.delete(HIT);
      highlights.delete(CURRENT);
      return;
    }
    highlights.set(HIT, new Ctor(...ranges.filter((r, i): r is Range => !!r && i !== current)));
    if (hand) highlights.set(CURRENT, new Ctor(hand));
    else highlights.delete(CURRENT);
  };
  const reveal = (): void => {
    const hand = matches[current];
    const range = hand ? rangeOf(hand) : null;
    if (!range) return;
    const box = range.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= win.innerHeight) return;
    const node = range.startContainer;
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    element?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  };
  const answer = (): void => frame.found(query, matches.length, current + 1);
  const search = (from: number): void => {
    matches = query ? findMatches(editor.prosemirrorView.state.doc, query).matches.map((m) => ({ from: m.from, to: m.to })) : [];
    current = nearestFrom(
      matches.map((m) => m.from),
      from,
    );
    draw();
  };

  const receive = (m: FrameIn): void => {
    if (m.kind === "find") {
      if (m.what === "clear") {
        query = "";
        matches = [];
        current = -1;
        draw();
        return;
      }
      if (m.what === "search") {
        query = m.query;
        search(editor.prosemirrorView.state.selection.from);
      } else {
        current = stepTo(matches.length, current, m.what === "next" ? 1 : -1);
        draw();
      }
      reveal();
      return answer();
    }
    if (!o.editable) return;
    if (m.kind === "undo") editor.undo();
    else if (m.kind === "redo") editor.redo();
    else if (m.what === "style") {
      if (read()?.styles.includes(m.style)) setLineStyle(editor, m.style);
    } else if (m.what === "list") toggleList(editor, LIST_TYPE[m.list]);
    else setMark(editor, m.what, !(read()?.[m.what] ?? false));
    push();
  };

  // The text changed under a search: searched again on the next frame, from the match that was in hand.
  const changed = (): void => {
    push();
    if (!query || again !== null) return;
    again = win.requestAnimationFrame(() => {
      again = null;
      const was = matches.length;
      search(matches[current]?.from ?? 0);
      if (matches.length !== was) answer();
    });
  };
  const stops = [editor.onChange(changed), editor.onSelectionChange(push)];
  const text = editor.domElement;
  text?.addEventListener("focusin", push);
  text?.addEventListener("focusout", push);
  push();
  return {
    refresh: push,
    receive,
    stop() {
      for (const stop of stops) stop?.();
      text?.removeEventListener("focusin", push);
      text?.removeEventListener("focusout", push);
      if (again !== null) win.cancelAnimationFrame(again);
      win.CSS?.highlights?.delete(HIT);
      win.CSS?.highlights?.delete(CURRENT);
    },
  };
}
