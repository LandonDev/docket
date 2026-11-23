import type { ExportFormat } from "@shared/contract-work-formats";
import type { CanvasSource } from "@shared/work";

/**
 * The export's and the import's words and rules (docs/agents/work-formats.md
 * "Import and export"), apart from React so a test reads them.
 */

/** The paper a print page asks for: US Letter where the locale's paper is, A4 elsewhere. */
export function paperFor(locale: string): "A4" | "Letter" {
  return /-(US|CA|MX|PH|CL|CO|VE|GT|PR)\b/i.test(locale) ? "Letter" : "A4";
}

const MIME: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown;charset=utf-8",
  html: "text/html;charset=utf-8",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
};
export const mimeOf = (format: ExportFormat): string => MIME[format];

export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Saves a file where the person keeps downloads: the system's own save dialog is the answer. */
export function saveFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A title as a file's name: nothing a path could make of it. */
export const fileStem = (title: string): string =>
  title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Document";

/** The files a document is made from, by their name. */
const IMPORTS = /\.(docx|odt|rtf|doc|md|markdown|html?|pdf)$/i;
export const importable = (name: string): boolean => IMPORTS.test(name);
export const isHtml = (name: string): boolean => /\.html?$/i.test(name);

/** A source the document kind claims but cannot open as it is: a Word, OpenDocument, RTF, markdown or text file, made a `.tcdoc` first. */
export function importsFirst(source: CanvasSource): boolean {
  if (source.at === "microsoft") return source.app === "word";
  return source.at === "file" && /\.(docx|odt|rtf|doc|md|markdown|txt)$/i.test(source.path);
}

/** The most a dropped file may be: what the host link carries in one frame. */
export const DROP_MAX_BYTES = 64 * 1024 * 1024;

/** What the import said it could not keep, as one toast. */
export const warningsLine = (warnings: readonly string[]): string | null => (warnings.length ? `${warnings.join("; ")}.` : null);
