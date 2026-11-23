import { defineChunk } from "../../lib/lazyChunk";
import { Doc } from "../icons";
import { defineCanvasKind } from "../canvas/kind";
import type { DocState } from "./DocumentCanvas";

/**
 * The document kind of canvas item (docs/agents/work-docs.md): the shared
 * block editor on a LifeOS document, a LifeOS project note that is one, or a
 * `.tcdoc`. Its versions open beside it (`history`). It claims Word,
 * OpenDocument and RTF files too: the body makes such a file a `.tcdoc`
 * beside it and the item reopens on that (work/formats, milestone 21). A
 * markdown or text file is the `file` kind's by its name, edited in place in
 * Files; beside a thread, and by Open as a document, it still opens here the
 * same way (`threadCanvasOf`, src/shared/work/files.ts).
 * Google documents (milestone 30) say on the state line that they cannot
 * open yet.
 */
export const documentCanvas = defineCanvasKind<DocState>({
  kind: "document",
  label: "Document",
  icon: Doc,
  opens: {
    sources: [{ at: "lifeos", table: "docs" }, { at: "lifeos", table: "projectDocs" }, { at: "microsoft", app: "word" }],
    mime: ["application/vnd.google-apps.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ext: ["tcdoc", "docx", "doc", "odt", "rtf"],
  },
  phone: "web",
  guestable: true,
  history: true,
  chunk: defineChunk("work-docs-canvas", () => import("./DocumentCanvas")),
});
