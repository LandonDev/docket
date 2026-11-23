import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import type { DeckTextFrame } from "@shared/contract-work-slides";
import { formatKeyOf } from "work-kit/format/keys";
import { bareKey, modKey, modOrCtrl } from "../../../lib/keys";
import { IS_MAC } from "../../../lib/platform";
import { keyAct, type Target } from "./DeckRow";
import { paint, placeOf, readModel, readSel, writeSel } from "./dom";
import type { BoxState, HandSession } from "./session";

/**
 * The typing box (docs/DESIGN.md "The slide editor"): his words laid over a
 * text shape on the stage, on its own corners and turned with it, in its
 * fonts, sizes, colours, alignment, insets and anchor, scaled to the stage.
 * It is filled with the slide's own ground, read from the picture just
 * inside the shape's edge, so the old words do not show through. Nothing
 * about it moves: it is there at once and gone at once.
 */

/** What is still "in the box" for a press or a focus: the box, the format row and the layers it opens. */
const INSIDE = "[data-slide-typing], [data-format-row], [data-work-kit]";
const inside = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(INSIDE);

/** Where the box sits: its first corner on the stage, its size, and its turn, in CSS pixels and degrees. */
export interface BoxPlace {
  left: number;
  top: number;
  width: number;
  height: number;
  turn: number;
}

const ANCHOR = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;
const DEFAULT_FRAME: DeckTextFrame = { anchor: "top", insets: [91_440, 45_720, 91_440, 45_720], fit: "none", wrap: true };
const HIGHLIGHT = "slide-typing";

/** The selection kept on screen while the row has the keyboard (a font list open): the browser's own is gone then. */
function keepShown(root: HTMLElement | null, box: BoxState | null): void {
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight;
  if (!highlights || !Highlight) return;
  highlights.delete(HIGHLIGHT);
  if (!root || !box || box.sel.from[0] === box.sel.to[0] && box.sel.from[1] === box.sel.to[1]) return;
  const range = root.ownerDocument.createRange();
  range.setStart(...placeOf(root, box.sel.from));
  range.setEnd(...placeOf(root, box.sel.to));
  highlights.set(HIGHLIGHT, new Highlight(range));
}

export function TypingBox({
  session,
  box,
  target,
  place,
  emu,
  frame = DEFAULT_FRAME,
  ground,
  tone,
  label,
  onLeave,
}: {
  session: HandSession;
  box: BoxState;
  target: Target;
  place: BoxPlace;
  /** CSS pixels an EMU on this stage */
  emu: number;
  frame?: DeckTextFrame;
  /** the slide's own colour under the shape's words, or null where it could not be read */
  ground: string | null;
  /** the picture's tone: the selection takes the tint that reads on it */
  tone: "dark" | "light";
  /** what the shape is ("Title"), for a screen reader */
  label: string;
  /** the box closed from the keyboard: the shape takes the keyboard back */
  onLeave(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const typing = box.phase === "typing";
  const first = useRef(true);

  // The page draws the model again when it must (a look, an undo, a paste, a new stage size), and the selection goes back.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    paint(el, box.drawn, emu);
    if (first.current) {
      first.current = false;
      el.focus({ preventScroll: true });
      const at = box.start;
      const caret = typeof at === "object" ? el.ownerDocument.caretRangeFromPoint?.(at.x, at.y) : null;
      if (caret && el.contains(caret.startContainer)) {
        const page = el.ownerDocument.getSelection();
        page?.removeAllRanges();
        page?.addRange(caret);
        const sel = readSel(el);
        if (sel) session.select(sel);
      } else writeSel(el, box.sel);
    } else if (el.ownerDocument.activeElement === el) writeSel(el, box.sel);
    else keepShown(el, box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.paint]);

  // Back from the row: the keyboard and his selection go into the box again.
  useEffect(() => {
    const el = root.current;
    if (!el || box.focus === 0) return;
    el.focus({ preventScroll: true });
    writeSel(el, box.sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.focus]);

  // A new stage size draws the words again at the new scale, as they stand now.
  const drawnAt = useRef(emu);
  useEffect(() => {
    if (drawnAt.current === emu) return;
    drawnAt.current = emu;
    session.repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emu]);

  // His selection, as he moves it.
  useEffect(() => {
    const el = root.current;
    if (!el || !typing) return;
    const doc = el.ownerDocument;
    const moved = (): void => {
      const sel = readSel(el);
      if (sel) session.select(sel);
    };
    doc.addEventListener("selectionchange", moved);
    return () => doc.removeEventListener("selectionchange", moved);
  }, [session, typing]);

  // A press or the keyboard anywhere but the box, the row and its layers commits.
  useEffect(() => {
    if (!typing) return;
    const doc = root.current?.ownerDocument ?? document;
    const away = (event: Event): void => {
      if (!inside(event.target)) void session.commit();
    };
    doc.addEventListener("pointerdown", away, true);
    doc.addEventListener("focusin", away, true);
    return () => {
      doc.removeEventListener("pointerdown", away, true);
      doc.removeEventListener("focusin", away, true);
    };
  }, [session, typing]);

  // What the browser would do to the words itself (bold by its own key, a paragraph, its own undo, a drop) goes through the model.
  useEffect(() => {
    const el = root.current;
    if (!el || !typing) return;
    const before = (event: InputEvent): void => {
      const kind = event.inputType;
      if (kind === "historyUndo" || kind === "historyRedo") {
        event.preventDefault();
        if (kind === "historyUndo") session.undo();
        else session.redo();
      } else if (kind === "insertParagraph") {
        event.preventDefault();
        session.enter();
      } else if (kind === "insertLineBreak") {
        event.preventDefault();
        session.insert("\n");
      } else if (kind.startsWith("format") || kind === "insertFromDrop" || kind === "deleteByDrag") {
        event.preventDefault();
      } else if (kind === "insertText" && event.data && Object.keys(session.get().box?.pending ?? {}).length > 0) {
        // Words after a look set at the caret take it: the model puts them in a run of their own.
        event.preventDefault();
        session.insert(event.data);
      }
    };
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  }, [session, typing]);

  // The kept selection goes once he is no longer typing, and with the box.
  useEffect(() => {
    if (!typing) keepShown(null, null);
    return () => keepShown(null, null);
  }, [typing]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!typing || event.nativeEvent.isComposing) return;
    const done = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      done();
      session.cancel();
      onLeave();
      return;
    }
    if (event.key === "Enter" && modOrCtrl(event) && !event.shiftKey && !event.altKey) {
      done();
      void session.commit();
      onLeave();
      return;
    }
    if (event.key === "Enter" && !modOrCtrl(event) && !event.altKey) {
      done();
      if (event.shiftKey) session.insert("\n");
      else session.enter();
      return;
    }
    const z = event.key.toLowerCase() === "z";
    if (modKey(event) && !event.altKey && (z || (!IS_MAC && event.key.toLowerCase() === "y" && !event.shiftKey))) {
      done();
      if (z && !event.shiftKey) session.undo();
      else session.redo();
      return;
    }
    // Tab and Shift-Tab at a list item's start move it in and out. Elsewhere Shift-Tab goes up to the format row with
    // the box still open (Escape there comes back), and Tab leaves the box, which commits.
    if (event.key === "Tab" && (bareKey(event) || (event.shiftKey && !modOrCtrl(event) && !event.altKey))) {
      const para = box.model[box.sel.from[0]];
      const atStart = box.sel.from[1] === 0 && box.sel.to[0] === box.sel.from[0] && box.sel.to[1] === 0;
      if (para && para.list !== "none" && atStart) {
        done();
        session.para({ level: Math.max(0, Math.min(8, para.level + (event.shiftKey ? -1 : 1))) });
        return;
      }
      const row = event.shiftKey ? root.current?.ownerDocument.querySelector<HTMLElement>('[data-format-row] [role=toolbar] [tabindex="0"]') : null;
      if (row) {
        done();
        row.focus();
      }
      return;
    }
    const key = formatKeyOf(event.nativeEvent, "slides", { mac: IS_MAC, editorKeys: true });
    if (key && keyAct(key, target, session)) done();
  };

  const [l, t, r, b] = frame.insets.map((v) => v * emu);
  const ink = box.model[0]?.runs[0]?.look.color ?? box.model[0]?.look.color;
  const style: CSSProperties = {
    left: place.left,
    top: place.top,
    width: place.width,
    minHeight: place.height,
    padding: `${t}px ${r}px ${b}px ${l}px`,
    justifyContent: ANCHOR[frame.anchor],
    ...(place.turn ? { transform: `rotate(${place.turn}deg)` } : {}),
    ...(ground ? { backgroundColor: ground } : {}),
  };
  return (
    <div data-slide-typing data-phase={box.phase} className={`absolute flex origin-top-left flex-col ${typing ? "" : "pointer-events-none"}`} style={style}>
      <div
        ref={root}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-hidden={typing ? undefined : true}
        contentEditable={typing}
        suppressContentEditableWarning
        spellCheck
        tabIndex={typing ? 0 : -1}
        className={`min-w-0 cursor-text outline-none [overflow-wrap:anywhere] ${frame.wrap ? "whitespace-pre-wrap" : "whitespace-pre"} ${
          tone === "dark" ? "selection:bg-(--sel-bg-dark-pic) [&_*::highlight(slide-typing)]:bg-(--sel-bg-dark-pic)" : "selection:bg-(--sel-bg-paper) [&_*::highlight(slide-typing)]:bg-(--sel-bg-paper)"
        }`}
        // A single line of PowerPoint's is 1.2 of its size.
        style={{ lineHeight: 1.2, ...(ink ? { caretColor: `#${ink}` } : {}) }}
        onInput={(event) => {
          const el = event.currentTarget;
          session.typed(readModel(el, box.drawn), readSel(el));
        }}
        onKeyDown={onKeyDown}
        onFocus={() => keepShown(null, null)}
        onBlur={() => keepShown(root.current, session.get().box)}
        onPaste={(event) => {
          event.preventDefault();
          session.paste(event.clipboardData.getData("text/plain"));
        }}
        onDrop={(event) => event.preventDefault()}
      />
    </div>
  );
}
