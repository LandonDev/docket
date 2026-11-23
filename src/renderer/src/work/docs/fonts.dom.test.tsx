// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_WATCH_MS, docFonts, useDocFonts } from "./fonts";

const text = (value: string, fontFamily?: string) => ({ type: "text", text: value, styles: fontFamily ? { fontFamily } : {} });
const para = (...content: unknown[]) => ({ type: "paragraph", props: {}, content, children: [] as unknown[] });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the fonts a document names", () => {
  it("finds each once: in a paragraph, a link, a nested block and a table's cells", () => {
    const blocks = [
      para(text("a", "Calibri"), text("b"), { type: "link", href: "https://example.com", content: [text("c", "Cambria")] }),
      { ...para(text("d", " Calibri ")), children: [para(text("e", "Arial"))] },
      { type: "table", props: {}, content: { type: "tableContent", rows: [{ cells: [[text("f", "Aptos")], { type: "tableCell", content: [text("g", "Courier New")] }] }] }, children: [] },
    ];
    expect(docFonts(blocks)).toEqual(["Calibri", "Cambria", "Arial", "Aptos", "Courier New"]);
  });

  it("names none for a document as it is today, or for a style that is not a name", () => {
    expect(docFonts([para(text("plain")), para({ type: "text", text: "x", styles: { bold: true, fontFamily: "" } }), para({ type: "text", text: "y", styles: { fontFamily: 12 } })])).toEqual([]);
  });
});

describe("loading them as the document opens and changes", () => {
  function Probe({ editor, load }: { editor: Parameters<typeof useDocFonts>[0]; load(names: string[]): void }) {
    useDocFonts(editor, load);
    return null;
  }

  function fake(blocks: unknown[]) {
    const listeners = new Set<() => void>();
    return {
      editor: { document: blocks, onChange: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)) },
      change: (next: unknown[]) => {
        blocks.splice(0, blocks.length, ...next);
        for (const listener of listeners) listener();
      },
      listeners,
    };
  }

  it("loads nothing for a document that names no font, then the font someone sets, once", () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const doc = fake([para(text("plain"))]);
    const view = render(<Probe editor={doc.editor} load={load} />);
    expect(load).not.toHaveBeenCalled();

    act(() => doc.change([para(text("styled", "Calibri"))]));
    expect(load).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(FONT_WATCH_MS));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(["Calibri"]);

    // Typing on in the same fonts asks for nothing; many edits in one wait are one look.
    act(() => {
      doc.change([para(text("styled more", "Calibri"))]);
      doc.change([para(text("styled more and more", "Calibri"))]);
    });
    act(() => void vi.advanceTimersByTime(FONT_WATCH_MS));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => doc.change([para(text("a", "Calibri"), text("b", "Arial"))]));
    act(() => void vi.advanceTimersByTime(FONT_WATCH_MS));
    expect(load).toHaveBeenLastCalledWith(["Calibri", "Arial"]);

    view.unmount();
    expect(doc.listeners.size).toBe(0);
  });

  it("loads at once the fonts a document already names when it opens", () => {
    const load = vi.fn();
    render(<Probe editor={fake([para(text("a", "Times New Roman"))]).editor} load={load} />);
    expect(load).toHaveBeenCalledWith(["Times New Roman"]);
  });
});
