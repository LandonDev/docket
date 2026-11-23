// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_FAMILIES } from "work-kit/fonts";
import { ensureFonts, fontUrl, forgetFonts, printFonts } from "./fonts";

const styles = (): HTMLStyleElement[] => [...document.head.querySelectorAll<HTMLStyleElement>("style[data-work-fonts]")];

afterEach(() => {
  for (const style of styles()) style.remove();
  forgetFonts();
  vi.restoreAllMocks();
});

describe("a file's fonts in the window", () => {
  it("has a file in the build for every face work-kit names", () => {
    const files = FONT_FAMILIES.flatMap((f) => f.faces.map((face) => face.file));
    expect(files).toHaveLength(20);
    for (const file of files) expect(fontUrl(file), file).toMatch(/\.woff2(\?|$)/);
    expect(() => fontUrl("Aptos-Regular.woff2")).toThrow("No font file");
  });

  it("registers a family once, under its twin's name, when a file first names it", async () => {
    const doc = document.implementation.createHTMLDocument("a");
    await ensureFonts(["Calibri"], doc);
    const made = [...doc.head.querySelectorAll("style[data-work-fonts]")];
    expect(made).toHaveLength(1);
    expect(made[0]!.getAttribute("data-work-fonts")).toBe("Carlito");
    expect(made[0]!.textContent!.match(/@font-face/g)).toHaveLength(4);
    expect(made[0]!.textContent).toContain('font-family: "Carlito"');
    expect(made[0]!.textContent).toContain("font-display: block");

    // Its own name, its Office name and a font with no twin here are all the same family: nothing more is added.
    await ensureFonts(["Carlito", "calibri", "Aptos"], doc);
    expect(doc.head.querySelectorAll("style[data-work-fonts]")).toHaveLength(1);

    await ensureFonts(["Times New Roman", "Calibri"], doc);
    const all = [...doc.head.querySelectorAll("style[data-work-fonts]")];
    expect(all.map((s) => s.getAttribute("data-work-fonts"))).toEqual(["Carlito", "Liberation Serif"]);
  });

  it("adds nothing for a file that names no font", async () => {
    const doc = document.implementation.createHTMLDocument("b");
    await ensureFonts([], doc);
    expect(doc.head.querySelector("style[data-work-fonts]")).toBeNull();
  });

  it("waits for every face of the family, and a face that will not load does not stop the file", async () => {
    const doc = document.implementation.createHTMLDocument("c");
    const asked: string[] = [];
    Object.defineProperty(doc, "fonts", {
      value: {
        load: (font: string) => {
          asked.push(font);
          return font.startsWith("italic 700") ? Promise.reject(new Error("no such face")) : Promise.resolve([]);
        },
      },
    });
    await expect(ensureFonts(["Arial"], doc)).resolves.toBeUndefined();
    expect(asked).toEqual(['normal 400 16px "Liberation Sans"', 'normal 700 16px "Liberation Sans"', 'italic 400 16px "Liberation Sans"', 'italic 700 16px "Liberation Sans"']);
  });
});

describe("the fonts of a page a print window loads", () => {
  const read = vi.fn(async (url: string) => new TextEncoder().encode(`font:${url}`).buffer as ArrayBuffer);

  it("carries the faces as data: URLs and the body's family list, the body's own family among them", async () => {
    read.mockClear();
    const fonts = await printFonts(["Arial"], "Calibri", read);
    expect(fonts.body).toBe('"Calibri", "Carlito", sans-serif');
    expect(fonts.faces.match(/@font-face/g)).toHaveLength(8);
    expect(fonts.faces.match(/url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/g)).toHaveLength(8);
    expect(fonts.faces).not.toMatch(/url\("(?!data:)/);
    expect(read).toHaveBeenCalledTimes(8);
    // The bytes are the file's own.
    const first = /url\("data:font\/woff2;base64,([^"]+)"\)/.exec(fonts.faces)![1]!;
    expect(atob(first)).toBe(`font:${fontUrl("Carlito-Regular.woff2")}`);
  });

  it("reads each face once however often it prints, and asks again after a read that failed", async () => {
    read.mockClear();
    await printFonts([], "Calibri", read);
    await printFonts(["Calibri"], "Calibri", read);
    expect(read).toHaveBeenCalledTimes(4);

    forgetFonts();
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(printFonts([], "Cambria", failing)).rejects.toThrow("offline");
    read.mockClear();
    const fonts = await printFonts([], "Cambria", read);
    expect(read).toHaveBeenCalledTimes(4);
    expect(fonts.body).toBe('"Cambria", "Caladea", serif');
  });
});
