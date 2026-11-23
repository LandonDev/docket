import { DEFAULT_TWIN, FONT_FAMILIES, facesFor, fontFaceCss, fontStack, twinOf, type FontFamily } from "work-kit/fonts";

/**
 * A file's fonts in the window (docs/agents/work-editors.md "Fonts"): a font is
 * named as Office names it and drawn with a free twin of the same metrics,
 * the same woff2 on every machine (work-kit/fonts), so the editor, the PDF
 * and LibreOffice's pictures break lines alike.
 *
 * Every kind draws through here. `ensureFonts(names)` before a file that
 * names those fonts is laid out; `fontStack(name)` as the `font-family` of
 * what is drawn; `printFonts(names)` for a page a print window loads, which
 * may fetch no file. Nothing is loaded until a file names a family, and
 * nothing of this is in first paint (scripts/entryGraph.test.ts).
 */

export { DEFAULT_TWIN, drawnAs, fontStack, fontStatus, twinOf } from "work-kit/fonts";

// Each face is a file of its own in the build; a rule that names one fetches it only when text is drawn with it.
const found = import.meta.glob("../../../../../node_modules/work-kit/src/fonts/files/*.woff2", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const urls = new Map(Object.entries(found).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));

/** Where the window loads a face from. */
export function fontUrl(file: string): string {
  const url = urls.get(file);
  if (!url) throw new Error(`No font file ${file}`);
  return url;
}

/** The family that draws a named font: its twin, or the default twin's for a font with none here. */
const familyOf = (name: string): FontFamily => twinOf(name) ?? FONT_FAMILIES.find((f) => f.twin === DEFAULT_TWIN)!;

const MARK = "data-work-fonts";
const registered = new WeakMap<Document, Set<string>>();

/**
 * Registers the faces the named fonts are drawn with and waits until they are
 * read, so nothing laid out after it moves when a face arrives. Safe to call
 * again and again: a family is registered once per page. It never rejects: a
 * face that will not load leaves the text in the next font of its stack.
 */
export async function ensureFonts(names: Iterable<string>, doc: Document = document): Promise<void> {
  const wanted = [...new Set([...names].map((name) => familyOf(name)))];
  if (wanted.length === 0) return;
  let have = registered.get(doc);
  if (!have) registered.set(doc, (have = new Set()));
  const fresh = wanted.filter((f) => !have.has(f.twin));
  if (fresh.length > 0) {
    for (const f of fresh) have.add(f.twin);
    const style = doc.createElement("style");
    style.setAttribute(MARK, fresh.map((f) => f.twin).join(","));
    style.textContent = fontFaceCss(fresh.map((f) => f.twin), fontUrl);
    doc.head.append(style);
  }
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (!fonts?.load) return;
  const loads = wanted.flatMap((f) => f.faces.map((face) => fonts.load(`${face.style} ${face.weight} 16px "${f.twin}"`)));
  await Promise.allSettled(loads);
}

const inlined = new Map<string, Promise<string>>();

function dataUrl(file: string, read: (url: string) => Promise<ArrayBuffer>): Promise<string> {
  let made = inlined.get(file);
  if (!made) {
    made = read(fontUrl(file)).then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:font/woff2;base64,${btoa(binary)}`;
    });
    // A read that failed is asked again next time.
    made.catch(() => inlined.delete(file));
    inlined.set(file, made);
  }
  return made;
}

const fetched = async (url: string): Promise<ArrayBuffer> => {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`The font could not be read (${answer.status})`);
  return answer.arrayBuffer();
};

/**
 * The fonts of a page a print window loads (`htmlDocument`'s `fonts`): the
 * faces as `data:` URLs, since that window fetches nothing, and the family
 * list the body takes. `body` is the font the text is in when nothing names
 * one.
 */
export async function printFonts(names: Iterable<string>, body: string, read: (url: string) => Promise<ArrayBuffer> = fetched): Promise<{ faces: string; body: string }> {
  const all = [...new Set([...names, body])];
  const data = new Map<string, string>();
  await Promise.all(facesFor(all).map(async (file) => data.set(file, await dataUrl(file, read))));
  return { faces: fontFaceCss(all, (file) => data.get(file)!), body: fontStack(body) };
}

/** For tests: a page starts with no face read. */
export function forgetFonts(): void {
  inlined.clear();
}
