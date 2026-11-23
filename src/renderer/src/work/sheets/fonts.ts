import { drawnAs, ensureFonts, fontUrl, twinOf } from "../formats/fonts";

/**
 * A workbook's fonts in the grid (docs/agents/work-editors.md "Fonts"). Univer draws a cell on a
 * canvas in the family its style names, by that name alone: it takes no stack. So beside the
 * twin's own faces (`ensureFonts`), each Office name this machine may lack is registered as a
 * family of its own that draws with the twin's files, the machine's real font first where it has
 * one. "Calibri" in a cell then draws as Calibri on a Mac with Office, and as Carlito, which
 * sets the same widths, everywhere else.
 */

const MARK = "data-sheet-fonts";
const registered = new WeakMap<Document, Set<string>>();

const quote = (value: string): string => `"${value.replace(/[\r\n\f]/g, "").replace(/["\\]/g, (c) => `\\${c}`)}"`;

/** The `@font-face` rules that let a canvas draw `name` with its twin; none for a font that is its own twin. */
export function aliasCss(name: string, urlOf: (file: string) => string = fontUrl): string {
  const twin = drawnAs(name);
  if (twin === null) return "";
  // A font with no twin of its own (Aptos, a brand font) draws with the default twin's faces.
  const family = twinOf(name) ?? twinOf(twin);
  if (!family) return "";
  return family.faces
    .map((face) => `@font-face { font-family: ${quote(name)}; src: local(${quote(name)}), url(${quote(urlOf(face.file))}) format("woff2"); font-weight: ${face.weight}; font-style: ${face.style}; font-display: block; }`)
    .join("\n");
}

/** One entry a font, whatever its case, by the spelling met first. */
function once(names: Iterable<string>): string[] {
  const byName = new Map<string, string>();
  for (const name of names) if (name.trim() && !byName.has(name.trim().toLowerCase())) byName.set(name.trim().toLowerCase(), name.trim());
  return [...byName.values()];
}

/** How long a sheet waits for its fonts before it draws without them. */
export const FONT_WAIT_MS = 2500;

/**
 * Registers what the named fonts are drawn with and waits until the faces are read, so the grid's
 * first paint is in them. Never rejects, and never waits past `FONT_WAIT_MS`: a face that will not
 * load, or is slow, leaves the text in the canvas's fallback.
 */
export function ensureSheetFonts(names: Iterable<string>, doc: Document = document): Promise<void> {
  return Promise.race([read(names, doc), new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS))]).catch(() => undefined);
}

async function read(names: Iterable<string>, doc: Document): Promise<void> {
  const wanted = once(names);
  if (wanted.length === 0) return;
  let have = registered.get(doc);
  if (!have) registered.set(doc, (have = new Set()));
  const fresh = wanted.filter((name) => !have.has(name.toLowerCase()));
  for (const name of fresh) have.add(name.toLowerCase());
  const css = fresh.map((name) => aliasCss(name)).filter(Boolean).join("\n");
  if (css) {
    const style = doc.createElement("style");
    style.setAttribute(MARK, fresh.join(","));
    style.textContent = css;
    doc.head.append(style);
  }
  await ensureFonts(wanted, doc);
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (!fonts?.load) return;
  await Promise.allSettled(wanted.flatMap((name) => [fonts.load(`400 16px ${quote(name)}`), fonts.load(`700 16px ${quote(name)}`)]));
}
