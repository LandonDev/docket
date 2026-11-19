import { defineChunk } from "../../lib/lazyChunk";
import { Pdf } from "../icons";
import { defineCanvasKind, type CanvasKindDef } from "../canvas/kind";
import { installCiteClicks } from "./cite";
import type { PdfState } from "./PdfCanvas";

/**
 * The pdf kind of canvas item (docs/agents/work-pdf.md). The body is its own
 * chunk, with pdf.js behind it; this file rides the canvas chunk, so it
 * stays small. It also listens for citation links in the thread
 * (`#pdf:<item>:<page>…`, cite.ts), from the first Work thread shown on,
 * whether or not a PDF has been opened in this window yet.
 */
export const pdfCanvas: CanvasKindDef = defineCanvasKind<PdfState>({
  kind: "pdf",
  label: "PDF",
  icon: Pdf,
  opens: { mime: ["application/pdf"], ext: ["pdf"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-pdf-canvas", () => import("./PdfCanvas")),
});

installCiteClicks(async () => {
  const [{ sessionStore }, store] = await Promise.all([import("../../lib/tcserver/store"), import("../canvas/store")]);
  return {
    environmentOf: (sessionId) => sessionStore.environmentOf(sessionId),
    show: async (environmentId, sessionId, itemId) => {
      // A shown or open tab is selected here; a closed one the host opens again.
      if (store.canvasOf(sessionId).items.some((item) => item.id === itemId)) {
        store.selectItem(sessionId, itemId);
        return;
      }
      await store.openItem(environmentId, sessionId, { itemId });
    },
  };
});
