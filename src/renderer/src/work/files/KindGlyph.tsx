import type { EntryKind } from "@shared/work/files";
import { Archive, File, FileText, Folder, type IconComponent } from "../../chrome/icons";
import { Doc, Media, Pdf, Slides, Table, Video, Volume } from "../icons";

/** The glyph for each kind of file. */
export const KIND_ICON: Record<EntryKind, IconComponent> = {
  folder: Folder,
  document: Doc,
  sheet: Table,
  deck: Slides,
  pdf: Pdf,
  picture: Media,
  video: Video,
  audio: Volume,
  text: FileText,
  archive: Archive,
  other: File,
};

/** Each kind's tint (docs/DESIGN.md "File kind tints"). Archive and other have none of their own, so they stay muted. */
export const KIND_TINT: Record<EntryKind, string> = {
  folder: "text-kind-folder",
  document: "text-kind-doc",
  sheet: "text-kind-sheet",
  deck: "text-kind-slides",
  pdf: "text-kind-pdf",
  picture: "text-kind-image",
  video: "text-kind-video",
  audio: "text-kind-audio",
  text: "text-kind-text",
  archive: "text-muted-foreground",
  other: "text-muted-foreground",
};

/**
 * A file's kind as one glyph. Tinted only in the Files place's rows, tiles and
 * headers; a canvas tab row passes `tinted={false}`. Hidden from readers, since
 * the row's name says what it is. A plain function: list rows draw thousands.
 */
export function KindGlyph({ kind, tinted = true, className }: { kind: EntryKind; tinted?: boolean; className?: string }) {
  const Glyph = KIND_ICON[kind];
  return <Glyph aria-hidden data-kind-glyph={kind} className={`${className ?? "size-4 shrink-0"} ${tinted ? KIND_TINT[kind] : "text-muted-foreground"}`} />;
}
