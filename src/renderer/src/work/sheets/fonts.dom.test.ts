// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { aliasCss, ensureSheetFonts } from "./fonts";

describe("a workbook's fonts in the grid", () => {
  const url = (file: string): string => `/fonts/${file}`;

  it("registers an Office font under its own name, drawn with its twin's files, the machine's own font first", () => {
    const css = aliasCss("Calibri", url);
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain('font-family: "Calibri"; src: local("Calibri"), url("/fonts/Carlito-Regular.woff2") format("woff2"); font-weight: 400; font-style: normal;');
    expect(css).toContain('url("/fonts/Carlito-BoldItalic.woff2") format("woff2"); font-weight: 700; font-style: italic;');
    // Cambria has a twin of its own; a font with none takes the default twin's faces
    expect(aliasCss("Cambria", url)).toContain("Caladea-Regular.woff2");
    expect(aliasCss("Aptos", url)).toContain('font-family: "Aptos"; src: local("Aptos"), url("/fonts/Carlito-Regular.woff2")');
  });

  it("needs no rule for a twin drawn as itself, and escapes a name", () => {
    expect(aliasCss("Carlito", url)).toBe("");
    expect(aliasCss('Bad"Name', url)).toContain('font-family: "Bad\\"Name"');
  });

  it("adds each font's rules to the page once, and the twin's own faces with them", async () => {
    const doc = document.implementation.createHTMLDocument("t");
    await ensureSheetFonts(["Calibri", "calibri", "Cambria", ""], doc);
    await ensureSheetFonts(["Calibri"], doc);
    const mine = [...doc.head.querySelectorAll("style[data-sheet-fonts]")];
    expect(mine).toHaveLength(1);
    expect(mine[0]!.getAttribute("data-sheet-fonts")).toBe("Calibri,Cambria");
    expect(mine[0]!.textContent).toContain('font-family: "Cambria"');
    expect(doc.head.querySelectorAll("style[data-work-fonts]").length).toBeGreaterThan(0);
  });
});
