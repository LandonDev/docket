import { defineChunk } from "../../lib/lazyChunk";
import type { ActViews } from "../acts/registry";

/**
 * How the mail pillar's held acts are shown (`mail.send`;
 * docs/agents/work-mail.md): who the mail is from and to, its subject, its
 * words and its files, exactly as they go.
 */
export const mailActs = {
  "mail.send": { kind: "mail.send", chunk: defineChunk("work-mail-act", () => import("./MailAct")) },
} satisfies ActViews;
