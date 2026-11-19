import { defineChunk } from "../../lib/lazyChunk";
import { Mail } from "../icons";
import type { CanvasKindDef } from "../canvas/kind";

/**
 * The mail kind of canvas item (docs/agents/work-mail.md): a draft in
 * LifeOS's `outbox` beside the thread that made it, in LifeOS's own
 * composer under the mail it answers, with an agent's rewrite waiting in it
 * to take or leave.
 */
export const mailCanvas: CanvasKindDef = {
  kind: "mail",
  label: "Mail",
  icon: Mail,
  opens: { sources: [{ at: "lifeos", table: "outbox" }] },
  phone: "native",
  guestable: false,
  chunk: defineChunk("work-mail-canvas", () => import("./MailCanvas")),
};
