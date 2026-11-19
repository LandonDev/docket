import { defineChunk } from "../../lib/lazyChunk";
import { Mail } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The mail kind of canvas item (docs/agents/work-mail.md). A stub: its
 * body says "Not built yet" until the mail pillar's milestone builds it
 * (`PILLAR_MILESTONE` in src/shared/work/ids.ts), which then points `chunk`
 * at its own module and corrects what the kind claims.
 */
export const mailCanvas: CanvasKindDef = {
  kind: "mail",
  label: "Mail",
  icon: Mail,
  opens: { sources: [{ at: "lifeos", table: "outbox" }], mime: ["message/rfc822"], ext: ["eml"] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-mail-canvas", () => import("../canvas/NotBuilt")),
};
