import { extsOfCanvas } from "@shared/work/files";
import { defineChunk } from "../../lib/lazyChunk";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import { File } from "../icons";

/**
 * The file kind of canvas item (docs/agents/work-files.md "The file kind"): any file no other kind shows, open as
 * itself. A text or code file is edited in place and saves as he types; anything else shows its facts with a
 * way to its own app and Download. Only the Files pane makes these items until a thread has the tools for them,
 * so the registry's lookup for a thread never answers this kind (`threadCanvasOf`, src/shared/work/files.ts).
 */
export const fileCanvas: CanvasKindDef = defineCanvasKind<undefined>({
  kind: "file",
  label: "File",
  icon: File,
  opens: { ext: extsOfCanvas("file") },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-files-canvas", () => import("./FileKind")),
});
