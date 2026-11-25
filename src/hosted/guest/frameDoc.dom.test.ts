// @vitest-environment jsdom
/**
 * A document's side of the phone's frame (frameDoc.ts): the selection read into the app's bar, the app's presses
 * run on the editor, and Find drawn with the page's own highlights, never by taking the focus. The editor and
 * work-kit's reads are stand-ins: they have their own tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom draws nothing: a range sits in plain sight.
Range.prototype.getBoundingClientRect ??= () => ({ top: 0, bottom: 10 }) as DOMRect;

const kit = vi.hoisted(() => ({
  format: { style: "Normal", inList: false, list: null as string | null, marks: { bold: false, italic: false, underline: false, strike: false }, canUndo: true, canRedo: false },
  calls: [] as unknown[][],
  matches: [] as { from: number; to: number }[],
}));
vi.mock("work-kit/editor", async (original) => {
  const real = await original<typeof import("work-kit/editor")>();
  return {
    ...real,
    readFormat: () => kit.format,
    setMark: (_: unknown, name: string, on: boolean) => kit.calls.push(["mark", name, on]),
    setLineStyle: (_: unknown, style: string) => kit.calls.push(["style", style]),
    toggleList: (_: unknown, type: string) => kit.calls.push(["list", type]),
    findMatches: () => ({ matches: kit.matches, capped: false }),
  };
});

const { bindDocument, CURRENT, HIT, stylesOffered } = await import("./frameDoc");
const { Frame } = await import("./frame");
import type { AnyEditor, DocumentPage } from "work-kit/editor";

/** An editor stand-in over one line of text in the DOM. */
function fakeEditor() {
  const text = document.createElement("div");
  text.textContent = "Budget and the budget sheet";
  document.body.append(text);
  const node = text.firstChild!;
  const listeners = { change: [] as (() => void)[], selection: [] as (() => void)[] };
  let focused = false;
  const editor = {
    domElement: text,
    isFocused: () => focused,
    undo: () => kit.calls.push(["undo"]),
    redo: () => kit.calls.push(["redo"]),
    onChange: (f: () => void) => (listeners.change.push(f), () => {}),
    onSelectionChange: (f: () => void) => (listeners.selection.push(f), () => {}),
    prosemirrorView: { state: { doc: {}, selection: { from: 5 } }, domAtPos: (pos: number) => ({ node, offset: pos }) },
  };
  return { editor: editor as unknown as AnyEditor, focus: (on: boolean) => (focused = on), changed: () => listeners.change.forEach((f) => f()) };
}

/** A window with highlights, and a frame whose frames run at once. */
function setup(editable = true) {
  const posted: Record<string, unknown>[] = [];
  const frame = new Frame({ postMessage: (m) => posted.push(m as Record<string, unknown>) }, (run) => (run(), 1), () => {});
  const drawn = new Map<string, Range[]>();
  class Highlight {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  const win = Object.assign(Object.create(window), {
    CSS: { highlights: { set: (name: string, h: Highlight) => drawn.set(name, h.ranges), delete: (name: string) => drawn.delete(name) } },
    Highlight,
    requestAnimationFrame: (run: () => void) => (run(), 1),
    cancelAnimationFrame: () => {},
    innerHeight: 10_000,
    document,
  });
  const fake = fakeEditor();
  const binding = bindDocument(frame, fake.editor, { page: () => null, editable, win });
  return { posted, drawn, binding, ...fake, last: (kind: string) => posted.filter((m) => m.kind === kind).at(-1) };
}

afterEach(() => {
  kit.calls.length = 0;
  kit.matches = [];
  kit.format.marks.bold = false;
  document.body.innerHTML = "";
});

describe("the bar's state", () => {
  it("says the line's style, the marks, the list, Undo and Redo, and the styles a classic document takes", () => {
    const { last } = setup();
    expect(last("state")).toEqual({ kind: "state", editing: false, style: "Normal", styles: ["Normal", "Heading 1", "Heading 2", "Heading 3", "Quote"], bold: false, italic: false, list: null, undo: true, redo: false });
  });

  it("says editing while the text holds the focus", () => {
    const { last, focus, editor } = setup();
    focus(true);
    editor.domElement!.dispatchEvent(new FocusEvent("focusin"));
    expect(last("state")).toMatchObject({ editing: true });
  });

  it("offers a reader nothing to press", () => {
    const { last, focus, editor } = setup(false);
    focus(true);
    editor.domElement!.dispatchEvent(new FocusEvent("focusin"));
    expect(last("state")).toMatchObject({ editing: false, styles: [], undo: false, redo: false });
  });

  it("offers a styled document its menu and its own styles; a list keeps the plain ones", () => {
    const page = { styles: { Normal: {}, "Speaker note": {} } } as unknown as DocumentPage;
    expect(stylesOffered(page, false)).toEqual(["Normal", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3", "Quote", "Caption", "Speaker note"]);
    expect(stylesOffered(page, true)).toEqual(["Normal", "Title", "Subtitle", "Caption", "Speaker note"]);
  });
});

describe("the app's presses", () => {
  it("toggles bold and italic from what the selection is", () => {
    const { binding } = setup();
    binding.receive({ kind: "format", what: "bold" });
    kit.format.marks.bold = true;
    binding.receive({ kind: "format", what: "bold" });
    binding.receive({ kind: "format", what: "italic" });
    expect(kit.calls).toEqual([
      ["mark", "bold", true],
      ["mark", "bold", false],
      ["mark", "italic", true],
    ]);
  });

  it("sets an offered style, refuses another, toggles a list, and runs Undo and Redo", () => {
    const { binding } = setup();
    binding.receive({ kind: "format", what: "style", style: "Heading 2" });
    binding.receive({ kind: "format", what: "style", style: "Title" });
    binding.receive({ kind: "format", what: "list", list: "number" });
    binding.receive({ kind: "undo" });
    binding.receive({ kind: "redo" });
    expect(kit.calls).toEqual([["style", "Heading 2"], ["list", "numberedListItem"], ["undo"], ["redo"]]);
  });

  it("writes nothing on a reader's page", () => {
    const { binding } = setup(false);
    binding.receive({ kind: "format", what: "bold" });
    binding.receive({ kind: "undo" });
    expect(kit.calls).toEqual([]);
  });
});

describe("find", () => {
  it("finds from the caret, steps round, and draws the hits and the one in hand", () => {
    kit.matches = [
      { from: 0, to: 6 },
      { from: 15, to: 21 },
    ];
    const { binding, last, drawn } = setup();
    binding.receive({ kind: "find", what: "search", query: "budget" });
    expect(last("found")).toEqual({ kind: "found", query: "budget", count: 2, at: 2 });
    expect(drawn.get(CURRENT)?.[0]?.startOffset).toBe(15);
    expect(drawn.get(HIT)).toHaveLength(1);
    binding.receive({ kind: "find", what: "next" });
    expect(last("found")).toMatchObject({ at: 1 });
    binding.receive({ kind: "find", what: "previous" });
    expect(last("found")).toMatchObject({ at: 2 });
    binding.receive({ kind: "find", what: "clear" });
    expect(drawn.size).toBe(0);
  });

  it("says none found, and searches again when the text changes under it", () => {
    const { binding, last, changed } = setup();
    binding.receive({ kind: "find", what: "search", query: "budget" });
    expect(last("found")).toEqual({ kind: "found", query: "budget", count: 0, at: 0 });
    kit.matches = [{ from: 0, to: 6 }];
    changed();
    expect(last("found")).toEqual({ kind: "found", query: "budget", count: 1, at: 1 });
  });

  it("never takes the focus", () => {
    kit.matches = [{ from: 0, to: 6 }];
    const { binding } = setup();
    const before = document.activeElement;
    binding.receive({ kind: "find", what: "search", query: "budget" });
    expect(document.activeElement).toBe(before);
  });
});
