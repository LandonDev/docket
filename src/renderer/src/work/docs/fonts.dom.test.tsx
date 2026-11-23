// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOC_FONTS, docFonts } from "./fonts";

const text = (value: string, fontFamily?: string) => ({ type: "text", text: value, styles: fontFamily ? { fontFamily } : {} });
const para = (...content: unknown[]) => ({ type: "paragraph", props: {}, content, children: [] as unknown[] });

afterEach(() => {
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

describe("the editor's fonts", () => {
  it("asks the window's loader for the names it is given, which is fetched only then", async () => {
    const asked: string[][] = [];
    vi.doMock("../formats/fonts", () => ({ ensureFonts: async (names: string[]) => void asked.push(names) }));
    await DOC_FONTS.ensure(["Calibri", "Aptos"]);
    expect(asked).toEqual([["Calibri", "Aptos"]]);
    vi.doUnmock("../formats/fonts");
  });
});
