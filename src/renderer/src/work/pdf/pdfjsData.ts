/**
 * pdf.js's own files that a file may lean on, shipped as assets of the PDF
 * canvas and fetched only when a page asks for one: the CMaps of text set
 * in a CJK font the file does not embed, the two standard fonts pdf.js
 * never takes from the system (Symbol and ZapfDingbats), and the JPEG 2000
 * and JBIG2 decoders. pdf.js asks for each by name through its
 * `BinaryDataFactory`; this one answers from the build's own URLs. Each file
 * is its own hashed asset (never inlined), and this module is loaded with
 * pdf.js itself (engine.ts), so none of it is in the first paint or in the
 * canvas's chunk.
 *
 * Not shipped: the Liberation fonts (GPL with a font exception) and the
 * other Foxit fonts, which pdf.js reads only with system fonts off; the ICC
 * profile and qcms, which pdf.js fetches only from a worker by a base URL
 * that hashed assets cannot give (CMYK falls back to pdf.js's own
 * conversion); and quickjs, for form scripts, which the canvas never runs.
 */

type Kind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

const urls = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));

const SHIPPED: Record<Kind, Map<string, string>> = {
  cMapUrl: urls(import.meta.glob<string>("../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", { query: "?url&no-inline", import: "default", eager: true })),
  standardFontDataUrl: urls(
    import.meta.glob<string>(["../../../../../node_modules/pdfjs-dist/standard_fonts/FoxitSymbol.pfb", "../../../../../node_modules/pdfjs-dist/standard_fonts/FoxitDingbats.pfb"], {
      query: "?url&no-inline",
      import: "default",
      eager: true,
    }),
  ),
  wasmUrl: urls(
    import.meta.glob<string>(["../../../../../node_modules/pdfjs-dist/wasm/openjpeg.wasm", "../../../../../node_modules/pdfjs-dist/wasm/jbig2.wasm"], {
      query: "?url&no-inline",
      import: "default",
      eager: true,
    }),
  ),
};

/** The licence notice of each file shipped, emitted beside them, as the licences ask: a notice goes where its file goes. */
export const NOTICES: readonly string[] = Object.values(
  import.meta.glob<string>(
    [
      "../../../../../node_modules/pdfjs-dist/cmaps/LICENSE",
      "../../../../../node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT",
      "../../../../../node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG",
      "../../../../../node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG",
      "../../../../../node_modules/pdfjs-dist/wasm/LICENSE_JBIG2",
      "../../../../../node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2",
    ],
    { query: "?url&no-inline", import: "default", eager: true },
  ),
);

/** The URL pdf.js's file `filename` is served at, or null for one the app does not ship. */
export function shippedUrl(kind: string, filename: string): string | null {
  return SHIPPED[kind as Kind]?.get(filename) ?? null;
}

/** How many files of each kind ship: a test holds the build to it. */
export const shippedCount = (kind: Kind): number => SHIPPED[kind].size;

/**
 * pdf.js's `BinaryDataFactory` (getDocument's option): it asks `fetch` for a
 * file by kind and name, on the main thread, since a factory of our own
 * turns its worker fetch off. A file we do not ship is refused, and pdf.js
 * draws on without it as it did before any was shipped.
 */
export class ShippedData {
  // pdf.js passes the base URLs it was given; this factory has none and needs none.
  constructor(_urls?: unknown) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = shippedUrl(kind, filename);
    if (!url) throw new Error(`pdf.js asked for ${filename}, which the app does not ship`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${filename}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
